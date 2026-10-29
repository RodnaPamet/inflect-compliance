/**
 * Shared harness for rendered tests that mount the REAL Evidence library
 * client (`EvidenceClient`). Not a test file itself.
 *
 * The client reads every list, the KPI aggregate, the detail sheet and the
 * controls list through `fetch`; `installEvidenceFetch` answers each by path
 * from one fixture and records every request, so a test can say both what the
 * page shows and what it asked the server for.
 *
 * The `jest.mock` calls a test needs must live in the test file itself (Jest
 * hoists them per file), so `EVIDENCE_CLIENT_MOCKS` documents them rather than
 * declaring them.
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { TooltipProvider } from '@/components/ui/tooltip';
import { __setConfettiForTest } from '@inflect/ui/components/ui/hooks/use-celebration';
import { EvidenceClient } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceClient';

type Props = React.ComponentProps<typeof EvidenceClient>;
export type EvidenceRowFixture = Props['initialEvidence'][number];

export const EN = require('../../messages/en.json') as Record<string, unknown>;

/** Walk a dotted path into en.json. */
export function enText(path: string): string {
    const v = path
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN);
    if (typeof v !== 'string') throw new Error(`no en.json string at ${path}`);
    return v;
}

export const COARSE = {
    ADMIN: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    EDITOR: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    READER: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
} as const;

/** The appPermissions grants the page reads, as the built-in roles hold them. */
export const GRANTS = {
    // `tasksCreate` / `tasksEdit` since #4415 — the detail sheet's linked-tasks
    // panel asks them separately. Set as the built-in roles hold them.
    ADMIN: { evidenceEdit: true, evidenceUpload: true, adminManage: true, controlsEdit: true, tasksCreate: true, tasksEdit: true },
    EDITOR: { evidenceEdit: true, evidenceUpload: true, adminManage: false, controlsEdit: true, tasksCreate: true, tasksEdit: true },
    READER: { evidenceEdit: false, evidenceUpload: false, adminManage: false, controlsEdit: false, tasksCreate: false, tasksEdit: false },
} as const;

export function evidenceRow(overrides: Partial<EvidenceRowFixture> = {}): EvidenceRowFixture {
    return {
        id: 'ev-1',
        title: 'Access review export',
        type: 'FILE',
        status: 'DRAFT',
        fileName: 'export.pdf',
        owner: null,
        ownerUserId: null,
        ownerUser: null,
        folder: null,
        isArchived: false,
        expiredAt: null,
        deletedAt: null,
        retentionUntil: null,
        nextReviewDate: null,
        reviewCycle: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
        dateCollected: '2026-10-01T00:00:00.000Z',
        fileRecordId: 'fr-1',
        content: 'tenants/t1/evidence/2026/10/abc_export.pdf',
        category: null,
        evidenceControlLinks: [],
        fileRecord: { id: 'fr-1', mimeType: 'application/pdf', scanStatus: 'CLEAN' },
        tags: [],
        ...overrides,
    };
}

export function metrics(overrides: Partial<Props['initialMetrics']> = {}): Props['initialMetrics'] {
    return {
        total: 1,
        byStatus: { DRAFT: 1, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
        active: 1,
        archived: 0,
        archivedView: 0,
        expiringSoon: 0,
        expired: 0,
        needsReview: 0,
        current: 1,
        ...overrides,
    };
}

export interface FetchCall {
    method: string;
    path: string;
    search: string;
    body: unknown;
}

export interface EvidenceServer {
    /** Rows `/evidence` answers with (every list variant). */
    rows: EvidenceRowFixture[];
    /** `/evidence/retention` (the KPI aggregate). */
    metrics: Props['initialMetrics'];
    /** `/evidence/<id>` — return undefined for a 404. */
    detail: (id: string) => Record<string, unknown> | undefined;
    /** `/controls` rows. */
    controls: Array<{ id: string; name: string; code: string | null; annexId: string | null }>;
    /** Override any POST/PUT/DELETE. Return undefined to fall through to `{}` 200. */
    mutate?: (call: FetchCall) => { status: number; body: unknown } | undefined;
    calls: FetchCall[];
}

export function makeServer(partial: Partial<Omit<EvidenceServer, 'calls'>> = {}): EvidenceServer {
    return {
        rows: [evidenceRow()],
        metrics: metrics(),
        detail: () => undefined,
        controls: [],
        ...partial,
        calls: [],
    };
}

function respond(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

export function installEvidenceFetch(server: EvidenceServer): void {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        const method = (init?.method ?? 'GET').toUpperCase();
        let body: unknown;
        if (typeof init?.body === 'string') {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        const path = url.pathname.replace(/^\/api\/t\/acme/, '');
        const call: FetchCall = { method, path, search: url.search, body };
        server.calls.push(call);

        if (method !== 'GET') {
            const r = server.mutate?.(call);
            return r ? respond(r.status, r.body) : respond(200, {});
        }
        if (path === '/evidence') return respond(200, { rows: server.rows, truncated: false });
        if (path === '/evidence/retention') return respond(200, server.metrics);
        if (path === '/controls') return respond(200, { rows: server.controls, truncated: false });
        const detail = path.match(/^\/evidence\/([^/]+)$/);
        if (detail) {
            const d = server.detail(detail[1]);
            return d
                ? respond(200, d)
                : respond(404, { error: { code: 'NOT_FOUND', message: 'Evidence not found' } });
        }
        if (/^\/evidence\/[^/]+\/file-versions$/.test(path)) {
            return respond(200, { fileVersion: 1, versions: [] });
        }
        return respond(200, {});
    }) as unknown as typeof fetch;
}

export interface MountOptions {
    role?: keyof typeof COARSE;
    permissions?: Props['permissions'];
    grants?: Props['grants'];
    initialEvidence?: EvidenceRowFixture[];
    initialControls?: Props['initialControls'];
    controlsComplete?: boolean;
    canViewControls?: boolean;
    initialMetrics?: Props['initialMetrics'];
}

/** Every translation key the server page passes, resolved from en.json. */
const translations = new Proxy({} as Props['translations'], {
    get: (_t, key) => {
        try {
            return enText(`evidence.${String(key)}`);
        } catch {
            return String(key);
        }
    },
});

export function mountEvidenceClient(server: EvidenceServer, opts: MountOptions = {}) {
    const role = opts.role ?? 'ADMIN';
    // The default fixture is "all evidence current", which fires the page's
    // celebration; jsdom has no canvas for the real confetti.
    __setConfettiForTest(() => null);
    window.sessionStorage.clear();
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <EvidenceClient
                    initialEvidence={opts.initialEvidence ?? server.rows}
                    initialControls={opts.initialControls ?? server.controls}
                    controlsComplete={opts.controlsComplete ?? true}
                    canViewControls={opts.canViewControls ?? true}
                    initialMetrics={opts.initialMetrics ?? server.metrics}
                    tenantSlug="acme"
                    permissions={opts.permissions ?? COARSE[role]}
                    grants={opts.grants ?? GRANTS[role]}
                    translations={translations}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}
