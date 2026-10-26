/**
 * What the Evidence library reads, and what it then says (#4277).
 *
 *   - Reviewing or editing from the details panel refreshes the PANEL. The
 *     review and the edit invalidated list keys only, and the panel reads
 *     `/evidence/<id>`, so it kept the old status and buttons — a second
 *     Submit was then refused as an illegal transition.
 *   - "No evidence yet" is said only when there is none. The default list is
 *     the Active bucket, so a tenant whose evidence is all archived or
 *     expired was told it had none while the Total card counted it.
 *   - The control pickers and the Linked control filter reach every control.
 *     The page held the SSR slice (the first 100) in state and never fetched
 *     the rest; it now does when the server says the slice is short.
 */
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            // Just enough ICU for `{count, plural, one {…} other {…}}`.
            const plural = v.replace(
                /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
                (_m, name, one, other) => {
                    const n = Number(values?.[name]);
                    return (n === 1 ? one : other).replace('#', String(n));
                },
            );
            return plural.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// `mock`-prefixed so the hoisted factory may read it; one instance, as the
// real hook returns a stable object.
const mockSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/evidence',
        useSearchParams: () => mockSearchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/LinkedTasksPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/user-combobox', () => ({ UserCombobox: () => null }));

import {
    enText,
    evidenceRow,
    installEvidenceFetch,
    makeServer,
    metrics,
    mountEvidenceClient,
    type EvidenceServer,
} from './evidence-client-harness';

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
});

function detailOf(row: ReturnType<typeof evidenceRow>, status: { value: string }, title: { value: string }) {
    return () => ({
        ...row,
        title: title.value,
        status: status.value,
        fileSize: 10,
        taskId: null,
        riskId: null,
        assetId: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        evidenceControlLinks: [],
        fileRecord: { id: 'fr-1', originalName: 'export.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'c'.repeat(64), retentionUntil: null, scanStatus: 'CLEAN' },
        reviews: [],
        tags: [],
    });
}

const gets = (server: EvidenceServer, path: string) =>
    server.calls.filter((c) => c.method === 'GET' && c.path === path).length;

describe('the details panel refreshes after a review or an edit made from it', () => {
    it('Submit moves the open panel to Submitted, and its Submit button goes', async () => {
        const row = evidenceRow();
        const status = { value: 'DRAFT' };
        const title = { value: row.title };
        const server = makeServer({
            rows: [row],
            detail: detailOf(row, status, title),
            mutate: (call) => {
                if (call.path === `/evidence/${row.id}/review`) {
                    status.value = (call.body as { action: string }).action;
                    return { status: 200, body: { success: true, status: status.value } };
                }
                return undefined;
            },
        });
        installEvidenceFetch(server);
        mockSearchParams.set('ev', row.id);
        mountEvidenceClient(server, { role: 'EDITOR' });

        const submit = await screen.findByRole('button', { name: enText('evidence.detail.submitForReview') });
        const before = gets(server, `/evidence/${row.id}`);
        await act(async () => {
            fireEvent.click(submit);
        });
        await waitFor(() => expect(gets(server, `/evidence/${row.id}`)).toBeGreaterThan(before));
        await waitFor(() =>
            expect(document.getElementById('evidence-sheet-status')).toHaveTextContent(
                enText('evidence.statusLabels.SUBMITTED'),
            ),
        );
        expect(document.getElementById('evidence-sheet-submit-btn')).toBeNull();
    });

    it('Save in the edit modal opened from the panel shows the new title in the panel', async () => {
        const row = evidenceRow();
        const status = { value: 'DRAFT' };
        const title = { value: row.title };
        const server = makeServer({
            rows: [row],
            detail: detailOf(row, status, title),
            mutate: (call) => {
                if (call.method === 'PUT' && call.path === `/evidence/${row.id}`) {
                    title.value = (call.body as { title: string }).title;
                    return { status: 200, body: {} };
                }
                return undefined;
            },
        });
        installEvidenceFetch(server);
        mockSearchParams.set('ev', row.id);
        mountEvidenceClient(server, { role: 'EDITOR' });

        fireEvent.click(await screen.findByRole('button', { name: enText('evidence.detail.editAria') }));
        const input = (await waitFor(() => {
            const el = document.getElementById('edit-evidence-title-input');
            if (!el) throw new Error('edit modal not open');
            return el;
        })) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'Access review export — signed' } });
        await act(async () => {
            fireEvent.click(document.getElementById('edit-evidence-submit-btn')!);
        });
        const sheet = await screen.findByTestId('evidence-sheet-controls');
        await waitFor(() =>
            expect(within(sheet.closest('[role="dialog"]') ?? document.body).getAllByText('Access review export — signed').length).toBeGreaterThan(0),
        );
    });
});

