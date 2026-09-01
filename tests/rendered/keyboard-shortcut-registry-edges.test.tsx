/**
 * Epic 57 — edge-path tests for the shortcut registry (provider + hook).
 *
 * Companion to `keyboard-shortcut-hook.test.tsx`, which covers the happy
 * dispatch path. This file covers the decisions that REFUSE or FALL
 * BACK, because those are what a regression silently flips:
 *
 *   - `stopPropagation: false` genuinely lets a later window listener
 *     see the keystroke (the default genuinely does not)
 *   - the legacy `sheet` alias, and an explicit `scope` overriding it
 *   - the editable-target rule at its boundaries: `contenteditable="false"`
 *     and a non-input `role` are NOT editable; `<select>`,
 *     `role="searchbox"` and an `isContentEditable` host are
 *   - unregistering a child while the provider stays mounted really
 *     removes it from the registry
 *   - the registered entry reads the LATEST handler through its ref
 *     without re-registering — stale-closure and registry-thrash are
 *     opposite failure modes of the same line
 *   - `useRegisteredShortcuts()` snapshot identity — stable when nothing
 *     changed, or React re-renders the palette forever. Only that TRUE
 *     direction of the cache check is testable from the public hook; see
 *     the NOTE in that describe block for why a "fresh when <field>
 *     changed" test cannot fail and must not be added back
 *
 * Timeout bump: jsdom + RTL render under full-suite parallelism. The
 * `.ts` sibling `keyboard-shortcut-internals-edges.test.ts` carries the
 * same bump; `keyboard-shortcut-hook.test.tsx` does not.
 */
jest.setTimeout(90_000);

import React from 'react';
import { render, fireEvent } from '@testing-library/react';

import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
    useRegisteredShortcuts,
    type RegisteredShortcut,
    type UseKeyboardShortcutOptions,
} from '@/lib/hooks/use-keyboard-shortcut';

// ─── Test primitives ───────────────────────────────────────────────────

function Binding({
    keys,
    onHit,
    options,
}: {
    keys: string | string[];
    onHit: () => void;
    options?: UseKeyboardShortcutOptions;
}) {
    useKeyboardShortcut(keys, onHit, options);
    return null;
}

type Mods = Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>>;

function dispatchKey(key: string, mods: Mods = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
    });
    window.dispatchEvent(event);
    return event;
}

/**
 * Counts keydown events reaching a window listener installed AFTER the
 * provider's. `stopImmediatePropagation()` only suppresses listeners
 * registered later on the same target, so the install order is the whole
 * point of the helper — it must run after `render()`.
 */
function withTrailingWindowListener<T>(
    body: () => T,
): { result: T; trailingCalls: number } {
    let trailingCalls = 0;
    const trailing = (): void => {
        trailingCalls += 1;
    };
    window.addEventListener('keydown', trailing);
    // Definite-assignment assertion: `body()` either assigns or throws,
    // and a throw skips the return entirely.
    let result!: T;
    try {
        result = body();
    } finally {
        window.removeEventListener('keydown', trailing);
    }
    return { result, trailingCalls };
}

// ─── stopPropagation ───────────────────────────────────────────────────

describe('useKeyboardShortcut — stopPropagation', () => {
    it('swallows the event for later window listeners by default', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        const { trailingCalls } = withTrailingWindowListener(() =>
            dispatchKey('k'),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(trailingCalls).toBe(0);
    });

    it('lets the event through when stopPropagation is false', () => {
        // Opt-out exists for bindings that must coexist with a library
        // listener (an editor, a canvas). If the flag stopped being
        // honoured, that coexistence would break silently.
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding
                    keys="k"
                    onHit={spy}
                    options={{ stopPropagation: false }}
                />
            </KeyboardShortcutProvider>,
        );
        const { trailingCalls } = withTrailingWindowListener(() =>
            dispatchKey('k'),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(trailingCalls).toBe(1);
    });

    it('keeps preventDefault and stopPropagation independent', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding
                    keys="k"
                    onHit={spy}
                    options={{ preventDefault: false, stopPropagation: true }}
                />
            </KeyboardShortcutProvider>,
        );
        const { result: event, trailingCalls } = withTrailingWindowListener(
            () => dispatchKey('k'),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        // stopPropagation still on…
        expect(trailingCalls).toBe(0);
        // …while the browser default survives.
        expect(event.defaultPrevented).toBe(false);
    });
});

