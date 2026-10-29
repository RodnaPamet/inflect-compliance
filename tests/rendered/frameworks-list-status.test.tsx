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
 *
 * And (#4459):
 *
 *   - There is no "Create framework" button. It created nothing and opened an
 *     explanation naming a tab the framework page does not have.
 *   - The empty state speaks to the person reading it, not to an operator.
 *   - A framework's kind is a translated label, not the stored enum value.
 *   - The Requirements figure counts the requirements the coverage beside it
 *     is worked out over, not every requirement row of every pack.
 *   - A framework "In use" never reads "0%" coverage.
 *   - The table view has no row selection: nothing acts on ticked rows.
 */
import * as React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';

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

import { FrameworkKind } from '@prisma/client';
import { FrameworksClient } from '@/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient';
import { viewModeStorageKey } from '@/components/ui/hooks';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

function renderTable(ui: React.ReactElement) {
    window.localStorage.setItem(viewModeStorageKey('frameworks'), '"table"');
    render(ui);
    return screen.findByRole('table');
}

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
        expect(within(card).getByText(en.frameworks.list.installed)).toBeTruthy();
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

describe('no Create framework button (#4459)', () => {
    it('renders neither the button nor its explanation, for any viewer', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" canInstall />);
        expect(document.getElementById('create-framework-btn')).toBeNull();
        expect(screen.queryByRole('button', { name: /create framework/i })).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.body.textContent).not.toMatch(/Customize|Coming soon/);
        // The Import entry point is unaffected.
        expect(document.getElementById('import-framework-btn')).not.toBeNull();
    });

    it('leaves no message key behind for it', () => {
        for (const messages of [en, bg]) {
            for (const key of ['createFramework', 'customTitle', 'customDescription', 'customToday', 'customComingSoon', 'close']) {
                expect(messages.frameworks.list[key]).toBeUndefined();
            }
        }
    });
});

describe('the empty state (#4459)', () => {
    it('tells the reader to ask whoever runs the installation, not to run a seed', () => {
        render(<FrameworksClient frameworks={[]} coverages={{}} tenantSlug="acme" />);
        expect(screen.getByText(en.frameworks.list.empty)).toBeTruthy();
        for (const messages of [en, bg]) {
            expect(messages.frameworks.list.empty).not.toMatch(/seed/i);
        }
    });
});

describe("a framework's kind (#4459)", () => {
    it('reads as a label on the card, never the enum value', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" />);
        expect(within(screen.getByTestId('fw-card-ISO27001')).getByText(en.frameworks.kinds.isoStandard)).toBeTruthy();
        expect(within(screen.getByTestId('fw-card-NIS2')).getByText(en.frameworks.kinds.euDirective)).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/ISO STANDARD|EU DIRECTIVE|ISO_STANDARD|EU_DIRECTIVE/);
    });

    it('reads as a label in the Domain column too', async () => {
        await renderTable(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" />);
        const row = screen.getByText('NIS 2').closest('tr')!;
        expect(within(row).getByText(en.frameworks.kinds.euDirective)).toBeTruthy();
        expect(row.textContent).not.toMatch(/EU DIRECTIVE/);
    });

    it('has a label for every stored kind', () => {
        const kinds = Object.values(FrameworkKind);
        expect(kinds.length).toBeGreaterThan(0);
        const frameworks = kinds.map((kind, i) => ({
            id: `k${i}`, key: `K${i}`, name: `Framework ${i}`, kind, version: null, description: null,
            _count: { requirements: 1, packs: 1 },
        }));
        render(<FrameworksClient frameworks={frameworks} coverages={{}} tenantSlug="acme" />);
        for (let i = 0; i < kinds.length; i++) {
            const card = screen.getByTestId(`fw-card-K${i}`);
            expect(card.textContent).not.toContain(kinds[i].replace('_', ' '));
            expect(card.textContent).not.toContain(kinds[i]);
        }
        for (const messages of [en, bg]) {
            expect(Object.keys(messages.frameworks.kinds)).toHaveLength(kinds.length);
        }
    });
});

describe('the Requirements figure (#4459)', () => {
    // A multi-pack framework the workspace scoped to some packs, with
    // deprecated requirements: the catalogue holds 120 rows, coverage is
    // worked out over 40.
    const SCOPED = [
        { id: 'fw3', key: 'EUDRONE', name: 'EU drones', kind: 'REGULATION', version: null, description: null, _count: { requirements: 120, packs: 7 } },
    ];

    it('is the population the coverage beside it is worked out over', () => {
        render(
            <FrameworksClient
                frameworks={SCOPED}
                coverages={{ EUDRONE: { coveragePercent: 25, mapped: 10, total: 40 } }}
                tenantSlug="acme"
            />,
        );
        const card = screen.getByTestId('fw-card-EUDRONE');
        expect(card.textContent).toContain('40');
        expect(card.textContent).not.toContain('120');
        expect(card.textContent).toContain('25%');
    });

    it('is the same figure in the table', async () => {
        await renderTable(
            <FrameworksClient
                frameworks={SCOPED}
                coverages={{ EUDRONE: { coveragePercent: 25, mapped: 10, total: 40 } }}
                tenantSlug="acme"
            />,
        );
        const row = screen.getByText('EU drones').closest('tr')!;
        expect(row.textContent).toContain('40');
        expect(row.textContent).not.toContain('120');
    });

    it("falls back to the catalogue's count only where coverage is unknown", () => {
        render(<FrameworksClient frameworks={SCOPED} coverages={{}} coverageErrors={['EUDRONE']} tenantSlug="acme" />);
        expect(screen.getByTestId('fw-card-EUDRONE').textContent).toContain('120');
    });
});

describe('an In use framework never reads 0% (#4459)', () => {
    // One mapped requirement of 250 rounds to 0 on the server.
    const COVERAGE = { ISO27001: { coveragePercent: 0, mapped: 1, total: 250 } };

    it('reads <1% on the card', () => {
        render(<FrameworksClient frameworks={FRAMEWORKS} coverages={COVERAGE} tenantSlug="acme" />);
        const card = screen.getByTestId('fw-card-ISO27001');
        expect(within(card).getByText(en.frameworks.list.installed)).toBeTruthy();
        expect(within(card).getByText(en.frameworks.list.coverageBelowOnePercent)).toBeTruthy();
        expect(card.textContent).not.toMatch(/(^|[^<\d])0%/);
    });

    it('reads <1% in the table', async () => {
        await renderTable(<FrameworksClient frameworks={FRAMEWORKS} coverages={COVERAGE} tenantSlug="acme" />);
        const row = screen.getByText('ISO 27001').closest('tr')!;
        expect(within(row).getByText(en.frameworks.list.coverageBelowOnePercent)).toBeTruthy();
        expect(row.textContent).not.toMatch(/(^|[^<\d])0%/);
    });

    it('a framework with nothing mapped still reads 0%', () => {
        render(
            <FrameworksClient
                frameworks={FRAMEWORKS}
                coverages={{ ISO27001: { coveragePercent: 0, mapped: 0, total: 250 } }}
                tenantSlug="acme"
            />,
        );
        const card = screen.getByTestId('fw-card-ISO27001');
        expect(card.textContent).toContain('0%');
        expect(within(card).queryByText(en.frameworks.list.coverageBelowOnePercent)).toBeNull();
    });
});

describe('the table view has no row selection (#4459)', () => {
    it('renders no checkboxes', async () => {
        await renderTable(<FrameworksClient frameworks={FRAMEWORKS} coverages={{}} tenantSlug="acme" />);
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });
});
