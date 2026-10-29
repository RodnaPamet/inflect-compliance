/**
 * The Evidence library says why the server refused, and offers the details
 * panel's link picker and unlink cross only where their routes accept them
 * (#4326).
 *
 *   - A refused review (segregation of duties, an illegal transition, a
 *     missing rejection reason) toasts the SERVER's reason. The mutation threw
 *     "Review action failed" on any non-OK answer without reading the body,
 *     so every refusal read the same. A request that got no answer keeps the
 *     generic sentence.
 *   - A refused "Link control" in the details panel shows the server's reason
 *     (e.g. a control from another tenant), not only "Failed to link control".
 *   - The unlink cross and the link picker follow `controls.edit`, which the
 *     unlink and link routes both require, as well as the coarse write tier.
 *     An EDITOR-based custom role without `controls.edit` was shown the cross
 *     and refused on click; linking now takes the same key (owner decision).
 *
 * Mounts the REAL `EvidenceClient` (fetch faked by path; see
 * `./evidence-client-harness`).
 */
import * as React from 'react';
import { act, configure, fireEvent, screen, waitFor } from '@testing-library/react';

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
// The control picker is a plain input here: the test is about what happens
// after a control is chosen, not about the picker.
jest.mock('@/components/ui/entity-picker', () => ({
    EntityPicker: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    ),
}));

const toastError = jest.fn();
jest.mock('sonner', () => {
    const actual = jest.requireActual('sonner');
    return {
        ...actual,
        toast: Object.assign((...a: unknown[]) => actual.toast(...a), {
            ...actual.toast,
            error: (...a: unknown[]) => toastError(...a),
        }),
    };
});

import {
    COARSE,
    GRANTS,
    enText,
    evidenceRow,
    installEvidenceFetch,
    makeServer,
    mountEvidenceClient,
    type EvidenceServer,
} from './evidence-client-harness';

const REVIEW_FAILED = enText('evidence.list.reviewFailed');

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
    toastError.mockClear();
});

const LINKS = [
    { id: 'l1', controlId: 'c1', control: { id: 'c1', name: 'Access control', annexId: 'A.5.15', code: null } },
];

function detailOf(row: ReturnType<typeof evidenceRow>, links: unknown[] = []) {
    return () => ({
        ...row,
        fileSize: 10,
        taskId: null,
        riskId: null,
        assetId: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        evidenceControlLinks: links,
        fileRecord: { id: 'fr-1', originalName: 'export.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'c'.repeat(64), retentionUntil: null, scanStatus: 'CLEAN' },
        reviews: [],
        tags: [],
    });
}

const toasted = () => toastError.mock.calls.map((c) => c[0]);

describe('a refused review says why', () => {
    it('Approve refused for segregation of duties toasts the server reason', async () => {
        const message = 'You cannot review evidence you submitted. Segregation of duties requires a different reviewer.';
        const row = evidenceRow({ status: 'SUBMITTED' });
        const server = makeServer({
            rows: [row],
            mutate: (call) =>
                call.path === `/evidence/${row.id}/review`
                    ? { status: 403, body: { error: { code: 'FORBIDDEN', message } } }
                    : undefined,
        });
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'ADMIN' });

        const [approve] = await screen.findAllByLabelText(enText('evidence.approveEvidence'));
        await act(async () => {
            fireEvent.click(approve);
        });
        await waitFor(() => expect(toasted()).toContain(message));
        expect(toasted()).not.toContain(REVIEW_FAILED);
    });

    it('Submit refused as an illegal transition toasts the server reason', async () => {
        const message = 'Illegal evidence transition SUBMITTED → SUBMITTED. From SUBMITTED the only legal next states are: APPROVED, REJECTED.';
        const row = evidenceRow({ status: 'DRAFT' });
        const server = makeServer({
            rows: [row],
            mutate: (call) =>
                call.path === `/evidence/${row.id}/review`
                    ? { status: 400, body: { error: { code: 'BAD_REQUEST', message } } }
                    : undefined,
        });
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'EDITOR' });

        const [submit] = await screen.findAllByLabelText(enText('evidence.submitForReview'));
        await act(async () => {
            fireEvent.click(submit);
        });
        await waitFor(() => expect(toasted()).toContain(message));
    });

    it('a review that got no answer keeps the generic sentence', async () => {
        const row = evidenceRow({ status: 'DRAFT' });
        const server = makeServer({ rows: [row] });
        installEvidenceFetch(server);
        const answered = global.fetch;
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith(`/evidence/${row.id}/review`)) throw new TypeError('Failed to fetch');
            return answered(input, init);
        }) as unknown as typeof fetch;
        mountEvidenceClient(server, { role: 'EDITOR' });

        const [submit] = await screen.findAllByLabelText(enText('evidence.submitForReview'));
        await act(async () => {
            fireEvent.click(submit);
        });
        await waitFor(() => expect(toasted()).toContain(REVIEW_FAILED));
        expect(toasted()).not.toContain('Failed to fetch');
    });
});

