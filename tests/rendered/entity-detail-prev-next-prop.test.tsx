/** @jest-environment jsdom */

/**
 * `<EntityDetailLayout prevNext>` — the shell composes the record stepper
 * beside the title.
 *
 * The prop exists so the 13 detail pages due to mount this nav do not each
 * hand-roll `<span className="inline-flex …">{title}<EntityPrevNextNav/></span>`.
 * The one page that DID hand-roll it is also the page where it silently broke,
 * so the composition is worth owning in one place.
 *
 * The nav must ride WITH the title through loading/error/empty suppression —
 * arrows flashing beside an empty heading while the entity loads is the
 * regression this locks.
 *
 * It must ALSO stay out of the <h1>. Per the accname spec a control's
 * aria-label inside a heading is concatenated into the HEADING's accessible
 * name, so nesting made Chromium announce the page title as
 * "Laptop 001 Previous asset Next asset". That one cannot be caught by
 * accessible-name assertions here: dom-accessibility-api deliberately skips
 * accname step 2C for descendant controls, so testing-library reports the
 * bare title either way and a nesting regression would sail through. The
 * containment assertion below is the thing that actually holds the line.
 *
 * The last case checks the third property of the composition: the stepper's
 * labels are catalog-resolved, and that survives the shell. `prevNext`
 * carries the entity KEY (`'asset'`, `'policy'`), so nothing here depends on
 * the shell's prop shape — only on the key reaching the nav intact.
 */

import { render, within } from '@testing-library/react';
import * as React from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Locale the local `next-intl` mock resolves against. A ref object rather
 * than a bare `let` — the factory below is hoisted above every declaration
 * in this file, so `.current` must be read lazily, at render time.
 */
const mockLocale: { current: 'en' | 'bg' } = { current: 'en' };

/**
 * Local `next-intl` mock. The repo-wide `__mocks__/next-intl.js` is pinned to
 * `messages/en.json` (this suite needs bg too) and returns a FRESH `t` from
 * every `useTranslations()` call — a consumer that feeds `t` output into a
 * hook dependency then re-registers forever and the suite TIMES OUT instead
 * of failing. One memoised `t` per (locale, namespace) removes both hazards.
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

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/assets/a2',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

const PREV_NEXT = {
    ids: ['a1', 'a2', 'a3'],
    currentId: 'a2',
    hrefFor: (id: string) => `/t/acme/assets/${id}`,
    labelSingular: 'asset',
};

function mount(extra: Record<string, unknown> = {}) {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityDetailLayout
                    title={<span>Laptop 001</span>}
                    prevNext={PREV_NEXT}
                    {...extra}
                >
                    <div>body</div>
                </EntityDetailLayout>
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

beforeEach(() => {
    mockLocale.current = 'en';
});

describe('EntityDetailLayout prevNext', () => {
    it('renders the stepper beside the title', () => {
        const { queryByTestId, getByText } = mount();
        expect(getByText('Laptop 001')).toBeTruthy();
        expect(queryByTestId('entity-prev-next-nav')).not.toBeNull();
        expect(queryByTestId('entity-nav-prev')).not.toBeNull();
        expect(queryByTestId('entity-nav-next')).not.toBeNull();
    });

    it('omits the stepper entirely when the prop is not passed', () => {
        const { queryByTestId } = render(
            <TooltipProvider delayDuration={0}>
                <KeyboardShortcutProvider>
                    <EntityDetailLayout title={<span>Laptop 001</span>}>
                        <div>body</div>
                    </EntityDetailLayout>
                </KeyboardShortcutProvider>
            </TooltipProvider>,
        );
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper while loading, with the title', () => {
        const { queryByTestId, queryByText } = mount({ loading: true });
        expect(queryByText('Laptop 001')).toBeNull();
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper in the error state', () => {
        const { queryByTestId } = mount({ error: 'Could not load asset.' });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('suppresses the stepper in the empty state', () => {
        const { queryByTestId } = mount({ empty: { message: 'Not found.' } });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('keeps the stepper OUT of the <h1> — its buttons must not join the heading name', () => {
        const { container } = mount();

        const heading = container.querySelector('h1');
        expect(heading).not.toBeNull();
        // The nav renders...
        expect(
            container.querySelector('[data-testid="entity-prev-next-nav"]'),
        ).not.toBeNull();
        // ...but NOT inside the heading. Nesting it there folds
        // "Previous asset" / "Next asset" into the h1's accessible name in
        // every real browser.
        expect(
            heading!.querySelector('[data-testid="entity-prev-next-nav"]'),
        ).toBeNull();
        expect(heading!.querySelector('button')).toBeNull();
    });

    it('leaves the heading text to the title alone', () => {
        const { container } = mount();
        // jsdom's accessible-name impl would pass even if the buttons were
        // nested, so assert on the heading's own text content instead.
        expect(container.querySelector('h1')!.textContent).toBe('Laptop 001');
    });

    it('still hides itself when the id list has nothing to step through', () => {
        const { queryByTestId } = mount({
            prevNext: { ...PREV_NEXT, ids: ['only'], currentId: 'only' },
        });
        expect(queryByTestId('entity-prev-next-nav')).toBeNull();
    });

    it('carries the entity key through to catalog-resolved, localised labels', () => {
        // `labelSingular` is a key under `ui.recordStepper`, so the shell can
        // keep forwarding the same lowercase slugs the detail pages already
        // pass. Bulgarian is the proof the phrase is looked up rather than
        // built from an English template — and `policy` is feminine
        // (политика), so an interpolated adjective would read "Предишен
        // политика" here.
        mockLocale.current = 'bg';
        const { container } = mount({
            prevNext: { ...PREV_NEXT, labelSingular: 'policy' },
        });
        const q = within(container);
        expect(q.getByTestId('entity-nav-prev').getAttribute('aria-label')).toBe(
            'Предишна политика',
        );
        expect(q.getByTestId('entity-nav-next').getAttribute('aria-label')).toBe(
            'Следваща политика',
        );
    });
});
