/** @jest-environment jsdom */

/**
 * The printed Statement of Applicability words each status and names the
 * workspace from its context (#4927).
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ tenantName: 'Acme Bank' }),
}));

import { SoAPrintView } from '@/app/t/[tenantSlug]/(app)/reports/soa/print/SoAPrintView';
import type { SoAReportDTO } from '@/lib/dto/soa';

const EN = jest.requireActual('../../messages/en.json') as {
    reports: { soaPrint: Record<string, string>; soaView: { controlStatus: Record<string, string> } };
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
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" />);
        expect(screen.getByText(EN.reports.soaView.controlStatus.IN_PROGRESS)).toBeInTheDocument();
        expect(screen.getByText(EN.reports.soaView.controlStatus.NOT_STARTED)).toBeInTheDocument();
        expect(screen.queryByText('IN PROGRESS')).toBeNull();
        expect(screen.queryByText('NOT STARTED')).toBeNull();
    });

    it('names the workspace and groups a requirement with no section under "Other"', () => {
        render(<SoAPrintView report={REPORT} backHref="/t/acme/reports" />);
        expect(screen.getByText('Acme Bank')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', {
                name: new RegExp(EN.reports.soaPrint.sectionControls.replace('{section}', EN.reports.soaPrint.otherSection)),
            }),
        ).toBeInTheDocument();
    });
});
