/**
 * `<TruncationBanner>` speaks the reader's language.
 *
 * The banner every list page shows past the 5,000-row backfill cap was
 * hard-coded English ("Showing the first 5,000 results."), so a Bulgarian
 * workspace got one English sentence on top of a translated page. It now
 * reads `common.truncationBanner`.
 *
 * The global `next-intl` mock always resolves against en.json, which cannot
 * show the Bulgarian half. This file's own mock resolves against whichever
 * REAL catalogue `mockLocale` names, so a key missing from bg.json, or a
 * placeholder the component does not fill, fails here.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

const mockLocale: { current: 'en' | 'bg' } = { current: 'en' };

jest.mock('next-intl', () => {
    const catalogues = {
        en: require('../../messages/en.json'),
        bg: require('../../messages/bg.json'),
    };
    const lookup = (ns: string, key: string): unknown =>
        `${ns}.${key}`
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                catalogues[mockLocale.current],
            );
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            const v = lookup(ns, key);
            if (typeof v !== 'string') return `MISSING:${ns}.${key}`;
            // `{name}` and the ICU `{name, number}` the catalogue uses for
            // the cap, which next-intl formats for the locale.
            return v.replace(/\{(\w+)(, number)?\}/g, (m, name, asNumber) => {
                if (!params || !(name in params)) return m;
                const value = params[name];
                return asNumber && typeof value === 'number'
                    ? new Intl.NumberFormat(mockLocale.current).format(value)
                    : String(value);
            });
        },
        useLocale: () => mockLocale.current,
    };
});

import { TruncationBanner } from '@/components/ui/TruncationBanner';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

function bannerText(): string {
    return screen.getByTestId('list-truncation-banner').textContent ?? '';
}

describe('TruncationBanner — localized copy', () => {
    it('renders the English catalogue text with the cap formatted', () => {
        mockLocale.current = 'en';
        render(<TruncationBanner truncated cap={5000} />);
        expect(bannerText()).toContain('Showing the first 5,000 results.');
        expect(bannerText()).toContain(en.common.truncationBanner.refine);
        expect(bannerText()).not.toMatch(/\{cap[^}]*\}|MISSING:/);
    });

    it('renders the Bulgarian catalogue text, not English', () => {
        mockLocale.current = 'bg';
        render(<TruncationBanner truncated cap={5000} />);
        expect(bannerText()).toContain(bg.common.truncationBanner.refine);
        expect(bannerText()).toContain(
            bg.common.truncationBanner.showingFirst.replace(
                '{cap, number}',
                new Intl.NumberFormat('bg').format(5000),
            ),
        );
        // The sentences the component used to hard-code.
        expect(bannerText()).not.toContain('Showing the first');
        expect(bannerText()).not.toContain('Refine your filters');
        expect(bannerText()).not.toMatch(/\{cap[^}]*\}|MISSING:/);
    });

    it('a page with no filters names its own narrowing control instead', () => {
        mockLocale.current = 'en';
        render(<TruncationBanner truncated cap={5000} hint="Pick a cycle." />);
        expect(bannerText()).toContain('Showing the first 5,000 results.');
        expect(bannerText()).toContain('Pick a cycle.');
        expect(bannerText()).not.toContain(en.common.truncationBanner.refine);
    });

    it('`hint={false}` leaves the sentence out rather than pointing at nothing', () => {
        mockLocale.current = 'en';
        render(<TruncationBanner truncated cap={5000} hint={false} />);
        expect(bannerText().trim()).toBe('Showing the first 5,000 results.');
    });

    it('renders nothing when not truncated', () => {
        const { container } = render(<TruncationBanner truncated={false} />);
        expect(container).toBeEmptyDOMElement();
    });
});
