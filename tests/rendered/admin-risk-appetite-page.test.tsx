/**
 * #4822 — the Risk appetite page refuses a limit it cannot read instead of
 * clearing it, says when it could not load, shows a score breach as a score,
 * labels breach types, and shows an acknowledged breach as acknowledged.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockRole = 'ADMIN';
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => {
        const { getPermissionsForRole } = require('@/lib/permissions');
        const p = getPermissionsForRole(mockRole);
        return {
            membershipRole: mockRole,
            appPermissions: p,
            permissions: { canRead: true, canWrite: true, canAdmin: mockRole === 'ADMIN' || mockRole === 'OWNER', canAudit: true, canExport: true },
        };
    },
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useMoneyFormatter: () => (v: number | null | undefined) => `€${v}`,
    useCurrencySymbol: () => '€',
}));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import RiskAppetitePage from '@/app/t/[tenantSlug]/(app)/admin/risk-appetite/page';
import en from '../../messages/en.json';

const ra = en.admin.riskAppetite;

type Reply = { status: number; body: unknown };
let puts: unknown[] = [];
let posts: string[] = [];
let approveBodies: unknown[] = [];
let configReads = 0;

beforeEach(() => { mockRole = 'ADMIN'; });

/** `config` may be a list: each read of the config takes the next, the last repeating. */
function stub(routes: { config?: Reply | Reply[]; breaches?: Reply; put?: Reply; approve?: Reply }) {
    puts = [];
    posts = [];
    approveBodies = [];
    configReads = 0;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        let r: Reply;
        if (method === 'POST' && String(url).endsWith('/risk-appetite/approve')) {
            posts.push(String(url));
            approveBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
            r = routes.approve ?? { status: 200, body: { success: true } };
        } else if (method === 'PUT') {
            puts.push(JSON.parse(String(init?.body)));
            r = routes.put ?? { status: 200, body: {} };
        } else if (String(url).endsWith('/breaches')) {
            r = routes.breaches ?? { status: 200, body: { breaches: [] } };
        } else {
            const configs = Array.isArray(routes.config) ? routes.config : routes.config ? [routes.config] : [];
            configReads += 1;
            r = configs[Math.min(configReads, configs.length) - 1] ?? { status: 200, body: { config: { totalAleThreshold: 500000 }, status: { status: 'WITHIN', portfolioAle: 1000, portfolioTested: null, activeBreaches: 0 } } };
        }
        return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
}

it('refuses a limit typed with a thousands separator, and never sends it', async () => {
    stub({});
    render(<RiskAppetitePage />);
    const field = await screen.findByDisplayValue('500000');
    fireEvent.change(field, { target: { value: '1,000,000' } });
    expect(screen.getByTestId('appetite-invalid-totalAleThreshold')).toHaveTextContent(ra.invalidNumber);
    expect(document.getElementById('appetite-save')).toBeDisabled();
    fireEvent.click(document.getElementById('appetite-save') as HTMLElement);
    expect(puts).toEqual([]);
});

it('saves a limit typed with spaces as the number it shows', async () => {
    stub({});
    render(<RiskAppetitePage />);
    fireEvent.change(await screen.findByDisplayValue('500000'), { target: { value: '1 000 000' } });
    fireEvent.click(document.getElementById('appetite-save') as HTMLElement);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ totalAleThreshold: 1_000_000 });
});

it('says it could not load, rather than showing defaults as if nothing were set', async () => {
    stub({ config: { status: 500, body: {} } });
    render(<RiskAppetitePage />);
    expect(await screen.findByText(ra.loadFailed)).toBeInTheDocument();
    expect(document.getElementById('appetite-save')).toBeNull();
});

it('shows the server\'s reason when a save is refused', async () => {
    stub({ put: { status: 400, body: { error: { message: 'qualScoreMax must be at most 25' } } } });
    render(<RiskAppetitePage />);
    await screen.findByDisplayValue('500000');
    fireEvent.click(document.getElementById('appetite-save') as HTMLElement);
    expect(await screen.findByTestId('appetite-save-msg')).toHaveTextContent('qualScoreMax must be at most 25');
});

