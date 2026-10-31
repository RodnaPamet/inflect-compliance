/**
 * #4822 — the Risk appetite page refuses a limit it cannot read instead of
 * clearing it, says when it could not load, shows a score breach as a score,
 * labels breach types, and shows an acknowledged breach as acknowledged.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
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

function stub(routes: { config?: Reply; breaches?: Reply; put?: Reply }) {
    puts = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        let r: Reply;
        if (method === 'PUT') {
            puts.push(JSON.parse(String(init?.body)));
            r = routes.put ?? { status: 200, body: {} };
        } else if (String(url).endsWith('/breaches')) {
            r = routes.breaches ?? { status: 200, body: { breaches: [] } };
        } else {
            r = routes.config ?? { status: 200, body: { config: { totalAleThreshold: 500000 }, status: { status: 'WITHIN', portfolioAle: 1000, portfolioTested: null, activeBreaches: 0 } } };
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
