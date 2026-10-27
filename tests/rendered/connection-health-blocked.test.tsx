/**
 * A connection whose sync has nobody to run as, on the page an admin reads
 * (#4389).
 *
 * The scheduled SharePoint delta sync skips such a connection and reports it in
 * a dispatch result and a `warn` line, neither of which anybody opens. What
 * makes this panel the right place is also what makes it easy to get wrong:
 * every freshness signal it already computes can say the connection is fine. A
 * successful "Test connection" counts as activity, so a connection blocked for
 * days reads `fresh` by `isStale`. The blocked state therefore has to be read
 * BEFORE stale/fresh, not folded into it — that precedence is what these
 * assert, along with the words an admin is actually given.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

// Stable references. A mock that returns a fresh function per render re-runs the
// load effect forever — the panel fetches in a `useCallback` keyed on `apiUrl`.
const apiUrl = (p: string) => `/api/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({ useTenantApiUrl: () => apiUrl }));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, (k: string, p?: Record<string, unknown>) => string>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    const v = walk(walk(en, ns), key);
                    if (typeof v !== 'string') return key;
                    let s = v;
                    for (const [p, val] of Object.entries(params ?? {})) {
                        s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                    }
                    return s;
                });
            }
            return cache.get(ns)!;
        },
    };
});

import { ConnectionHealthPanel } from '@/app/t/[tenantSlug]/(app)/admin/integrations/ConnectionHealthPanel';

const BASE = {
    provider: 'sharepoint',
    name: 'Marketing site',
    lastSuccessAt: null,
    secondsSinceLastSuccess: null,
    hasEverSucceeded: false,
    lastActivityAt: new Date().toISOString(),
    secondsSinceActivity: 60,
    lastTestStatus: 'ok',
    lastTestedAt: new Date().toISOString(),
};

function serve(connections: unknown[], blockedCount = 0) {
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
            connections,
            staleThresholdSeconds: 86_400,
            staleCount: 0,
            blockedCount,
            generatedAt: new Date().toISOString(),
        }),
    })) as unknown as typeof fetch;
}

const loaded = () => waitFor(() => expect(screen.getByText('Marketing site')).toBeInTheDocument());

describe('the integrations health panel shows a connection that cannot sync', () => {
    it('names the reason in words, not as a stored token', async () => {
        serve([{ ...BASE, connectionId: 'c1', isStale: false,
            syncBlockedAt: new Date().toISOString(), syncBlockedReason: 'NO_ADMIN_WITH_EVIDENCE_UPLOAD' }], 1);
        render(<ConnectionHealthPanel />);
        await loaded();

        expect(screen.getByText(/may upload evidence/i)).toBeInTheDocument();
        expect(screen.queryByText('NO_ADMIN_WITH_EVIDENCE_UPLOAD')).not.toBeInTheDocument();
    });

    it('reads BLOCKED, not fresh, for a connection every freshness signal calls healthy', async () => {
        // isStale false, a recent successful test — fine by every other measure.
        serve([{ ...BASE, connectionId: 'c1', isStale: false,
            syncBlockedAt: new Date().toISOString(), syncBlockedReason: 'NO_ACTIVE_ADMIN' }], 1);
        render(<ConnectionHealthPanel />);
        await loaded();

        expect(screen.getByText('Not syncing')).toBeInTheDocument();
        expect(screen.queryByText('Fresh')).not.toBeInTheDocument();
        expect(screen.getByText(/no active owner or admin/i)).toBeInTheDocument();
    });

    /**
     * The case the PRECEDENCE actually turns on, and the one the first draft of
     * this file could not express: every fixture above has `isStale: false`, so
     * only one branch is ever true and swapping the order changes nothing
     * (measured — the swap left 4/4 green). A connection that is BOTH stale and
     * blocked is where reading stale first costs the admin the reason.
     */
    it('a connection that is stale AND blocked still says why, not just that it is stale', async () => {
        serve([{ ...BASE, connectionId: 'c1', isStale: true,
            syncBlockedAt: new Date().toISOString(), syncBlockedReason: 'NO_ADMIN_WITH_EVIDENCE_UPLOAD' }], 1);
        render(<ConnectionHealthPanel />);
        await loaded();

        expect(screen.getByText('Not syncing')).toBeInTheDocument();
        expect(screen.getByText(/may upload evidence/i)).toBeInTheDocument();
        // "Stale" alone tells an admin to wait; this tells them what to change.
        expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    });

    it('still says something useful for a reason this build has never heard of', async () => {
        serve([{ ...BASE, connectionId: 'c1', isStale: false,
            syncBlockedAt: new Date().toISOString(), syncBlockedReason: 'SOME_FUTURE_REASON' }], 1);
        render(<ConnectionHealthPanel />);
        await loaded();

        expect(screen.getByText('Not syncing')).toBeInTheDocument();
        expect(screen.getByText(/cannot run for this connection/i)).toBeInTheDocument();
        expect(screen.queryByText('SOME_FUTURE_REASON')).not.toBeInTheDocument();
    });

    it('leaves an unblocked connection reading exactly as before', async () => {
        serve([{ ...BASE, connectionId: 'c1', isStale: false, syncBlockedAt: null, syncBlockedReason: null }], 0);
        render(<ConnectionHealthPanel />);
        await loaded();

        expect(screen.queryByText('Not syncing')).not.toBeInTheDocument();
        expect(screen.getByText('Fresh')).toBeInTheDocument();
    });
});