it('labels breach types, shows a score as a score, and marks an acknowledged breach', async () => {
    stub({
        breaches: {
            status: 200,
            body: {
                breaches: [
                    { id: 'b1', breachType: 'QUAL_SCORE', thresholdValue: 15, actualValue: 20, detectedAt: '2026-10-01', resolvedAt: null, acknowledgedAt: '2026-10-02', riskId: 'r1', category: null, remediationTaskId: null },
                    { id: 'b2', breachType: 'PORTFOLIO_ALE', thresholdValue: 100, actualValue: 150, detectedAt: '2026-10-01', resolvedAt: null, acknowledgedAt: null, riskId: null, category: null, remediationTaskId: null },
                ],
            },
        },
    });
    render(<RiskAppetitePage />);
    expect(await screen.findByTestId('breach-type-b1')).toHaveTextContent(ra.breachType.QUAL_SCORE);
    expect(screen.getByTestId('breach-values-b1')).toHaveTextContent('threshold 15 · actual 20');
    expect(screen.getByTestId('breach-values-b2')).toHaveTextContent('threshold €100 · actual €150');
    expect(screen.getByTestId('breach-acknowledged-b1')).toHaveTextContent(ra.acknowledged);
    expect(screen.queryByTestId('breach-ack-b1')).toBeNull();
    expect(screen.getByTestId('breach-ack-b2')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('QUAL_SCORE');
});

describe('approval (#5313 item 11)', () => {
    const storedRow = {
        id: 'cfg-1', tenantId: 't-1', createdAt: '2026-01-01', updatedAt: '2026-01-02T08:15:30.123Z',
        totalAleThreshold: 500000, singleRiskAleMax: null, qualScoreMax: null, testedPercentile: 80,
        appetiteStatement: 'Moderate.', reviewCadence: 'ANNUALLY', categoryOverridesJson: null,
        nextReviewAt: '2027-01-01T00:00:00.000Z',
        approvedByUserId: 'owner-1', approvedAt: '2026-11-01T00:00:00.000Z',
    };
    const configReply = (approval: unknown): Reply => ({
        status: 200,
        body: { config: storedRow, status: { status: 'WITHIN', portfolioAle: 1, portfolioTested: null, activeBreaches: 0 }, approval },
    });

    it('a save sends only the fields it edits: never the approval or the row\'s own columns', async () => {
        stub({ config: configReply(null) });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        fireEvent.click(document.getElementById('appetite-save') as HTMLElement);
        await waitFor(() => expect(puts).toHaveLength(1));
        const body = puts[0] as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual([
            'appetiteStatement', 'categoryOverridesJson', 'nextReviewAt', 'qualScoreMax',
            'reviewCadence', 'singleRiskAleMax', 'testedPercentile', 'totalAleThreshold',
        ]);
        // The fields it does not edit go back as they came, so a save keeps them.
        expect(body.nextReviewAt).toBe('2027-01-01T00:00:00.000Z');
    });

    it('shows who approved it to every viewer, and offers Approve to an ADMIN nowhere', async () => {
        stub({ config: configReply({ approvedAt: '2026-11-01T00:00:00.000Z', approverName: 'Olga Owner' }) });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        expect(document.getElementById('appetite-approval')).toHaveTextContent('Approved by Olga Owner on');
        expect(document.getElementById('appetite-approve')).toBeNull();
    });

    it('says when it is not approved', async () => {
        stub({ config: configReply(null) });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        expect(document.getElementById('appetite-approval')).toHaveTextContent(ra.notApproved);
    });

    it('offers an OWNER Approve, which posts to the approve route', async () => {
        mockRole = 'OWNER';
        stub({ config: configReply(null) });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        const approve = document.getElementById('appetite-approve') as HTMLButtonElement;
        expect(approve).not.toBeDisabled();
        fireEvent.click(approve);
        await waitFor(() => expect(posts).toEqual(['/api/t/acme/risk-appetite/approve']));
        expect(puts).toEqual([]);
    });

    it('sends the version it loaded, so the server approves only what was shown', async () => {
        mockRole = 'OWNER';
        stub({ config: configReply(null) });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        fireEvent.click(document.getElementById('appetite-approve') as HTMLElement);
        await waitFor(() => expect(approveBodies).toHaveLength(1));
        expect(approveBodies[0]).toEqual({ configId: 'cfg-1', viewedUpdatedAt: '2026-01-02T08:15:30.123Z' });
    });

    it('on a save made since the page loaded, says so and shows what is stored now', async () => {
        mockRole = 'OWNER';
        const changed: Reply = {
            status: 200,
            body: {
                config: { ...storedRow, totalAleThreshold: 900000, updatedAt: '2026-11-15T09:30:00.000Z' },
                status: { status: 'WITHIN', portfolioAle: 1, portfolioTested: null, activeBreaches: 0 },
                approval: null,
            },
        };
        stub({
            config: [configReply(null), changed],
            approve: {
                status: 409,
                body: { error: { code: 'CONFLICT', message: 'The risk appetite has changed since it was shown to you', details: { reason: 'RISK_APPETITE_CHANGED_SINCE_VIEWED' } } },
            },
        });
        render(<RiskAppetitePage />);
        await screen.findByDisplayValue('500000');
        fireEvent.click(document.getElementById('appetite-approve') as HTMLElement);
        expect(await screen.findByTestId('appetite-save-msg')).toHaveTextContent(ra.approveChangedSinceViewed);
        // Re-read: the limits now on screen are the ones a second Approve would approve.
        expect(await screen.findByDisplayValue('900000')).toBeInTheDocument();
        expect(screen.getByTestId('appetite-save-msg')).toHaveTextContent(ra.approveChangedSinceViewed);
        fireEvent.click(document.getElementById('appetite-approve') as HTMLElement);
        await waitFor(() => expect(approveBodies).toHaveLength(2));
        expect(approveBodies[1]).toEqual({ configId: 'cfg-1', viewedUpdatedAt: '2026-11-15T09:30:00.000Z' });
    });

    it('holds Approve while the screen differs from what is stored', async () => {
        mockRole = 'OWNER';
        stub({ config: configReply(null) });
        render(<RiskAppetitePage />);
        fireEvent.change(await screen.findByDisplayValue('500000'), { target: { value: '600000' } });
        expect(document.getElementById('appetite-approve')).toBeDisabled();
        expect(document.getElementById('appetite-approve-save-first')).toHaveTextContent(ra.approveSaveFirst);
    });

    it('offers no Approve before anything is saved', async () => {
        mockRole = 'OWNER';
        stub({
            config: { status: 200, body: { config: null, status: { status: 'NONE', portfolioAle: 0, portfolioTested: null, activeBreaches: 0 }, approval: null } },
            // A breach row, so the test can see the load has finished.
            breaches: { status: 200, body: { breaches: [{ id: 'b9', breachType: 'QUAL_SCORE', thresholdValue: 1, actualValue: 2, detectedAt: '2026-10-01', resolvedAt: null, acknowledgedAt: null, riskId: null, category: null, remediationTaskId: null }] } },
        });
        render(<RiskAppetitePage />);
        await screen.findByTestId('breach-type-b9');
        expect(document.getElementById('appetite-save')).not.toBeNull();
        expect(document.getElementById('appetite-approve')).toBeNull();
    });
});
