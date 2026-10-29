/**
 * The Evidence library offers each button only where the server will accept
 * the click (#4277).
 *
 * Mounts the REAL `EvidenceClient` (fetch faked by path; see
 * `./evidence-client-harness`) and reads what each role is offered:
 *
 *   - bulk Delete is ADMIN-tier: `bulkDeleteEvidence` asserts canAdmin and
 *     its route requires `admin.manage`, so an EDITOR is not offered it;
 *   - row and gallery selection exists only where a bulk action does;
 *   - a download (and the gallery preview, which reads the same route) is
 *     not offered on archived evidence, nor to a read-tier role on evidence
 *     linked to no control — both are refused by `downloadEvidenceFile`;
 *   - a custom role's buttons follow its `appPermissions.evidence` grants,
 *     not only the coarse tier of its base role;
 *   - a refused bulk action shows the server's reason.
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
    const make = (ns: string) => {
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const searchParams = new URLSearchParams();
jest.mock('next/navigation', () => {
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
        usePathname: () => '/t/acme/evidence',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

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

const BULK_DELETE = enText('evidence.list.bulkDelete');
const BULK_ASSIGN = enText('evidence.list.bulkAssign');
const BULK_APPROVE = enText('evidence.list.bulkApprove');
const DOWNLOAD = enText('evidence.list.downloadFile');

const ROW = evidenceRow();

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(searchParams.keys())) searchParams.delete(k);
    toastError.mockClear();
});

/** Select the first row, then read the actions the bulk bar offers (null = no selection). */
async function offeredBulkActions(): Promise<string[] | null> {
    await screen.findAllByText(ROW.title);
    const boxes = screen.queryAllByRole('checkbox');
    if (boxes.length === 0) return null;
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = document.getElementById('bulk-action-select');
    if (!select) return [];
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

function mount(server: EvidenceServer, opts: Parameters<typeof mountEvidenceClient>[1] = {}) {
    installEvidenceFetch(server);
    return mountEvidenceClient(server, opts);
}

describe('Evidence list — bulk actions match the server', () => {
    it('an ADMIN is offered Approve, Assign owner and Delete', async () => {
        mount(makeServer(), { role: 'ADMIN' });
        expect(await offeredBulkActions()).toEqual([BULK_APPROVE, BULK_ASSIGN, BULK_DELETE]);
    });

    it('an EDITOR is offered Assign owner, never Delete (the route is admin.manage)', async () => {
        mount(makeServer(), { role: 'EDITOR' });
        expect(await offeredBulkActions()).toEqual([BULK_ASSIGN]);
    });

    it('an ADMIN-tier custom role without admin.manage is not offered Delete', async () => {
        mount(makeServer(), {
            permissions: COARSE.ADMIN,
            grants: { ...GRANTS.ADMIN, adminManage: false },
        });
        expect(await offeredBulkActions()).toEqual([BULK_APPROVE, BULK_ASSIGN]);
    });

    it('a READER gets no row checkboxes at all', async () => {
        mount(makeServer(), { role: 'READER' });
        expect(await offeredBulkActions()).toBeNull();
    });

    it('a refused bulk action shows the server reason, not only "Bulk action failed"', async () => {
        const server = makeServer({
            mutate: (call) =>
                call.path === '/evidence/bulk/assign'
                    ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have permission to edit evidence.' } } }
                    : undefined,
        });
        mount(server, { role: 'EDITOR' });
        await offeredBulkActions();
        fireEvent.click(within(screen.getByRole('listbox')).getByText(BULK_ASSIGN));
        const apply = await screen.findByRole('button', { name: /apply/i });
        await act(async () => {
            fireEvent.click(apply);
        });
        await waitFor(() =>
            expect(toastError.mock.calls.map((c) => c[0])).toContain(
                'You do not have permission to edit evidence.',
            ),
        );
    });
});

describe('Evidence gallery — selection matches the table', () => {
    it('a READER cannot tick gallery cards', async () => {
        window.history.replaceState({}, '', '/t/acme/evidence?view=gallery');
        mount(makeServer(), { role: 'READER' });
        await screen.findByTestId(`evidence-gallery-card-${ROW.id}`);
        expect(screen.queryByTestId(`evidence-gallery-select-${ROW.id}`)).toBeNull();
    });

    it('an EDITOR still can', async () => {
        window.history.replaceState({}, '', '/t/acme/evidence?view=gallery');
        mount(makeServer(), { role: 'EDITOR' });
        expect(await screen.findByTestId(`evidence-gallery-select-${ROW.id}`)).toBeInTheDocument();
    });
});

describe('Evidence list — download is offered only where the route serves it', () => {
    const unlinked = evidenceRow({ id: 'ev-unlinked', title: 'Unlinked export' });
    const linked = evidenceRow({
        id: 'ev-linked',
        title: 'Linked export',
        fileRecordId: 'fr-2',
        evidenceControlLinks: [{ control: { id: 'c1', name: 'Access control', annexId: 'A.5.15', code: null } }],
    });
    const archived = evidenceRow({ id: 'ev-archived', title: 'Archived export', fileRecordId: 'fr-3', isArchived: true });

    it('a READER gets no download on evidence linked to no control, and keeps it on linked evidence', async () => {
        mount(makeServer({ rows: [unlinked, linked] }), { role: 'READER' });
        await screen.findByText('Linked export');
        expect(document.getElementById('download-ev-unlinked')).toBeNull();
        expect(document.getElementById('download-ev-linked')).not.toBeNull();
    });

    it('an EDITOR keeps the download on unlinked evidence (the write tier may)', async () => {
        mount(makeServer({ rows: [unlinked] }), { role: 'EDITOR' });
        await screen.findByText('Unlinked export');
        expect(document.getElementById('download-ev-unlinked')).not.toBeNull();
    });

    it('nobody is offered a download on archived evidence', async () => {
        mount(makeServer({ rows: [archived] }), { role: 'ADMIN' });
        await screen.findByText('Archived export');
        expect(document.getElementById('download-ev-archived')).toBeNull();
        expect(screen.queryByLabelText(DOWNLOAD)).toBeNull();
    });

    it('the gallery loads no preview and offers no download for a refused file', async () => {
        window.history.replaceState({}, '', '/t/acme/evidence?view=gallery');
        const image = evidenceRow({
            id: 'ev-img',
            title: 'Screenshot',
            fileName: 'shot.png',
            fileRecordId: 'fr-img',
            fileRecord: { id: 'fr-img', mimeType: 'image/png', scanStatus: 'CLEAN' },
        });
        mount(makeServer({ rows: [image] }), { role: 'READER' });
        await screen.findByTestId('evidence-gallery-card-ev-img');
        expect(screen.queryByTestId('evidence-gallery-thumb-ev-img')).toBeNull();
        expect(screen.queryByTestId('evidence-gallery-download-ev-img')).toBeNull();
    });
});

describe('Evidence list — a custom role follows its evidence grants', () => {
    // EDITOR base, so the coarse tier reads canWrite — but the role may not
    // edit or upload evidence, and every one of these usecases checks that.
    const viewOnly = { evidenceEdit: false, evidenceUpload: false, adminManage: false, controlsEdit: true, tasksCreate: true, tasksEdit: true };

    it('no Add evidence menu, Edit, Archive or Submit for a role without evidence.edit / upload', async () => {
        mount(makeServer(), { permissions: COARSE.EDITOR, grants: viewOnly });
        await screen.findByText(ROW.title);
        expect(document.getElementById('add-evidence-btn')).toBeNull();
        expect(document.getElementById(`edit-evidence-${ROW.id}`)).toBeNull();
        expect(document.getElementById(`archive-${ROW.id}`)).toBeNull();
        expect(screen.queryByLabelText(enText('evidence.submitForReview'))).toBeNull();
    });

    it('upload-only: the menu offers file upload and ZIP import, not a note or a link', async () => {
        mount(makeServer(), {
            permissions: COARSE.EDITOR,
            grants: { ...viewOnly, evidenceUpload: true },
        });
        await screen.findByText(ROW.title);
        fireEvent.click(document.getElementById('add-evidence-btn')!);
        await screen.findByText(enText('evidence.list.createFileUpload'));
        expect(screen.getByText(enText('evidence.list.createBulkImport'))).toBeInTheDocument();
        expect(screen.queryByText(enText('evidence.list.createTextNote'))).toBeNull();
        expect(screen.queryByText(enText('evidence.list.createLink'))).toBeNull();
    });

    it('a built-in EDITOR keeps every create path and the row buttons', async () => {
        mount(makeServer(), { role: 'EDITOR' });
        await screen.findByText(ROW.title);
        expect(document.getElementById(`edit-evidence-${ROW.id}`)).not.toBeNull();
        expect(document.getElementById(`archive-${ROW.id}`)).not.toBeNull();
        fireEvent.click(document.getElementById('add-evidence-btn')!);
        await screen.findByText(enText('evidence.list.createTextNote'));
        expect(screen.getByText(enText('evidence.list.createLink'))).toBeInTheDocument();
        expect(screen.getByText(enText('evidence.list.createFileUpload'))).toBeInTheDocument();
    });
});

describe('Evidence gallery — a thumbnail is a preview, not a download', () => {
    it('loads the image with ?purpose=preview and keeps the download link a download', async () => {
        window.history.replaceState({}, '', '/t/acme/evidence?view=gallery');
        const image = evidenceRow({
            id: 'ev-img',
            title: 'Screenshot',
            fileName: 'shot.png',
            fileRecordId: 'fr-img',
            fileRecord: { id: 'fr-img', mimeType: 'image/png', scanStatus: 'CLEAN' },
        });
        mount(makeServer({ rows: [image] }), { role: 'EDITOR' });
        const thumb = await screen.findByTestId('evidence-gallery-thumb-ev-img');
        expect(thumb.getAttribute('src')).toBe('/api/t/acme/evidence/files/fr-img/download?purpose=preview');
        expect(screen.getByTestId('evidence-gallery-download-ev-img').getAttribute('href')).toBe(
            '/api/t/acme/evidence/files/fr-img/download',
        );
    });
});
