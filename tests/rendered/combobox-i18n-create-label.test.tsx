/** @jest-environment jsdom */

/**
 * <Combobox> create-row copy comes from the catalogue, in both locales.
 *
 * `tests/rendered/i18n-kept-primitives.test.tsx` already covers three of the
 * Combobox's four built-in strings — the trigger name, the search
 * placeholder and the empty state. The fourth, the "Create …" row, is the
 * only one that needs `onCreate` to render at all, which is why it was
 * missed: it is also the only one with TWO keys, `createLabelEmpty` for an
 * empty search and `createLabel` with a `{search}` placeholder for a typed
 * one, so a half-translated catalogue shows English on exactly one of them.
 *
 * Both are asserted the same way as the sibling suite: under `en` the exact
 * sentence the component used to hard-code, and under `bg` a Cyrillic string
 * that differs from it. A missing key, a key read from the wrong namespace
 * (next-intl returns the raw key) or a leftover literal each fail one half.
 *
 * Why a LOCAL `next-intl` mock: the repo-wide `__mocks__/next-intl.js` is
 * hard-wired to en.json, so it cannot answer the bg half at all.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { Combobox } from '@/components/ui/combobox';

type Locale = 'en' | 'bg';

/** Read from inside the hoisted mock factory, so a ref rather than a `let`. */
const mockLocale: { current: Locale } = { current: 'en' };

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
    // One translator per (locale, namespace): a fresh `t` on every call can
    // loop a render when it sits in a hook dependency.
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
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
            children,
    };
});

const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Open a single-select Combobox that offers the create row. */
async function openCreatable() {
    const user = userEvent.setup();
    render(
        <Combobox
            options={[]}
            selected={null}
            setSelected={() => {}}
            onCreate={async () => true}
        />,
    );
    await user.click(screen.getByRole('combobox'));
    return user;
}

function searchInput(): HTMLInputElement {
    const el = document.querySelector('[cmdk-input]');
    if (!el) throw new Error('combobox search input never rendered');
    return el as HTMLInputElement;
}

/** The create row is the only option carrying the create copy. */
function createRowText(): string {
    const row = screen
        .getAllByRole('option')
        .find((el) => (el.textContent ?? '').length > 0);
    if (!row) throw new Error('create row never rendered');
    return row.textContent ?? '';
}

describe('Combobox create-row defaults are localised', () => {
    afterEach(() => {
        mockLocale.current = 'en';
    });

    it('en: an empty search offers the English create-new row', async () => {
        mockLocale.current = 'en';
        await openCreatable();
        expect(createRowText()).toContain('Create new option…');
    });

    it('bg: an empty search offers a Cyrillic create-new row', async () => {
        mockLocale.current = 'bg';
        await openCreatable();
        const text = createRowText();
        expect(text).toMatch(CYRILLIC);
        expect(text).not.toContain('Create new option…');
        // A key read from the wrong namespace resolves to the raw key.
        expect(text).not.toContain('createLabelEmpty');
    });

    it('en: a typed search is interpolated into the English label', async () => {
        mockLocale.current = 'en';
        const user = await openCreatable();
        await user.type(searchInput(), 'Sofia');
        expect(createRowText()).toContain('Create "Sofia"');
    });

    it('bg: a typed search is interpolated into the Cyrillic label', async () => {
        mockLocale.current = 'bg';
        const user = await openCreatable();
        await user.type(searchInput(), 'Sofia');
        const text = createRowText();
        expect(text).toContain('Sofia');
        expect(text).toMatch(CYRILLIC);
        // The `{search}` placeholder must be substituted, not rendered.
        expect(text).not.toContain('{search}');
        expect(text).not.toContain('createLabel');
    });

    it('a caller-supplied createLabel still wins over the catalogue', async () => {
        mockLocale.current = 'bg';
        const user = userEvent.setup();
        render(
            <Combobox
                options={[]}
                selected={null}
                setSelected={() => {}}
                onCreate={async () => true}
                createLabel={(search) => `Add ${search || 'one'}`}
            />,
        );
        await user.click(screen.getByRole('combobox'));
        expect(createRowText()).toContain('Add one');
    });
});
