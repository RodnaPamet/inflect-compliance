/**
 * The control detail page's Evidence tab — what "Add evidence" sends, and
 * what the user reads when the server refuses it (#4126).
 *
 *   1. A web link becomes a LIBRARY record. It used to POST
 *      `/controls/:id/evidence`, which writes only a plain
 *      `ControlEvidenceLink` row the evidence library never reads, so the
 *      link could never be reviewed. It now goes through the library's own
 *      create path — `POST /evidence` with `type: 'LINK'` and `controlIds`
 *      — exactly as the library's link dialog does.
 *   2. That path refuses an untitled record, so the form asks for a title
 *      and the submit waits for one; the note box is gone (a library record
 *      has no note).
 *   3. A refused upload or link shows the server's reason. An API error
 *      body is the envelope `{ error: { code, message } }`, and
 *      `new Error(body.error || …)` read "[object Object]".
 *
 * Drives the real page against a stubbed `useTenantSWR` (reads) and a
 * stubbed `fetch` (writes). Children that fetch for themselves on the
 * Overview tab are stubbed out — they are not what this suite is about.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

// A STABLE translator per namespace: the page keys memos and effects on
// `t`, and a fresh function per render re-runs them on every render.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    // Namespaces can be dotted (`panels.evidenceForm`), so walk the whole path.
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        t.has = (key: string) => typeof resolve(ns, key) === 'string';
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', controlId: 'ctrl_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/controls/ctrl_1',
    useSearchParams: () => new URLSearchParams(),
}));

// Attaching evidence here links it to the control, which takes `controls.edit`.
let mockControlsEdit = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: {
            controls: { view: true, create: true, edit: mockControlsEdit },
            // The exceptions panel reads `admin.manage` for its approve/reject
            // gate (#4387). A real context always carries it; this mock did
            // not, so the page threw at render rather than failing a gate.
            admin: { manage: true },
            tasks: { view: true, create: true, edit: true, assign: true },
        },
        role: 'ADMIN',
        tenantSlug: 'acme',
        userId: 'user_1',
    }),
    useTenantApiUrl: () => (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) =>
        `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useCurrentUserId: () => 'user_1',
}));

const CONTROL = {
    id: 'ctrl_1',
    name: 'Access reviews',
    code: 'AC-1',
    annexId: null,
    status: 'IN_PROGRESS',
    applicability: 'APPLICABLE',
    category: null,
    frequency: null,
    ownerUserId: null,
    owner: null,
    contributors: [],
    _count: { controlTasks: 0, evidenceLinks: 0, evidenceControlLinks: 0, frameworkMappings: 0 },
    doneControlTasks: 0,
};

const mutateEvidence = jest.fn(async () => undefined);
const mutatePage = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key === '/controls/ctrl_1/page-data') {
            return { data: { control: CONTROL, syncStatus: null }, isLoading: false, error: undefined, mutate: mutatePage };
        }
        if (key === '/controls/ctrl_1/evidence') {
            return { data: { links: [], evidence: [] }, isLoading: false, error: undefined, mutate: mutateEvidence };
        }
        return { data: undefined, isLoading: false, error: undefined, mutate: jest.fn() };
    },
}));

// Self-fetching children that are not under test.
jest.mock('@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlHealthCard', () => ({ ControlHealthCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/controls/[controlId]/_components/ControlRoiCard', () => ({ ControlRoiCard: () => null }));
jest.mock('@/components/bia/ControlBiaSurface', () => ({ ControlBiaSurface: () => null }));
jest.mock('@/components/automation/AutomationSuggestionsRail', () => ({ AutomationSuggestionsRail: () => null }));
jest.mock('@/components/LinkedVendorsPanel', () => ({ LinkedVendorsPanel: () => null }));
jest.mock('@/components/controls-shared/PanelActivityFeed', () => ({ PanelActivityFeed: () => null }));

import ControlDetailPage from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/page';

const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
}

beforeEach(() => {
    mockControlsEdit = true;
    fetchMock.mockReset();
    mutateEvidence.mockClear();
    mutatePage.mockClear();
    fetchMock.mockResolvedValue(json({}));
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

async function openEvidenceForm() {
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <ControlDetailPage />
        </SWRConfig>,
    );
    const tab = await waitFor(() => {
        const el = document.getElementById('tab-evidence');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(tab);
    fireEvent.click(await waitFor(() => {
        const el = document.getElementById('link-evidence-btn');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    }));
    await waitFor(() => expect(document.getElementById('control-evidence-form')).not.toBeNull());
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

/** The write calls the page made (reads go through the stubbed SWR). */
function writes(): Array<[string, RequestInit]> {
    return fetchMock.mock.calls.filter(
        ([, init]) => init && (init as RequestInit).method && (init as RequestInit).method !== 'GET',
    ) as Array<[string, RequestInit]>;
}

