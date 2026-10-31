/** @jest-environment jsdom */

/**
 * #4649 — gated Trust Center documents can be added, requested and approved
 * through the product.
 *
 * The server side was complete — upload, public request, admin list and
 * approve, single-use download — and no screen called any of it. These are
 * the two halves: the administrator's section on the Trust Center admin page,
 * and the visitor's request form on the public page.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        success: (...a: unknown[]) => toastSuccess(...a),
        error: (...a: unknown[]) => toastError(...a),
        info: jest.fn(), warning: jest.fn(), dismiss: jest.fn(), custom: jest.fn(), message: jest.fn(), loading: jest.fn(),
    }),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            if (typeof val !== 'string') return key;
            return val.replace(/\{(\w+)\}/g, (m: string, name: string) =>
                params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
            );
        };
        t.has = (k: string) => typeof lookup(ns, k) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/trust-center',
    useSearchParams: () => new URLSearchParams(),
}));

import { SWRConfig } from 'swr';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';
import { GatedDocumentsAdmin } from '@/app/t/[tenantSlug]/(app)/admin/trust-center/GatedDocumentsAdmin';
import { GatedDocumentRequests } from '@/app/trust/[slug]/GatedDocumentRequests';

const en = jest.requireActual('../../messages/en.json');
const A = en.admin.trustCenter.gated;
const P = en.external.trustCenter.gated;

type Reply = { status?: number; body: unknown };
type Route = (url: string, init?: RequestInit) => Reply | undefined;
let routes: Route[] = [];
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const r of routes) {
        const reply = r(String(url), init);
        if (reply) {
            const status = reply.status ?? 200;
            return { ok: status < 400, status, json: async () => reply.body } as unknown as Response;
        }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as unknown as Response;
});
const on = (method: string, re: RegExp, reply: Reply): Route => (u, i) =>
    (i?.method ?? 'GET') === method && re.test(u) ? reply : undefined;

beforeEach(() => {
    routes = [];
    fetchMock.mockClear();
    toastSuccess.mockReset();
    toastError.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

const TENANT = {
    userId: 'u-1', tenantId: 't-1', tenantSlug: 'acme', tenantName: 'Acme', role: 'ADMIN' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('ADMIN'),
    modules: { processCanvas: false },
};

function mountAdmin() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT}>
                <TooltipProvider>
                    <GatedDocumentsAdmin tenantSlug="acme" />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

const REQUEST = {
    id: 'req-1', requesterName: 'Grace Hopper', requesterEmail: 'grace@navy.example', company: 'Navy',
    status: 'REQUESTED', ndaSignedAt: '2026-10-30T00:00:00.000Z', expiresAt: null, downloadedAt: null,
    createdAt: '2026-10-30T00:00:00.000Z', document: { label: 'SOC 2 Type II' },
};

describe('the admin section (#4649)', () => {
    it('lists the gated documents and the requests, with their status in words', async () => {
        routes = [
            on('GET', /\/admin\/trust-center\/documents$/, { body: { documents: [{ id: 'd-1', label: 'SOC 2 Type II', gated: true, createdAt: '2026-10-01T00:00:00.000Z' }] } }),
            on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [REQUEST] } }),
        ];
        mountAdmin();
        const list = await waitFor(() => {
            const el = document.getElementById('trust-gated-list');
            if (!el?.textContent?.includes('SOC 2 Type II')) throw new Error('not yet');
            return el;
        });
        expect(list.textContent).toContain('SOC 2 Type II');
        const row = await waitFor(() => {
            const el = document.getElementById('trust-request-row-req-1');
            if (!el) throw new Error('not yet');
            return el;
        });
        expect(row.textContent).toContain('Grace Hopper · grace@navy.example · Navy');
        expect(row.textContent).toContain(A.status.REQUESTED);
        expect(row.textContent).toContain(A.ndaAccepted);
        expect(row.textContent).not.toContain('REQUESTED');
    });

    it('uploads the file, then adds it as a gated document', async () => {
        routes = [
            on('GET', /\/admin\/trust-center\/documents$/, { body: { documents: [] } }),
            on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [] } }),
            on('POST', /\/evidence\/uploads$/, { status: 201, body: { id: 'ev-1', fileRecord: { id: 'file-1' } } }),
            on('POST', /\/admin\/trust-center\/documents$/, { status: 201, body: { id: 'd-1' } }),
        ];
        mountAdmin();
        await screen.findByText(A.emptyDocuments);
        fireEvent.change(document.getElementById('trust-gated-label') as HTMLInputElement, { target: { value: 'Pentest summary' } });
        fireEvent.change(document.getElementById('trust-gated-file') as HTMLInputElement, {
            target: { files: [new File(['pdf'], 'pentest.pdf', { type: 'application/pdf' })] },
        });
        await act(async () => { fireEvent.click(document.getElementById('trust-gated-upload') as HTMLElement); });
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(A.added, expect.anything()));

        const upload = fetchMock.mock.calls.find(([u, i]) => /\/evidence\/uploads$/.test(String(u)) && i?.method === 'POST');
        const form = upload![1]!.body as FormData;
        expect((form.get('file') as File).name).toBe('pentest.pdf');
        expect(form.get('title')).toBe('Pentest summary');
        const add = fetchMock.mock.calls.find(([u, i]) => /\/admin\/trust-center\/documents$/.test(String(u)) && i?.method === 'POST');
        expect(JSON.parse(String(add![1]!.body))).toEqual({ label: 'Pentest summary', fileRecordId: 'file-1', gated: true });
    });

    it("shows the server's reason when the document cannot be added", async () => {
        routes = [
            on('GET', /\/admin\/trust-center\/documents$/, { body: { documents: [] } }),
            on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [] } }),
            on('POST', /\/evidence\/uploads$/, { status: 201, body: { fileRecord: { id: 'file-1' } } }),
            on('POST', /\/admin\/trust-center\/documents$/, { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Create the trust center before adding documents.' } } }),
        ];
        mountAdmin();
        await screen.findByText(A.emptyDocuments);
        fireEvent.change(document.getElementById('trust-gated-label') as HTMLInputElement, { target: { value: 'SOC 2' } });
        fireEvent.change(document.getElementById('trust-gated-file') as HTMLInputElement, { target: { files: [new File(['x'], 'soc2.pdf')] } });
        await act(async () => { fireEvent.click(document.getElementById('trust-gated-upload') as HTMLElement); });
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Create the trust center before adding documents.', expect.anything()));
    });

    it('approving shows the single-use link once, with copy and email', async () => {
        routes = [
            on('GET', /\/admin\/trust-center\/documents$/, { body: { documents: [] } }),
            on('GET', /\/admin\/trust-center\/requests$/, { body: { requests: [REQUEST] } }),
            on('POST', /\/requests\/req-1\/approve$/, { body: { requestId: 'req-1', downloadToken: 'ictc_abc123' } }),
        ];
        mountAdmin();
        const approveBtn = await waitFor(() => {
            const el = document.getElementById('trust-approve-req-1');
            if (!el) throw new Error('not yet');
            return el;
        });
        await act(async () => { fireEvent.click(approveBtn); });
        const panel = await waitFor(() => {
            const el = document.getElementById('trust-issued-link');
            if (!el) throw new Error('not yet');
            return el;
        });
        const url = `${window.location.origin}/api/trust/download/ictc_abc123`;
        expect(panel.textContent).toContain(url);
        expect(panel.textContent).toContain(A.linkHint.replace('{email}', 'grace@navy.example'));
        const mail = within(panel).getByRole('link', { name: A.emailLink }).getAttribute('href') ?? '';
        expect(mail.startsWith('mailto:grace%40navy.example?')).toBe(true);
        expect(decodeURIComponent(mail)).toContain(url);

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: A.dismissLink })); });
        expect(document.getElementById('trust-issued-link')).toBeNull();
    });
});

describe('the public request form (#4649)', () => {
    const DOCS = [{ id: 'd-1', label: 'SOC 2 Type II' }];

    function open(ndaRequired = false) {
        render(<GatedDocumentRequests slug="acme" ndaRequired={ndaRequired} documents={DOCS} />);
        fireEvent.click(screen.getByRole('button', { name: P.request }));
        const form = document.getElementById('trust-request-form-d-1') as HTMLFormElement;
        const inputs = form.querySelectorAll('input');
        fireEvent.change(inputs[0], { target: { value: 'Grace Hopper' } });
        fireEvent.change(inputs[1], { target: { value: 'grace@navy.example' } });
        return form;
    }

    it('sends the request and says only that it was received', async () => {
        routes = [on('POST', /\/api\/trust\/acme\/access-request$/, { status: 201, body: { status: 'REQUESTED' } })];
        const form = open();
        await act(async () => { fireEvent.submit(form); });
        expect(await screen.findByText(P.received)).toBeTruthy();
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({
            documentId: 'd-1', requesterName: 'Grace Hopper', requesterEmail: 'grace@navy.example',
        });
        expect(screen.queryByRole('button', { name: P.request })).toBeNull();
    });

    it('says a withdrawn document is no longer offered, not "not_found"', async () => {
        routes = [on('POST', /\/access-request$/, { status: 404, body: { error: 'not_found' } })];
        const form = open();
        await act(async () => { fireEvent.submit(form); });
        expect((await screen.findByRole('alert')).textContent).toBe(P.unavailable);
    });

    it('requires the NDA box when the trust center asks for it', async () => {
        routes = [on('POST', /\/access-request$/, { status: 201, body: { status: 'REQUESTED' } })];
        const form = open(true);
        const submit = within(form).getByRole('button', { name: P.submit });
        expect(submit).toBeDisabled();
        fireEvent.click(within(form).getByRole('checkbox'));
        expect(submit).toBeEnabled();
        await act(async () => { fireEvent.submit(form); });
        await screen.findByText(P.received);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({ ndaAccepted: true });
    });
});
