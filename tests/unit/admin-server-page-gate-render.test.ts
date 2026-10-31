/**
 * An admin server page's RENDER refuses before it reads.
 *
 * The admin layout is a client component, so it cannot keep a server page's
 * props out of the RSC payload: whatever a server page passes to its client
 * island reaches the browser, under an "Access denied" screen or not. The fix
 * is a server gate at each page (`gateAdminPage`). This file calls each page
 * the way Next does and asserts, for every gated admin page:
 *
 *   · a READER's render returns the admin forbidden page (the layout's own
 *     title and message) and NO data read is started — every usecase the pages
 *     call and the Prisma client two of them use directly are spies;
 *   · an ADMIN's render reads and returns the page.
 *
 * The audit log is the one page an AUDITOR's render reads (owner decision
 * 2026-10-29); every other gated page refuses an AUDITOR.
 *
 * The structural rule (gate first, own route, from the real module) is
 * `tests/guardrails/admin-layout-guard.test.ts`; who each row admits is
 * `tests/unit/admin-page-requirements.test.ts`.
 */
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';

// ─── Mocks, all declared before the page modules are imported ──────────────

/** The session → context boundary: each test IS the principal it names. */
let currentCtx: RequestContext;
const getTenantCtxMock = jest.fn(async (_params: { tenantSlug: string }) => currentCtx);
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (params: { tenantSlug: string }) => getTenantCtxMock(params),
}));

/**
 * The RBAC and billing pages used to resolve the caller themselves, through
 * `auth()` and `resolveTenantContext`, with no permission check. Both are
 * mocked to admit the session, so a page that goes back to that shape fails
 * this file on its assertions rather than on importing NextAuth.
 */
jest.mock('@/auth', () => ({
    __esModule: true,
    auth: async () => ({ user: { id: currentCtx.userId } }),
}));
jest.mock('@/lib/tenant-context', () => ({
    __esModule: true,
    resolveTenantContext: async () => ({
        tenant: { id: currentCtx.tenantId, slug: 'acme', name: 'Acme' },
        role: currentCtx.role,
    }),
}));

/** `next-intl/server` is ESM; resolve against the real catalogue. */
jest.mock('next-intl/server', () => {
    const lookup = (bag: unknown, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bag);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const en = require('../../messages/en.json') as Record<string, unknown>;
            const bag = lookup(en, ns);
            const t = (key: string) => {
                const v = lookup(bag, key);
                return typeof v === 'string' ? v : key;
            };
            t.rich = (key: string) => t(key);
            return t;
        },
    };
});

/** Every data read the gated pages make. */
const reads = {
    listEmployees: jest.fn(async () => ({ employees: [], truncated: false, total: 0 })),
    listDevices: jest.fn(async () => []),
    listTrainingAssignments: jest.fn(async () => []),
    listAuditLogPage: jest.fn(async (_ctx: unknown, _input: unknown) => ({
        rows: [] as unknown[],
        nextCursor: null as string | null,
    })),
    listDsarRequests: jest.fn(async () => []),
    getTrustCenter: jest.fn(async () => null),
    listAgentCredentials: jest.fn(async () => []),
    getPrivacyPosture: jest.fn(async () => {
        throw new Error('not rendered in this file');
    }),
    getRiskMatrixConfig: jest.fn(async () => ({})),
    listRiskLevelsInUse: jest.fn(async () => []),
    readSandboxRuntimeDeclaration: jest.fn(() => ({
        configured: false,
        configDigest: null,
        reachableVersion: null,
        channels: [],
        appliedAt: null,
    })),
    readSandboxExecutionPlatformEnabled: jest.fn(() => false),
    tenantFindUnique: jest.fn(async () => ({ name: 'Acme' })),
    membershipFindMany: jest.fn(async () => []),
    billingAccountFindUnique: jest.fn(async () => null),
    billingEventFindMany: jest.fn(async () => []),
};

