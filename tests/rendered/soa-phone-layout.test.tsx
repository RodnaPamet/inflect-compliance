/** @jest-environment jsdom */

/**
 * The Statement of Applicability on a phone: one card per requirement, the
 * summary as a scrolling strip, the requirement's group in words — and the
 * table and the tile grid from `md` up, unchanged.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => toast }));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/reports/soa',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => ({ reports: { view: true, export: true } }),
    useTenantContext: () => ({ plan: undefined }),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { SoAClient } from '@/app/t/[tenantSlug]/(app)/reports/soa/SoAClient';
import type { SoAReportDTO } from '@/lib/dto/soa';

const EN = jest.requireActual('../../messages/en.json') as {
    controls: { categoryLabels: Record<string, string>; isoDomainLabels: Record<string, string> };
    reports: { soaView: Record<string, string> };
};

const control = (id: string, over: Record<string, unknown> = {}) => ({
    controlId: id, code: `CTL-${id}`, title: `Control ${id}`, status: 'IMPLEMENTED',
    applicability: 'APPLICABLE', justification: null, owner: null, frequency: null, ...over,
});

const REPORT: SoAReportDTO = {
    tenantId: 't1',
    tenantSlug: 'acme',
    framework: 'ISO27001',
    frameworkName: 'ISO/IEC 27001:2022',
    hasStatementOfApplicability: true,
    generatedAt: '2026-10-31T00:00:00.000Z',
    entries: [
        {
            requirementId: 'req-1', requirementCode: 'A.5.1', requirementTitle: 'Policies for information security',
            section: 'ORGANIZATIONAL', applicable: true, justification: null, implementationStatus: 'IMPLEMENTED',
            verdict: 'implemented', exceptedUntil: null, mappedControls: [control('1')],
            evidenceCount: 0, openTaskCount: 0, lastTestResult: null,
        },
        {
            requirementId: 'req-2', requirementCode: 'A.7.1', requirementTitle: 'Physical security perimeters',
            section: 'Access control', applicable: false, justification: 'Fully remote company.',
            implementationStatus: 'NOT_APPLICABLE', verdict: null, exceptedUntil: null,
            mappedControls: [control('2', { applicability: 'NOT_APPLICABLE', justification: 'Fully remote company.' })],
            evidenceCount: 0, openTaskCount: 0, lastTestResult: null,
        },
        {
            requirementId: 'req-3', requirementCode: 'A.8.9', requirementTitle: 'Configuration management',
            section: 'Our own section', applicable: null, justification: null, implementationStatus: null,
            verdict: null, exceptedUntil: null, mappedControls: [],
            evidenceCount: 0, openTaskCount: 0, lastTestResult: null,
        },
    ],
    summary: { total: 3, applicable: 1, notApplicable: 1, unmapped: 1, implemented: 1, excepted: 0, missingJustification: 0 },
} as SoAReportDTO;

/** A viewport below `md` (a phone), or at/above it. */
const realMatchMedia = window.matchMedia;
function setViewport(phone: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width: 767.98px') ? phone : false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
}

function renderPage(canEdit = true) {
    return render(<SoAClient report={REPORT} controls={[]} tenantSlug="acme" canEdit={canEdit} />);
}

afterEach(() => {
    window.matchMedia = realMatchMedia;
});

describe('SoA on a phone', () => {
    beforeEach(() => setViewport(true));

    it('reads one card per requirement instead of the wide table', () => {
        renderPage();
        expect(document.getElementById('soa-table')).toBeNull();
        const cards = within(screen.getByTestId('soa-cards')).getAllByRole('listitem');
        expect(cards).toHaveLength(3);
        const first = screen.getByTestId('soa-card-req-1');
        expect(first).toHaveTextContent('A.5.1');
        expect(first).toHaveTextContent('Policies for information security');
        expect(first).toHaveTextContent(EN.reports.soaView.applicable);
        // The requirement's own reason, not only behind a hover.
        expect(screen.getByTestId('soa-card-req-2')).toHaveTextContent('Fully remote company.');
    });

    it('words the requirement group instead of the stored constant', () => {
        renderPage();
        const sections = screen.getAllByTestId('soa-card-section').map((el) => el.textContent);
        expect(sections).toEqual([
            EN.controls.categoryLabels.ORGANIZATIONAL,
            EN.controls.isoDomainLabels.ACCESS_CONTROL,
            // A framework's own section is its text, passed through.
            'Our own section',
        ]);
        expect(screen.queryByText('ORGANIZATIONAL')).toBeNull();
    });

    it('lays the summary out as one scrolling strip, not a tile grid', () => {
        renderPage();
        const strip = screen.getByTestId('soa-kpi-strip');
        expect(strip.hasAttribute('data-scroll-cue-strip')).toBe(true);
        expect(screen.queryByTestId('soa-kpi-grid')).toBeNull();
        const list = strip.querySelector('[data-scroll-cue-list]') as HTMLElement;
        expect(list.className).toContain('overflow-x-auto');
        // Tiles keep their width, so the strip scrolls rather than squeezes.
        const tiles = Array.from(list.children).filter((el) => !el.hasAttribute('data-scroll-cue-end-spacer'));
        expect(tiles).toHaveLength(7);
        for (const tile of tiles) expect(tile.className).toContain('shrink-0');
    });

    it('opens a card\'s mapped controls from its button, with the reason in full', async () => {
        renderPage();
        const toggle = screen.getByTestId('soa-card-toggle-req-2');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByTestId('soa-mapped-controls-req-2')).toBeNull();
        await act(async () => { fireEvent.click(toggle); });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const detail = screen.getByTestId('soa-mapped-controls-req-2');
        expect(within(detail).getByRole('link', { name: 'CTL-2' })).toHaveAttribute('href', '/t/acme/controls/2');
        expect(within(detail).getByText('Fully remote company.')).toBeInTheDocument();
        expect(document.getElementById('soa-edit-justification-2')).not.toBeNull();
    });

    it('offers Map control on an unmapped requirement, and only to an editor', () => {
        const { unmount } = renderPage(true);
        expect(within(screen.getByTestId('soa-card-req-3')).getByRole('button', { name: EN.reports.soaView.mapControl }))
            .toBeInTheDocument();
        unmount();
        renderPage(false);
        expect(within(screen.getByTestId('soa-card-req-3')).queryByRole('button', { name: EN.reports.soaView.mapControl }))
            .toBeNull();
    });

    it('filters the cards with "Show gaps only"', async () => {
        renderPage();
        await act(async () => { fireEvent.click(document.getElementById('soa-gaps-only')!); });
        const cards = within(screen.getByTestId('soa-cards')).getAllByRole('listitem');
        expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['soa-card-req-3']);
    });
});

describe('SoA from md up', () => {
    beforeEach(() => setViewport(false));

    it('keeps the table and the tile grid', () => {
        renderPage();
        expect(document.getElementById('soa-table')).not.toBeNull();
        expect(screen.getByTestId('soa-kpi-grid')).toBeInTheDocument();
        expect(screen.queryByTestId('soa-cards')).toBeNull();
        expect(screen.queryByTestId('soa-kpi-strip')).toBeNull();
    });
});
