/** @jest-environment jsdom */

/**
 * `<EntityPrevNextNav>` — the up/down record stepper beside a detail-page name.
 *
 * Two invariants, both of which were broken or latent before this suite:
 *
 * 1. It RENDERS when given real list ids. The component was never deleted —
 *    it hid itself because its caller fed it `[]` after `/assets` changed
 *    response shape. The retired structural guard asserted only that the
 *    source still *mentioned* the component, so it passed 3/3 the whole time
 *    the feature was dead. These assertions fail instead.
 *
 * 2. Its keyboard binding requires ALT. `useKeyboardShortcut` defaults
 *    `preventDefault` to true and binds on `window`, so a bare ArrowUp/Down
 *    binding would stop the arrow keys scrolling the detail page. That was
 *    invisible while the component rendered nothing.
 *
 * 3. Its labels come from the message catalog, per locale. Both halves used
 *    to be built as `Previous ${labelSingular}` in source, so a Bulgarian UI
 *    announced "Previous policy" over an otherwise fully translated page.
 *    The fix cannot be a single interpolated `"Предишен {entity}"` either:
 *    Bulgarian adjectives agree in gender, so the feminine nouns политика
 *    (policy) and задача (task) need Предиш*на* / Следва*ща*. The
 *    table-driven bg assertions below fail for BOTH the English-only build
 *    and the naive single-template build.
 */

import { fireEvent, render, within } from '@testing-library/react';
import * as React from 'react';

import {
    EntityPrevNextNav,
    STEPPER_ENTITIES,
} from '@/components/ui/entity-prev-next-nav';
import {
    KeyboardShortcutProvider,
    useRegisteredShortcuts,
} from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';
import { idsFromCappedList } from '@/lib/list-backfill-cap';

/**
 * Locale the local `next-intl` mock resolves against. A ref object (not a
 * bare `let`) because the mock factory is hoisted above every declaration in
 * this file — reading `.current` lazily, from inside `useTranslations`, is
 * what keeps it out of the temporal dead zone.
 */
const mockLocale: { current: 'en' | 'bg' } = { current: 'en' };

/**
 * Why a LOCAL mock rather than the repo-wide `__mocks__/next-intl.js`:
 *
 *   • the shared one is hard-wired to `messages/en.json`, and half the point
 *     of this suite is asserting the Bulgarian rendering;
 *   • it also hands back a FRESH `t` on every `useTranslations()` call. Any
 *     consumer that feeds `t` (or a value derived from it) into a hook
 *     dependency then re-registers on every render, and the suite TIMES OUT
 *     rather than failing — a slow, confusing way to find out. Memoising one
 *     `t` per (locale, namespace) makes the identity stable.
 */
jest.mock('next-intl', () => {
    const catalogs: Record<string, unknown> = {
        en: jest.requireActual('../../messages/en.json'),
        bg: jest.requireActual('../../messages/bg.json'),
    };
    type Translator = ((key: string) => string) & { has: (key: string) => boolean };
    const build = (locale: string, ns: string): Translator => {
        const resolve = (key: string): unknown =>
            `${ns}.${key}`
                .split('.')
                .reduce<unknown>(
                    (o, k) =>
                        o && typeof o === 'object'
                            ? (o as Record<string, unknown>)[k]
                            : undefined,
                    catalogs[locale],
                );
        return Object.assign(
            (key: string) => {
                const v = resolve(key);
                return typeof v === 'string' ? v : key;
            },
            { has: (key: string) => typeof resolve(key) === 'string' },
        );
    };
    const cache = new Map<string, Translator>();
    return {
        useTranslations: (ns: string): Translator => {
            const cacheKey = `${mockLocale.current}:${ns}`;
            let t = cache.get(cacheKey);
            if (!t) {
                t = build(mockLocale.current, ns);
                cache.set(cacheKey, t);
            }
            return t;
        },
        useLocale: () => mockLocale.current,
    };
});

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: mockReplace,
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

const hrefFor = (id: string) => `/t/acme/assets/${id}`;