jest.mock('@/app-layer/usecases/personnel', () => ({ __esModule: true, listEmployees: () => reads.listEmployees() }));
jest.mock('@/app-layer/usecases/device', () => ({ __esModule: true, listDevices: () => reads.listDevices() }));
jest.mock('@/app-layer/usecases/training', () => ({
    __esModule: true,
    listTrainingAssignments: () => reads.listTrainingAssignments(),
}));
jest.mock('@/app-layer/usecases/auditLog', () => ({
    __esModule: true,
    listAuditLogPage: (ctx: unknown, input: unknown) => reads.listAuditLogPage(ctx, input),
}));
jest.mock('@/app-layer/usecases/dsar-register', () => ({
    __esModule: true,
    listDsarRequests: () => reads.listDsarRequests(),
}));
jest.mock('@/app-layer/usecases/trust-center', () => ({ __esModule: true, getTrustCenter: () => reads.getTrustCenter() }));
jest.mock('@/app-layer/usecases/api-keys', () => ({
    __esModule: true,
    listAgentCredentials: () => reads.listAgentCredentials(),
}));
jest.mock('@/app-layer/usecases/privacy-posture', () => ({
    __esModule: true,
    getPrivacyPosture: () => reads.getPrivacyPosture(),
}));
jest.mock('@/app-layer/usecases/risk-matrix-config', () => ({
    __esModule: true,
    getRiskMatrixConfig: () => reads.getRiskMatrixConfig(),
    listRiskLevelsInUse: () => reads.listRiskLevelsInUse(),
}));
jest.mock('@/app-layer/usecases/sandbox-runtime-config', () => ({
    __esModule: true,
    readSandboxRuntimeDeclaration: () => reads.readSandboxRuntimeDeclaration(),
    readSandboxExecutionPlatformEnabled: () => reads.readSandboxExecutionPlatformEnabled(),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: () => reads.tenantFindUnique() },
        tenantMembership: { findMany: () => reads.membershipFindMany() },
        billingAccount: { findUnique: () => reads.billingAccountFindUnique() },
        billingEvent: { findMany: () => reads.billingEventFindMany() },
    },
}));

import { ForbiddenPage } from '@/components/ForbiddenPage';
import { PageHeader } from '@/components/layout/PageHeader';
import en from '../../messages/en.json';
import AdminPage from '@/app/t/[tenantSlug]/(app)/admin/page';
import AuditLogPage from '@/app/t/[tenantSlug]/(app)/admin/audit-log/page';
import { AuditLogClient } from '@/app/t/[tenantSlug]/(app)/admin/audit-log/AuditLogClient';
import BillingPage from '@/app/t/[tenantSlug]/(app)/admin/billing/page';
import DevicesPage from '@/app/t/[tenantSlug]/(app)/admin/devices/page';
import DsarPage from '@/app/t/[tenantSlug]/(app)/admin/dsar-requests/page';
import McpPage from '@/app/t/[tenantSlug]/(app)/admin/mcp/page';
import PersonnelPage from '@/app/t/[tenantSlug]/(app)/admin/personnel/page';
import PrivacyPage from '@/app/t/[tenantSlug]/(app)/admin/privacy/page';
import RbacPage from '@/app/t/[tenantSlug]/(app)/admin/rbac/page';
import RiskMatrixPage from '@/app/t/[tenantSlug]/(app)/admin/risk-matrix/page';
import SandboxRuntimePage from '@/app/t/[tenantSlug]/(app)/admin/sandbox-runtime/page';
import TrainingPage from '@/app/t/[tenantSlug]/(app)/admin/training/page';
import TrustCenterPage from '@/app/t/[tenantSlug]/(app)/admin/trust-center/page';
import VendorReviewsPage from '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/page';
import VendorReviewPage from '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/page';
import VendorTemplatesPage from '@/app/t/[tenantSlug]/(app)/admin/vendor-templates/page';
import VendorTemplatePage from '@/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/page';
import { ADMIN_PAGE_REQUIREMENTS } from '@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-requirements';