describe('control Evidence tab — adding a web link', () => {
    it('creates a library LINK record linked to this control', async () => {
        fetchMock.mockResolvedValue(json({ id: 'ev_1' }, 201));
        await openEvidenceForm();

        fireEvent.change(byId('evidence-url-input'), { target: { value: 'https://example.com/report' } });
        fireEvent.change(byId('control-upload-title'), { target: { value: 'Q3 access review' } });
        await act(async () => {
            fireEvent.click(byId('submit-evidence-btn'));
        });

        await waitFor(() => expect(writes()).toHaveLength(1));
        const [url, init] = writes()[0];
        expect(url).toBe('/api/t/acme/evidence');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            type: 'LINK',
            title: 'Q3 access review',
            content: 'https://example.com/report',
            controlIds: ['ctrl_1'],
        });
        // Never the plain-link endpoint the library does not read.
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/controls/ctrl_1/evidence'))).toBe(false);
        // The tab and the header badge both revalidate.
        await waitFor(() => expect(mutateEvidence).toHaveBeenCalled());
        expect(mutatePage).toHaveBeenCalled();
    });

    it('asks for a title: no note box, and the submit waits for one', async () => {
        await openEvidenceForm();
        // A library LINK record has no note.
        expect(document.getElementById('evidence-note-input')).toBeNull();

        fireEvent.change(byId('evidence-url-input'), { target: { value: 'https://example.com/report' } });
        expect(byId('submit-evidence-btn')).toBeDisabled();
        expect(screen.getByText('A link is saved to the evidence library and needs a title.')).toBeInTheDocument();

        fireEvent.change(byId('control-upload-title'), { target: { value: 'Q3 access review' } });
        expect(byId('submit-evidence-btn')).not.toBeDisabled();
    });

    it("shows the server's reason when the link is refused", async () => {
        fetchMock.mockResolvedValue(
            json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to edit evidence.' } }, 403),
        );
        await openEvidenceForm();
        fireEvent.change(byId('evidence-url-input'), { target: { value: 'https://example.com/report' } });
        fireEvent.change(byId('control-upload-title'), { target: { value: 'Q3 access review' } });
        await act(async () => {
            fireEvent.click(byId('submit-evidence-btn'));
        });

        await waitFor(() =>
            expect(document.getElementById('control-evidence-error')).toHaveTextContent(
                'You do not have permission to edit evidence.',
            ),
        );
        expect(document.getElementById('control-evidence-error')).not.toHaveTextContent('[object Object]');
    });
});

describe('control Evidence tab — a refused upload', () => {
    it("shows the server's reason, not [object Object]", async () => {
        fetchMock.mockResolvedValue(
            json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds the 25 MB limit.' } }, 413),
        );
        await openEvidenceForm();
        const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
        fireEvent.change(byId('control-file-input'), { target: { files: [file] } });
        await act(async () => {
            fireEvent.click(byId('submit-evidence-btn'));
        });

        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0][0]).toBe('/api/t/acme/evidence/uploads');
        await waitFor(() =>
            expect(document.getElementById('control-evidence-error')).toHaveTextContent(
                'File exceeds the 25 MB limit.',
            ),
        );
        expect(document.getElementById('control-evidence-error')).not.toHaveTextContent('[object Object]');
    });
});

describe('control Evidence tab — attaching needs controls.edit', () => {
    it('a custom role on a write-tier base without controls.edit is not offered the form', async () => {
        // The link and the upload both link the evidence to this control,
        // which the server refuses without `controls.edit` (#4326).
        mockControlsEdit = false;
        render(
            <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
                <ControlDetailPage />
            </SWRConfig>,
        );
        const tab = await waitFor(() => {
            const el = document.getElementById('tab-evidence');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        fireEvent.click(tab);
        // The tab itself renders; only the add trigger is withheld. The other
        // cases in this file are the positive control.
        await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
        expect(document.getElementById('link-evidence-btn')).toBeNull();
    });
});

/**
 * The rest of the control detail page's write controls also need
 * `controls.edit`, not the write tier alone (#4387).
 *
 * Each of these was gated on `permissions.canWrite` while the route and usecase
 * behind it assert `assertCanUpdateControl` or `assertCanSetApplicability` —
 * both `canWrite && controls.edit`. So a custom role on a write-tier base
 * without `controls.edit` was offered the control and refused by the server,
 * which is the shape #4360 fixed on the task page.
 */
describe('control detail page — the write controls need controls.edit', () => {
    const mount = () =>
        render(
            <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
                <ControlDetailPage />
            </SWRConfig>,
        );

    const settled = () =>
        waitFor(() => {
            expect(document.getElementById('control-where-used-btn')).not.toBeNull();
        });

    it('withholds the status picker and the Edit button without controls.edit', async () => {
        mockControlsEdit = false;
        mount();
        await settled();

        expect(document.getElementById('control-status-select')).toBeNull();
        expect(screen.queryByTestId('control-edit-button')).not.toBeInTheDocument();
    });

    it('offers them to a role that holds controls.edit — the control case', async () => {
        // The positive half, and not optional: a `queryByTestId` for a NAME
        // THAT DOES NOT EXIST returns null in both worlds. The first draft of
        // the case above asked for `control-edit-btn`, which the page never
        // renders — it is `control-edit-button` — so the assertion passed
        // without being able to fail.
        mockControlsEdit = true;
        mount();
        await settled();

        expect(document.getElementById('control-status-select')).not.toBeNull();
        expect(screen.getByTestId('control-edit-button')).toBeInTheDocument();
    });

    it('keeps the Where-used button for a viewer who may not edit', async () => {
        // Informational, and auditors need it most — it must stay outside the
        // write gate (the property `p2c-control-reverse-lookup` pins).
        mockControlsEdit = false;
        mount();
        await settled();

        expect(document.getElementById('control-where-used-btn')).not.toBeNull();
    });
});
