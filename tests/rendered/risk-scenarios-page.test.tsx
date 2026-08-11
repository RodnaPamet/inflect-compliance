/**
 * Scenarios page — the what-if builder and the baseline-vs-scenario compare.
 *
 * Same debt as `risk-loss-events-page`: `risk-write-permission-gates` mounted
 * this 101-statement page for the first time and enrolled it in the coverage
 * report at whatever the permission assertions touched. Enrolling a file and
 * leaving it unexecuted means its logic runs in production unchecked, so the
 * repayment is real tests of what the page does.
 *
 * The behaviours that matter here:
 *
 *   - the override builder is the expensive input. It dedupes on
 *     (risk, field) so re-entering a field corrects rather than duplicates,
 *     rejects a non-numeric value outright, and a failed create must not
 *     throw the whole assembly away.
 *   - the comparison table only appears once a simulation returns one, and
 *     it must repeat the Monte-Carlo panel's honesty about a dropped
 *     correlation matrix.
 *   - an ARCHIVED scenario keeps Clone but loses Simulate and Archive.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

const PERMS = { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true };

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: PERMS }),
    usePermissions: () => ({}),
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '—' : `€${Math.round(v)}`),
    useCurrentUserId: () => 'u1',
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => resolve(ns, key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/scenarios',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

// The override builder needs a risk selected. The picker is a Combobox over
// `/risks/options`; driving it through cmdk is orthogonal to what is under
// test here, so it is replaced with a plain button that selects a known risk.
jest.mock('@/app/t/[tenantSlug]/(app)/risks/_shared/RiskPicker', () => ({
    RiskPicker: ({ onChange, id }: { onChange: (id: string | null, label?: string) => void; id?: string }) => (
        <button type="button" data-testid={id ?? 'risk-picker'} onClick={() => onChange('r1', 'Ransomware')}>
            pick
        </button>
    ),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import ScenariosPage from '@/app/t/[tenantSlug]/(app)/risks/scenarios/page';

const en = require('../../messages/en.json');
const S = en.risks.scenarios;

type Scenario = { id: string; name: string; status: string; investmentCost: number | null; computedRoi: number | null; createdAt: string };
let scenarios: Scenario[] = [];
let writeOk = true;
let writeBody: unknown = {};
const writes: { url: string; method: string; body: unknown }[] = [];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET') {
            writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            const b = writeOk ? writeBody : { error: { code: 'internal', message: 'boom' } };
            return { ok: writeOk, status: writeOk ? 200 : 500, headers: new Headers({ 'content-type': 'application/json' }), json: async () => b, text: async () => JSON.stringify(b) } as unknown as Response;
        }
        const body = url.includes('/risks/scenarios') ? { scenarios } : { risks: [] };
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    scenarios = [];
    writeOk = true;
    writeBody = {};
    writes.length = 0;
    installFetch();
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><ScenariosPage /></TooltipProvider>
        </SWRConfig>,
    );

/** Select the mocked risk, type a value, press Add override. */
const addOverride = (value: string) => {
    fireEvent.click(screen.getByTestId('scenario-override-risk'));
    fireEvent.change(screen.getByPlaceholderText(S.overrideValuePlaceholder), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: S.addOverride }));
};

describe('Scenarios — the override builder', () => {
    it('adds an override and shows the risk it applies to', async () => {
        mount();
        await screen.findByPlaceholderText(S.namePlaceholder);
        addOverride('50000');

        const list = screen.getByTestId('scenario-overrides');
        expect(within(list).getByText('Ransomware')).toBeInTheDocument();
        expect(list).toHaveTextContent('50000');
        // The value input clears so the next override starts fresh.
        expect(screen.getByPlaceholderText(S.overrideValuePlaceholder)).toHaveValue('');
    });

    it('re-entering the same risk+field corrects it rather than duplicating', async () => {
        mount();
        await screen.findByPlaceholderText(S.namePlaceholder);
        addOverride('50000');
        addOverride('75000');

        const rows = within(screen.getByTestId('scenario-overrides')).getAllByRole('listitem');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent('75000');
    });

    it('rejects a non-numeric value without adding anything', async () => {
        mount();
        await screen.findByPlaceholderText(S.namePlaceholder);
        addOverride('not a number');
        expect(screen.queryByTestId('scenario-overrides')).not.toBeInTheDocument();
    });

    it('an override can be removed again', async () => {
        mount();
        await screen.findByPlaceholderText(S.namePlaceholder);
        addOverride('50000');
        fireEvent.click(within(screen.getByTestId('scenario-overrides')).getByRole('button', { name: S.removeOverride }));
        expect(screen.queryByTestId('scenario-overrides')).not.toBeInTheDocument();
    });
});

