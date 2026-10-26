/**
 * The control detail page's write controls follow their routes' keys (#4387).
 *
 * The page used to gate most of its write controls on the coarse write tier
 * alone, while the routes behind them check a granular key. A custom role
 * built on Editor without the key was offered the control and the server then
 * refused it. Each control now asks the write tier AND its route's key:
 *
 *   - `controls.edit` — the status picker, applicability, the Edit button (and
 *     the owner it saves), adding and removing a contributor, the Evidence
 *     tab's add and unlink, the Requirements tab (map, unmap, per-requirement
 *     applicability), and removing a risk or an asset link on Traceability;
 *   - `tasks.create` AND `tasks.edit` — the Tasks tab's "+ Task", which creates
 *     the task and then links it to this control;
 *   - `tests.create` / `tests.execute` — the Tests tab's new plan and run.
 *
 * What the server allows on the write tier alone stays offered: linking a risk
 * or an asset, and requesting an exception.
 *
 * Built-in roles hold every key their tier implies, so a built-in Editor keeps
 * every control — the first case is the positive control for the rest.
 *
 * Drives the real page and the real tab bodies against a stubbed
 * `useTenantSWR` (the page's own reads) and a routed `fetch` (the panels that
 * fetch for themselves). Only Overview children that are not under test are
 * stubbed out.
 */
import * as React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

// A STABLE translator per namespace: the page keys memos and effects on `t`.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        (ns ? `${ns}.${key}` : key).split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns = '') => {
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
    return { useTranslations: (ns?: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', controlId: 'ctrl_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/controls/ctrl_1',
    useSearchParams: () => new URLSearchParams(),
}));

let mockPermissions: { canRead: boolean; canWrite: boolean; canAdmin: boolean };
let mockAppPermissions: PermissionSet;
// STABLE url builders, as the real provider's are: the tab bodies key effects
// on them, and a fresh function per render re-runs those effects for ever.
const mockApiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
const mockHref = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: mockPermissions,
        appPermissions: mockAppPermissions,
        role: 'EDITOR',
        tenantSlug: 'acme',
        tenantId: 'tenant_1',
        userId: 'user_1',
    }),
    useTenantApiUrl: () => mockApiUrl,
    useTenantHref: () => mockHref,
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
    contributors: [{ user: { id: 'user_2', name: 'Dana Contributor' } }],
    _count: { controlTasks: 0, evidenceLinks: 1, evidenceControlLinks: 0, frameworkMappings: 1 },
    doneControlTasks: 0,
};

const EVIDENCE_TAB = {
    links: [
        {
            id: 'lnk_1',
            kind: 'LINK',
            url: 'https://example.com/report',
            note: 'Q3 report',
            fileId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
        },
    ],
    evidence: [],
};

const MAPPINGS = [
    {
        id: 'map_1',
        fromRequirementId: 'req_1',
        fromRequirement: { id: 'req_1', code: 'A.5.1', title: 'Policies', framework: { name: 'ISO 27001' } },
        applicability: null,
        applicabilityJustification: null,
    },
];

const mockMutate = jest.fn(async () => undefined);
const mockPageData = { control: CONTROL, syncStatus: null };
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        const reads: Record<string, unknown> = {
            '/controls/ctrl_1/page-data': mockPageData,
            '/controls/ctrl_1/evidence': EVIDENCE_TAB,
            '/controls/ctrl_1/requirements': MAPPINGS,
        };
        return {
            data: key ? reads[key] : undefined,
            isLoading: false,
            error: undefined,
            mutate: mockMutate,
        };
    },
}));