describe('a refused "Link control" in the details panel says why', () => {
    it('shows the server reason, not only "Failed to link control"', async () => {
        const message = 'Control not found or belongs to a different tenant';
        const row = evidenceRow();
        const server: EvidenceServer = makeServer({
            rows: [row],
            detail: detailOf(row),
            mutate: (call) =>
                call.method === 'POST' && call.path === `/evidence/${row.id}/controls`
                    ? { status: 400, body: { error: { code: 'INVALID_CONTROL', message } } }
                    : undefined,
        });
        installEvidenceFetch(server);
        mockSearchParams.set('ev', row.id);
        mountEvidenceClient(server, { role: 'EDITOR' });

        await screen.findByTestId('evidence-sheet-controls');
        const picker = (await waitFor(() => {
            const el = document.getElementById('evidence-link-control-input');
            if (!el) throw new Error('link picker not rendered');
            return el;
        })) as HTMLInputElement;
        fireEvent.change(picker, { target: { value: 'c-foreign' } });
        await act(async () => {
            fireEvent.click(document.getElementById('evidence-link-control-btn')!);
        });
        const alert = await screen.findByText(message);
        expect(alert).toHaveAttribute('role', 'alert');
        expect(screen.queryByText(enText('evidence.detail.linkControlFailed'))).toBeNull();
    });
});

describe('the details panel offers the link picker and unlink cross only with controls.edit', () => {
    async function openPanel(opts: Parameters<typeof mountEvidenceClient>[1]) {
        const row = evidenceRow();
        const server = makeServer({ rows: [row], detail: detailOf(row, LINKS) });
        installEvidenceFetch(server);
        mockSearchParams.set('ev', row.id);
        mountEvidenceClient(server, opts);
        await screen.findByText('A.5.15: Access control');
    }

    it('an EDITOR-based custom role without controls.edit sees neither the cross nor the link picker', async () => {
        await openPanel({ permissions: COARSE.EDITOR, grants: { ...GRANTS.EDITOR, controlsEdit: false, tasksCreate: true, tasksEdit: true } });
        expect(document.getElementById('unlink-control-c1')).toBeNull();
        // The link route requires controls.edit too, so the picker goes with the cross.
        expect(document.getElementById('evidence-link-control-btn')).toBeNull();
        expect(document.getElementById('evidence-link-control-input')).toBeNull();
    });

    it('a built-in EDITOR keeps the cross and the link picker', async () => {
        await openPanel({ role: 'EDITOR' });
        expect(document.getElementById('unlink-control-c1')).not.toBeNull();
        expect(document.getElementById('evidence-link-control-btn')).not.toBeNull();
    });

    it('a READER sees neither', async () => {
        await openPanel({ role: 'READER' });
        expect(document.getElementById('unlink-control-c1')).toBeNull();
        expect(document.getElementById('evidence-link-control-btn')).toBeNull();
    });
});
