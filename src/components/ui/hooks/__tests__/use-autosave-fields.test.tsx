/**
 * `useAutosaveFields` — the debounced autosave engine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The engine used to be copy-pasted into `ControlEditPanel` and
 * `TaskEditPanel`, and the only thing verifying it was
 *
 *     expect(src).toMatch(/setTimeout\(\(\) => void commitFields\(\), \d+\)/)
 *
 * asserted against EACH file separately in
 * `tests/guards/controls-quickview-interaction.test.ts`. That assertion
 * required the duplication in order to pass — extracting the shared hook
 * broke both copies of it. It also verified nothing about the behaviour: it
 * would have passed on a debounce that never fired, one that fired against a
 * stale closure, or one that leaked a timer past unmount.
 *
 * These are the assertions that regex was standing in for. The guard now
 * checks only that the panels DELEGATE here.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';

import { useAutosaveFields } from '@/components/ui/hooks';

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

type Fields = { name: string; category: string };

const SEED: Fields = { name: 'Access review', category: 'ORGANIZATIONAL' };

/** Advance past the debounce and let the resulting promise settle. */
async function flushDebounce(ms = 800) {
    await act(async () => {
        jest.advanceTimersByTime(ms);
    });
}

describe('debounce', () => {
    it('does not save until the debounce elapses', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'Access review v2' }));
        // The whole point of the debounce: mid-typing, nothing has been sent.
        await act(async () => {
            jest.advanceTimersByTime(799);
        });
        expect(save).not.toHaveBeenCalled();

        await flushDebounce(1);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of keystrokes into ONE save carrying the LAST value', async () => {
        // The stale-closure trap: a naive implementation reads React state
        // inside the timer callback and PATCHes whatever was current when the
        // timer was armed — i.e. the first keystroke, not the last.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'A' }));
        act(() => result.current.update({ name: 'AB' }));
        act(() => result.current.update({ name: 'ABC' }));

        await flushDebounce();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({ name: 'ABC', category: 'ORGANIZATIONAL' });
    });

    it('an immediate update saves at once and cancels the pending debounce', async () => {
        // Type, then pick from a dropdown: the dropdown commits now, and the
        // typed value must not then be sent a second time by the old timer.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'Typed' }));
        await act(async () => {
            result.current.update({ category: 'PEOPLE' }, true);
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({ name: 'Typed', category: 'PEOPLE' });

        await flushDebounce();
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('commitNow flushes the pending debounce exactly once (blur after typing)', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'Blurred' }));
        await act(async () => {
            result.current.commitNow();
        });
        await flushDebounce();

        expect(save).toHaveBeenCalledTimes(1);
    });

    it('honours a custom debounce window', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save,
                networkErrorMessage: 'offline',
                debounceMs: 200,
            }),
        );

        act(() => result.current.update({ name: 'Quick' }));
        await flushDebounce(200);
        expect(save).toHaveBeenCalledTimes(1);
    });
});

describe('unmount', () => {
    it('does not save after the component is gone', async () => {
        // A panel closed mid-debounce firing a PATCH is both a wasted write
        // and a setState-after-unmount warning.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, unmount } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'Abandoned' }));
        unmount();
        await flushDebounce();

        expect(save).not.toHaveBeenCalled();
    });
});

describe('status machine', () => {
    it('walks idle → saving → saved', async () => {
        let release: (() => void) | undefined;
        const save = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = () => resolve();
                }),
        );
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        expect(result.current.state).toBe('idle');
        act(() => result.current.update({ name: 'Pending' }));
        await flushDebounce();
        expect(result.current.state).toBe('saving');

        await act(async () => {
            release?.();
        });
        expect(result.current.state).toBe('saved');
        expect(result.current.error).toBe('');
    });

    it('surfaces a returned message as an error without clearing the fields', async () => {
        const save = jest.fn().mockResolvedValue('Server said no');
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'Rejected' }));
        await flushDebounce();

        expect(result.current.state).toBe('error');
        expect(result.current.error).toBe('Server said no');
        // The user's typing survives a failed save — otherwise a transient
        // 500 silently discards their edit.
        expect(result.current.fields.name).toBe('Rejected');
    });

    it('uses the translated network message when save THROWS', async () => {
        // Never surface the raw Error ("Failed to fetch") — it is untranslated.
        const save = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'You are offline' }),
        );

        act(() => result.current.update({ name: 'Offline' }));
        await flushDebounce();

        expect(result.current.state).toBe('error');
        expect(result.current.error).toBe('You are offline');
    });

    it('clears a previous error when the next save starts', async () => {
        const save = jest
            .fn()
            .mockResolvedValueOnce('Server said no')
            .mockResolvedValueOnce(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        act(() => result.current.update({ name: 'First' }));
        await flushDebounce();
        expect(result.current.error).toBe('Server said no');

        act(() => result.current.update({ name: 'Second' }));
        await flushDebounce();
        expect(result.current.state).toBe('saved');
        expect(result.current.error).toBe('');
    });
});