// Overview children that fetch for themselves and are not under test.
jest.mock('@/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlHealthCard', () => ({ ControlHealthCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/controls/[controlId]/_components/ControlRoiCard', () => ({ ControlRoiCard: () => null }));
jest.mock('@/components/bia/ControlBiaSurface', () => ({ ControlBiaSurface: () => null }));
jest.mock('@/components/automation/AutomationSuggestionsRail', () => ({ AutomationSuggestionsRail: () => null }));
jest.mock('@/components/LinkedVendorsPanel', () => ({ LinkedVendorsPanel: () => null }));
jest.mock('@/components/controls-shared/PanelActivityFeed', () => ({ PanelActivityFeed: () => null }));

import ControlDetailPage from '@/app/t/[tenantSlug]/(app)/controls/[controlId]/page';

const TRACEABILITY = {
    risks: [{ id: 'cr_1', rationale: null, risk: { id: 'risk_1', title: 'Phishing', status: 'OPEN', score: 9 } }],
    controls: [],
    assets: [{ id: 'ac_1', rationale: null, asset: { id: 'asset_1', name: 'Laptop fleet', type: 'HARDWARE', criticality: 'LOW' } }],
    processMaps: [],
};

const TEST_PLANS = [
    {
        id: 'plan_1',
        name: 'Quarterly access review',
        method: 'MANUAL',
        frequency: 'QUARTERLY',
        status: 'ACTIVE',
        nextDueAt: null,
        owner: null,
        _count: { runs: 0, steps: 0 },
        runs: [],
    },
];

function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
}

const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/controls/ctrl_1/traceability')) return Promise.resolve(json(TRACEABILITY));
    if (url.endsWith('/controls/ctrl_1/tests/plans')) return Promise.resolve(json(TEST_PLANS));
    if (url.includes('/controls/ctrl_1/exceptions')) return Promise.resolve(json({ rows: [] }));
    if (url.includes('/tasks?')) return Promise.resolve(json({ rows: [] }));
    return Promise.resolve(json([]));
});

const WRITE_TIER = { canRead: true, canWrite: true, canAdmin: false };

/** A custom role on an EDITOR base with the named keys switched off. */
function editorWithout(...keys: string[]): PermissionSet {
    const set = getPermissionsForRole('EDITOR') as unknown as Record<string, Record<string, boolean>>;
    const copy: Record<string, Record<string, boolean>> = {};
    for (const [domain, actions] of Object.entries(set)) copy[domain] = { ...actions };
    for (const key of keys) {
        const [domain, action] = key.split('.');
        copy[domain][action] = false;
    }
    return copy as unknown as PermissionSet;
}

