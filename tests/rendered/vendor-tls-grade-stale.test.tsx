/**
 * A vendor's TLS grade is shown as stale once the latest fetch did not grade,
 * with the reason, so a refused fetch is never read as "nothing changed".
 *
 * The verdict is the server's (`tlsGradeStale` from the posture read); the
 * panel renders it and the recorded outcome, and decides neither.
 */
import { render, screen } from '@testing-library/react';
import { VendorMonitoringPanel } from '@/app/t/[tenantSlug]/(app)/vendors/[vendorId]/_components/VendorMonitoringPanel';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    return {
        useTranslations: (ns: string) => (key: string, values?: Record<string, string>) => {
            const v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? `{${name}}`);
        },
    };
});

const baseMonitor = {
    enabled: true,
    checkAttestation: true,
    checkBreach: true,
    checkTls: true,
    materializeFindings: false,
    lastRunAt: '2026-07-02T02:00:00.000Z',
    lastRunStatus: 'OK',
    breachLastSeenAt: null,
    breachCount: 0,
    tlsGrade: 'A',
    tlsCheckedAt: '2026-07-01T02:00:00.000Z',
    attestationExpiresAt: null,
};

const realFetch = global.fetch;
afterAll(() => {
    global.fetch = realFetch;
});

function servePosture(posture: unknown) {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => posture })) as unknown as typeof fetch;
}

const renderPanel = () => render(<VendorMonitoringPanel tenantSlug="acme" vendorId="v1" canWrite={false} />);

describe('VendorMonitoringPanel — a TLS grade the latest fetch did not confirm', () => {
    it('marks the grade stale and says the site refused the monitor', async () => {
        servePosture({
            monitor: { ...baseMonitor, tlsFetchOutcome: 'REFUSED', tlsFetchOutcomeAt: '2026-07-02T02:00:00.000Z' },
            events: [],
            providers: { breach: 'hibp-domain', tls: 'header-grade' },
            tlsGradeStale: true,
        });

        renderPanel();

        expect(await screen.findByText('Stale')).toBeInTheDocument();
        expect(screen.getByText(/the site refused the monitor/)).toBeInTheDocument();
        // The last real grade is still shown beside the stale mark.
        expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('tells the operator a BLOCKED domain needs correcting on the vendor record', async () => {
        servePosture({
            monitor: { ...baseMonitor, tlsFetchOutcome: 'BLOCKED', tlsFetchOutcomeAt: '2026-07-02T02:00:00.000Z' },
            events: [],
            tlsGradeStale: true,
        });

        renderPanel();

        expect(await screen.findByText(/correct it on the vendor record/)).toBeInTheDocument();
    });

    it('shows neither the stale mark nor a reason when the latest fetch graded', async () => {
        servePosture({
            monitor: { ...baseMonitor, tlsFetchOutcome: 'GRADED', tlsFetchOutcomeAt: '2026-07-02T02:00:00.000Z' },
            events: [],
            tlsGradeStale: false,
        });

        renderPanel();

        expect(await screen.findByText('A')).toBeInTheDocument();
        expect(screen.queryByText('Stale')).not.toBeInTheDocument();
        expect(screen.queryByText(/Last check/)).not.toBeInTheDocument();
    });
});
