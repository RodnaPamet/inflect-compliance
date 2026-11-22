/** @jest-environment jsdom */

/**
 * The Statement of Applicability page has its own header and export, words
 * its values, lets a recorded justification be corrected, and keeps the
 * server's refusal (#4740).
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => toast }));

// A stable translator per namespace, as next-intl gives.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh, prefetch: jest.fn() }),
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

let canExport = true;
let plan: string | undefined;
jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path}`;
    return {
        usePermissions: () => ({ reports: { view: true, export: canExport } }),
        // Read by <UpgradeGate> around Print: no plan is self-hosted, all features.
        useTenantContext: () => ({ plan }),
        useTenantHref: () => href,
    };
});

import { SoAClient } from '@/app/t/[tenantSlug]/(app)/reports/soa/SoAClient';
import type { SoAReportDTO } from '@/lib/dto/soa';

const EN = jest.requireActual('../../messages/en.json') as {
    reports: Record<string, string> & { soaView: Record<string, string> & { controlStatus: Record<string, string> } };
};
const R = EN.reports;

const REPORT: SoAReportDTO = {
    tenantId: 't1',
    tenantSlug: 'acme',
    framework: 'ISO27001',
    frameworkName: 'ISO/IEC 27001:2022',
    hasStatementOfApplicability: true,
    generatedAt: '2026-10-31T00:00:00.000Z',
    entries: [
        {
            requirementId: 'req-1',
            requirementCode: 'A.7.1',
            requirementTitle: 'Physical security perimeters',
            section: 'Physical',
            applicable: false,
            justification: 'Fully remote company.',
            implementationStatus: 'NOT_APPLICABLE',
            verdict: null,
            exceptedUntil: null,
            mappedControls: [
                {
                    controlId: 'ctl-1', code: 'A.7.1', title: 'Physical perimeter', status: 'NEEDS_REVIEW',
                    applicability: 'NOT_APPLICABLE', justification: 'Fully remote company.', owner: null, frequency: null,
                },
            ],
            evidenceCount: 0,
            openTaskCount: 0,
            lastTestResult: null,
        },
    ],
    summary: { total: 1, applicable: 0, notApplicable: 1, unmapped: 0, implemented: 0, excepted: 0, missingJustification: 0 },
};

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
    canExport = true;
    plan = undefined;
    Object.values(toast).forEach((f) => f.mockReset());
    refresh.mockReset();
    global.fetch = jest.fn(async () => reply(200, {})) as unknown as typeof fetch;
});

function renderPage(canEdit = true) {
    render(<SoAClient report={REPORT} controls={[]} tenantSlug="acme" canEdit={canEdit} />);
}

async function expandRow() {
    await act(async () => { fireEvent.click(screen.getByText('Physical security perimeters')); });
}

describe('Statement of Applicability page', () => {
    it('has its own title and breadcrumbs, and the CSV export beside Print', () => {
        renderPage();
        expect(screen.getByRole('heading', { level: 1, name: R.soa })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: R.title })).toHaveAttribute('href', '/t/acme/reports');
        expect(document.getElementById('soa-export-csv')).toHaveAttribute(
            'href',
            '/api/t/acme/reports/soa/export.csv?framework=ISO27001',
        );
    });

    it('offers the CSV and Print only to a role the export routes admit (#4927)', () => {
        canExport = false;
        renderPage();
        expect(document.getElementById('soa-export-csv')).toBeNull();
        expect(document.getElementById('soa-print-link')).toBeNull();
    });

    it('locks Print behind the plan when PDF exports are not in it, and says which plan (#4927)', () => {
        plan = 'FREE';
        renderPage();
        // Shown but inert, beside a link to billing naming the plan it needs,
        // rather than a link the print page would bounce.
        const print = document.getElementById('soa-print-link')!;
        expect(print.closest('.pointer-events-none')).not.toBeNull();
        expect(document.querySelector('a[href="/t/acme/admin/billing"]')).not.toBeNull();
        // The CSV is not a PDF export, so it stays usable.
        expect(document.getElementById('soa-export-csv')!.closest('.pointer-events-none')).toBeNull();
    });

    it('words the control status and its applicability', async () => {
        renderPage();
        await expandRow();
        expect(screen.getAllByText(R.soaView.controlStatus.NEEDS_REVIEW).length).toBeGreaterThan(0);
        expect(screen.queryByText('NEEDS REVIEW')).toBeNull();
        expect(screen.queryByText('NOT_APPLICABLE')).toBeNull();
    });

    it('opens a recorded justification for correction, prefilled', async () => {
        renderPage();
        await expandRow();
        await act(async () => { fireEvent.click(document.getElementById('soa-edit-justification-ctl-1')!); });
        await waitFor(() => expect(screen.getByDisplayValue('Fully remote company.')).toBeInTheDocument());
    });

    it('offers no correction to a role that cannot edit', async () => {
        renderPage(false);
        await expandRow();
        expect(document.getElementById('soa-edit-justification-ctl-1')).toBeNull();
    });

    it("says who can edit when the server refuses the role, rather than to try again", async () => {
        global.fetch = jest.fn(async () => reply(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } })) as unknown as typeof fetch;
        renderPage();
        await expandRow();
        await act(async () => { fireEvent.click(document.getElementById('soa-edit-justification-ctl-1')!); });
        const save = await screen.findByRole('button', { name: R.soaView.saveJustification });
        await act(async () => { fireEvent.click(save); });
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(R.soaView.writeRestricted));
        expect(toast.error).not.toHaveBeenCalledWith(R.soaView.justificationFailed);
    });

    it('saves the justification through the applicability endpoint (#5218)', async () => {
        renderPage();
        await expandRow();
        await act(async () => { fireEvent.click(document.getElementById('soa-edit-justification-ctl-1')!); });
        const box = await screen.findByDisplayValue('Fully remote company.');
        fireEvent.change(box, { target: { value: '  Fully remote; no office.  ' } });
        const save = await screen.findByRole('button', { name: R.soaView.saveJustification });
        await act(async () => { fireEvent.click(save); });

        const fetchMock = global.fetch as jest.Mock;
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/controls/ctl-1/applicability');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({
            applicability: 'NOT_APPLICABLE',
            justification: 'Fully remote; no office.',
        });
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(toast.error).not.toHaveBeenCalled();
    });
});
