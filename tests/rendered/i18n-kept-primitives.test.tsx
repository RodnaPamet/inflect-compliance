/** @jest-environment jsdom */

/**
 * The shared UI primitives render their built-in copy in the viewer's locale.
 *
 * Every label below used to be an English literal inside the component — a
 * JSX text node, an `aria-label="…"`, or a parameter default such as
 * `ariaLabel = 'Options'`. Those render English on a Bulgarian page, and no
 * catalogue check can see them, because they never reach the catalogue. They
 * are catalogue keys now; this suite is what proves the keys are real.
 *
 * It matters beyond inflect: a downstream product copies these files
 * byte-identical and rejects English in JSX text and copy attributes, so a
 * literal left here is a local diff there.
 *
 * Each case renders a primitive with NO caller copy, so every label comes
 * from the component's own default, then asserts:
 *
 *   • under `en`, the exact sentence the file hard-coded before — the
 *     English UI is unchanged, so every English assertion elsewhere holds;
 *   • under `bg`, a Cyrillic label that differs from the English one. A
 *     missing bg key, a key read from the wrong namespace (which resolves to
 *     the raw key) or a leftover literal all fail here.
 *
 * Several of these files call `t("…")` with double quotes, which
 * `tests/guards/i18n-keys-resolve.test.ts` does not read (it matches
 * single-quoted calls only), so this suite is the check that their keys
 * resolve at all.
 *
 * Why a LOCAL `next-intl` mock: the repo-wide `__mocks__/next-intl.js` is
 * hard-wired to en.json, and it hands back a fresh `t` per call. This one
 * resolves against either catalogue and memoises one translator per
 * (locale, namespace), so a `t` in a hook dependency cannot loop a render.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { useTranslations } from 'next-intl';

import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { UserMenu } from '@/components/layout/user-menu';
import { NavBarBrand, NavBarMobileMenu } from '@/components/layout/nav-bar';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Combobox } from '@/components/ui/combobox';
import { AleHistogram } from '@/components/ui/charts/ale-histogram';
import { GanttChart } from '@/components/ui/charts/gantt-chart';
import { LineChart } from '@/components/ui/charts/line-chart';
import { LossExceedanceCurve } from '@/components/ui/charts/loss-exceedance-curve';
import { RadarChart } from '@/components/ui/charts/radar-chart';
import { chartReady } from '@/components/ui/charts/types';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Popover } from '@/components/ui/popover';
import {
    SkeletonDashboard,
    SkeletonDetailTabs,
    SkeletonSettings,
} from '@/components/ui/skeleton';
import { createColumns, DataTable } from '@/components/ui/table';
import { EditColumnsButton } from '@/components/ui/table/edit-columns-button';
import { TableEmptyState } from '@/components/ui/table/table-empty-state';
import type { TableInstance } from '@/components/ui/table/types';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { InfoTooltip, TooltipProvider } from '@/components/ui/tooltip';
import { UndoToast } from '@/components/ui/undo-toast';

type Locale = 'en' | 'bg';

/**
 * Read lazily from inside the mock factories below, which Jest hoists above
 * every declaration — a ref object, not a bare `let`, keeps that out of the
 * temporal dead zone.
 */
// visx's ParentSize measures 0x0 in jsdom, and every chart primitive below
// returns null at width 0 — so without this the five #3209 chart cases would
// assert against an empty container and read `undefined`, which is what they
// did on the first run. Same shape the dedicated chart suites use. Harmless to
// the non-chart primitives in this file: nothing else mounts ParentSize.
jest.mock('@visx/responsive', () => ({
    ParentSize: ({
        children,
    }: {
        children: (size: { width: number; height: number }) => React.ReactNode;
    }) => <>{children({ width: 600, height: 300 })}</>,
}));

const mockLocale: { current: Locale } = { current: 'en' };
const mockTheme: { current: 'dark' | 'light' } = { current: 'dark' };

