/**
 * The Evidence library's add and edit forms offer a control only to a role
 * that may change control links (#4326, owner decision).
 *
 * Setting a link takes the coarse write tier AND `controls.edit` on every path
 * now: the details panel's picker already did, and the text note, link, file
 * upload and ZIP import forms, and the edit form's Controls field, now do too.
 * An EDITOR-based custom role without `controls.edit` therefore gets:
 *
 *   - no control picker in the four add forms, so nothing it creates names a
 *     control;
 *   - the edit form's current links READ-ONLY, and a save that sends no
 *     `controlIds` at all, so the links are left exactly as they are. Sending
 *     the seeded set back would be harmless today (an unchanged set passes),
 *     but an omitted key is the only body that cannot clear a link.
 *
 * A built-in EDITOR keeps every picker. Mounts the REAL `EvidenceClient` (fetch
 * faked by path; see `./evidence-client-harness`).
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
// The ZIP import's default-control picker, as a plain input that keeps its id.
jest.mock('@/components/ui/entity-picker', () => ({
    EntityPicker: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    ),
}));

import {
    COARSE,
    GRANTS,
    enText,
    evidenceRow,
    installEvidenceFetch,
    makeServer,
    mountEvidenceClient,
} from './evidence-client-harness';

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
});

const CONTROLS = [{ id: 'c1', name: 'Access control', code: null, annexId: 'A.5.15' }];

/** An EDITOR-based custom role with `controls.edit` switched off. */
const withoutControlsEdit = { permissions: COARSE.EDITOR, grants: { ...GRANTS.EDITOR, controlsEdit: false, tasksCreate: true, tasksEdit: true } };
const builtInEditor = { role: 'EDITOR' as const };

/** Each add form: the menu item that opens it, a field it always has, and its control picker. */
const ADD_FORMS = [
    { name: 'text note', menu: 'evidence.list.createTextNote', field: 'text-evidence-title-input', picker: 'text-evidence-control-select' },
    { name: 'link', menu: 'evidence.list.createLink', field: 'link-evidence-title-input', picker: 'link-evidence-control-select' },
    { name: 'file upload', menu: 'evidence.list.createFileUpload', field: 'upload-title-input', picker: 'control-select' },
    { name: 'ZIP import', menu: 'evidence.list.createBulkImport', field: 'bulk-import-folder-input', picker: 'bulk-import-control-input' },
] as const;

async function openAddForm(menuKey: string, fieldId: string, opts: Parameters<typeof mountEvidenceClient>[1]) {
    const server = makeServer({ controls: CONTROLS });
    installEvidenceFetch(server);
    mountEvidenceClient(server, opts);
    await screen.findByText(evidenceRow().title);
    fireEvent.click(document.getElementById('add-evidence-btn')!);
    fireEvent.click(await screen.findByText(enText(menuKey)));
    // The form is open once a field it always has is on the page.
    await waitFor(() => {
        if (!document.getElementById(fieldId)) throw new Error(`${fieldId} not rendered`);
    });
}

describe.each(ADD_FORMS)('the $name form offers a control only with controls.edit', ({ menu, field, picker }) => {
    it('an EDITOR-based custom role without controls.edit gets no control picker', async () => {
        await openAddForm(menu, field, withoutControlsEdit);
        expect(document.getElementById(picker)).toBeNull();
    });

    it('a built-in EDITOR gets the picker', async () => {
        await openAddForm(menu, field, builtInEditor);
        expect(document.getElementById(picker)).not.toBeNull();
    });
});

describe('the edit form changes control links only with controls.edit', () => {
    const row = evidenceRow({
        evidenceControlLinks: [{ control: { id: 'c1', name: 'Access control', annexId: 'A.5.15', code: null } }],
    });

    async function openEditAndSave(opts: Parameters<typeof mountEvidenceClient>[1]) {
        const server = makeServer({ rows: [row], controls: CONTROLS });
        installEvidenceFetch(server);
        mountEvidenceClient(server, opts);
        await screen.findByText(row.title);
        fireEvent.click(document.getElementById(`edit-evidence-${row.id}`)!);
        await waitFor(() => {
            if (!document.getElementById('edit-evidence-title-input')) throw new Error('edit form not open');
        });
        return {
            save: async () => {
                await act(async () => {
                    fireEvent.click(document.getElementById('edit-evidence-submit-btn')!);
                });
                const put = await waitFor(() => {
                    const call = server.calls.find((c) => c.method === 'PUT' && c.path === `/evidence/${row.id}`);
                    if (!call) throw new Error('no PUT yet');
                    return call;
                });
                return put.body as Record<string, unknown>;
            },
        };
    }

    it('a custom role without controls.edit sees the links read-only, and its save sends no controlIds', async () => {
        const { save } = await openEditAndSave(withoutControlsEdit);
        expect(document.getElementById('edit-evidence-control-input')).toBeNull();
        const readOnly = document.getElementById('edit-evidence-controls-readonly');
        expect(readOnly).not.toBeNull();
        expect(readOnly!.textContent).toContain('A.5.15: Access control');
        expect(screen.getByText(enText('evidence.edit.controlsReadOnlyDesc'))).toBeInTheDocument();

        const body = await save();
        expect(body).not.toHaveProperty('controlIds');
        // The rest of the form still saves.
        expect(body).toMatchObject({ title: row.title });
    });

    it('a built-in EDITOR gets the picker, and its save sends the link set', async () => {
        const { save } = await openEditAndSave(builtInEditor);
        expect(document.getElementById('edit-evidence-control-input')).not.toBeNull();
        expect(document.getElementById('edit-evidence-controls-readonly')).toBeNull();

        const body = await save();
        expect(body.controlIds).toEqual(['c1']);
    });
});
