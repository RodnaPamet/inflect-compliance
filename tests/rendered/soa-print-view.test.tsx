/** @jest-environment jsdom */

/**
 * The printed Statement of Applicability words each status and names the
 * workspace from its context (#4927).
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ tenantName: 'Acme Bank' }),
}));

import { SoAPrintView } from '@/app/t/[tenantSlug]/(app)/reports/soa/print/SoAPrintView';
import type { SoAReportDTO } from '@/lib/dto/soa';

const EN = jest.requireActual('../../messages/en.json') as {
    reports: {
        soaPrint: Record<string, string>;
        soaPrintMobile: Record<string, string>;
        soaView: { controlStatus: Record<string, string> };
    };
};

function entry(id: string, overrides: Record<string, unknown> = {}) {
    return {
        requirementId: id,
        requirementCode: `A.${id}`,
        requirementTitle: `Requirement ${id}`,
        section: 'Organizational',
        applicable: true,
        justification: null,
        implementationStatus: 'IN_PROGRESS',
        verdict: 'covered',
        exceptedUntil: null,
        mappedControls: [],
        ...overrides,
    };
}

const SOA_HREF = '/t/acme/reports/soa?framework=ISO27001';

const REPORT = {
    tenantId: 't1',
    tenantSlug: 'acme',
    framework: 'ISO27001',
    frameworkName: 'ISO/IEC 27001:2022',
    generatedAt: '2026-10-01T00:00:00.000Z',
    hasStatementOfApplicability: true,
    summary: { total: 2, applicable: 2, notApplicable: 0, unmapped: 0, implemented: 0, excepted: 0, missingJustification: 0 },
    entries: [entry('1'), entry('2', { section: null, implementationStatus: 'NOT_STARTED' })],
} as unknown as SoAReportDTO;

describe('SoA print view', () => {
    it('words each status rather than printing the code', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
        expect(screen.getByText(EN.reports.soaView.controlStatus.IN_PROGRESS)).toBeInTheDocument();
        expect(screen.getByText(EN.reports.soaView.controlStatus.NOT_STARTED)).toBeInTheDocument();
        expect(screen.queryByText('IN PROGRESS')).toBeNull();
        expect(screen.queryByText('NOT STARTED')).toBeNull();
    });

    it('names the workspace and groups a requirement with no section under "Other"', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
        expect(screen.getByText('Acme Bank')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', {
                name: new RegExp(EN.reports.soaPrint.sectionControls.replace('{section}', EN.reports.soaPrint.otherSection)),
            }),
        ).toBeInTheDocument();
    });
});

it('words an ISO 27002 theme in a section heading instead of printing the constant', () => {
    const themed = {
        ...REPORT,
        entries: [entry('1', { section: 'ORGANIZATIONAL' })],
    } as unknown as SoAReportDTO;
    render(<SoAPrintView report={themed} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
    const CATEGORY = (jest.requireActual('../../messages/en.json') as { controls: { categoryLabels: Record<string, string> } })
        .controls.categoryLabels.ORGANIZATIONAL;
    expect(
        screen.getByRole('heading', { name: new RegExp(EN.reports.soaPrint.sectionControls.replace('{section}', CATEGORY)) }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ORGANIZATIONAL/)).toBeNull();
});

/**
 * On a phone's screen the print view is a notice with working actions; the
 * document stays in the page for the printer. Both gates are `@media screen`
 * so that printing — whose page is narrower than `md` too — is unchanged.
 */
describe('SoA print view on a phone screen', () => {
    const PHONE_SCREEN = '[@media_screen_and_(max-width:767.98px)]';

    it('shows a notice offering print, the readable SoA and the way back', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
        const notice = screen.getByTestId('soa-print-phone-notice');
        expect(within(notice).getByText(EN.reports.soaPrintMobile.title)).toBeInTheDocument();
        expect(within(notice).getByTestId('soa-print-phone-open-soa')).toHaveAttribute('href', SOA_HREF);
        expect(within(notice).getByRole('button', { name: EN.reports.soaPrint.back })).toBeInTheDocument();

        const print = jest.fn();
        window.print = print;
        fireEvent.click(within(notice).getByTestId('soa-print-phone-print'));
        expect(print).toHaveBeenCalledTimes(1);
    });

    it('shows the notice only on a phone screen, and never on paper', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
        const notice = screen.getByTestId('soa-print-phone-notice').className.split(' ');
        expect(notice).toEqual(expect.arrayContaining(['hidden', `${PHONE_SCREEN}:block`, 'no-print']));
    });

    it('keeps the whole document in the page, hidden on a phone screen only', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" soaHref={SOA_HREF} />);
        const doc = screen.getByTestId('soa-print-document');
        expect(doc.className.split(' ')).toEqual([`${PHONE_SCREEN}:hidden`]);
        // The tables a printout needs are inside it, not replaced by the notice.
        expect(within(doc).getAllByRole('table').length).toBeGreaterThan(1);
        expect(within(doc).getByText('Requirement 1')).toBeInTheDocument();
    });
});
