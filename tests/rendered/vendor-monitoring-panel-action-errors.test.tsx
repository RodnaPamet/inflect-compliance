/**
 * A failed monitor toggle or "Run now" is a notice inside the vendor
 * monitoring panel, not the panel (#5313). The panel had one `error`, so a
 * single refused action replaced every card with an error line that
 * nothing cleared.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                let v = resolve(ns, key);
                if (typeof v !== 'string') return key;
                if (params) for (const [p, val] of Object.entries(params)) v = (v as string).split(`{${p}}`).join(String(val));
                return v;
            });
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

import { VendorMonitoringPanel } from '@/app/t/[tenantSlug]/(app)/vendors/[vendorId]/_components/VendorMonitoringPanel';
import { TooltipProvider } from '@/components/ui/tooltip';

const M = (jest.requireActual('../../messages/en.json') as { vendors: { monitoring: Record<string, string> } }).vendors.monitoring;

const POSTURE = {
    monitor: {
        enabled: true, checkAttestation: true, checkBreach: true, checkTls: true, materializeFindings: false,
        lastRunAt: null, lastRunStatus: null, breachLastSeenAt: null, breachCount: 0,
        tlsGrade: 'A', tlsCheckedAt: null, attestationExpiresAt: null,
    },
    events: [],
    providers: { breach: 'hibp-domain', tls: 'header-grade' },
    tlsGradeStale: false,
};

let runStatus = 500;
const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
    runStatus = 500;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
        if (String(url).endsWith('/monitor/run') && init?.method === 'POST') return reply(runStatus, {});
        return reply(200, POSTURE);
    }) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <TooltipProvider>
            <VendorMonitoringPanel tenantSlug="acme" vendorId="v1" canWrite />
        </TooltipProvider>,
    );

it('a failed "Run now" keeps the panel and says why, and the next action clears it', async () => {
    mount();
    const run = await waitFor(() => {
        const el = document.getElementById('run-vendor-monitor-btn');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    await act(async () => { fireEvent.click(run); });

    expect(await screen.findByText(M.runFailed)).toBeInTheDocument();
    // The panel is still there: its title, the run button and the settings.
    expect(screen.getByText(M.title)).toBeInTheDocument();
    expect(document.getElementById('run-vendor-monitor-btn')).not.toBeNull();
    expect(screen.getByText(M.settingsTitle)).toBeInTheDocument();

    runStatus = 200;
    await act(async () => { fireEvent.click(document.getElementById('run-vendor-monitor-btn') as HTMLElement); });
    await waitFor(() => expect(screen.queryByText(M.runFailed)).toBeNull());
});