describe('validate', () => {
    it('blocks the request and reports the message WITHOUT passing through saving', async () => {
        // Showing "Saving…" for a value that was never sent is a lie the old
        // inline copies specifically avoided; keep it that way.
        const save = jest.fn().mockResolvedValue(undefined);
        const states: string[] = [];
        const { result } = renderHook(() => {
            const api = useAutosaveFields<Fields>({
                seed: SEED,
                save,
                validate: (f) => (f.name.trim().length < 3 ? 'Too short' : null),
                networkErrorMessage: 'offline',
            });
            states.push(api.state);
            return api;
        });

        act(() => result.current.update({ name: 'ab' }));
        await flushDebounce();

        expect(save).not.toHaveBeenCalled();
        expect(result.current.state).toBe('error');
        expect(result.current.error).toBe('Too short');
        expect(states).not.toContain('saving');
    });

    it('lets a valid value through after an invalid one', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save,
                validate: (f) => (f.name.trim().length < 3 ? 'Too short' : null),
                networkErrorMessage: 'offline',
            }),
        );

        act(() => result.current.update({ name: 'ab' }));
        await flushDebounce();
        act(() => result.current.update({ name: 'abc' }));
        await flushDebounce();

        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.state).toBe('saved');
    });
});

describe('canCommit', () => {
    it('skips the save silently, leaving the status untouched', async () => {
        // A read-only viewer has nothing to report — the status line should
        // not read "Not saved".
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save,
                canCommit: () => false,
                networkErrorMessage: 'offline',
            }),
        );

        act(() => result.current.update({ name: 'Read only' }));
        await flushDebounce();

        expect(save).not.toHaveBeenCalled();
        expect(result.current.state).toBe('idle');
        expect(result.current.error).toBe('');
    });

    it('is read FRESH at commit time, not captured at render', async () => {
        // TaskEditPanel gates on a ref set by an async GET — a ref precisely
        // so it does not re-render. A boolean option would be captured stale
        // and every edit before the next render would be dropped.
        const save = jest.fn().mockResolvedValue(undefined);
        const loaded = { current: false };
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save,
                canCommit: () => loaded.current,
                networkErrorMessage: 'offline',
            }),
        );

        act(() => result.current.update({ name: 'Too early' }));
        await flushDebounce();
        expect(save).not.toHaveBeenCalled();

        // The GET lands. No re-render happens — only the ref flips.
        loaded.current = true;
        act(() => result.current.update({ name: 'Now allowed' }));
        await flushDebounce();
        expect(save).toHaveBeenCalledTimes(1);
    });
});

