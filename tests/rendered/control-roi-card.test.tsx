/**
 * RQ3-8 — ControlRoiCard rendered tests.
 *
 * Pins the honest-null UX: ok verdict renders the headline + ROI
 * multiple; a gap verdict renders the typed nudge — no synthetic
 * "0×" leaks through.
 */
import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import useSWR from 'swr';

jest.mock('swr');
const useSWRMock = useSWR as jest.MockedFunction<typeof useSWR>;

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ currencySymbol: '€', tenantSlug: 'acme' }),
    // B1-4 — the card now formats through the tenant hook rather than
    // importing formatCompactCurrency and re-deriving the ?? '€' fallback.
    // Mock it with the real formatter so the assertions still read the
    // symbol they always did.
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v, '€'),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => useSWRMock(path),
}));

// next-intl is ESM (jest can't parse its export). Mock it against the
// real en catalog, with `.rich` support for the ROI headline's <b>/<m> tags.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const React = require('react');
    const resolve = (ns: string, key: string): string | undefined => {
        const out = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
        return typeof out === 'string' ? out : undefined;
    };
    const subst = (str: string, params?: Record<string, unknown>) =>
        !params ? str : str.replace(/\{(\w+)\}/g, (_, p) => (p in params && typeof params[p] !== 'function' ? String(params[p]) : `{${p}}`));
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            return v !== undefined ? subst(v, params) : key;
        };
        (t as unknown as { rich: unknown }).rich = (key: string, params?: Record<string, unknown>) => {
            const raw = resolve(ns, key);
            if (raw === undefined) return key;
            const v = subst(raw, params);
            const parts: unknown[] = [];
            const re = /<(\w+)>(.*?)<\/\1>/g;
            let last = 0, m: RegExpExecArray | null, i = 0;
            while ((m = re.exec(v))) {
                if (m.index > last) parts.push(v.slice(last, m.index));
                const fn = params && (params[m[1]] as ((c: string) => React.ReactElement) | undefined);
                parts.push(fn ? React.cloneElement(fn(m[2]), { key: i++ }) : m[2]);
                last = re.lastIndex;
            }
            if (last < v.length) parts.push(v.slice(last));
            return parts;
        };
        return t;
    };
    return { useTranslations: (ns: string) => makeT(ns), useLocale: () => 'en' };
});

import { ControlRoiCard } from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_components/ControlRoiCard';

function mockSwrData(data: unknown) {
    useSWRMock.mockReturnValue({
        data,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
    } as unknown as ReturnType<typeof useSWR>);
}

describe('ControlRoiCard', () => {
    afterEach(() => jest.clearAllMocks());

    it('ok verdict renders the headline + ROI multiple + risk count', async () => {
        mockSwrData({
            controlId: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: 10_000,
            effectiveness: 50,
            verdict: {
                ok: true,
                value: {
                    aleProtected: 80_000,
                    roiMultiple: 8,
                    quantifiedRiskCount: 2,
                    linkedRiskCount: 3,
                },
            },
        });
        render(<ControlRoiCard controlId="c-1" />);
        await waitFor(() => expect(screen.getByTestId('control-roi-card')).toBeInTheDocument());
        expect(screen.getByTestId('control-roi-multiple').textContent).toBe('8.0×');
        expect(screen.getByTestId('control-roi-headline').textContent).toMatch(/€80K/);
        expect(screen.getByTestId('control-roi-headline').textContent).toMatch(/€10K/);
        expect(screen.queryByTestId('control-roi-gap')).toBeNull();
    });

    it('NO_COST verdict renders the typed gap nudge — no fabricated ROI', async () => {
        mockSwrData({
            controlId: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: null, effectiveness: 80,
            verdict: { ok: false, reason: 'NO_COST', linkedRiskCount: 2 },
        });
        render(<ControlRoiCard controlId="c-1" />);
        await waitFor(() => expect(screen.getByTestId('control-roi-card')).toBeInTheDocument());
        expect(screen.getByTestId('control-roi-gap').textContent).toMatch(/Set an annual cost/);
        expect(screen.queryByTestId('control-roi-multiple')).toBeNull();
    });

    it('NO_QUANT_RISKS with linkedRiskCount=0 nudges to link a risk first', async () => {
        mockSwrData({
            controlId: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: 10_000, effectiveness: 80,
            verdict: { ok: false, reason: 'NO_QUANT_RISKS', linkedRiskCount: 0 },
        });
        render(<ControlRoiCard controlId="c-1" />);
        expect(screen.getByTestId('control-roi-gap').textContent).toMatch(/Link this control to a risk first/);
    });

    it('NO_QUANT_RISKS with linked-but-unquantified nudges to quantify', async () => {
        mockSwrData({
            controlId: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: 10_000, effectiveness: 80,
            verdict: { ok: false, reason: 'NO_QUANT_RISKS', linkedRiskCount: 3 },
        });
        render(<ControlRoiCard controlId="c-1" />);
        expect(screen.getByTestId('control-roi-gap').textContent).toMatch(/Quantify the linked risks/);
    });
});