type Element = { type: unknown; props: Record<string, unknown> };
type PageFn = (args: {
    params: Promise<Record<string, string>>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<Element>;

/** Every gated page, keyed by its route; the last test pins it to the table. */
const PAGES: Record<string, unknown> = {
    '/admin': AdminPage,
    '/admin/audit-log': AuditLogPage,
    '/admin/billing': BillingPage,
    '/admin/devices': DevicesPage,
    '/admin/dsar-requests': DsarPage,
    '/admin/mcp': McpPage,
    '/admin/personnel': PersonnelPage,
    '/admin/privacy': PrivacyPage,
    '/admin/rbac': RbacPage,
    '/admin/risk-matrix': RiskMatrixPage,
    '/admin/sandbox-runtime': SandboxRuntimePage,
    '/admin/training': TrainingPage,
    '/admin/trust-center': TrustCenterPage,
    '/admin/vendor-assessment-reviews': VendorReviewsPage,
    '/admin/vendor-assessment-reviews/[assessmentId]': VendorReviewPage,
    '/admin/vendor-templates': VendorTemplatesPage,
    '/admin/vendor-templates/[templateId]': VendorTemplatePage,
};

async function render(
    route: string,
    role: string,
    searchParams?: Record<string, string | string[] | undefined>,
): Promise<Element> {
    // A built-in membership: its own role is the role the edge reads (#4581 B).
    currentCtx = makeRequestContext(role, { tenantSlug: 'acme', membershipRole: role as RequestContext['role'] });
    const params = Promise.resolve({ tenantSlug: 'acme', assessmentId: 'a-1', templateId: 't-1' });
    // Next hands every page `searchParams`; the personnel page reads it, and
    // the audit log reads its cursor from it.
    return (PAGES[route] as PageFn)({ params, searchParams: Promise.resolve(searchParams ?? {}) });
}

/** The first element of `type` in a rendered element tree. */
function find(el: unknown, type: unknown): Element | null {
    if (!el || typeof el !== 'object') return null;
    if (Array.isArray(el)) {
        for (const child of el) {
            const hit = find(child, type);
            if (hit) return hit;
        }
        return null;
    }
    const node = el as Element;
    if (node.type === type) return node;
    return find(node.props?.children, type);
}

function readsStarted(): string[] {
    return Object.entries(reads)
        .filter(([, spy]) => spy.mock.calls.length > 0)
        .map(([name]) => name);
}

function expectAdminForbidden(el: Element): void {
    expect(el.type).toBe(ForbiddenPage);
    expect(el.props).toEqual({ title: en.admin.forbidden.title, message: en.admin.forbidden.message });
}

beforeEach(() => {
    for (const spy of Object.values(reads)) spy.mockClear();
    getTenantCtxMock.mockClear();
});

describe('a READER is refused by every gated admin page before any read', () => {
    test.each(Object.keys(PAGES))('%s', async (route) => {
        const el = await render(route, 'READER');
        expectAdminForbidden(el);
        expect(readsStarted()).toEqual([]);
        // The gate resolved the caller from the URL's tenant, and only that.
        expect(getTenantCtxMock).toHaveBeenCalledWith({ tenantSlug: 'acme' });
    });
});

describe('personnel — the roster', () => {
    test('a READER gets the forbidden page and the roster is never read', async () => {
        expectAdminForbidden(await render('/admin/personnel', 'READER'));
        expect(reads.listEmployees).not.toHaveBeenCalled();
    });

    test('an AUDITOR is refused too: no admin.view', async () => {
        expectAdminForbidden(await render('/admin/personnel', 'AUDITOR'));
        expect(reads.listEmployees).not.toHaveBeenCalled();
    });

    test.each(['ADMIN', 'OWNER'])('an %s reads the roster and gets the page', async (role) => {
        const el = await render('/admin/personnel', role);
        expect(el.type).not.toBe(ForbiddenPage);
        expect(reads.listEmployees).toHaveBeenCalledTimes(1);
        expect(el.props.tenantSlug).toBe('acme');
    });
});

describe('rbac — every member with email and role', () => {
    test('a READER gets the forbidden page and no membership is read', async () => {
        expectAdminForbidden(await render('/admin/rbac', 'READER'));
        expect(reads.membershipFindMany).not.toHaveBeenCalled();
        expect(reads.tenantFindUnique).not.toHaveBeenCalled();
    });

    test('an ADMIN reads the member list and gets the page', async () => {
        const el = await render('/admin/rbac', 'ADMIN');
        expect(el.type).not.toBe(ForbiddenPage);
        expect(reads.membershipFindMany).toHaveBeenCalledTimes(1);
    });
});

describe('audit log — the owner decision of 2026-10-29', () => {
    test.each(['READER', 'EDITOR', 'AI_ADMIN'])('a %s gets the forbidden page and the log is never read', async (role) => {
        expectAdminForbidden(await render('/admin/audit-log', role));
        expect(reads.listAuditLogPage).not.toHaveBeenCalled();
    });

    test.each(['AUDITOR', 'ADMIN', 'OWNER'])('an %s reads the log', async (role) => {
        const el = await render('/admin/audit-log', role);
        expect(el.type).not.toBe(ForbiddenPage);
        expect(reads.listAuditLogPage).toHaveBeenCalledTimes(1);
    });
});

describe('audit log — the header names only pages the reader can open', () => {
    const crumbs = async (role: string) => {
        const header = find(await render('/admin/audit-log', role), PageHeader);
        expect(header).not.toBeNull();
        return (header!.props.breadcrumbs as Array<{ label: string; href?: string }>).map((c) => c.href ?? null);
    };

    test('an AUDITOR, who cannot open the admin landing, is not offered it', async () => {
        expect(await crumbs('AUDITOR')).toEqual(['/t/acme/dashboard', null]);
    });

    test.each(['ADMIN', 'OWNER'])('an %s keeps the Admin crumb', async (role) => {
        expect(await crumbs(role)).toEqual(['/t/acme/dashboard', '/t/acme/admin', null]);
    });
});

describe('audit log — paged, so an entry older than one page can be reached', () => {
    const client = async (searchParams?: Record<string, string | string[] | undefined>) => {
        const el = find(await render('/admin/audit-log', 'AUDITOR', searchParams), AuditLogClient);
        expect(el).not.toBeNull();
        return el!.props as { olderHref: string | null; newestHref: string | null };
    };

    test('the first page links to the older page exactly when the read says one exists', async () => {
        reads.listAuditLogPage.mockResolvedValueOnce({ rows: [], nextCursor: 'c 2' });
        expect(await client()).toMatchObject({ olderHref: '/t/acme/admin/audit-log?cursor=c%202', newestHref: null });
        expect(reads.listAuditLogPage).toHaveBeenLastCalledWith(expect.anything(), { cursor: null });

        reads.listAuditLogPage.mockResolvedValueOnce({ rows: [], nextCursor: null });
        expect(await client()).toMatchObject({ olderHref: null, newestHref: null });
    });

    test('a later page reads from its cursor and links back to the newest', async () => {
        reads.listAuditLogPage.mockResolvedValueOnce({ rows: [], nextCursor: null });
        expect(await client({ cursor: 'c-2' })).toMatchObject({ olderHref: null, newestHref: '/t/acme/admin/audit-log' });
        expect(reads.listAuditLogPage).toHaveBeenLastCalledWith(expect.anything(), { cursor: 'c-2' });
    });

    test.each([[''], [['a', 'b']]])('a cursor of %j reads the newest page', async (cursor) => {
        await client({ cursor });
        expect(reads.listAuditLogPage).toHaveBeenLastCalledWith(expect.anything(), { cursor: null });
    });

    test('each row reaches the client as the table shows it: the sentence or summary, never the request JSON', async () => {
        const at = new Date('2026-10-29T12:00:00.000Z');
        reads.listAuditLogPage.mockResolvedValueOnce({
            rows: [
                { id: 'a', createdAt: at, action: 'RISK_CREATED', entity: 'Risk', details: 'Created risk\n\nContext: {"requestId":"r-1"}', detailsJson: null, user: { name: 'Ivo' } },
                { id: 'b', createdAt: at, action: 'INTEGRATION_CONNECTION_UPDATED', entity: 'IntegrationConnection', details: 'Context: {"requestId":"r-2"}', detailsJson: { summary: 'Updated integration: Jira' }, user: null },
            ],
            nextCursor: null,
        });
        const el = find(await render('/admin/audit-log', 'AUDITOR'), AuditLogClient);
        expect(el!.props.auditLog).toEqual([
            { id: 'a', createdAt: at.toISOString(), action: 'RISK_CREATED', entity: 'Risk', details: 'Created risk', userName: 'Ivo' },
            { id: 'b', createdAt: at.toISOString(), action: 'INTEGRATION_CONNECTION_UPDATED', entity: 'IntegrationConnection', details: 'Updated integration: Jira', userName: null },
        ]);
    });

    test('a failed read is an error, never an empty log', async () => {
        reads.listAuditLogPage.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(render('/admin/audit-log', 'ADMIN')).rejects.toThrow('database unavailable');
    });
});

describe('the gated pages here are the gated pages there', () => {
    test('PAGES covers every row of ADMIN_PAGE_REQUIREMENTS', () => {
        expect(Object.keys(PAGES).sort()).toEqual(Object.keys(ADMIN_PAGE_REQUIREMENTS).sort());
    });
});

describe('the admin index offers Modules to Owners only (#4819)', () => {
    /** Whether any element in the tree carries this `id` prop. */
    function hasId(el: unknown, id: string): boolean {
        if (!el || typeof el !== 'object') return false;
        if (Array.isArray(el)) return el.some((child) => hasId(child, id));
        const node = el as Element;
        if (node.props?.id === id) return true;
        return hasId(node.props?.children, id);
    }

    test('an OWNER sees the Modules button', async () => {
        const el = await render('/admin', 'OWNER');
        expect(hasId(el, 'modules-pill-btn')).toBe(true);
        expect(hasId(el, 'ai-features-pill-btn')).toBe(true);
    });

    test('an ADMIN does not: the page behind it is Owner-only', async () => {
        const el = await render('/admin', 'ADMIN');
        expect(hasId(el, 'modules-pill-btn')).toBe(false);
        // The rest of the index is unchanged for an Admin.
        expect(hasId(el, 'ai-features-pill-btn')).toBe(true);
        expect(hasId(el, 'billing-pill-btn')).toBe(true);
    });
});
