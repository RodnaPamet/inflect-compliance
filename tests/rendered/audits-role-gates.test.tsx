/** @jest-environment jsdom */

/**
 * The audits pages, driven per role against the answers the real API gives
 * (#4129).
 *
 * The pages gated on `audits.manage` / `audits.share` while the server gates on
 * the built-in role, so they disagreed: an Editor was offered no Cycle, Add
 * items or Clone the server allowed, a Reader was offered a Pack button, a
 * status picker and an empty-state Add Audit Cycle the server refused, and an
 * Auditor was offered share, resolve and create-finding buttons that always
 * failed. Lists a role may not read rendered as empty ("No share links yet.",
 * "No auditors yet"), the server's error message was never shown (the pages
 * read `err.message`, the API sends `error.message`), and a missing cycle or
 * pack — a 404, which `apiGet` throws — always rendered as "Could not load".
 *
 * Every test mounts the real page in a real TenantProvider, so a gate that
 * drifts from `lib/audit-readiness/access.ts` fails here.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Role } from '@prisma/client';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// The undo window is the hook's own business (it has its own tests); here we
// capture what the page hands it and run the commit or the undo ourselves.
const undoCalls: Array<{ action: () => Promise<unknown>; undoAction?: () => unknown; onError?: (e: unknown) => void; message: string }> = [];
jest.mock('@/components/ui/hooks/use-toast-with-undo', () => ({
    useToastWithUndo: () => (input: (typeof undoCalls)[number]) => { undoCalls.push(input); return 'undo-1'; },
    cancelPendingUndoToast: jest.fn(),
}));

// Memoised per namespace, with `.has` — see tests/rendered/audit-pack-freeze.test.tsx.
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
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: String, number: String, relativeTime: String, list: (l: string[]) => l.join(', ') }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/components/integrations/sharepoint/SharePointFilePicker', () => ({
    SharePointFilePicker: () => null,
}));

const routerMock = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() };
const routeParams: Record<string, string> = { tenantSlug: 'acme', cycleId: 'cyc-1', packId: 'pack-1', token: 'tok-1' };
jest.mock('next/navigation', () => ({
    useParams: () => routeParams,
    useRouter: () => routerMock,
    usePathname: () => '/t/acme/audits',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import { toast } from 'sonner';
import AuditCyclesPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/page';
import CycleDetailPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page';
import PackDetailPage from '@/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page';
import AuditorsManagementPage from '@/app/t/[tenantSlug]/(app)/audits/auditors/page';
import SharedPackPage from '@/app/audit/shared/[token]/page';
import { __setConfettiForTest } from '@inflect/ui/components/ui/hooks/use-celebration';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Harness ────────────────────────────────────────────────────────────

type Reply = { status?: number; body: unknown };
type Route = (url: string, init?: RequestInit) => Reply | undefined;
let routes: Route[] = [];
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const route of routes) {
        const reply = route(String(url), init);
        if (reply) {
            const status = reply.status ?? 200;
            return { ok: status < 400, status, url: String(url), json: async () => reply.body } as unknown as Response;
        }
    }
    return { ok: true, status: 200, url: String(url), json: async () => [] } as unknown as Response;
});

/** The API's error envelope (`toApiErrorResponse`). */
const envelope = (status: number, message: string): Reply => ({ status, body: { error: { code: 'X', message } } });
const get = (re: RegExp, reply: Reply): Route => (u, i) => (!i?.method || i.method === 'GET') && re.test(u) ? reply : undefined;
const post = (re: RegExp, reply: Reply): Route => (u, i) => i?.method === 'POST' && re.test(u) ? reply : undefined;

function ctxFor(role: Role) {
    return {
        userId: 'user-1', tenantId: 'tenant-1', tenantSlug: 'acme', tenantName: 'Acme',
        role,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole(role),
        modules: { processCanvas: false },
    };
}

async function mount(ui: React.ReactElement, role: Role) {
    const view = render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={ctxFor(role)}>{ui}</TenantProvider>
        </SWRConfig>,
    );
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    return view;
}

