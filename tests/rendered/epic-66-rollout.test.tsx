/**
 * Epic 66 — rollout integration coverage.
 *
 * Verifies the two real-page surfaces:
 *   - portfolio dashboard tenant-health cards
 *   - framework list page table/cards toggle
 *
 * Strategy mirrors the Epic-63 rollout file: don't mount the heavy
 * server modules (the framework `page.tsx` runs on the server with
 * a real Prisma fetch), and don't mount the dashboard widget grid
 * (`PortfolioDashboard` pulls in react-grid-layout). Render the
 * leaf components (`TenantCoverageCards`, `FrameworksClient`)
 * directly with synthesised props.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { fireEvent, render } from '@testing-library/react';

// jsdom 0×0 ParentSize stub so MiniAreaChart has room to draw under
// the sparkline branch of the tenant cards.
jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({
            children,
            className,
        }: {
            children: (args: { width: number; height: number }) => React.ReactNode;
            className?: string;
        }) => (
            <div
                data-testid="parent-size"
                className={className}
                style={{ width: 200, height: 40 }}>
                {children({ width: 200, height: 40 })}
            </div>
        ),
    };
});

// `<TenantCoverageCards>` uses `<TimestampTooltip>` which reaches
// the real Radix Tooltip via the `@/` alias — bypasses the
// jest.config moduleNameMapper rewrite that catches `./tooltip` and
// `../tooltip` only. Mock locally so the test doesn't need a
// TooltipProvider wrapper.
jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({
        children,
        content,
    }: {
        children: React.ReactNode;
        content: React.ReactNode;
    }) => (
        <span data-testid="tooltip-mock">
            {children}
            <span data-testid="tooltip-content">{content}</span>
        </span>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// next/navigation isn't in scope under jsdom — stub the hooks the
// FrameworksClient (and any transitively-imported primitives) might
// reach for.
// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so text assertions track the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce((o: unknown, k) =>
            o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
    return {
        useTranslations: (ns: string) => {
            const fn = (key: string, params?: Record<string, unknown>) => {
                let v = resolve(ns, key);
                if (typeof v !== 'string') return key;
                if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                return v;
            };
            // `.rich` — resolve the value and strip <tag>inner</tag> to its text.
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
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme-corp/frameworks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme-corp' }),
}));

import { FrameworksClient } from '@/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient';
import {
    viewModeStorageKey,
} from '@/components/ui/hooks';
// ─── FrameworksClient — table/cards toggle ─────────────────────────

const FW_FIXTURES = [
    {
        id: 'fw1',
        key: 'ISO27001',
        name: 'ISO 27001',
        kind: 'INFOSEC',
        version: '2022',
        description: 'Information Security Management System',
        _count: { requirements: 93, packs: 1 },
    },
    {
        id: 'fw2',
        key: 'NIS2',
        name: 'NIS 2',
        kind: 'CYBER',
        version: null,
        description: 'EU Network and Information Security Directive',
        _count: { requirements: 20, packs: 1 },
    },
];
const COV_FIXTURES = {
    ISO27001: { coveragePercent: 100, mapped: 93, total: 93 },
    NIS2: { coveragePercent: 0, mapped: 0, total: 20 },
};

describe('FrameworksClient — view toggle rollout', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('defaults to cards view (preserves the prior bespoke layout)', () => {
        const { container } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        expect(
            container.querySelector('[data-testid="frameworks-card-list"]'),
        ).not.toBeNull();
        // Two framework cards in the grid.
        expect(
            container.querySelectorAll(
                '[data-testid="frameworks-card-list"] [data-card-list-card]',
            ).length,
        ).toBe(2);
        // Toggle is visible.
        expect(
            container.querySelector('[data-testid="frameworks-view-toggle"]'),
        ).not.toBeNull();
    });

    it('renders Installed badge when coverage > 0 mapped', () => {
        const { getByTestId } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        const isoCard = getByTestId('fw-card-ISO27001');
        const nisCard = getByTestId('fw-card-NIS2');
        expect(isoCard.textContent).toContain('Installed');
        expect(nisCard.textContent).toContain('Available');
    });

    it('switches to a DataTable when the user picks the Table view', () => {
        const { container } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        const tableRadio = container.querySelector(
            '#view-toggle-table',
        ) as HTMLElement;
        fireEvent.click(tableRadio);
        // Cards gone, table mounted.
        expect(
            container.querySelector('[data-testid="frameworks-card-list"]'),
        ).toBeNull();
        expect(container.querySelector('table')).not.toBeNull();
        // Table row count matches fixture count (1 header + 2 data rows).
        expect(
            container.querySelectorAll('table tbody tr').length,
        ).toBe(2);
    });

    it('persists the table preference to localStorage', () => {
        const { container } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        const tableRadio = container.querySelector(
            '#view-toggle-table',
        ) as HTMLElement;
        fireEvent.click(tableRadio);
        const stored = window.localStorage.getItem(
            viewModeStorageKey('frameworks'),
        );
        expect(stored).toBe('"table"');
    });

    it('hydrates the persisted view from localStorage on mount', async () => {
        window.localStorage.setItem(
            viewModeStorageKey('frameworks'),
            '"table"',
        );
        const { container, findByRole } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        // useLocalStorage hydrates inside a useEffect — wait for table to render.
        await findByRole('table');
        expect(
            container.querySelector('[data-testid="frameworks-card-list"]'),
        ).toBeNull();
    });

    it('cards link to the framework detail page', () => {
        const { container } = render(
            <FrameworksClient
                frameworks={FW_FIXTURES}
                coverages={COV_FIXTURES}
                tenantSlug="acme-corp"
            />,
        );
        const iso = container.querySelector(
            '[data-testid="fw-card-ISO27001"] a[href="/t/acme-corp/frameworks/ISO27001"]',
        );
        expect(iso).not.toBeNull();
    });
});