describe('Scenarios — creating', () => {
    it('sends name, investment and overrides, then clears the whole assembly', async () => {
        mount();
        fireEvent.change(await screen.findByPlaceholderText(S.namePlaceholder), { target: { value: 'WAF rollout' } });
        fireEvent.change(screen.getByPlaceholderText(S.investmentPlaceholder), { target: { value: '130000' } });
        addOverride('50000');
        fireEvent.click(screen.getByRole('button', { name: S.create }));

        await waitFor(() => expect(writes.some((w) => w.method === 'POST')).toBe(true));
        const post = writes.find((w) => w.method === 'POST')!;
        expect(post.body).toMatchObject({
            name: 'WAF rollout',
            investmentCost: 130000,
            overrides: [{ riskId: 'r1', field: 'primaryLossMagnitude', newValue: 50000 }],
        });
        await waitFor(() => expect(screen.getByPlaceholderText(S.namePlaceholder)).toHaveValue(''));
        expect(screen.queryByTestId('scenario-overrides')).not.toBeInTheDocument();
    });

    it('a failed create keeps the name AND the overrides — the expensive part', async () => {
        writeOk = false;
        mount();
        fireEvent.change(await screen.findByPlaceholderText(S.namePlaceholder), { target: { value: 'WAF rollout' } });
        addOverride('50000');
        fireEvent.click(screen.getByRole('button', { name: S.create }));

        await screen.findByTestId('scenario-save-error');
        expect(screen.getByPlaceholderText(S.namePlaceholder)).toHaveValue('WAF rollout');
        expect(screen.getByTestId('scenario-overrides')).toBeInTheDocument();
    });

    it('an empty name never reaches the network', async () => {
        mount();
        await screen.findByPlaceholderText(S.namePlaceholder);
        fireEvent.click(screen.getByRole('button', { name: S.create }));
        await waitFor(() => expect(writes).toHaveLength(0));
    });
});

describe('Scenarios — the list and the comparison', () => {
    const draft: Scenario = { id: 's1', name: 'WAF', status: 'DRAFT', investmentCost: 130000, computedRoi: null, createdAt: '2026-01-01' };

    it('renders investment and ROI when the scenario carries them', async () => {
        scenarios = [{ ...draft, status: 'SIMULATED', computedRoi: 2.5 }];
        mount();
        const item = await screen.findByText('WAF');
        expect(item.parentElement).toHaveTextContent('€130000');
        expect(item.parentElement).toHaveTextContent('2.5');
    });

    it('an ARCHIVED scenario keeps Clone but loses Simulate and Archive', async () => {
        scenarios = [{ ...draft, status: 'ARCHIVED' }];
        mount();
        expect(await screen.findByTestId('scenario-clone-s1')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: S.simulate })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: S.archive })).not.toBeInTheDocument();
    });

    it('simulating renders the baseline-vs-scenario table with the ROI row', async () => {
        scenarios = [draft];
        writeBody = {
            comparison: {
                baseline: { portfolioAle: { mean: 100000, p95: 400000, p99: 900000 } },
                scenario: { portfolioAle: { mean: 60000, p95: 250000, p99: 500000 } },
                delta: { meanAleDelta: -40000, varP95Delta: -150000, varP99Delta: -400000, roi: 3.2 },
                perRiskDeltas: [{ riskId: 'r1', title: 'Ransomware', baselineAle: 50000, scenarioAle: 20000, deltaPercent: -60 }],
            },
        };
        mount();
        fireEvent.click(await screen.findByRole('button', { name: S.simulate }));

        const cmp = await screen.findByTestId('scenario-comparison');
        expect(cmp).toHaveTextContent('€100000');
        expect(cmp).toHaveTextContent('€60000');
        // A reduction must read as a reduction, not a bare number.
        expect(cmp).toHaveTextContent('−€40000');
        expect(cmp).toHaveTextContent('3.2×');
        expect(cmp).toHaveTextContent('Ransomware');
        expect(screen.queryByTestId('scenario-correlations-dropped')).not.toBeInTheDocument();
    });

    it('warns when either simulation dropped its correlation matrix', async () => {
        scenarios = [draft];
        writeBody = {
            comparison: {
                baseline: { portfolioAle: { mean: 1, p95: 2, p99: 3 }, correlationsDropped: true },
                scenario: { portfolioAle: { mean: 1, p95: 2, p99: 3 } },
                delta: { meanAleDelta: 0, varP95Delta: 0, varP99Delta: 0, roi: null },
                perRiskDeltas: [],
            },
        };
        mount();
        fireEvent.click(await screen.findByRole('button', { name: S.simulate }));

        const warn = await screen.findByTestId('scenario-correlations-dropped');
        expect(warn).toHaveAttribute('role', 'alert');
        // roi: null → no ROI row invented.
        expect(screen.getByTestId('scenario-comparison')).not.toHaveTextContent('×');
    });

    it('a failed simulation surfaces the error and paints no comparison', async () => {
        scenarios = [draft];
        writeOk = false;
        mount();
        fireEvent.click(await screen.findByRole('button', { name: S.simulate }));
        await screen.findByTestId('scenario-save-error');
        expect(screen.queryByTestId('scenario-comparison')).not.toBeInTheDocument();
    });
});
