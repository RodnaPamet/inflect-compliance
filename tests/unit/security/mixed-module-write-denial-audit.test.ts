/**
 * The mixed-module tranche (#2117 follow-up): write verbs that sat beside an
 * ALREADY-GATED destructive verb in the same route file.
 *
 * Why these were missed for five tranches. The census guard asked whether a
 * gate appeared anywhere in a route FILE, so a module exporting a gated DELETE
 * beside an ungated PATCH read as fully covered. It was not: the PATCH refused
 * through its usecase assert, which throws `forbidden(...)` and writes nothing,
 * so editing a KRI, a risk-hierarchy node, a report schedule, an org dashboard
 * widget or an org initiative could be turned away and leave no trace at all.
 * #2168 made the census resolve per handler; this is the behavioural half.
 *
 * The three tenant routes were gated by the diff that adds this file. The two
 * ORG routes were gated by #2167, and its own table already asserts their
 * denial pair — they are carried here for assertions 3 and 4, which it does
 * not make and which are the two this file exists for.
 *
 * Each verb gets four assertions, and the last two are the reason this file
 * exists rather than another line in the census:
 *
 *   1. an unauthorized caller is refused BEFORE the usecase runs, and the
 *      refusal is RECORDED,
 *   2. an authorized caller still reaches the usecase and records nothing
 *      (without this, a handler that 403s unconditionally would satisfy 1),
 *   3. authorization runs BEFORE the body is parsed — an unauthorized caller
 *      sending unparseable JSON gets 403, not 400,
 *   4. the body is still SCHEMA-validated — an authorized caller sending a
 *      type-invalid body gets 400.
 *
 * 3 and 4 pin the `parseJsonBody` composition from both sides. These handlers
 * used to compose `withValidatedBody`, which cannot stack with
 * `requirePermission` because both want the third handler argument — the
 * wrapper puts the parsed body there, the gate puts `ctx`. Reverting to it
 * would parse first and so answer 3 with a 400; dropping the schema while
 * keeping the gate would answer 4 with a 200. Neither survives.
 */

// ─── Mocks (before imports) ────────────────────────────────────────

const mockGetTenantCtx = jest.fn();
const mockGetOrgCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
    getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a),
}));

const mockAppendAuditEntry = jest.fn();
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...a: unknown[]) => mockAppendAuditEntry(...a),
}));

const mockAppendOrgAuditEntry = jest.fn();
jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: (...a: unknown[]) => mockAppendOrgAuditEntry(...a),
}));

const mockUpdateNode = jest.fn();
jest.mock('@/app-layer/usecases/risk-hierarchy', () => ({
    updateNode: (...a: unknown[]) => mockUpdateNode(...a),
    deleteNode: jest.fn(),
    aggregateByHierarchy: jest.fn(),
}));

const mockUpdateKri = jest.fn();
jest.mock('@/app-layer/usecases/key-risk-indicator', () => ({
    updateKri: (...a: unknown[]) => mockUpdateKri(...a),
    deleteKri: jest.fn(),
}));

const mockUpdateSchedule = jest.fn();
jest.mock('@/app-layer/usecases/risk-report', () => ({
    updateSchedule: (...a: unknown[]) => mockUpdateSchedule(...a),
    deleteSchedule: jest.fn(),
}));

const mockUpdateWidget = jest.fn();
jest.mock('@/app-layer/usecases/org-dashboard-widgets', () => ({
    updateOrgDashboardWidget: (...a: unknown[]) => mockUpdateWidget(...a),
    deleteOrgDashboardWidget: jest.fn(),
}));