// ─── Legacy scope aliases ──────────────────────────────────────────────

describe('useKeyboardShortcut — legacy scope aliases', () => {
    function OverlayTree({
        options,
        onHit,
    }: {
        options: UseKeyboardShortcutOptions;
        onHit: () => void;
    }) {
        return (
            <KeyboardShortcutProvider>
                <div role="dialog" aria-label="x" data-state="open" />
                <Binding keys="Escape" onHit={onHit} options={options} />
            </KeyboardShortcutProvider>
        );
    }

    it('maps the legacy `sheet: true` alias to scope=overlay', () => {
        const spy = jest.fn();
        render(<OverlayTree options={{ sheet: true }} onHit={spy} />);
        dispatchKey('Escape');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not fire a `sheet: true` binding while no overlay is open', () => {
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="Escape" onHit={spy} options={{ sheet: true }} />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(spy).not.toHaveBeenCalled();
    });

    it('an explicit `scope` beats the legacy alias', () => {
        // `scope` is the modern option; if the legacy alias could
        // override it, a migrated call site would silently keep the old
        // behaviour.
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding
                    keys="Escape"
                    onHit={spy}
                    options={{ modal: true, sheet: true, scope: 'global' }}
                />
            </KeyboardShortcutProvider>,
        );
        dispatchKey('Escape');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reports the resolved scope through the palette snapshot', () => {
        const scopes: RegisteredShortcut[] = [];
        function Probe() {
            for (const s of useRegisteredShortcuts()) scopes.push(s);
            return null;
        }
        render(
            <KeyboardShortcutProvider>
                <Binding
                    keys="Escape"
                    onHit={() => {}}
                    options={{ sheet: true, description: 'Close sheet' }}
                />
                <Probe />
            </KeyboardShortcutProvider>,
        );
        expect(scopes.map((s) => s.scope)).toContain('overlay');
    });
});

// ─── Editable-target boundaries ────────────────────────────────────────

