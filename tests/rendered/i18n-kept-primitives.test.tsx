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

import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { UserMenu } from '@/components/layout/user-menu';
import { NavBarBrand, NavBarMobileMenu } from '@/components/layout/nav-bar';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Combobox } from '@/components/ui/combobox';
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

// UserMenu's language row mounts the switcher, which needs a router; the
// switcher's own copy is covered by its own suite.
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
        // The info button here is tests/rendered/tooltip-mock.tsx (form-field
        // imports `./tooltip`), which renders the aria-label FormField computes.
        const { unmount } = render(
            <FormField label="E-mail" hint="-">
                <Input />
            </FormField>,
        );
        expectLocalised(
            screen.getByTestId('info-tooltip-trigger').getAttribute('aria-label'),
            'More info about E-mail',
        );
        unmount();
        render(
            <FormField label={<span>E-mail</span>} hint="-">
                <Input />
            </FormField>,
        );
        expectLocalised(
            screen.getByTestId('info-tooltip-trigger').getAttribute('aria-label'),
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
                <NavBarBrand href="/" />
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
        render(
            <TooltipProvider>
                <UserMenu displayName={null} displayEmail={null} displayImage={null} />
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
});
