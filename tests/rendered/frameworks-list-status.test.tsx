/** @jest-environment jsdom */

/**
 * The Frameworks list (#4125):
 *
 *   - **Import framework** is offered only to a member who holds
 *     `frameworks.install`, the key the install API checks. Everyone else
 *     used to walk the whole wizard and be refused at its last click.
 *   - The status badge reads **In use**, with a hint saying what it means:
 *     at least one requirement has a mapped control. It is derived from
 *     coverage, not from a pack install, so "Installed" overstated it.
 *   - A failed coverage calculation shows the same "couldn't compute" state
 *     in the CARDS view as in the table: never "0%" and never "Available",
 *     which read exactly like a framework nobody has started.
 */
import * as React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
        <span data-testid="tooltip-mock">
            {children}
            <span data-testid="tooltip-content">{content}</span>
        </span>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    return {
        useTranslations: (ns: string) => {
            const fn = (key: string, params?: Record<string, unknown>) => {
                let v = resolve(ns, key);
                if (typeof v !== 'string') return key;
                for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
                return v;
            };
            fn.rich = (key: string) => {
                const v = resolve(ns, key);
                return typeof v === 'string' ? v.replace(/<(\w+)>(.*?)<\/\1>/g, '$2') : key;
            };
            return fn;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/frameworks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { FrameworksClient } from '@/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient';
import { viewModeStorageKey } from '@/components/ui/hooks';

const en = require('../../messages/en.json');

const FRAMEWORKS = [
    { id: 'fw1', key: 'ISO27001', name: 'ISO 27001', kind: 'ISO_STANDARD', version: '2022', description: null, _count: { requirements: 93, packs: 1 } },
    { id: 'fw2', key: 'NIS2', name: 'NIS 2', kind: 'EU_DIRECTIVE', version: null, description: null, _count: { requirements: 20, packs: 1 } },
];

afterEach(() => {
    cleanup();
    window.localStorage.clear();
});

describe('Import framework is offered only to a member who can install', () => {
    it('is absent without frameworks.install (the default)', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" />);
        expect(document.getElementById('import-framework-btn')).toBeNull();
    });

    it('is present with frameworks.install, pointing at the install wizard', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" canInstall />);
        const btn = document.getElementById('import-framework-btn');
        expect(btn).not.toBeNull();
        expect(btn!.closest('a')!.getAttribute('href')).toBe('/t/acme/frameworks/ISO27001/install');
    });

    it('is absent from the custom-framework explainer too, without the permission', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" />);
        fireEvent.click(document.getElementById('create-framework-btn')!);
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).queryByText(en.frameworks.list.importFramework)).toBeNull();
    });
});

describe('the In use badge', () => {
    it('reads "In use" with the hint that says what it means', () => {
        render(
            <FrameworksClient
                frameworks={FRAMEWORKS}
                coverages={{ ISO27001: { coveragePercent: 4, mapped: 4, total: 93 } }}
                tenantSlug="acme"
            />,
        );
        const card = screen.getByTestId('fw-card-ISO27001');
        expect(within(card).getByText(en.frameworks.list.inUse)).toBeTruthy();
        expect(within(card).getByText(en.frameworks.list.inUseHint)).toBeTruthy();
        expect(card.textContent).not.toContain('Installed');
    });
});

describe('a failed coverage calculation in the cards view', () => {
    it('shows the error state, never 0% and never Available', () => {
        render(
            <FrameworksClient
                frameworks={FRAMEWORKS}
                coverages={{ ISO27001: { coveragePercent: 50, mapped: 46, total: 93 } }}
                coverageErrors={['NIS2']}
                tenantSlug="acme"
            />,
        );
        const card = screen.getByTestId('fw-card-NIS2');
        expect(within(card).getAllByText(en.frameworks.list.coverageError).length).toBeGreaterThan(0);
        expect(card.textContent).not.toContain('0%');
        expect(within(card).queryByText(en.frameworks.list.available)).toBeNull();
        // The bar would draw a 0% coverage the page does not know.
        expect(within(card).queryByRole('progressbar')).toBeNull();
        // A framework whose coverage did compute is unaffected.
        expect(screen.getByTestId('fw-card-ISO27001').textContent).toContain('50%');
    });

    it('the table view does not call it Available either', () => {
        window.localStorage.setItem(viewModeStorageKey('frameworks'), '"table"');
        render(
            <FrameworksClient
                frameworks={FRAMEWORKS}
                coverages={{}}
                coverageErrors={['NIS2']}
                tenantSlug="acme"
            />,
        );
        return screen.findByRole('table').then(() => {
            const row = screen.getByText('NIS 2').closest('tr')!;
            expect(within(row).queryByText(en.frameworks.list.available)).toBeNull();
            expect(within(row).getAllByText(en.frameworks.list.coverageError).length).toBe(2);
        });
    });
});
