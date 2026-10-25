/**
 * Who sees the policy acknowledgement roster (#4128).
 *
 * The roster and its attestation log are acknowledgement EVIDENCE, which is
 * what an auditor asks for. They were gated on `canAdmin` on both sides, so an
 * AUDITOR saw neither. By owner decision OWNER, ADMIN and AUDITOR now READ them
 * (`assertCanAudit` on the server, `canViewRoster` here), while REQUESTING
 * acknowledgements stays OWNER / ADMIN (`canAdmin`).
 *
 * Each "is absent" check is paired with a render where the same thing is
 * present, so the test cannot pass against a panel that renders nothing.
 */
import * as React from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The builder must be STABLE across renders, as the real `useCallback` one is:
// the panel's fetch effects depend on it, and a fresh function per render
// re-runs them on every render.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const tenant = { tenantSlug: 'acme' };
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantContext: () => tenant,
    };
});

import { PolicyAcknowledgementsPanel } from '@/components/policies/PolicyAcknowledgementsPanel';

const ROSTER_URL = '/api/t/acme/policies/p1/attestations';

const ROSTER = {
    policyVersionId: 'v1',
    assignedCount: 2,
    acknowledgedCount: 1,
    pctComplete: 50,
    entries: [
        {
            userId: 'u2', name: 'Bea Outstanding', email: 'bea@example.test', required: true,
            acknowledgedAt: null, status: 'OUTSTANDING', supersededAckAt: null,
            assignedById: 'a1', assignedByName: 'Ada Admin', assignedAt: '2026-10-01T09:00:00.000Z',
        },
        {
            userId: 'u1', name: 'Cal Done', email: 'cal@example.test', required: true,
            acknowledgedAt: '2026-10-02T09:00:00.000Z', status: 'ACKNOWLEDGED', supersededAckAt: null,
            assignedById: 'a1', assignedByName: 'Ada Admin', assignedAt: '2026-10-01T09:00:00.000Z',
        },
    ],
    attestations: [
        { userId: 'u1', name: 'Cal Done', email: 'cal@example.test', acknowledgedAt: '2026-10-02T09:00:00.000Z' },
    ],
};

let fetchMock: jest.Mock;

beforeEach(() => {
    fetchMock = jest.fn(async (url: unknown) => {
        const u = String(url);
        if (u === ROSTER_URL) return { ok: true, status: 200, json: async () => ROSTER };
        // Own-attestation read.
        return { ok: true, status: 200, json: async () => ({ attested: false, attestation: null }) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

afterEach(cleanup);

function renderPanel(props: { canAdmin: boolean; canViewRoster: boolean }) {
    return render(
        <PolicyAcknowledgementsPanel policyId="p1" isPublished currentVersionNumber={1} {...props} />,
    );
}

const rosterRequested = () => fetchMock.mock.calls.some(([u]) => String(u) === ROSTER_URL);

describe('policy acknowledgement roster — who may see it', () => {
    it('an AUDITOR sees the roster and the attestation log, read-only', async () => {
        renderPanel({ canAdmin: false, canViewRoster: true });

        const roster = await screen.findByTestId('policy-ack-roster');
        await waitFor(() => expect(within(roster).getByText('Bea Outstanding')).toBeTruthy());
        expect(rosterRequested()).toBe(true);
        expect(within(roster).getByText('Acknowledgement roster')).toBeTruthy();
        expect(within(roster).getByText('50% acknowledged')).toBeTruthy();
        expect(within(roster).getByText('Attestation log')).toBeTruthy();
        // Cal appears twice: once in the roster, once in the attestation log.
        expect(within(roster).getAllByText('Cal Done')).toHaveLength(2);

        // Read-only: no way to ask people.
        expect(screen.queryByTestId('policy-request-ack-button')).toBeNull();
    });

    it('an OWNER / ADMIN sees the roster AND the request action', async () => {
        renderPanel({ canAdmin: true, canViewRoster: true });

        const roster = await screen.findByTestId('policy-ack-roster');
        await waitFor(() => expect(within(roster).getByText('Bea Outstanding')).toBeTruthy());
        expect(screen.getByTestId('policy-request-ack-button')).toBeTruthy();
    });

    it('a role that may not see it gets no roster and never asks the server for one', async () => {
        renderPanel({ canAdmin: false, canViewRoster: false });

        // The own-status read still happens — this is the same panel, mounted.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.getByText('Your acknowledgement')).toBeTruthy();
        expect(screen.queryByTestId('policy-ack-roster')).toBeNull();
        expect(rosterRequested()).toBe(false);
        expect(screen.queryByTestId('policy-request-ack-button')).toBeNull();
    });
});