describe('the empty state', () => {
    it('says "No active evidence" (not "No evidence yet") when everything is archived or expired', async () => {
        const server = makeServer({
            rows: [],
            // The cards count active evidence only, so all of theirs read 0;
            // `archivedView` is what says the library is not empty.
            metrics: metrics({ total: 0, active: 0, archived: 3, archivedView: 3, current: 0, byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, NEEDS_REVIEW: 0 } }),
        });
        installEvidenceFetch(server);
        mountEvidenceClient(server);
        expect(await screen.findByText(enText('evidence.list.emptyActiveTitle'))).toBeInTheDocument();
        expect(screen.queryByText(enText('evidence.noEvidence'))).toBeNull();
        expect(screen.getByRole('button', { name: enText('evidence.list.showArchived') })).toBeInTheDocument();
    });

    it('still says "No evidence yet" for a tenant with none', async () => {
        const server = makeServer({ rows: [], metrics: metrics({ total: 0, active: 0, current: 0, byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, NEEDS_REVIEW: 0 } }) });
        installEvidenceFetch(server);
        mountEvidenceClient(server);
        expect(await screen.findByText(enText('evidence.noEvidence'))).toBeInTheDocument();
        expect(screen.queryByText(enText('evidence.list.emptyActiveTitle'))).toBeNull();
    });
});

describe('the control list reaches every control', () => {
    const control = (n: number) => ({ id: `c${n}`, name: `Control ${n}`, code: `C-${n}`, annexId: null });
    const FIRST_PAGE = Array.from({ length: 100 }, (_, i) => control(i + 1));
    const ALL = Array.from({ length: 150 }, (_, i) => control(i + 1));

    it('fetches the full list when the SSR slice is short, and the upload form counts all 150', async () => {
        const server = makeServer({ controls: ALL });
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'EDITOR', initialControls: FIRST_PAGE, controlsComplete: false });
        await waitFor(() => expect(gets(server, '/controls')).toBe(1));

        // The upload form states how many controls its picker searches —
        // it read "Search across 100 controls" for a tenant with more.
        fireEvent.click(document.getElementById('add-evidence-btn')!);
        fireEvent.click(await screen.findByText(enText('evidence.list.createFileUpload')));
        expect(
            await screen.findByText(/Search across 150 controls/),
        ).toBeInTheDocument();
    });

    it('does not fetch when the SSR slice is already the whole list', async () => {
        const server = makeServer({ controls: FIRST_PAGE });
        installEvidenceFetch(server);
        mountEvidenceClient(server, { initialControls: FIRST_PAGE, controlsComplete: true });
        await screen.findByText(evidenceRow().title);
        expect(gets(server, '/controls')).toBe(0);
    });

    it('does not ask for controls for a role that may not list them', async () => {
        const server = makeServer();
        installEvidenceFetch(server);
        mountEvidenceClient(server, { initialControls: [], controlsComplete: false, canViewControls: false });
        await screen.findByText(evidenceRow().title);
        expect(gets(server, '/controls')).toBe(0);
    });
});
