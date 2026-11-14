/**
 * The control health card names applicability in the list's three states
 * (#5313). A control nobody has assessed is stored as APPLICABLE, and the card
 * called it "Applicable" while the list called it "Not assessed".
 */
import * as React from 'react';
import { render, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    let v = resolve(ns, key);
                    if (typeof v !== 'string') return key;
                    if (params) for (const [p, val] of Object.entries(params)) v = (v as string).split(`{${p}}`).join(String(val));
                    return v;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { ControlHealthCard } from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlHealthCard';
import { TooltipProvider } from '@/components/ui/tooltip';

const health = (over: Record<string, unknown>) => ({
    verdict: 'UNKNOWN',
    status: 'IN_PROGRESS',
    applicability: 'APPLICABLE',
    applicabilityDecidedAt: null,
    lastTested: null,
    latestTestResult: null,
    latestTestAt: null,
    latestCheckStatus: null,
    latestCheckAt: null,
    openExceptions: 0,
    effectiveness: { passRate: null, total: 0, passes: 0, fails: 0, inconclusive: 0, windowDays: 90 },
    coverage: { requirementCount: 0, frameworkCount: 0, frameworks: [] },
    ...over,
});

function mount(body: unknown) {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <ControlHealthCard controlId="c-1" />
            </TooltipProvider>
        </SWRConfig>,
    );
    return waitFor(() => {
        const el = document.getElementById('control-health-applicability');
        expect(el).not.toBeNull();
        return (el as HTMLElement).textContent;
    });
}

it('a control never assessed reads "Not assessed"', async () => {
    expect(await mount(health({ applicabilityDecidedAt: null }))).toBe('Not assessed');
});

it('a control decided applicable reads "Applicable"', async () => {
    expect(await mount(health({ applicabilityDecidedAt: '2026-05-01T00:00:00.000Z' }))).toBe('Applicable');
});

it('a control marked not applicable reads "Not Applicable"', async () => {
    expect(await mount(health({ applicability: 'NOT_APPLICABLE' }))).toBe('Not Applicable');
});
