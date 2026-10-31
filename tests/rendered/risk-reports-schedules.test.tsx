/** @jest-environment jsdom */

/**
 * The risk reports page's schedules and runs (#4774).
 *
 *   1. A schedule that delivers only to SharePoint can be edited with no
 *      email recipient.
 *   2. "Whole portfolio" clears a deep-dive schedule's stored risk.
 *   3. A refused schedule says why, in the server's words.
 *   4. Creating needs the write tier; changing a schedule also `risks.edit`.
 *   5. A run's status is worded.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => toast }));
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => toast,
    useToastWithUndo: () => jest.fn(),
}));

let tier = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
let appPermissions: Record<string, unknown> = { risks: { edit: true }, reports: { view: true, export: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: tier, appPermissions }),
    usePermissions: () => appPermissions,
}));

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
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/reports',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/UpgradeGate', () => ({ UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
// The risk picker is a "clear" button here: choosing "Whole portfolio".
jest.mock('../../src/app/t/[tenantSlug]/(app)/risks/_shared/RiskPicker', () => ({
    RiskPicker: ({ id, onChange }: { id: string; onChange: (v: string | null) => void }) => (
        <button type="button" data-testid={`picker-${id}`} onClick={() => onChange(null)}>clear</button>
    ),
}));

import RiskReportsPage from '@/app/t/[tenantSlug]/(app)/risks/reports/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as { risks: { reports: Record<string, string> } };
const R = EN.risks.reports;

const TEMPLATES = [
    { id: 'tpl-p', name: 'Portfolio', description: null, type: 'PORTFOLIO_SUMMARY' },
    { id: 'tpl-d', name: 'Deep dive', description: null, type: 'RISK_DEEP_DIVE' },
];
const SCHEDULES = [
    {
        id: 'sch-sp', templateId: 'tpl-p', cadence: 'MONTHLY', format: 'PDF', isActive: true,
        recipientsJson: [], nextRunAt: null, lastRunAt: null, parametersJson: null, deliveryDay: null,
        sharePointDriveId: 'drive-1', sharePointFolderId: null,
    },
    {
        id: 'sch-dd', templateId: 'tpl-d', cadence: 'WEEKLY', format: 'CSV', isActive: true,
        recipientsJson: ['ana@example.com'], nextRunAt: null, lastRunAt: null, parametersJson: { riskId: 'r1' },
        deliveryDay: null, sharePointDriveId: null, sharePointFolderId: null,
    },
];
const RUNS = [
    { id: 'run-1', format: 'PDF', status: 'COMPLETED', createdAt: '2026-10-31T00:00:00.000Z', templateId: 'tpl-p', errorMessage: null, parametersJson: null },
];

let patches: Array<{ url: string; body: Record<string, unknown> }> = [];
let patchStatus = 200;
let patchBody: unknown = {};

beforeEach(() => {
    tier = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
    appPermissions = { risks: { edit: true }, reports: { view: true, export: true } };
    patches = [];
    patchStatus = 200;
    patchBody = {};
    Object.values(toast).forEach((f) => f.mockReset());
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const reply = (status: number, body: unknown) => ({
            ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        });
        const u = String(url);
        if (method === 'PATCH') {
            patches.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
            return reply(patchStatus, patchBody);
        }
        if (u.includes('/risks/reports/schedules')) return reply(200, { schedules: SCHEDULES });
        if (u.includes('/integrations/sharepoint/connections')) return reply(200, []);
        if (u.includes('/risks/reports')) return reply(200, { templates: TEMPLATES, reports: RUNS });
        return reply(200, {});
    }) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><RiskReportsPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('Risk reports — schedules', () => {
    it('saves a SharePoint-only schedule with no email recipient', async () => {
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('schedule-edit-btn-sch-sp')); });
        const save = screen.getByTestId('schedule-save-sch-sp');
        expect(save).toBeEnabled();
        await act(async () => { fireEvent.click(save); });
        await waitFor(() => expect(patches).toHaveLength(1));
        expect(patches[0].body).toMatchObject({ recipients: [] });
    });

    it('clears a deep-dive scope when "Whole portfolio" is chosen', async () => {
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('schedule-edit-btn-sch-dd')); });
        fireEvent.click(screen.getByTestId('picker-schedule-edit-risk-sch-dd'));
        await act(async () => { fireEvent.click(screen.getByTestId('schedule-save-sch-dd')); });
        await waitFor(() => expect(patches).toHaveLength(1));
        expect(patches[0].body.parameters).toEqual({});
    });

    it("says why a schedule was refused, in the server's words", async () => {
        patchStatus = 400;
        patchBody = { error: { code: 'BAD_REQUEST', message: '"x@outside.com" is not a member of this tenant and is not on the report-recipient allowlist.' } };
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('schedule-edit-btn-sch-dd')); });
        await act(async () => { fireEvent.click(screen.getByTestId('schedule-save-sch-dd')); });
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('x@outside.com')));
    });

    it('shows what each schedule sends and where', async () => {
        mount();
        expect(await screen.findByTestId('schedule-format-sch-dd')).toHaveTextContent('CSV');
        expect(screen.getByTestId('schedule-scope-sch-dd')).toHaveTextContent(R.scheduleScopeOneRisk);
        expect(screen.getByTestId('schedule-sharepoint-sch-sp')).toHaveTextContent(R.scheduleToSharePoint);
    });

    it('offers no schedule or template creation to a role without the write tier', async () => {
        tier = { ...tier, canWrite: false };
        mount();
        await screen.findByTestId('schedule-row-sch-sp');
        expect(document.getElementById('schedule-create-btn')).toBeNull();
        expect(document.getElementById('new-template-btn')).toBeNull();
        expect(screen.queryByTestId('schedule-edit-btn-sch-sp')).toBeNull();
    });

    it('offers no schedule changes without risks.edit', async () => {
        appPermissions = { risks: { edit: false }, reports: { view: true, export: true } };
        mount();
        await screen.findByTestId('schedule-row-sch-sp');
        expect(screen.queryByTestId('schedule-edit-btn-sch-sp')).toBeNull();
        expect(screen.queryByTestId('schedule-delete-sch-sp')).toBeNull();
        expect(document.getElementById('schedule-create-btn')).not.toBeNull();
    });

    it('words a run’s status', async () => {
        mount();
        expect(await screen.findByText(R.status_COMPLETED)).toBeInTheDocument();
        expect(screen.queryByText('COMPLETED')).toBeNull();
    });
});