const mockUpdateInitiative = jest.fn();
jest.mock('@/app-layer/usecases/org-security-initiative', () => ({
    updateInitiative: (...a: unknown[]) => mockUpdateInitiative(...a),
    deleteInitiative: jest.fn(),
    getInitiative: jest.fn(),
    getInitiativeProgress: jest.fn(),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────

import type { NextRequest } from 'next/server';
import { makeRequestContext } from '../../helpers/make-context';

import { PATCH as nodePatch } from '@/app/api/t/[tenantSlug]/risks/hierarchy/[nodeId]/route';
import { PATCH as kriPatch } from '@/app/api/t/[tenantSlug]/risks/kri/[kriId]/route';
import { PATCH as schedulePatch } from '@/app/api/t/[tenantSlug]/risks/reports/schedules/[scheduleId]/route';
import { PATCH as widgetPatch } from '@/app/api/org/[orgSlug]/dashboard/widgets/[widgetId]/route';
import { PATCH as initiativePatch } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/route';

type Handler = (req: NextRequest, args: { params: unknown }) => Promise<Response>;
const asHandler = (h: unknown): Handler => h as Handler;

const ORG_FLAGS_ALL_FALSE = {
    canViewPortfolio: false, canDrillDown: false, canExportReports: false,
    canManageTenants: false, canManageMembers: false, canConfigureDashboard: false,
    canSetThreatLevel: false, canSetMaturity: false,
};

const orgCtx = (flags: Partial<typeof ORG_FLAGS_ALL_FALSE>) => ({
    requestId: 'req-1', userId: 'user-1', organizationId: 'org-1',
    orgSlug: 'acme', orgRole: 'ORG_READER',
    permissions: { ...ORG_FLAGS_ALL_FALSE, ...flags },
});

/**
 * `unparseable` models a malformed request body: `req.json()` REJECTS, which
 * is what `parseJsonBody` turns into a 400. It is not the same thing as a
 * body that parses and fails the schema — case 4 covers that separately.
 */
function makeReq(path: string, body: unknown, opts: { unparseable?: boolean } = {}): NextRequest {
    return {
        method: 'PATCH',
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: {
            pathname: path,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
        json: async () => {
            if (opts.unparseable) throw new SyntaxError('Unexpected token');
            return body;
        },
    } as unknown as NextRequest;
}

type Surface = 'tenant' | 'org';

const CASES: Array<{
    name: string; surface: Surface; handler: Handler; path: string;
    params: Record<string, string>; usecase: jest.Mock;
    good: unknown; typeInvalid: unknown; orgFlag?: keyof typeof ORG_FLAGS_ALL_FALSE;
}> = [
    {
        name: 'PATCH /risks/hierarchy/[nodeId]', surface: 'tenant',
        handler: asHandler(nodePatch), path: '/api/t/acme/risks/hierarchy/n-1',
        params: { tenantSlug: 'acme', nodeId: 'n-1' }, usecase: mockUpdateNode,
        good: { name: 'Renamed node' }, typeInvalid: { name: 42 },
    },
    {
        name: 'PATCH /risks/kri/[kriId]', surface: 'tenant',
        handler: asHandler(kriPatch), path: '/api/t/acme/risks/kri/k-1',
        params: { tenantSlug: 'acme', kriId: 'k-1' }, usecase: mockUpdateKri,
        good: { name: 'Renamed KRI' }, typeInvalid: { name: 42 },
    },
    {
        name: 'PATCH /risks/reports/schedules/[scheduleId]', surface: 'tenant',
        handler: asHandler(schedulePatch), path: '/api/t/acme/risks/reports/schedules/s-1',
        params: { tenantSlug: 'acme', scheduleId: 's-1' }, usecase: mockUpdateSchedule,
        good: { isActive: false }, typeInvalid: { isActive: 'no' },
    },
    {
        name: 'PATCH /org/dashboard/widgets/[widgetId]', surface: 'org',
        handler: asHandler(widgetPatch), path: '/api/org/acme/dashboard/widgets/w-1',
        params: { orgSlug: 'acme', widgetId: 'w-1' }, usecase: mockUpdateWidget,
        good: { enabled: false }, typeInvalid: { enabled: 'no' },
        orgFlag: 'canConfigureDashboard',
    },
    {
        name: 'PATCH /org/initiatives/[initiativeId]', surface: 'org',
        handler: asHandler(initiativePatch), path: '/api/org/acme/initiatives/i-1',
        params: { orgSlug: 'acme', initiativeId: 'i-1' }, usecase: mockUpdateInitiative,
        good: { title: 'Renamed initiative' }, typeInvalid: { title: 42 },
        orgFlag: 'canConfigureDashboard',
    },
];

const denialRows = (surface: Surface) =>
    surface === 'tenant'
        ? mockAppendAuditEntry.mock.calls
              .map((c) => c[0] as { action?: string })
              .filter((e) => e?.action === 'AUTHZ_DENIED')
        : mockAppendOrgAuditEntry.mock.calls
              .map((c) => c[0] as { action?: string })
              .filter((e) => e?.action === 'ORG_AUTHZ_DENIED');

beforeEach(() => {
    [mockGetTenantCtx, mockGetOrgCtx, mockAppendAuditEntry, mockAppendOrgAuditEntry,
     mockUpdateNode, mockUpdateKri, mockUpdateSchedule, mockUpdateWidget,
     mockUpdateInitiative].forEach((m) => m.mockReset());
    mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
    mockAppendOrgAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
});

describe.each(CASES)('$name', (c) => {
    /** READER holds no `risks.edit`; the all-false org ctx holds no flag. */
    const denyCaller = () =>
        c.surface === 'tenant'
            ? mockGetTenantCtx.mockResolvedValue(makeRequestContext('READER'))
            : mockGetOrgCtx.mockResolvedValue(orgCtx({}));

    /** EDITOR is the role that legitimately performs these edits. */
    const allowCaller = () =>
        c.surface === 'tenant'
            ? mockGetTenantCtx.mockResolvedValue(makeRequestContext('EDITOR'))
            : mockGetOrgCtx.mockResolvedValue(orgCtx({ [c.orgFlag as string]: true }));

    const call = (req: NextRequest) =>
        c.handler(req, {
            params: c.surface === 'tenant' ? Promise.resolve(c.params) : Promise.resolve(c.params),
        });

    it('refuses an unauthorized caller, records it, and never reaches the usecase', async () => {
        denyCaller();

        const res = await call(makeReq(c.path, c.good));

        expect(res.status).toBe(403);
        expect(c.usecase).not.toHaveBeenCalled();
        expect(denialRows(c.surface)).toHaveLength(1);
    });

    it('admits an authorized caller and records no denial', async () => {
        allowCaller();
        c.usecase.mockResolvedValue({ ok: true });

        const res = await call(makeReq(c.path, c.good));

        expect(res.status).toBeLessThan(400);
        expect(c.usecase).toHaveBeenCalledTimes(1);
        expect(denialRows(c.surface)).toHaveLength(0);
    });

    it('authorizes BEFORE parsing the body (unparseable + unauthorized ⇒ 403)', async () => {
        denyCaller();

        const res = await call(makeReq(c.path, undefined, { unparseable: true }));

        // 400 here would mean the body was read first — the composition this
        // tranche moved away from. The refusal must not depend on the payload.
        expect(res.status).toBe(403);
        expect(c.usecase).not.toHaveBeenCalled();
        expect(denialRows(c.surface)).toHaveLength(1);
    });

    it('still schema-validates the body for an authorized caller', async () => {
        allowCaller();

        const res = await call(makeReq(c.path, c.typeInvalid));

        // Dropping the schema when moving off `withValidatedBody` would let
        // this through — the gate alone cannot catch a malformed payload.
        expect(res.status).toBe(400);
        expect(c.usecase).not.toHaveBeenCalled();
    });
});