jest.mock('next-intl', () => {
    const catalogs: Record<string, unknown> = {
        en: jest.requireActual('../../messages/en.json'),
        bg: jest.requireActual('../../messages/bg.json'),
    };
    type Values = Record<string, string | number>;
    type Translator = ((key: string, values?: Values) => string) & {
        has: (key: string) => boolean;
        raw: (key: string) => unknown;
        rich: (key: string, values?: Values) => string;
        markup: (key: string, values?: Values) => string;
    };
    const build = (locale: string, ns: string | undefined): Translator => {
        const resolve = (key: string): unknown =>
            (ns ? `${ns}.${key}` : key)
                .split('.')
                .reduce<unknown>(
                    (o, k) =>
                        o && typeof o === 'object'
                            ? (o as Record<string, unknown>)[k]
                            : undefined,
                    catalogs[locale],
                );
        const format = (key: string, values?: Values): string => {
            const v = resolve(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name: string) =>
                values && name in values ? String(values[name]) : m,
            );
        };
        return Object.assign(format, {
            has: (key: string) => typeof resolve(key) === 'string',
            raw: resolve,
            rich: format,
            markup: format,
        });
    };
    const cache = new Map<string, Translator>();
    return {
        useTranslations: (ns?: string): Translator => {
            const cacheKey = `${mockLocale.current}:${ns ?? ''}`;
            let t = cache.get(cacheKey);
            if (!t) {
                t = build(mockLocale.current, ns);
                cache.set(cacheKey, t);
            }
            return t;
        },
        useLocale: () => mockLocale.current,
        useMessages: () => catalogs[mockLocale.current],
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        useFormatter: () => ({
            dateTime: (d: unknown) => String(d),
            number: (n: unknown) => String(n),
            relativeTime: (d: unknown) => String(d),
            list: (l: Iterable<unknown>) => Array.from(l).join(', '),
        }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

// ThemeToggle reads `useTheme()`; pinning it keeps both labels reachable
// without the provider's cookie + localStorage side effects leaking between
// cases.
jest.mock('@/components/theme/ThemeProvider', () => ({
    useTheme: () => ({ theme: mockTheme.current, setTheme: () => {}, toggle: () => {} }),
}));

// UserMenu's language row mounts the switcher, stubbed out so the UserMenu
// case reads only the menu's own copy. The switcher's group name has a case
// of its own, which renders the real module.
jest.mock('@/components/layout/LocaleSwitcher', () => ({ LocaleSwitcher: () => null }));
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

// DataTable reaches next/navigation through its filter wiring.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/things',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

/**
 * The rows `TopChrome` supplies through `UserMenu`'s `items` slot since T08
 * (#3003), with the SAME translation keys. A component rather than inline JSX
 * because it has to call `useTranslations`, and the slot is a render prop
 * invoked during the menu's own render — a hook there would break the rules of
 * hooks.
 */
function HostSuppliedRows({ close }: { close: () => void }) {
    const tSecurity = useTranslations('account.security');
    const tNav = useTranslations('nav');
    return (
        <>
            <button
                type="button"
                role="menuitem"
                data-testid="user-menu-account-security"
                onClick={close}
            >
                {tSecurity('securityTitle')}
            </button>
            <button
                type="button"
                role="menuitem"
                data-testid="user-menu-sign-out"
                onClick={close}
            >
                {tNav('signOut')}
            </button>
        </>
    );
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** en: exactly the old literal. bg: Cyrillic, and not the English sentence. */
function expectLocalised(actual: string | null | undefined, english: string): void {
    if (mockLocale.current === 'en') {
        expect(actual).toBe(english);
        return;
    }
    // `stringMatching`, not `toMatch`: the assertion-reach ratchets count
    // every `toMatch` whose subject they cannot trace to a file as a skipped
    // read, and `actual` is a parameter.
    expect(actual).toEqual(expect.stringMatching(CYRILLIC));
    expect(actual).not.toBe(english);
}

/** The text of the elements an `aria-labelledby` / `aria-describedby` names. */
function textOfIdRefs(el: Element, attr: string): string {
    return (el.getAttribute(attr) ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
}

interface Row {
    id: string;
    name: string;
}

describe.each<Locale>(['en', 'bg'])('shared primitives render their own copy — %s', (locale) => {
    beforeEach(() => {
        mockLocale.current = locale;
        mockTheme.current = 'dark';
    });

    it('Popover drawer: the dialog title and description', () => {
        render(
            <Popover openPopover setOpenPopover={() => {}} mobileOnly content={<div />}>
                <button type="button">-</button>
            </Popover>,
        );
        const dialog = screen.getByRole('dialog');
        expectLocalised(textOfIdRefs(dialog, 'aria-labelledby'), 'Menu');
        expectLocalised(textOfIdRefs(dialog, 'aria-describedby'), 'Popover content');
    });

    it('InfoTooltip: the help button name', () => {
        render(
            <TooltipProvider>
                <InfoTooltip content="-" />
            </TooltipProvider>,
        );
        expectLocalised(screen.getByRole('button').getAttribute('aria-label'), 'More information');
    });

    it('EmptyState: the learn-more link', () => {
        render(<EmptyState title="-" description="-" learnMore="https://example.com/help" />);
        expectLocalised(screen.getByRole('link').textContent, 'Learn more ↗');
    });

    it('ErrorState: the default title and retry button', () => {
        render(<ErrorState onRetry={() => {}} />);
        const alert = screen.getByRole('alert');
        expectLocalised(alert.querySelector('p')?.textContent, 'Something went wrong');
        expectLocalised(within(alert).getByRole('button').textContent, 'Try again');
    });

    it.each([
        ['dashboard', <SkeletonDashboard key="d" />, 'Loading dashboard'],
        ['details', <SkeletonDetailTabs key="t" />, 'Loading details'],
        ['settings', <SkeletonSettings key="s" />, 'Loading settings'],
    ])('Skeleton (%s): the busy region name', (_name, element, english) => {
        const { container } = render(element);
        expectLocalised(
            container.querySelector('[aria-busy="true"]')?.getAttribute('aria-label'),
            english,
        );
    });

    it('Input: the password toggle, in both states', () => {
        render(<Input type="password" />);
        const toggle = screen.getByRole('button');
        expectLocalised(toggle.getAttribute('aria-label'), 'Show password');
        fireEvent.click(toggle);
        expectLocalised(toggle.getAttribute('aria-label'), 'Hide password');
    });

    it('FormField: the hint button name, for a text and a non-text label', () => {
        // The info button is the REAL `InfoTooltip`: form-field imports
        // `./tooltip`, which jest maps to `tests/rendered/tooltip-mock.tsx` —
        // a DELEGATE since #3163, so what renders is the primitive itself with
        // a `TooltipProvider` supplied around it, carrying the aria-label
        // FormField computes.
        //
        // `getByRole('button')` rather than the `info-tooltip-trigger` testid
        // the old stub emitted: the real primitive has no testid, and the role
        // query is strictly stronger anyway — it asserts the trigger is an
        // accessible BUTTON (a testid on a <div> would have passed) and, by
        // throwing on more than one match, that it is the only button in a
        // field whose <Input /> renders none.
        const { unmount } = render(
            <FormField label="E-mail" hint="-">
                <Input />
            </FormField>,
        );
        expectLocalised(
            screen.getByRole('button').getAttribute('aria-label'),
            'More info about E-mail',
        );
        unmount();
        render(
            <FormField label={<span>E-mail</span>} hint="-">
                <Input />
            </FormField>,
        );
        expectLocalised(
            screen.getByRole('button').getAttribute('aria-label'),
            'More information',
        );
    });

    it('ToggleGroup: the radiogroup name', () => {
        render(
            <ToggleGroup
                options={[
                    { value: 'a', label: 'A' },
                    { value: 'b', label: 'B' },
                ]}
                selected="a"
                selectAction={() => {}}
            />,
        );
        expectLocalised(screen.getByRole('radiogroup').getAttribute('aria-label'), 'Options');
    });

    it('LocaleSwitcher: the radiogroup name (#3201)', () => {
        // The real module: the file-level stub above is for UserMenu's row.
        const { LocaleSwitcher } = jest.requireActual<
            typeof import('@/components/layout/LocaleSwitcher')
        >('@/components/layout/LocaleSwitcher');
        render(<LocaleSwitcher />);
        expectLocalised(screen.getByRole('radiogroup').getAttribute('aria-label'), 'Language');
    });

    it('InlineNotice: the dismiss button name', () => {
        render(
            <InlineNotice variant="info" onDismiss={() => {}}>
                -
            </InlineNotice>,
        );
        expectLocalised(screen.getByRole('button').getAttribute('aria-label'), 'Dismiss');
    });

    it('Breadcrumbs: the navigation landmark name', () => {
        render(<Breadcrumbs items={[{ label: 'A', href: '/a' }, { label: 'B' }]} />);
        expectLocalised(screen.getByRole('navigation').getAttribute('aria-label'), 'Breadcrumb');
    });

    it('UndoToast: the countdown bar name and value text', () => {
        // The Undo button label is caller copy (the hook's callers pass it),
        // so it is given per locale, as a caller would.
        render(
            <UndoToast
                toastId="toast"
                pendingId="pending"
                message="-"
                undoMessage={locale === 'en' ? 'Undo' : 'Отмяна'}
                delayMs={5000}
                onUndo={() => {}}
            />,
        );
        const bar = screen.getByRole('progressbar');
        expectLocalised(bar.getAttribute('aria-label'), 'Undo window');
        expectLocalised(bar.getAttribute('aria-valuetext'), '5s remaining');
    });

    it.each([
        ['dark', 'Switch to light theme'],
        ['light', 'Switch to dark theme'],
    ] as const)('ThemeToggle (%s): the button name and tooltip', (theme, english) => {
        mockTheme.current = theme;
        render(
            <TooltipProvider>
                <ThemeToggle />
            </TooltipProvider>,
        );
        expectLocalised(screen.getByRole('button').getAttribute('aria-label'), english);
    });

    it('Combobox: the trigger name with the default and with a non-text placeholder', () => {
        const { unmount } = render(
            <Combobox options={[]} selected={null} setSelected={() => {}} />,
        );
        expectLocalised(screen.getByRole('combobox').getAttribute('aria-label'), 'Select…');
        unmount();
        render(
            <Combobox
                options={[]}
                selected={null}
                setSelected={() => {}}
                placeholder={<span>-</span>}
            />,
        );
        expectLocalised(screen.getByRole('combobox').getAttribute('aria-label'), 'Select');
    });

    it('Combobox: the search placeholder and the empty state', async () => {
        const user = userEvent.setup();
        render(<Combobox options={[]} selected={null} setSelected={() => {}} />);
        await user.click(screen.getByRole('combobox'));
        const empty = await screen.findByText((_, el) => el?.hasAttribute('cmdk-empty') ?? false);
        expectLocalised(empty.textContent, 'No matches');
        expectLocalised(
            document.querySelector('[cmdk-input]')?.getAttribute('placeholder'),
            'Search…',
        );
    });

    it('EditColumnsButton: the trigger name and the reset row', async () => {
        // The five members the button reads, not a whole table: a hidden
        // hideable column is what makes the reset row render.
        const column = {
            id: 'name',
            columnDef: { header: 'Name' },
            getCanHide: () => true,
            getIsVisible: () => false,
            toggleVisibility: () => {},
        };
        const table = { getAllColumns: () => [column] } as unknown as TableInstance<Row>;
        render(<EditColumnsButton table={table} onReset={() => {}} />);
        const trigger = screen.getByTestId('edit-columns-button');
        expectLocalised(trigger.getAttribute('aria-label'), 'Edit columns');
        fireEvent.click(trigger);
        expectLocalised((await screen.findByTestId('column-reset')).textContent, 'Reset to defaults');
    });

    it('TableEmptyState: the default title', () => {
        render(<TableEmptyState />);
        expectLocalised(
            screen.getByTestId('table-empty-state').querySelector('p')?.textContent,
            'No items found',
        );
    });

    it('virtualised DataTable: the scroll region and the sort button names', () => {
        const columns = createColumns<Row>([{ accessorKey: 'name', header: 'Name' }]);
        render(
            <DataTable<Row>
                data={[
                    { id: 'r1', name: 'One' },
                    { id: 'r2', name: 'Two' },
                ]}
                columns={columns}
                getRowId={(r) => r.id}
                virtualize
                virtualHeight={200}
                selectionEnabled={false}
                sortableColumns={['name']}
                onSortChange={() => {}}
            />,
        );
        expectLocalised(
            screen.getByRole('region').getAttribute('aria-label'),
            'Table contents (scrollable)',
        );
        expectLocalised(
            document
                .querySelector('[data-virtual-table-header] button')
                ?.getAttribute('aria-label'),
            'Sort by column',
        );
    });

    it('NavBar: the brand link and the menu button names', () => {
        render(
            <>
                <NavBarBrand href="/" initials="IC" />
                <NavBarMobileMenu onClick={() => {}} />
            </>,
        );
        expectLocalised(
            screen.getByRole('link').getAttribute('aria-label'),
            'Inflect Compliance — go to dashboard',
        );
        expectLocalised(screen.getByRole('button').getAttribute('aria-label'), 'Open navigation menu');
    });

    it('UserMenu: the trigger, the menu, the name fallback and both rows', async () => {
        // T08 (#3003) moved the security and sign-out rows OUT of `UserMenu`
        // and into the host's `items` slot — one named a route only this
        // product has, the other imported `signOut` from next-auth.
        //
        // The rows are supplied here the way `TopChrome` supplies them, with
        // the SAME translation keys, because what this file protects is that
        // the keys resolve in both locales — not which component owns the
        // JSX. Asserting them against hardcoded English would have kept the
        // test green while measuring nothing.
        render(
            <TooltipProvider>
                <UserMenu
                    displayName={null}
                    displayEmail={null}
                    displayImage={null}
                    items={({ close }) => <HostSuppliedRows close={close} />}
                />
            </TooltipProvider>,
        );
        const trigger = screen.getByTestId('top-chrome-user-menu');
        expectLocalised(trigger.getAttribute('aria-label'), 'Account menu for Account');
        fireEvent.click(trigger);
        const menu = await screen.findByRole('menu');
        expectLocalised(menu.getAttribute('aria-label'), 'Account menu');
        expectLocalised(screen.getByTestId('user-menu-display-name').textContent, 'Account');
        expectLocalised(
            screen.getByTestId('user-menu-account-security').textContent,
            'Account security',
        );
        expectLocalised(screen.getByTestId('user-menu-sign-out').textContent, 'Sign out');
    });

    // ── Shared chart primitives (#3209) ──────────────────────────────────
    //
    // Each of these names its SVG with a `??` FALLBACK on an optional
    // `ariaLabel` prop rather than a plain attribute, which is why the older
    // i18n-adoption ratchet could not see them: it reads JSX text, not a
    // literal inside an attribute expression. A caller can still override the
    // name; what is asserted here is the default a screen reader gets when
    // nobody does, because that default was hard-coded English.
    //
    // Two prop shapes, deliberately not unified here: LineChart, RadarChart and
    // GanttChart wrap ChartFrame and take a `state`, while LossExceedanceCurve
    // and AleHistogram render directly and take `data`.
    //
    // The outer SVG is selected explicitly: gantt and radar each render a
    // SECOND role="img" per bar/point, so a bare getByRole('img') is ambiguous
    // and getAllByRole(...)[0] would depend on document order.
    const outerSvgLabel = (c: HTMLElement): string | null | undefined =>
        c.querySelector('svg[role="img"]')?.getAttribute('aria-label');

    it('LineChart: the SVG default name (#3209)', () => {
        const { container } = render(
            <LineChart
                state={chartReady([
                    { date: new Date('2026-01-01'), value: 1 },
                    { date: new Date('2026-01-02'), value: 2 },
                ])}
                seriesIndex={1}
            />,
        );
        expectLocalised(outerSvgLabel(container), 'Line chart');
    });

    it('RadarChart: the SVG default name (#3209)', () => {
        const { container } = render(
            <RadarChart
                state={chartReady([
                    { key: 'a', label: 'A', value: 0.5 },
                    { key: 'b', label: 'B', value: 0.8 },
                    { key: 'c', label: 'C', value: 0.3 },
                ])}
                seriesIndex={1}
            />,
        );
        expectLocalised(outerSvgLabel(container), 'Radar chart');
    });

    it('GanttChart: the SVG default name (#3209)', () => {
        const { container } = render(
            <GanttChart
                state={chartReady([
                    {
                        key: 'r1',
                        label: 'Row one',
                        start: new Date('2026-01-01'),
                        end: new Date('2026-02-01'),
                        seriesIndex: 1 as const,
                    },
                ])}
            />,
        );
        expectLocalised(outerSvgLabel(container), 'Gantt chart');
    });

    it('LossExceedanceCurve: the SVG default name (#3209)', () => {
        const { container } = render(
            <LossExceedanceCurve
                data={[
                    { threshold: 1000, exceedanceCount: 10, exceedanceFraction: 0.5 },
                    { threshold: 2000, exceedanceCount: 4, exceedanceFraction: 0.2 },
                ]}
            />,
        );
        expectLocalised(outerSvgLabel(container), 'Loss exceedance curve');
    });

    it('AleHistogram: the bucket list name (#3209)', () => {
        // Not the SVG here — a `<g role="list">` inside it. The SVG's own name
        // is a computed summary, which was never a hard-coded string.
        const { container } = render(
            <AleHistogram
                data={[
                    { id: '1', title: 'R1', ale: 1000, bandName: 'High', bandColor: '#f00' },
                    { id: '2', title: 'R2', ale: 50, bandName: 'Low', bandColor: '#0f0' },
                ]}
            />,
        );
        expectLocalised(
            container.querySelector('g[role="list"]')?.getAttribute('aria-label'),
            'Loss buckets',
        );
    });

});
