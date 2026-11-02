/**
 * A refused archive or unarchive says why, and never shows a reader the HTTP
 * status (#4966). With no reason from the server, the page's own sentence.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useToast: () => ({ error: toastError, success: jest.fn(), info: jest.fn() }),
    };
});

import { TooltipProvider } from '@/components/ui/tooltip';
import { EvidenceClient } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceClient';
import { __setConfettiForTest } from '@inflect/ui/components/ui/hooks/use-celebration';

type Row = React.ComponentProps<typeof EvidenceClient>['initialEvidence'][number];

const base = {
    type: 'TEXT',
    status: 'DRAFT',
    fileName: null,
    owner: null,
    ownerUserId: null,
    ownerUser: null,
    folder: null,
    deletedAt: null,
    retentionUntil: null,
    nextReviewDate: null,
    reviewCycle: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    dateCollected: '2026-10-01T00:00:00.000Z',
    fileRecordId: null,
    content: 'note',
    category: null,
    controlLinks: [],
};
const STUCK = {
    ...base,
    id: 'ev-stuck',
    title: 'Lapsed access review',
    isArchived: false,
    expiredAt: '2026-09-01T00:00:00.000Z',
} as unknown as Row;
const LIVE = {
    ...base,
    id: 'ev-live',
    title: 'Current access review',
    isArchived: false,
    expiredAt: null,
} as unknown as Row;

const METRICS = {
    total: 2,
    byStatus: { DRAFT: 2, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
    expiring: 0,
    expired: 1,
    archived: 0,
} as unknown as React.ComponentProps<typeof EvidenceClient>['initialMetrics'];

let answerArchive: { status: number; body: unknown } = { status: 200, body: {} };
const calls: Array<{ path: string; method: string }> = [];

beforeEach(() => {
    toastError.mockReset();
    __setConfettiForTest(() => Promise.resolve(null));
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme');
    calls.length = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'https://test.local').pathname;
        calls.push({ path, method: init?.method ?? 'GET' });
        let body: unknown = {};
        let status = 200;
        if (path.endsWith('/evidence')) body = { rows: [STUCK, LIVE], truncated: false };
        else if (path.endsWith('/evidence/retention')) body = METRICS;
        else if (path.endsWith('/archive') && init?.method === 'POST') {
            status = answerArchive.status;
            body = answerArchive.body;
        }
        return {
            ok: status < 400,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});


function mount() {
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <EvidenceClient
                    initialEvidence={[STUCK, LIVE]}
                    initialControls={[]}
                    controlsComplete
                    canViewControls
                    initialMetrics={METRICS}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true }}
                    // An Editor's grants, as the server page passes them.
                    grants={{ evidenceEdit: true, evidenceUpload: true, adminManage: false, controlsEdit: true, tasksCreate: true, tasksEdit: true }}
                    translations={{}}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

async function archiveLiveRow() {
    mount();
    await screen.findByText('Current access review');
    await act(async () => {
        fireEvent.click(document.getElementById('archive-ev-live') as HTMLElement);
    });
}

const EN = require('../../messages/en.json');

it("a refused archive shows the server's reason", async () => {
    answerArchive = {
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'Evidence under legal hold cannot be archived', requestId: 'r1' } },
    };
    await archiveLiveRow();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Evidence under legal hold cannot be archived'));
});

it('with no reason, the page sentence and no status code', async () => {
    answerArchive = { status: 500, body: {} };
    await archiveLiveRow();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(EN.evidence.list.archiveFailed));
    expect(toastError.mock.calls.flat().join(' ')).not.toMatch(/500/);
});