beforeEach(() => {
    mockPermissions = WRITE_TIER;
    mockAppPermissions = getPermissionsForRole('EDITOR');
    fetchMock.mockClear();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

const el = (id: string) => document.getElementById(id);
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

function renderPage() {
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <TooltipProvider>
                <ControlDetailPage />
            </TooltipProvider>
        </SWRConfig>,
    );
}

async function openTab(key: string) {
    const tab = await waitFor(() => {
        const t = el(`tab-${key}`);
        expect(t).not.toBeNull();
        return t as HTMLElement;
    });
    fireEvent.click(tab);
    await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

/** Waits for a tab body to have rendered, by an element every role sees. */
async function waitForId(id: string) {
    await waitFor(() => expect(el(id)).not.toBeNull());
}

describe('control detail page — a built-in Editor keeps every write control', () => {
    it('Overview: status, applicability, Edit, contributors, and requesting an exception', async () => {
        renderPage();
        await waitForId('control-edit-button');
        expect(el('control-status-select')).not.toBeNull();
        expect(el('toggle-applicability-btn')).not.toBeNull();
        expect(el('add-contributor-btn')).not.toBeNull();
        expect(el('remove-contributor-user_2')).not.toBeNull();
        await waitFor(() => expect(byTestId('control-exception-request-button')).not.toBeNull());
    });

    it('Tasks: + Task', async () => {
        renderPage();
        await openTab('tasks');
        await waitFor(() => expect(el('linked-task-create-btn')).not.toBeNull());
    });

    it('Evidence: add and unlink', async () => {
        renderPage();
        await openTab('evidence');
        await waitForId('link-evidence-btn');
        expect(el('unlink-lnk_1')).not.toBeNull();
    });

    it('Requirements: map, unmap and per-requirement applicability', async () => {
        renderPage();
        await openTab('mappings');
        await waitForId('map-requirement-btn');
        expect(el('unmap-map_1')).not.toBeNull();
        expect(el('applicability-map_1')).not.toBeNull();
    });

    it('Traceability: link and remove a risk and an asset', async () => {
        renderPage();
        await openTab('traceability');
        await waitFor(() => expect(el('unlink-risk-risk_1')).not.toBeNull());
        expect(el('unlink-asset-asset_1')).not.toBeNull();
        expect(el('add-risk-link-btn')).not.toBeNull();
        expect(el('add-asset-link-btn')).not.toBeNull();
    });

    it('Tests: new plan and run', async () => {
        renderPage();
        await openTab('tests');
        await waitFor(() => expect(el('run-test-btn-plan_1')).not.toBeNull());
        expect(el('create-test-plan-btn')).not.toBeNull();
    });
});

describe('control detail page — a custom role on Editor without controls.edit', () => {
    beforeEach(() => {
        mockAppPermissions = editorWithout('controls.edit');
    });

    it('Overview: no status picker, applicability, Edit or contributor controls', async () => {
        renderPage();
        // The exception request asks the write tier alone, so it stays — and
        // its presence shows the Overview has rendered.
        await waitFor(() => expect(byTestId('control-exception-request-button')).not.toBeNull());
        expect(el('control-where-used-btn')).not.toBeNull();
        expect(el('control-status-select')).toBeNull();
        expect(el('toggle-applicability-btn')).toBeNull();
        expect(el('control-edit-button')).toBeNull();
        expect(el('add-contributor-btn')).toBeNull();
        expect(el('remove-contributor-user_2')).toBeNull();
        // The contributor is still listed, read-only.
        expect(document.body.textContent).toContain('Dana Contributor');
    });

    it('Evidence: neither add nor unlink', async () => {
        renderPage();
        await openTab('evidence');
        await waitFor(() => expect(document.body.textContent).toContain('Q3 report'));
        expect(el('link-evidence-btn')).toBeNull();
        expect(el('unlink-lnk_1')).toBeNull();
    });

    it('Requirements: no map, unmap or applicability picker; the override reads as text', async () => {
        renderPage();
        await openTab('mappings');
        await waitFor(() => expect(document.body.textContent).toContain('Policies'));
        expect(el('map-requirement-btn')).toBeNull();
        expect(el('unmap-map_1')).toBeNull();
        expect(el('applicability-map_1')).toBeNull();
    });

    it('Traceability: no remove buttons, but linking a risk or an asset stays', async () => {
        renderPage();
        await openTab('traceability');
        await waitFor(() => expect(document.body.textContent).toContain('Phishing'));
        expect(el('unlink-risk-risk_1')).toBeNull();
        expect(el('unlink-asset-asset_1')).toBeNull();
        // `POST /controls/:id/risks` and `POST /assets/:id/controls` ask the
        // write tier alone, so the page does not withhold them.
        expect(el('add-risk-link-btn')).not.toBeNull();
        expect(el('add-asset-link-btn')).not.toBeNull();
    });

    it('Tasks and Tests keep their controls: they ask other keys', async () => {
        renderPage();
        await openTab('tasks');
        await waitFor(() => expect(el('linked-task-create-btn')).not.toBeNull());
        await openTab('tests');
        await waitFor(() => expect(el('run-test-btn-plan_1')).not.toBeNull());
        expect(el('create-test-plan-btn')).not.toBeNull();
    });
});

describe('control detail page — the Tasks tab needs tasks.create and tasks.edit', () => {
    it.each(['tasks.create', 'tasks.edit'])('a custom role on Editor without %s is not offered + Task', async (key) => {
        mockAppPermissions = editorWithout(key);
        renderPage();
        await openTab('tasks');
        await waitFor(() => expect(el('linked-tasks-table')).not.toBeNull());
        expect(el('linked-task-create-btn')).toBeNull();
        // The control's own edit controls are unaffected.
        expect(el('control-status-select')).not.toBeNull();
    });
});

describe('control detail page — the Tests tab follows tests.create and tests.execute', () => {
    it('without tests.create: no new plan, the run stays', async () => {
        mockAppPermissions = editorWithout('tests.create');
        renderPage();
        await openTab('tests');
        await waitFor(() => expect(el('run-test-btn-plan_1')).not.toBeNull());
        expect(el('create-test-plan-btn')).toBeNull();
    });

    it('without tests.execute: no run, the new plan stays', async () => {
        mockAppPermissions = editorWithout('tests.execute');
        renderPage();
        await openTab('tests');
        await waitFor(() => expect(document.body.textContent).toContain('Quarterly access review'));
        expect(el('run-test-btn-plan_1')).toBeNull();
        expect(el('create-test-plan-btn')).not.toBeNull();
    });
});