describe('useKeyboardShortcut — editable-target boundaries', () => {
    function renderWithTarget(node: React.ReactNode) {
        const spy = jest.fn();
        const utils = render(
            <KeyboardShortcutProvider>
                {node}
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        return { spy, ...utils };
    }

    it('does not fire from a SELECT', () => {
        const { spy, getByTestId } = renderWithTarget(
            <select data-testid="target" defaultValue="a">
                <option value="a">a</option>
            </select>,
        );
        fireEvent.keyDown(getByTestId('target'), { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not fire from role="searchbox" or role="textbox"', () => {
        const search = renderWithTarget(
            <div data-testid="target" role="searchbox" />,
        );
        fireEvent.keyDown(search.getByTestId('target'), { key: 'k' });
        expect(search.spy).not.toHaveBeenCalled();
        search.unmount();

        const textbox = renderWithTarget(
            <div data-testid="target" role="textbox" />,
        );
        fireEvent.keyDown(textbox.getByTestId('target'), { key: 'k' });
        expect(textbox.spy).not.toHaveBeenCalled();
    });

    it('does not fire when the target reports isContentEditable', () => {
        // `isContentEditable` is the FIRST editable signal the guard
        // consults and the one a real browser sets for every rich-text
        // host (policy editor, task comment box). jsdom never computes it
        // — it has no editing-host model — so the production-primary
        // branch is only reachable by defining the property. Losing it
        // would let every global shortcut fire mid-sentence.
        const { spy, getByTestId } = renderWithTarget(
            <div data-testid="target" />,
        );
        const el = getByTestId('target');
        Object.defineProperty(el, 'isContentEditable', {
            value: true,
            configurable: true,
        });
        fireEvent.keyDown(el, { key: 'k' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('DOES fire from contenteditable="false"', () => {
        // The attribute is present but explicitly disabled — treating it
        // as editable would make every shortcut dead inside a read-only
        // rich-text surface (policy viewer, evidence preview).
        const { spy, getByTestId } = renderWithTarget(
            <div data-testid="target" contentEditable={false} />,
        );
        fireEvent.keyDown(getByTestId('target'), { key: 'k' });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('DOES fire from a non-input role such as role="button"', () => {
        const { spy, getByTestId } = renderWithTarget(
            <div data-testid="target" role="button" tabIndex={0} />,
        );
        fireEvent.keyDown(getByTestId('target'), { key: 'k' });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('DOES fire from a plain element with no role at all', () => {
        const { spy, getByTestId } = renderWithTarget(
            <div data-testid="target" />,
        );
        fireEvent.keyDown(getByTestId('target'), { key: 'k' });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ─── Keystrokes that match nothing ─────────────────────────────────────

describe('KeyboardShortcutProvider — non-matching keystrokes', () => {
    it('leaves an unrelated keystroke entirely alone', () => {
        // The dispatcher walks every registration before it decides. A
        // regression that stopped skipping the non-matching ones would
        // make the FIRST registered shortcut answer for every key on the
        // keyboard — and, worse, swallow the keystroke via
        // preventDefault, so typing would stop working page-wide.
        const spy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="k" onHit={spy} />
            </KeyboardShortcutProvider>,
        );
        const event = dispatchKey('j');
        expect(spy).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('does not let a LATER-registered non-matching entry steal the keystroke', () => {
        // Registration order is load-bearing here and the reason this
        // case is separate from the one above. Ties break LIFO, so a
        // non-matching entry registered LAST is the one that would win
        // if the "matched nothing" skip stopped skipping — an
        // order-dependent hijack that a first-registered decoy hides.
        const jSpy = jest.fn();
        const kSpy = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <Binding keys="j" onHit={jSpy} />
                <Binding keys="k" onHit={kSpy} />
            </KeyboardShortcutProvider>,
        );
        const event = dispatchKey('j');
        expect(jSpy).toHaveBeenCalledTimes(1);
        expect(kSpy).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });
});

// ─── Unregistration while the provider stays mounted ───────────────────

describe('KeyboardShortcutProvider — registry drains', () => {
    it('removes a child binding without unmounting the provider', () => {
        // The sibling suite unmounts the whole tree, which also removes
        // the window listener — so it cannot see an `unregister` that
        // fails to delete. This one keeps the provider (and its
        // listener) alive.
        const spy = jest.fn();
        function Tree({ show }: { show: boolean }) {
            return (
                <KeyboardShortcutProvider>
                    {show ? <Binding keys="k" onHit={spy} /> : null}
                    <div data-testid="anchor" />
                </KeyboardShortcutProvider>
            );
        }
        const { rerender, getByTestId } = render(<Tree show />);
        dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);

        rerender(<Tree show={false} />);
        expect(getByTestId('anchor')).toBeInTheDocument();

        const event = dispatchKey('k');
        expect(spy).toHaveBeenCalledTimes(1);
        // With an empty registry nothing may claim the keystroke —
        // preventDefault stays off so the browser default survives.
        expect(event.defaultPrevented).toBe(false);
    });
});

// ─── Handler freshness (the "ref-as-mailbox") ──────────────────────────

describe('useKeyboardShortcut — handler freshness', () => {
    it('dispatches to the LATEST handler without re-registering the entry', () => {
        // The entry stored in the registry closes over a REF, not over
        // the handler passed on the render that registered it, and the
        // registration effect deliberately does not depend on `handler`.
        // Capturing the handler directly instead would keep calling the
        // first render's closure — a stale-state bug that reads as "the
        // shortcut works but acts on yesterday's data". Re-registering on
        // every render would fix staleness but thrash the registry (and
        // move the entry to the back of the LIFO tiebreak), so BOTH halves
        // are asserted here: newest handler, same registration id.
        const first = jest.fn();
        const second = jest.fn();
        const ids: string[] = [];

        function IdProbe() {
            for (const s of useRegisteredShortcuts()) ids.push(s.id);
            return null;
        }

        function Tree({ onHit }: { onHit: () => void }) {
            return (
                <KeyboardShortcutProvider>
                    <Binding keys="k" onHit={onHit} />
                    <IdProbe />
                </KeyboardShortcutProvider>
            );
        }

        const { rerender } = render(<Tree onHit={first} />);
        dispatchKey('k');
        expect(first).toHaveBeenCalledTimes(1);
        const idAfterMount = ids[ids.length - 1];

        rerender(<Tree onHit={second} />);
        dispatchKey('k');

        expect(second).toHaveBeenCalledTimes(1);
        // The stale closure would have been called a second time.
        expect(first).toHaveBeenCalledTimes(1);
        // …and the binding was never torn down and re-added.
        expect(ids[ids.length - 1]).toBe(idAfterMount);
    });
});

// ─── Palette snapshot identity ─────────────────────────────────────────

describe('useRegisteredShortcuts — snapshot identity', () => {
    const seen: RegisteredShortcut[][] = [];

    function Probe() {
        const list = useRegisteredShortcuts();
        seen.push(list);
        return <span data-testid="count">{list.length}</span>;
    }

    beforeEach(() => {
        seen.length = 0;
    });

    function latest(): RegisteredShortcut[] {
        expect(seen.length).toBeGreaterThan(0);
        return seen[seen.length - 1];
    }

    function Tree({
        description,
        priority,
        keys,
    }: {
        description: string;
        priority: number;
        keys: string[];
    }) {
        return (
            <KeyboardShortcutProvider>
                <Binding
                    keys={keys}
                    onHit={() => {}}
                    options={{ description, priority }}
                />
                <Probe />
            </KeyboardShortcutProvider>
        );
    }

    it('returns the SAME array across a re-render that changed nothing', () => {
        // useSyncExternalStore re-bails on an unstable snapshot identity;
        // a regression here is an infinite render loop in the palette.
        const { rerender } = render(
            <Tree description="Open palette" priority={0} keys={['mod+k']} />,
        );
        const before = latest();
        rerender(
            <Tree description="Open palette" priority={0} keys={['mod+k']} />,
        );
        const after = latest();
        expect(after).toBe(before);
        expect(after).toHaveLength(1);
    });

    // NOTE — there is deliberately no "returns a FRESH array when <field>
    // changed" test in this block, and one must not be added. Every field the
    // snapshot exposes (id / keys / priority / scope / description) is a dep of
    // the registration `useEffect`, so changing any of them makes the effect
    // unregister and then re-register. The notify in between reads a registry
    // that is one entry SHORT, so the cache is already invalidated by the outer
    // `prev.length === next.length` check before the per-entry predicate is ever
    // the deciding comparison. Five such tests were written here and deleted:
    // removing the ENTIRE per-entry predicate from `getStable` left all five
    // green. They named a clause they could not reach.
    //
    // The per-entry predicate is reachable only in its TRUE direction — the
    // "changed nothing" test above — because `snapshot()` allocates a fresh
    // array on every call, so array identity alone can never be the answer.

    it('maps the entry priority into the palette snapshot', () => {
        // `priority` is the one snapshot field no other suite reads: the
        // pre-existing palette test renders `keys — description — scope`, and
        // the precedence tests observe priority only indirectly, through which
        // handler fires. Hardcode `priority` in `snapshot()` and this is the
        // only assertion in the repo that notices.
        render(
            <Tree description="Open palette" priority={7} keys={['mod+k']} />,
        );
        expect(latest()[0].priority).toBe(7);
    });

    it('returns an empty list — not a throw — outside any provider', () => {
        render(<Probe />);
        const list = latest();
        expect(list).toStrictEqual([]);
        expect(list).toHaveLength(0);
    });
});