describe('re-seeding', () => {
    it('adopts a new seed — the panel can point at another row without remounting', async () => {
        // This is what replaced the `key={`qv-control-${id}`}` remount hack in
        // ControlsClient: mount-only seeding is why the caller had to force a
        // remount to show a different control.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook(
            ({ seed }: { seed: Fields }) =>
                useAutosaveFields<Fields>({ seed, save, networkErrorMessage: 'offline' }),
            { initialProps: { seed: SEED } },
        );

        rerender({ seed: { name: 'Backup policy', category: 'TECHNOLOGICAL' } });
        expect(result.current.fields).toEqual({
            name: 'Backup policy',
            category: 'TECHNOLOGICAL',
        });
    });

    it('does NOT re-seed on an equal seed object — typing survives a parent re-render', async () => {
        // The caller passes an object literal; identity changes every render.
        // Re-seeding on identity would wipe the field between keystrokes.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook(
            ({ seed }: { seed: Fields }) =>
                useAutosaveFields<Fields>({ seed, save, networkErrorMessage: 'offline' }),
            { initialProps: { seed: { ...SEED } } },
        );

        act(() => result.current.update({ name: 'Half-typed' }));
        rerender({ seed: { ...SEED } });

        expect(result.current.fields.name).toBe('Half-typed');
    });

    it('keeps "Saved" when the caller refetches and hands back our own values', async () => {
        // onSaved() triggers a list refetch, which returns the row we just
        // wrote. That echo is not a new row — resetting to idle there would
        // flicker "Saved" away the instant it appeared.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook(
            ({ seed }: { seed: Fields }) =>
                useAutosaveFields<Fields>({ seed, save, networkErrorMessage: 'offline' }),
            { initialProps: { seed: SEED } },
        );

        act(() => result.current.update({ name: 'Renamed' }));
        await flushDebounce();
        expect(result.current.state).toBe('saved');

        rerender({ seed: { name: 'Renamed', category: 'ORGANIZATIONAL' } });
        expect(result.current.state).toBe('saved');
    });

    it('treats the server TRIMMING our value as the same echo', async () => {
        // Callers trim before writing (`name: f.name.trim()`), so the refetch
        // returns "Renamed" for what we hold as "Renamed ". Comparing raw
        // would read that as a different row and reset the status.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook(
            ({ seed }: { seed: Fields }) =>
                useAutosaveFields<Fields>({ seed, save, networkErrorMessage: 'offline' }),
            { initialProps: { seed: SEED } },
        );

        act(() => result.current.update({ name: 'Renamed ' }));
        await flushDebounce();
        expect(result.current.state).toBe('saved');

        rerender({ seed: { name: 'Renamed', category: 'ORGANIZATIONAL' } });
        expect(result.current.state).toBe('saved');
        expect(result.current.fields.name).toBe('Renamed ');
    });

    it('resets a stale error when a different row is seeded in', async () => {
        const save = jest.fn().mockResolvedValue('Server said no');
        const { result, rerender } = renderHook(
            ({ seed }: { seed: Fields }) =>
                useAutosaveFields<Fields>({ seed, save, networkErrorMessage: 'offline' }),
            { initialProps: { seed: SEED } },
        );

        act(() => result.current.update({ name: 'Broken' }));
        await flushDebounce();
        expect(result.current.state).toBe('error');

        rerender({ seed: { name: 'Another control', category: 'PEOPLE' } });
        expect(result.current.state).toBe('idle');
        expect(result.current.error).toBe('');
    });
});

describe('run — sibling endpoints share the status line', () => {
    it('reports success through the same state', async () => {
        // Owner / assignee / status each POST to their own endpoint but
        // report in the panel's single "Saving…/Saved" line.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({ seed: SEED, save, networkErrorMessage: 'offline' }),
        );

        await act(async () => {
            await result.current.run(async () => undefined);
        });
        expect(result.current.state).toBe('saved');
        expect(save).not.toHaveBeenCalled();
    });

    it('reports a returned message as an error', async () => {
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save: jest.fn().mockResolvedValue(undefined),
                networkErrorMessage: 'offline',
            }),
        );

        await act(async () => {
            await result.current.run(async () => 'Owner update failed');
        });
        expect(result.current.state).toBe('error');
        expect(result.current.error).toBe('Owner update failed');
    });

    it('reports a throw as the network message', async () => {
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save: jest.fn().mockResolvedValue(undefined),
                networkErrorMessage: 'You are offline',
            }),
        );

        await act(async () => {
            await result.current.run(async () => {
                throw new Error('Failed to fetch');
            });
        });
        expect(result.current.state).toBe('error');
        expect(result.current.error).toBe('You are offline');
    });

    it('ignores canCommit and validate — a sibling endpoint has its own rules', async () => {
        // `run` is for saves the field validator knows nothing about.
        const { result } = renderHook(() =>
            useAutosaveFields<Fields>({
                seed: SEED,
                save: jest.fn().mockResolvedValue(undefined),
                validate: () => 'Field is invalid',
                canCommit: () => false,
                networkErrorMessage: 'offline',
            }),
        );

        const operation = jest.fn().mockResolvedValue(undefined);
        await act(async () => {
            await result.current.run(operation);
        });
        expect(operation).toHaveBeenCalledTimes(1);
        expect(result.current.state).toBe('saved');
    });
});

describe('wired into a real input', () => {
    function Panel({ save }: { save: (f: Fields) => Promise<string | void> }) {
        const { fields, state, update, commitNow } = useAutosaveFields<Fields>({
            seed: SEED,
            save,
            networkErrorMessage: 'offline',
        });
        return (
            <div>
                <input
                    aria-label="name"
                    value={fields.name}
                    onChange={(e) => update({ name: e.target.value })}
                    onBlur={commitNow}
                />
                <span data-testid="status">{state}</span>
            </div>
        );
    }

    it('types into a controlled input, blurs, and saves the typed value once', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { getByLabelText, getByTestId } = render(<Panel save={save} />);
        const input = getByLabelText('name') as HTMLInputElement;

        fireEvent.change(input, { target: { value: 'Renamed control' } });
        expect(input.value).toBe('Renamed control');

        await act(async () => {
            fireEvent.blur(input);
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({
            name: 'Renamed control',
            category: 'ORGANIZATIONAL',
        });
        await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
    });
});