const requested = (re: RegExp) => fetchMock.mock.calls.filter(([u]) => re.test(String(u)));
const byId = (id: string) => document.getElementById(id);

beforeEach(() => {
    __setConfettiForTest(() => Promise.resolve(null));
    routes = [];
    undoCalls.length = 0;
    fetchMock.mockClear();
    (toast.error as jest.Mock).mockClear();
    (toast.success as jest.Mock).mockClear();
    routerMock.push.mockClear();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

// ─── Cycles list ────────────────────────────────────────────────────────

describe('Audit cycles list', () => {
    const emptyOverview = get(/\/audits\/readiness\/overview$/, { body: { cycles: [], scoresByCycleId: {} } });

    it('a Reader is offered neither the Cycle button nor the empty state’s add action', async () => {
        routes = [emptyOverview];
        await mount(<AuditCyclesPage />, 'READER');
        await screen.findByText('No audit cycles yet');
        expect(byId('create-cycle-btn')).toBeNull();
        expect(screen.queryByText('Add Audit Cycle')).toBeNull();
        expect(screen.getByText('Owners, Admins and Editors can create audit cycles.')).toBeTruthy();
    });

    it('an Editor is offered the Cycle button and the add action — the server lets Editors create cycles', async () => {
        routes = [emptyOverview];
        await mount(<AuditCyclesPage />, 'EDITOR');
        await waitFor(() => expect(byId('create-cycle-btn')).toBeTruthy());
        expect(screen.getByText('Add Audit Cycle')).toBeTruthy();
    });

    it('the picker offers only frameworks in use, and says so when there are none', async () => {
        routes = [emptyOverview, get(/\/frameworks\?inUse=true$/, { body: [] })];
        await mount(<AuditCyclesPage />, 'OWNER');
        await waitFor(() => expect(byId('create-cycle-btn')).toBeTruthy());
        await act(async () => { fireEvent.click(byId('create-cycle-btn')!); });
        await waitFor(() => expect(byId('cycle-no-framework-in-use')).toBeTruthy());
        // The global catalogue is never asked; the seeds are not offered.
        expect(requested(/\/frameworks$/)).toHaveLength(0);
        expect(byId('fw-select')?.textContent ?? '').not.toContain('ISO');
        fireEvent.change(byId('cycle-name-input')!, { target: { value: 'FY26' } });
        expect((byId('submit-cycle-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a refused create shows the server’s reason, not a generic sentence', async () => {
        routes = [
            emptyOverview,
            get(/\/frameworks\?inUse=true$/, { body: [{ key: 'SOC2', name: 'SOC 2', version: '2017' }] }),
            post(/\/audits\/cycles$/, envelope(400, 'This framework is not in use in this workspace')),
        ];
        await mount(<AuditCyclesPage />, 'OWNER');
        await waitFor(() => expect(byId('create-cycle-btn')).toBeTruthy());
        await act(async () => { fireEvent.click(byId('create-cycle-btn')!); });
        await waitFor(() => expect(byId('fw-select')?.textContent).toContain('SOC 2'));
        fireEvent.change(byId('cycle-name-input')!, { target: { value: 'FY26' } });
        await act(async () => { fireEvent.submit(byId('cycle-form')!); });
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('This framework is not in use in this workspace', expect.anything()),
        );
        const body = JSON.parse(String(requested(/\/audits\/cycles$/)[0][1]!.body));
        expect(body).toMatchObject({ frameworkKey: 'SOC2', frameworkVersion: '2017' });
    });
});

// ─── Cycle detail ───────────────────────────────────────────────────────

describe('Audit cycle detail', () => {
    const cycle = {
        id: 'cyc-1', name: 'SOC 2 FY26', frameworkKey: 'SOC2', frameworkVersion: '2017', status: 'PLANNING',
        packs: [{ id: 'pack-9', name: 'Old pack', status: 'FROZEN' }], audits: [],
    };
    const preview = {
        frameworkKey: 'SOC2',
        selection: { controls: { count: 1, ids: ['c1'] }, policies: { count: 0, ids: [] }, evidence: { count: 0, ids: [] }, issues: { count: 0, ids: [] } },
        totalItems: 1,
    };
    const cycleRoutes = () => [
        get(/\/audits\/cycles\/cyc-1\?action=default-pack-preview$/, { body: preview }),
        get(/\/audits\/cycles\/cyc-1$/, { body: cycle }),
    ];

    it.each([
        ['READER', { pack: false, status: false, reliance: false }],
        ['AUDITOR', { pack: false, status: false, reliance: false }],
        ['EDITOR', { pack: true, status: true, reliance: false }],
        ['OWNER', { pack: true, status: true, reliance: true }],
    ] as const)('%s sees the controls the server lets it use', async (role, expected) => {
        routes = cycleRoutes();
        await mount(<CycleDetailPage />, role);
        await waitFor(() => expect(byId('cycle-name')?.textContent).toContain('SOC 2 FY26'));
        expect(Boolean(byId('create-default-pack-btn'))).toBe(expected.pack);
        expect(Boolean(byId('cycle-status-select'))).toBe(expected.status);
        expect(Boolean(byId('assemble-reliance-pack-btn'))).toBe(expected.reliance);
    });

    it('lists a pack’s status by its label, not the stored value', async () => {
        routes = cycleRoutes();
        await mount(<CycleDetailPage />, 'READER');
        await screen.findByText('Old pack');
        expect(byId('pack-link-pack-9')?.textContent).toContain('Frozen');
        expect(byId('pack-link-pack-9')?.textContent).not.toContain('FROZEN');
    });

    it('a missing cycle reads as not found, not as a load failure', async () => {
        routes = [
            get(/\/audits\/cycles\/cyc-1\?action=default-pack-preview$/, envelope(404, 'Audit cycle not found')),
            get(/\/audits\/cycles\/cyc-1$/, envelope(404, 'Audit cycle not found')),
        ];
        await mount(<CycleDetailPage />, 'OWNER');
        await screen.findByText('Audit cycle not found.');
        expect(document.querySelector('[data-testid="cycle-load-error"]')).toBeNull();
    });

    it('shows the reliance refusal by name, from the error envelope', async () => {
        routes = [
            ...cycleRoutes(),
            post(/\/reliance-pack$/, envelope(409, 'No workpaper of a library v1 procedure falls inside the cycle’s period')),
        ];
        await mount(<CycleDetailPage />, 'OWNER');
        await waitFor(() => expect(byId('assemble-reliance-pack-btn')).toBeTruthy());
        await act(async () => { fireEvent.click(byId('assemble-reliance-pack-btn')!); });
        await waitFor(() =>
            expect(byId('reliance-refusal')?.textContent).toBe('No workpaper of a library v1 procedure falls inside the cycle’s period'),
        );
    });

    it('a refused default pack shows the server’s reason', async () => {
        routes = [...cycleRoutes(), post(/\/audits\/packs$/, envelope(403, 'Only OWNER, ADMIN, or EDITOR can manage audit packs'))];
        await mount(<CycleDetailPage />, 'EDITOR');
        await waitFor(() => expect((byId('create-default-pack-btn') as HTMLButtonElement | null)?.disabled).toBe(false));
        await act(async () => { fireEvent.click(byId('create-default-pack-btn')!); });
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('Only OWNER, ADMIN, or EDITOR can manage audit packs', expect.anything()),
        );
    });
});

// ─── Pack detail ────────────────────────────────────────────────────────

describe('Audit pack detail', () => {
    const draft = () => ({
        id: 'pack-1', name: 'SOC 2 pack', status: 'DRAFT', frozenAt: null, frozenBy: null,
        cycle: { frameworkKey: 'SOC2' }, _count: { items: 2 },
        items: [
            { id: 'it-1', entityType: 'CONTROL', entityId: 'cuid-control-1', snapshotJson: '{}', displayName: 'CC6.1' },
            { id: 'it-2', entityType: 'POLICY', entityId: 'cuid-policy-1', snapshotJson: '{}', displayName: 'Access policy' },
        ],
    });
    const frozen = () => ({
        ...draft(), status: 'FROZEN', frozenAt: '2026-10-01T00:00:00.000Z',
        items: [
            { id: 'it-1', entityType: 'CONTROL', entityId: 'cuid-control-1', snapshotJson: '{"code":"CC6.1","status":"IMPLEMENTED","snapshotAt":"x"}' },
            { id: 'it-s', entityType: 'FRAMEWORK_COVERAGE', entityId: 'soa-ISO27001', snapshotJson: '{"type":"SOA_REPORT","framework":"ISO27001","frameworkName":"ISO 27001:2022","entries":[]}' },
        ],
    });
    const comments = {
        comments: [{ id: 'cm-1', kind: 'FINDING', body: 'Missing MFA evidence', authorLabel: 'Jane', status: 'OPEN', auditPackItemId: null, createdAt: '2026-10-02T00:00:00.000Z', resolvedAt: null }],
        openCount: 1,
    };
    const packRoutes = (pack: unknown, extra: Route[] = []) => [
        ...extra,
        get(/\/audits\/packs\/pack-1\/share-comments$/, { body: comments }),
        get(/\/audits\/packs\/pack-1\/shares$/, { body: [] }),
        get(/\/audits\/packs\/pack-1$/, { body: pack }),
    ];

    it('names draft items by the server’s displayName, never by raw id', async () => {
        routes = packRoutes(draft());
        await mount(<PackDetailPage />, 'READER');
        await screen.findByText('CC6.1');
        expect(screen.getByText('Access policy')).toBeTruthy();
        expect(document.body.textContent).not.toContain('cuid-control-1');
    });

    it('an Editor may add and remove items on a draft, but not freeze it', async () => {
        routes = packRoutes(draft());
        await mount(<PackDetailPage />, 'EDITOR');
        await screen.findByText('CC6.1');
        expect(byId('add-pack-items-btn')).toBeTruthy();
        expect(byId('remove-pack-item-it-1')).toBeTruthy();
        expect(byId('freeze-pack-btn')).toBeNull();
    });

    it('a Reader may change nothing on a draft', async () => {
        routes = packRoutes(draft());
        await mount(<PackDetailPage />, 'READER');
        await screen.findByText('CC6.1');
        expect(byId('add-pack-items-btn')).toBeNull();
        expect(byId('remove-pack-item-it-1')).toBeNull();
        expect(byId('freeze-pack-btn')).toBeNull();
    });

    it('removing an item takes it off the list, posts only on commit, and Undo puts it back', async () => {
        let serverPack = draft();
        routes = [
            post(/action=remove-item$/, { body: { removed: true, itemId: 'it-1' } }),
            get(/\/audits\/packs\/pack-1\/share-comments$/, { body: comments }),
            (u, i) => (!i?.method || i.method === 'GET') && /\/audits\/packs\/pack-1$/.test(u) ? { body: serverPack } : undefined,
        ];
        await mount(<PackDetailPage />, 'EDITOR');
        await screen.findByText('CC6.1');

        await act(async () => { fireEvent.click(byId('remove-pack-item-it-1')!); });
        expect(screen.queryByText('CC6.1')).toBeNull();
        expect(requested(/action=remove-item/)).toHaveLength(0);

        // Undo: the row is back and nothing was sent.
        await act(async () => { await undoCalls[0].undoAction?.(); });
        await screen.findByText('CC6.1');
        expect(requested(/action=remove-item/)).toHaveLength(0);

        // Remove again and let the window close.
        await act(async () => { fireEvent.click(byId('remove-pack-item-it-1')!); });
        serverPack = { ...draft(), items: draft().items.slice(1), _count: { items: 1 } };
        await act(async () => { await undoCalls[1].action(); });
        const sent = requested(/action=remove-item/);
        expect(sent).toHaveLength(1);
        expect(JSON.parse(String(sent[0][1]!.body))).toEqual({ itemId: 'it-1' });
        await waitFor(() => expect(screen.queryByText('CC6.1')).toBeNull());
        expect(screen.getByText('Access policy')).toBeTruthy();
    });

    it('an Auditor on a frozen pack is offered no share, resolve or create-finding action, and is told why the links are not listed', async () => {
        routes = packRoutes(frozen());
        await mount(<PackDetailPage />, 'AUDITOR');
        await screen.findByText('Missing MFA evidence');
        expect(byId('share-pack-btn')).toBeNull();
        expect(document.querySelector('[data-testid="materialize-comment-cm-1"]')).toBeNull();
        expect(screen.queryByText('Resolve')).toBeNull();
        expect(byId('pack-shares-restricted')?.textContent).toBe("Only Owners and Admins can see this pack's share links.");
        expect(screen.queryByText('No share links yet.')).toBeNull();
        // The refused list is not asked for at all.
        expect(requested(/\/shares$/)).toHaveLength(0);
    });

    it('an Editor may clone a frozen pack for retest', async () => {
        routes = packRoutes(frozen());
        await mount(<PackDetailPage />, 'EDITOR');
        await screen.findByText('Missing MFA evidence');
        expect(byId('clone-pack-btn')).toBeTruthy();
        expect(byId('share-pack-btn')).toBeNull();
    });

    it('an Owner sees the share actions, and a failed share list is an error, not "No share links yet."', async () => {
        routes = packRoutes(frozen(), [get(/\/audits\/packs\/pack-1\/shares$/, envelope(500, 'boom'))]);
        await mount(<PackDetailPage />, 'OWNER');
        await screen.findByText('Missing MFA evidence');
        expect(byId('share-pack-btn')).toBeTruthy();
        expect(document.querySelector('[data-testid="materialize-comment-cm-1"]')).toBeTruthy();
        await waitFor(() => expect(byId('pack-shares-error')).toBeTruthy());
        expect(screen.queryByText('No share links yet.')).toBeNull();
    });

    it('names the attached Statement of Applicability in words', async () => {
        routes = packRoutes(frozen());
        await mount(<PackDetailPage />, 'READER');
        await screen.findByText('Statement of Applicability — ISO 27001:2022');
        expect(document.body.textContent).not.toContain('soa-ISO27001');
    });

    it('says when a created finding did not reach the cycle', async () => {
        routes = packRoutes(frozen(), [
            post(/\/materialize$/, { body: { findingId: 'f-1', alreadyExisted: false, attachedToAudit: false } }),
        ]);
        await mount(<PackDetailPage />, 'OWNER');
        await screen.findByText('Missing MFA evidence');
        await act(async () => { fireEvent.click(document.querySelector('[data-testid="materialize-comment-cm-1"]')!); });
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                'Finding created. This cycle has no fieldwork audit, so the finding is not attached to the cycle.',
                expect.anything(),
            ),
        );
    });

    it('a refused write shows the server’s reason from the error envelope', async () => {
        routes = packRoutes(frozen(), [post(/\/resolve$/, envelope(403, 'Only OWNER or ADMIN can share audit packs'))]);
        await mount(<PackDetailPage />, 'OWNER');
        await screen.findByText('Missing MFA evidence');
        await act(async () => { fireEvent.click(screen.getByText('Resolve')); });
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('Only OWNER or ADMIN can share audit packs', expect.anything()),
        );
    });

    it('a missing pack reads as not found, not as a load failure', async () => {
        routes = [get(/\/audits\/packs\/pack-1$/, envelope(404, 'Audit pack not found'))];
        await mount(<PackDetailPage />, 'OWNER');
        await screen.findByText('Pack not found.');
        expect(screen.queryByText("Couldn't load this pack")).toBeNull();
    });
});

// ─── Auditor management ─────────────────────────────────────────────────

describe('Auditor management', () => {
    it('a role that may not list auditors is told so, not shown "No auditors yet"', async () => {
        await mount(<AuditorsManagementPage />, 'EDITOR');
        await screen.findByText('Auditor management is for Owners and Admins');
        expect(screen.queryByText('No auditors yet')).toBeNull();
        expect(byId('invite-auditor-btn')).toBeNull();
        expect(requested(/\/audits\/auditors$/)).toHaveLength(0);
    });

    it('a failed load shows the load error with Retry, not "No auditors yet"', async () => {
        routes = [get(/\/audits\/auditors$/, envelope(500, 'boom'))];
        await mount(<AuditorsManagementPage />, 'OWNER');
        await screen.findByText('Could not load auditors. Please try again.');
        expect(screen.queryByText('No auditors yet')).toBeNull();
        expect(screen.getByText('Retry')).toBeTruthy();
    });
});

// ─── The auditor's shared page ──────────────────────────────────────────

describe('Shared pack page', () => {
    it('shows the server’s reason a link does not work', async () => {
        routes = [get(/\/api\/audit\/shared\/tok-1$/, envelope(403, 'Share link has expired'))];
        await mount(<SharedPackPage />, 'READER');
        await screen.findByText('Share link has expired');
    });

    it('shows statuses by their labels and names the SoA in words', async () => {
        routes = [get(/\/api\/audit\/shared\/tok-1$/, {
            body: {
                pack: { id: 'pack-1', name: 'SOC 2 pack', status: 'FROZEN', frozenAt: '2026-10-01T00:00:00.000Z' },
                cycle: { name: 'FY26', frameworkKey: 'ISO27001', frameworkVersion: '2022' },
                items: [
                    { id: 'it-1', entityType: 'CONTROL', entityId: 'c-1', snapshotJson: '{"code":"A.5.1","status":"NEEDS_REVIEW"}' },
                    { id: 'it-s', entityType: 'FRAMEWORK_COVERAGE', entityId: 'soa-ISO27001', snapshotJson: '{"type":"SOA_REPORT","framework":"ISO27001","frameworkName":"ISO 27001:2022"}' },
                ],
            },
        })];
        await mount(<SharedPackPage />, 'READER');
        await screen.findByText('Needs review');
        expect(screen.queryByText('NEEDS_REVIEW')).toBeNull();
        expect(byId('shared-pack-name')?.parentElement?.textContent).toContain('FY26 · ISO27001 · Frozen');
        expect(screen.getAllByText('Statement of Applicability — ISO 27001:2022').length).toBeGreaterThan(0);
    });

    const ISSUE_PACK = get(/\/api\/audit\/shared\/tok-1$/, {
        body: {
            pack: { id: 'pack-1', name: 'SOC 2 pack', status: 'FROZEN', frozenAt: null },
            cycle: { name: 'FY26', frameworkKey: 'ISO27001', frameworkVersion: '2022' },
            items: [{ id: 'it-i', entityType: 'ISSUE', entityId: 'i-1', snapshotJson: '{"title":"Weak TLS","severity":"HIGH"}' }],
        },
    });

    it("shows a frozen item's severity by its label (#4651)", async () => {
        routes = [ISSUE_PACK];
        await mount(<SharedPackPage />, 'READER');
        // The name is also on the attach buttons; the item row is the span's.
        const name = (await screen.findAllByText('Weak TLS')).find((el) => el.tagName === 'SPAN') as HTMLElement;
        const row = name.closest('div.p-3') as HTMLElement;
        expect(row.textContent).toContain('High');
        expect(row.textContent).not.toContain('HIGH');
    });

    it("shows the server's reason a message was refused (#4651)", async () => {
        routes = [ISSUE_PACK, post(/\/api\/audit\/shared\/tok-1$/, envelope(410, 'Share link has expired'))];
        await mount(<SharedPackPage />, 'READER');
        await screen.findAllByText('Weak TLS');
        fireEvent.change(screen.getByLabelText(jest.requireActual('../../messages/en.json').external.auditShare.returnChannel.messageLabel), { target: { value: 'Please add the TLS scan.' } });
        await act(async () => { fireEvent.click(byId('return-channel-submit') as HTMLElement); });
        expect((await screen.findByText('Share link has expired')).id).toBe('return-channel-error');
    });
});