function mount(ids: string[], currentId: string, labelSingular = 'asset') {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityPrevNextNav
                    ids={ids}
                    currentId={currentId}
                    hrefFor={hrefFor}
                    labelSingular={labelSingular}
                />
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

beforeEach(() => {
    mockReplace.mockClear();
    mockLocale.current = 'en';
});

describe('EntityPrevNextNav — renders for a real list payload', () => {
    // The exact envelope `/assets` returns today. Feeding the component ids
    // derived from it is the assertion that would have failed on dd0a9127e.
    const payload = {
        rows: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        truncated: false,
    };

    it('mounts both steppers for a mid-list record', () => {
        const ids = idsFromCappedList(payload);
        const { queryByTestId } = mount(ids, 'a2');
        expect(queryByTestId('entity-prev-next-nav')).not.toBeNull();
        expect(queryByTestId('entity-nav-prev')).not.toBeNull();
        expect(queryByTestId('entity-nav-next')).not.toBeNull();
    });

    it('steps to the previous and next neighbour in list order', () => {
        const ids = idsFromCappedList(payload);
        const { getByTestId } = mount(ids, 'a2');

        fireEvent.click(getByTestId('entity-nav-prev'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.click(getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });

    it('disables the ends rather than wrapping around', () => {
        const ids = idsFromCappedList(payload);
        const first = mount(ids, 'a1');
        expect(first.getByTestId('entity-nav-prev').hasAttribute('disabled')).toBe(true);
        expect(first.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(false);
        first.unmount();

        const last = mount(ids, 'a3');
        expect(last.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(true);
    });

    it('hides itself when there is nothing to step through', () => {
        expect(mount(idsFromCappedList({ rows: [{ id: 'only' }], truncated: false }), 'only')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
        // Current id outside the loaded window — arrows would point nowhere.
        expect(mount(['a1', 'a2'], 'not-in-list')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
    });
});

describe('EntityPrevNextNav — arrow keys need alt, so the page still scrolls', () => {
    const ids = ['a1', 'a2', 'a3'];

    it('ignores a BARE ArrowUp/ArrowDown', () => {
        mount(ids, 'a2');
        fireEvent.keyDown(window, { key: 'ArrowUp' });
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does not preventDefault a bare ArrowDown — that is the page scroll', () => {
        mount(ids, 'a2');
        const evt = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
    });

    it('navigates on alt+ArrowUp / alt+ArrowDown', () => {
        mount(ids, 'a2');

        fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });
});


// A probe that RENDERS whatever the shortcut registry currently holds. The
// keyboard `description` never reaches the nav's own markup, so it is
// invisible to any query over that — but a probe can put it somewhere
// queryable, which is how tests/rendered/keyboard-shortcut-hook.test.tsx
// introspects the registry. Rendering beats reassigning a module-scope
// binding from inside a component, which the React Compiler rule refuses.
function ShortcutProbe() {
    const list = useRegisteredShortcuts();
    return (
        <ul data-testid="shortcut-registry">
            {list.map((s) => (
                <li key={s.id}>{s.description ?? '(none)'}</li>
            ))}
        </ul>
    );
}

function mountWithProbe(labelSingular: string) {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityPrevNextNav
                    ids={['a1', 'a2', 'a3']}
                    currentId="a2"
                    hrefFor={hrefFor}
                    labelSingular={labelSingular}
                />
                <ShortcutProbe />
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

describe('EntityPrevNextNav — labels come from the catalog, per locale', () => {
    const ids = ['a1', 'a2', 'a3'];

    // Scoped to the render's own container, not document.body: a test that
    // mounts several variants in one body would otherwise trip RTL's
    // "found multiple elements" error instead of comparing labels.
    const labels = (r: ReturnType<typeof mount>) => {
        const q = within(r.container);
        return {
            prev: q.getByTestId('entity-nav-prev').getAttribute('aria-label'),
            next: q.getByTestId('entity-nav-next').getAttribute('aria-label'),
        };
    };

    it('renders the English catalog phrases', () => {
        expect(labels(mount(ids, 'a2', 'asset'))).toEqual({
            prev: 'Previous asset',
            next: 'Next asset',
        });
    });

    // EVERY entity a detail page passes today, in both directions, across all
    // THREE Bulgarian genders. The masculine rows would survive a naive
    // `"Предишен {entity}"` template; the feminine and neuter rows are what
    // make an interpolated adjective impossible, so they are the load-bearing
    // cases:
    //
    //   m  -ен / -ащ    актив, контрол, инцидент, риск, доставчик,
    //                   цикъл, пакет, преглед, анализ
    //   f  -на / -аща   политика, задача, рамка
    //   n  -но / -ащо   изпълнение          ← only one, and the easiest to miss
    //
    // The neuter row arrived with the audit/framework wave and was NOT covered
    // here at the time; it is the form a native speaker would catch and a
    // catalog diff would not.
    it.each([
        ['asset', 'Предишен актив', 'Следващ актив'],
        ['control', 'Предишен контрол', 'Следващ контрол'],
        ['incident', 'Предишен инцидент', 'Следващ инцидент'],
        ['risk', 'Предишен риск', 'Следващ риск'],
        ['vendor', 'Предишен доставчик', 'Следващ доставчик'],
        ['cycle', 'Предишен цикъл', 'Следващ цикъл'],
        ['pack', 'Предишен пакет', 'Следващ пакет'],
        ['accessReview', 'Предишен преглед на достъпа', 'Следващ преглед на достъпа'],
        ['bia', 'Предишен анализ', 'Следващ анализ'],
        ['policy', 'Предишна политика', 'Следваща политика'],
        ['task', 'Предишна задача', 'Следваща задача'],
        ['framework', 'Предишна рамка', 'Следваща рамка'],
        ['testRun', 'Предишно изпълнение', 'Следващо изпълнение'],
    ])('renders gender-agreeing Bulgarian for %s', (entity, prev, next) => {
        mockLocale.current = 'bg';
        expect(labels(mount(ids, 'a2', entity))).toEqual({ prev, next });
    });

    it('falls back to the generic record phrase for an unregistered entity', () => {
        mockLocale.current = 'bg';
        expect(labels(mount(ids, 'a2', 'sprocket'))).toEqual({
            prev: 'Предишен запис',
            next: 'Следващ запис',
        });
    });

    it('resolves to real Cyrillic prose, never a raw catalog key', () => {
        // Two ways a keyed implementation goes wrong without the exact-string
        // assertions above noticing a NEW entity: the label falls through to
        // the dotted key (`previous.sprocket`), or it never leaves English.
        // Both are caught here for any entity, known or not.
        mockLocale.current = 'bg';
        for (const entity of ['policy', 'task', 'sprocket']) {
            const { prev, next } = labels(mount(ids, 'a2', entity));
            for (const label of [prev, next]) {
                expect(label).not.toMatch(/recordStepper|previous\.|next\./);
                expect(label).toMatch(/^[\u0400-\u04FF ]+$/);
            }
        }
    });

    it('localises the keyboard-shortcut descriptions too', () => {
        mockLocale.current = 'bg';
        const r = mountWithProbe('task');
        const probe = within(r.container).getByTestId('shortcut-registry');
        const descriptions = Array.from(probe.querySelectorAll('li'))
            .map((li) => li.textContent)
            .sort();
        expect(descriptions).toEqual(['Предишна задача', 'Следваща задача']);
    });

    it('sources the task noun from the record-stepper catalog, not nav.tasks', () => {
        // `nav.tasks` is "План" — a repurposed sidebar label meaning *Plan*.
        // Wrong word, wrong gender. Reaching for it is the tempting shortcut
        // this assertion forecloses.
        const bg = jest.requireActual('../../messages/bg.json') as {
            nav: Record<string, string>;
            ui: { recordStepper: Record<string, Record<string, string>> };
        };
        expect(bg.nav.tasks).toBe('План');
        expect(bg.ui.recordStepper.previous.task).toBe('Предишна задача');
        expect(bg.ui.recordStepper.next.task).toBe('Следваща задача');
    });
});


// The component gates on a local slug set instead of probing the catalog with
// `t.has`, so the set and the catalogs have to be pinned to each other from
// BOTH directions — otherwise the gate silently drops an entity ("item" for a
// reader who should have seen "Предишна политика") or an added catalog phrase
// never gets used.
describe('the stepper entity set and the catalogs agree', () => {
    const en = require('../../messages/en.json') as Record<string, never>;
    const bg = require('../../messages/bg.json') as Record<string, never>;
    const stepper = (m: Record<string, never>) =>
        (m as unknown as {
            ui: { recordStepper: Record<'previous' | 'next', Record<string, string>> };
        }).ui.recordStepper;

    it.each(['previous', 'next'] as const)(
        'every registered entity has a %s phrase in en AND bg',
        (direction) => {
            const missing: string[] = [];
            for (const slug of [...STEPPER_ENTITIES, 'item']) {
                if (!stepper(en)[direction][slug]) missing.push(`en.${direction}.${slug}`);
                if (!stepper(bg)[direction][slug]) missing.push(`bg.${direction}.${slug}`);
            }
            expect(missing).toEqual([]);
        },
    );

    it('every catalog phrase belongs to a registered entity', () => {
        const registered = new Set([...STEPPER_ENTITIES, 'item']);
        const orphans = ['previous', 'next'].flatMap((d) =>
            Object.keys(stepper(en)[d as 'previous']).filter((k) => !registered.has(k)),
        );
        expect(orphans).toEqual([]);
    });

    it('en and bg carry the same keys', () => {
        for (const direction of ['previous', 'next'] as const) {
            expect(Object.keys(stepper(bg)[direction]).sort()).toEqual(
                Object.keys(stepper(en)[direction]).sort(),
            );
        }
    });
});
