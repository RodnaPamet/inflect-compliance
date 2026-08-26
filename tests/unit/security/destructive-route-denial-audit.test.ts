/**
 * #2117 — destructive register routes record their refusals.
 *
 * The property under test is NOT "does this route return 403". Every one
 * of these routes already refused an unauthorized caller correctly, at
 * the usecase layer, before this change — that was never the gap. The
 * property is that the refusal LEAVES A ROW.
 *
 * `AUTHZ_DENIED` is written in exactly one place: `requirePermission` in
 * `src/lib/security/permission-middleware.ts`. A usecase `assertCan*`
 * throws `forbidden(...)` and writes nothing at all, so a purge of the
 * evidence register or a bulk delete of the vendor register that was
 * turned away produced a 403 in the request log and silence in the audit
 * trail. That contrast is reproduced directly in the first test below,
 * so this file cannot be read as pinning behaviour that already existed.
 *
 * Each route therefore gets three assertions:
 *
 *   1. an authorized caller still reaches the usecase (the positive
 *      companion — without it, a route that 403s unconditionally would
 *      satisfy every negative assertion here),
 *   2. an unauthorized caller is refused BEFORE the usecase runs, and
 *   3. that refusal appends an `AUTHZ_DENIED` entry naming the key.
 *
 * The unauthorized role is EDITOR rather than READER on purpose. EDITOR
 * is the role that holds the entity-level `.edit` flags and so was the
 * one actually reaching these usecases and being thrown out invisibly;
 * a READER would have been stopped further up on most surfaces and would
 * make the test weaker while looking the same.
 *
 * ─── The vendors.edit routes flip the pair, deliberately ───────────
 *
 * The second tranche added routes whose usecase asserts read
 * `appPermissions.vendors.edit` directly, so EDITOR is the AUTHORIZED
 * role there and READER the refused one. The table below therefore
 * carries the pair per route rather than assuming it. That is not a
 * weakening: on those routes the point being proven is that EDITOR —
 * the population that legitimately uses them — is unaffected by the new
 * gate, while the caller who was refused invisibly is now on the record.
 */

// ─── Mocks (before imports) ────────────────────────────────────────

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));

const mockBulkDeleteEvidence = jest.fn();
const mockPurgeEvidence = jest.fn();
const mockRestoreEvidence = jest.fn();
jest.mock('@/app-layer/usecases/evidence', () => ({
    bulkDeleteEvidence: (...a: unknown[]) => mockBulkDeleteEvidence(...a),
    purgeEvidence: (...a: unknown[]) => mockPurgeEvidence(...a),
    restoreEvidence: (...a: unknown[]) => mockRestoreEvidence(...a),
}));

const mockBulkDeletePolicy = jest.fn();
const mockBulkArchivePolicy = jest.fn();
const mockPurgePolicy = jest.fn();
const mockRestorePolicy = jest.fn();
const mockArchivePolicy = jest.fn();
jest.mock('@/app-layer/usecases/policy', () => ({
    bulkDeletePolicy: (...a: unknown[]) => mockBulkDeletePolicy(...a),
    bulkArchivePolicy: (...a: unknown[]) => mockBulkArchivePolicy(...a),
    purgePolicy: (...a: unknown[]) => mockPurgePolicy(...a),
    restorePolicy: (...a: unknown[]) => mockRestorePolicy(...a),
    archivePolicy: (...a: unknown[]) => mockArchivePolicy(...a),
}));

const mockBulkDeleteVendor = jest.fn();
const mockRemoveVendorDocument = jest.fn();
const mockRemoveVendorLink = jest.fn();
jest.mock('@/app-layer/usecases/vendor', () => ({
    bulkDeleteVendor: (...a: unknown[]) => mockBulkDeleteVendor(...a),
    removeVendorDocument: (...a: unknown[]) => mockRemoveVendorDocument(...a),
    removeVendorLink: (...a: unknown[]) => mockRemoveVendorLink(...a),
}));

const mockRevokeAssessmentLink = jest.fn();
jest.mock('@/app-layer/usecases/vendor-assessment-send', () => ({
    revokeAssessmentLink: (...a: unknown[]) => mockRevokeAssessmentLink(...a),
}));

const mockDeleteLossEvent = jest.fn();
jest.mock('@/app-layer/usecases/loss-event', () => ({
    deleteLossEvent: (...a: unknown[]) => mockDeleteLossEvent(...a),
}));

const mockDeleteProcessMap = jest.fn();
jest.mock('@/app-layer/usecases/process-map', () => ({
    // The processes/[id] route file also exports GET / PUT / PATCH, which
    // import these four. They are not under test — the module factory has to
    // supply them or the import of the route file throws.
    getProcessMap: jest.fn(),
    saveProcessMap: jest.fn(),
    setProcessMapCanvasMode: jest.fn(),
    setProcessMapStatus: jest.fn(),
    deleteProcessMap: (...a: unknown[]) => mockDeleteProcessMap(...a),
}));

const mockBulkDeleteTestPlan = jest.fn();
const mockBulkRestoreTestPlan = jest.fn();
jest.mock('@/app-layer/usecases/control', () => ({
    bulkDeleteTestPlan: (...a: unknown[]) => mockBulkDeleteTestPlan(...a),
    bulkRestoreTestPlan: (...a: unknown[]) => mockBulkRestoreTestPlan(...a),
}));

const mockBulkDeleteTask = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    bulkDeleteTask: (...a: unknown[]) => mockBulkDeleteTask(...a),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────

import type { NextRequest } from 'next/server';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { assertCanAdmin } from '@/app-layer/policies/common';

import { POST as evidenceBulkDelete } from '@/app/api/t/[tenantSlug]/evidence/bulk/delete/route';
import { POST as evidencePurge } from '@/app/api/t/[tenantSlug]/evidence/[id]/purge/route';
import { POST as evidenceRestore } from '@/app/api/t/[tenantSlug]/evidence/[id]/restore/route';
import { POST as policiesBulkDelete } from '@/app/api/t/[tenantSlug]/policies/bulk/delete/route';
import { POST as policiesBulkArchive } from '@/app/api/t/[tenantSlug]/policies/bulk/archive/route';
import { POST as policyPurge } from '@/app/api/t/[tenantSlug]/policies/[id]/purge/route';
import { POST as policyRestore } from '@/app/api/t/[tenantSlug]/policies/[id]/restore/route';
import { POST as vendorsBulkDelete } from '@/app/api/t/[tenantSlug]/vendors/bulk/delete/route';
import { POST as testPlansBulkDelete } from '@/app/api/t/[tenantSlug]/tests/plans/bulk/delete/route';
import { POST as testPlansBulkRestore } from '@/app/api/t/[tenantSlug]/tests/plans/bulk/restore/route';
import { POST as tasksBulkDelete } from '@/app/api/t/[tenantSlug]/tasks/bulk/delete/route';
import { DELETE as vendorDocumentDelete } from '@/app/api/t/[tenantSlug]/vendors/[vendorId]/documents/[docId]/route';
import { DELETE as vendorLinkDelete } from '@/app/api/t/[tenantSlug]/vendors/[vendorId]/links/[linkId]/route';
import { POST as assessmentRevoke } from '@/app/api/t/[tenantSlug]/vendor-assessment-reviews/[assessmentId]/revoke/route';
import { DELETE as lossEventDelete } from '@/app/api/t/[tenantSlug]/loss-events/[id]/route';
import { DELETE as processMapDelete } from '@/app/api/t/[tenantSlug]/processes/[id]/route';
import { POST as policyArchive } from '@/app/api/t/[tenantSlug]/policies/[id]/archive/route';

// ─── Fixtures ──────────────────────────────────────────────────────

type RouteParams = { tenantSlug: string } & Record<string, string>;

type Handler = (
    req: NextRequest,
    routeArgs: { params: RouteParams },
) => Promise<Response>;

/**
 * Invoke a real route export as a `Handler`.
 *
 * Route handlers type `params` as `Promise<Params>` — the Next 15+ contract
 * this repo pins in `tests/guards/async-params-route-typing.test.ts`. These
 * tests pass params synchronously, which is runtime-correct because the
 * handlers `await` them and `await` accepts a non-thenable unchanged.
 *
 * So the mismatch is purely at the type boundary. It is bridged ONCE here,
 * with the reason written down, rather than by scattering `as unknown as`
 * across every call site — where the next reader would have to re-derive why
 * each one was safe.
 */
const asHandler = (h: unknown): Handler => h as Handler;

/**
 * The method is a parameter, not a constant. `auditPermissionDenied`
 * copies `req.method` into the AUTHZ_DENIED row, so hard-coding POST
 * would have made the DELETE routes' rows assert a method they never
 * carry — the assertion would still pass and would be describing a
 * request nobody makes.
 */
function makeReq(path: string, body?: unknown, method: string = 'POST'): NextRequest {
    return {
        method,
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: {
            pathname: path,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
        json: async () => body ?? {},
    } as unknown as NextRequest;
}

/** The AUTHZ_DENIED entries appended during a call, in order. */
function denialEntries(): Array<{ entity: string; entityId: string; action: string }> {
    return mockAppendAuditEntry.mock.calls
        .map((c) => c[0] as { entity: string; entityId: string; action: string })
        .filter((e) => e && e.action === 'AUTHZ_DENIED');
}

beforeEach(() => {
    [
        mockGetTenantCtx,
        mockAppendAuditEntry,
        mockBulkDeleteEvidence,
        mockPurgeEvidence,
        mockRestoreEvidence,
        mockBulkDeletePolicy,
        mockBulkArchivePolicy,
        mockPurgePolicy,
        mockRestorePolicy,
        mockBulkDeleteVendor,
        mockBulkDeleteTestPlan,
        mockBulkRestoreTestPlan,
        mockBulkDeleteTask,
        mockRemoveVendorDocument,
        mockRemoveVendorLink,
        mockRevokeAssessmentLink,
        mockDeleteLossEvent,
        mockDeleteProcessMap,
        mockArchivePolicy,
    ].forEach((m) => m.mockReset());
    mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
});

// ─── The mechanism, proven rather than asserted ────────────────────

describe('the mechanism gap is proven directly', () => {
    /**
     * ONE test, deliberately: the two halves are only meaningful together.
     * "assertCanAdmin wrote nothing" on its own is indistinguishable from
     * "the audit spy was never wired up" — an absence proves nothing about
     * a detector nobody demonstrated. So the same EDITOR context is put
     * through both paths in sequence, and the counter is read after each.
     */
    it('the usecase assert writes no row where the route middleware writes one', async () => {
        const editor: RequestContext = makeRequestContext('EDITOR');

        // (a) The usecase layer. The real policy helper, not a stand-in.
        expect(() => assertCanAdmin(editor)).toThrow(/permission/i);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();

        // (b) The route layer, same context, same refusal — and now a row.
        mockGetTenantCtx.mockResolvedValue(editor);
        const res = await asHandler(evidenceBulkDelete)(
            makeReq('/api/t/acme/evidence/bulk/delete', { evidenceIds: ['ev-1'] }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(403);
        expect(denialEntries()).toHaveLength(1);
    });
});

// ─── Per-route table ───────────────────────────────────────────────

/**
 * One row per migrated route. `key` is the value the AUTHZ_DENIED row
 * must carry — `requirePermission` joins multiple keys with a comma —
 * so a route silently re-gated on a different key fails here rather
 * than passing on "some 403 happened".
 */
const ROUTES: ReadonlyArray<{
    name: string;
    handler: Handler;
    path: string;
    params: RouteParams;
    body?: unknown;
    /** Defaults to POST. */
    method?: string;
    key: string;
    usecase: jest.Mock;
    /** Args the handler must forward on the success path. */
    forwards: unknown[];
    /** The JSON body the route must return. */
    result: unknown;
    /**
     * What the usecase resolves with, when the route reshapes it before
     * responding (the revoke route stringifies a Date). Defaults to
     * `result` for the routes that pass the value straight through.
     */
    usecaseReturns?: unknown;
    /** Role that must still get through. Defaults to ADMIN. */
    allowedRole?: string;
    /** Role that must be refused AND recorded. Defaults to EDITOR. */
    deniedRole?: string;
}> = [
    {
        name: 'POST /evidence/bulk/delete',
        handler: asHandler(evidenceBulkDelete),
        path: '/api/t/acme/evidence/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { evidenceIds: ['ev-1', 'ev-2'] },
        key: 'admin.manage',
        usecase: mockBulkDeleteEvidence,
        forwards: [['ev-1', 'ev-2']],
        result: { deleted: 2 },
    },
    {
        name: 'POST /evidence/[id]/purge',
        handler: asHandler(evidencePurge),
        path: '/api/t/acme/evidence/ev-1/purge',
        params: { tenantSlug: 'acme', id: 'ev-1' },
        key: 'admin.manage',
        usecase: mockPurgeEvidence,
        forwards: ['ev-1'],
        result: { purged: true },
    },
    {
        name: 'POST /evidence/[id]/restore',
        handler: asHandler(evidenceRestore),
        path: '/api/t/acme/evidence/ev-1/restore',
        params: { tenantSlug: 'acme', id: 'ev-1' },
        key: 'admin.manage',
        usecase: mockRestoreEvidence,
        forwards: ['ev-1'],
        result: { restored: true },
    },
    {
        name: 'POST /policies/bulk/delete',
        handler: asHandler(policiesBulkDelete),
        path: '/api/t/acme/policies/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { policyIds: ['pol-1'] },
        key: 'admin.manage,policies.edit',
        usecase: mockBulkDeletePolicy,
        forwards: [['pol-1']],
        result: { deleted: 1 },
    },
    {
        name: 'POST /policies/bulk/archive',
        handler: asHandler(policiesBulkArchive),
        path: '/api/t/acme/policies/bulk/archive',
        params: { tenantSlug: 'acme' },
        body: { policyIds: ['pol-1'] },
        key: 'admin.manage,policies.edit',
        usecase: mockBulkArchivePolicy,
        forwards: [['pol-1']],
        result: { updated: 1 },
    },
    {
        name: 'POST /policies/[id]/purge',
        handler: asHandler(policyPurge),
        path: '/api/t/acme/policies/pol-1/purge',
        params: { tenantSlug: 'acme', id: 'pol-1' },
        key: 'admin.manage',
        usecase: mockPurgePolicy,
        forwards: ['pol-1'],
        result: { purged: true },
    },
    {
        name: 'POST /policies/[id]/restore',
        handler: asHandler(policyRestore),
        path: '/api/t/acme/policies/pol-1/restore',
        params: { tenantSlug: 'acme', id: 'pol-1' },
        key: 'admin.manage',
        usecase: mockRestorePolicy,
        forwards: ['pol-1'],
        result: { restored: true },
    },
    {
        name: 'POST /vendors/bulk/delete',
        handler: asHandler(vendorsBulkDelete),
        path: '/api/t/acme/vendors/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { vendorIds: ['v-1'] },
        key: 'admin.manage',
        usecase: mockBulkDeleteVendor,
        forwards: [['v-1']],
        result: { deleted: 1 },
    },
    {
        name: 'POST /tests/plans/bulk/delete',
        handler: asHandler(testPlansBulkDelete),
        path: '/api/t/acme/tests/plans/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { planIds: ['tp-1'] },
        key: 'admin.manage',
        usecase: mockBulkDeleteTestPlan,
        forwards: [['tp-1']],
        result: { deleted: 1 },
    },
    {
        name: 'POST /tests/plans/bulk/restore',
        handler: asHandler(testPlansBulkRestore),
        path: '/api/t/acme/tests/plans/bulk/restore',
        params: { tenantSlug: 'acme' },
        body: { planIds: ['tp-1'] },
        key: 'admin.manage',
        usecase: mockBulkRestoreTestPlan,
        forwards: [['tp-1']],
        result: { restored: 1 },
    },
    {
        name: 'POST /tasks/bulk/delete',
        handler: asHandler(tasksBulkDelete),
        path: '/api/t/acme/tasks/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { taskIds: ['t-1'] },
        key: 'admin.manage',
        usecase: mockBulkDeleteTask,
        forwards: [['t-1']],
        result: { deleted: 1 },
    },

    // ── Second tranche: single-entity destruction + revocation ─────
    //
    // The three vendor rows run EDITOR-allowed / READER-refused because
    // `vendors.edit` is the exact flag their usecase asserts read. Using
    // the default ADMIN/EDITOR pair here would have asserted nothing
    // about the population that actually calls these routes.
    {
        name: 'DELETE /vendors/[vendorId]/documents/[docId]',
        handler: asHandler(vendorDocumentDelete),
        path: '/api/t/acme/vendors/v-1/documents/doc-1',
        params: { tenantSlug: 'acme', vendorId: 'v-1', docId: 'doc-1' },
        method: 'DELETE',
        key: 'vendors.edit',
        usecase: mockRemoveVendorDocument,
        forwards: ['doc-1', 'v-1'],
        result: { deleted: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /vendors/[vendorId]/links/[linkId]',
        handler: asHandler(vendorLinkDelete),
        path: '/api/t/acme/vendors/v-1/links/lk-1',
        params: { tenantSlug: 'acme', vendorId: 'v-1', linkId: 'lk-1' },
        method: 'DELETE',
        key: 'vendors.edit',
        usecase: mockRemoveVendorLink,
        forwards: ['lk-1', 'v-1'],
        result: { deleted: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'POST /vendor-assessment-reviews/[assessmentId]/revoke',
        handler: asHandler(assessmentRevoke),
        path: '/api/t/acme/vendor-assessment-reviews/as-1/revoke',
        params: { tenantSlug: 'acme', assessmentId: 'as-1' },
        key: 'vendors.edit',
        usecase: mockRevokeAssessmentLink,
        forwards: ['as-1'],
        // The route reshapes the usecase's Date into an ISO string, so the
        // asserted body is not the mock's return value verbatim.
        result: {
            assessmentId: 'as-1',
            revokedAt: '2026-08-20T00:00:00.000Z',
        },
        usecaseReturns: {
            assessmentId: 'as-1',
            revokedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /loss-events/[id]',
        handler: asHandler(lossEventDelete),
        path: '/api/t/acme/loss-events/le-1',
        params: { tenantSlug: 'acme', id: 'le-1' },
        method: 'DELETE',
        key: 'admin.manage',
        usecase: mockDeleteLossEvent,
        forwards: ['le-1'],
        result: { success: true },
    },
    {
        name: 'DELETE /processes/[id]',
        handler: asHandler(processMapDelete),
        path: '/api/t/acme/processes/pm-1',
        params: { tenantSlug: 'acme', id: 'pm-1' },
        method: 'DELETE',
        key: 'admin.manage',
        usecase: mockDeleteProcessMap,
        forwards: ['pm-1'],
        result: { deleted: true },
    },
    {
        // The single-policy twin of policies/bulk/archive, which has carried
        // the two-key gate since the first tranche. `key` is the comma-joined
        // form requirePermission writes into the row, so a regression to one
        // key fails here rather than passing on "some 403 happened".
        name: 'POST /policies/[id]/archive',
        handler: asHandler(policyArchive),
        path: '/api/t/acme/policies/pol-1/archive',
        params: { tenantSlug: 'acme', id: 'pol-1' },
        key: 'admin.manage,policies.edit',
        usecase: mockArchivePolicy,
        forwards: ['pol-1'],
        result: { archived: true },
    },
];

/**
 * A table-driven suite hides its own deletions: remove a row and the three
 * tests it generated simply stop existing, and the run is still green. The
 * count is therefore asserted, and it only goes up — 11 after the first
 * tranche, 17 after the second.
 */
it('the migrated population does not silently shrink', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(17);
    // Every row must name a distinct handler, so a copy-paste that leaves two
    // rows pointing at the same route reads as coverage it is not.
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
});

describe.each(ROUTES.map((r) => [r.name, r] as const))('%s', (_name, route) => {
    const method = route.method ?? 'POST';
    const allowed = route.allowedRole ?? 'ADMIN';
    const denied = route.deniedRole ?? 'EDITOR';
    const req = () => makeReq(route.path, route.body, method);

    it(`an authorized ${allowed} still reaches the usecase`, async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext(allowed));
        route.usecase.mockResolvedValue(
            'usecaseReturns' in route ? route.usecaseReturns : route.result,
        );

        const res = await route.handler(req(), { params: route.params });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(route.result);
        expect(route.usecase).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1' }),
            ...route.forwards,
        );
        // A gate that denied everything would still pass the negative
        // assertions below; it would not pass this one, nor leave the
        // audit trail free of a spurious denial.
        expect(denialEntries()).toEqual([]);
    });

    it(`a ${denied} is refused BEFORE the usecase runs`, async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext(denied));

        const res = await route.handler(req(), { params: route.params });

        expect(res.status).toBe(403);
        expect(route.usecase).not.toHaveBeenCalled();
    });

    it('the refusal WRITES an AUTHZ_DENIED row naming the key', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext(denied));

        await route.handler(req(), { params: route.params });

        expect(denialEntries()).toEqual([
            expect.objectContaining({
                entity: 'Permission',
                entityId: route.key,
                action: 'AUTHZ_DENIED',
            }),
        ]);
        const entry = mockAppendAuditEntry.mock.calls[0][0] as {
            tenantId: string;
            userId: string;
            detailsJson: { category: string; method: string; path: string };
        };
        expect(entry.tenantId).toBe('tenant-1');
        expect(entry.userId).toBe('user-1');
        expect(entry.detailsJson.category).toBe('access');
        expect(entry.detailsJson.method).toBe(method);
        expect(entry.detailsJson.path).toBe(route.path);
    });
});

// ─── The second key on the policy bulk verbs is load-bearing ───────

describe('policies bulk verbs require BOTH halves of assertCanAdminPolicies', () => {
    /**
     * A custom role can hold `admin.manage` while `policies.edit` is
     * revoked — that is exactly the shape `assertCanAdminPolicies` exists
     * to refuse. On a one-key gate this caller passes the middleware and
     * is thrown out by the usecase, writing nothing: the same invisible
     * denial in a new place. Asserting it here is what stops a future
     * "simplify to admin.manage" from reading as a tidy-up.
     */
    const adminWithoutPolicyEdit = () =>
        makeRequestContext('ADMIN', {
            appPermissions: {
                ...getPermissionsForRole('ADMIN'),
                policies: {
                    ...getPermissionsForRole('ADMIN').policies,
                    edit: false,
                },
            },
        });

    it.each([
        ['bulk/delete', asHandler(policiesBulkDelete), '/api/t/acme/policies/bulk/delete', mockBulkDeletePolicy, { tenantSlug: 'acme' }],
        ['bulk/archive', asHandler(policiesBulkArchive), '/api/t/acme/policies/bulk/archive', mockBulkArchivePolicy, { tenantSlug: 'acme' }],
        // The single-entity archive joined the two-key set in the second
        // tranche. Included here rather than trusted to the table above,
        // because the table pins the key as a STRING — this is the assertion
        // that the second key actually changes an outcome.
        ['[id]/archive', asHandler(policyArchive), '/api/t/acme/policies/pol-1/archive', mockArchivePolicy, { tenantSlug: 'acme', id: 'pol-1' }],
    ])('%s refuses admin.manage-without-policies.edit, and records it', async (
        _verb,
        handler,
        path,
        usecase,
        params,
    ) => {
        mockGetTenantCtx.mockResolvedValue(adminWithoutPolicyEdit());

        const res = await handler(makeReq(path, { policyIds: ['pol-1'] }), {
            params: params as RouteParams,
        });

        expect(res.status).toBe(403);
        expect(usecase).not.toHaveBeenCalled();
        expect(denialEntries()).toEqual([
            expect.objectContaining({ entityId: 'admin.manage,policies.edit' }),
        ]);
    });

    it('the ONE-key routes admit that same caller — the asymmetry is deliberate', async () => {
        // The diff's headline design decision is that policies/bulk/{delete,
        // archive} declare TWO keys while policies/[id]/{purge,restore} declare
        // one. Only the two-key half had a behavioural test; this half was
        // pinned by string literals alone (`key: 'admin.manage'`), which a
        // "make purge consistent with bulk" PR would naturally update in the
        // same diff — so nothing would have failed.
        //
        // A caller with admin.manage but NOT policies.edit must be REFUSED at
        // bulk (asserted above) and ADMITTED at purge. Asserting both is what
        // makes the asymmetry a decision rather than an accident.
        mockGetTenantCtx.mockResolvedValue(adminWithoutPolicyEdit());
        mockPurgePolicy.mockResolvedValue({ purged: 1 });

        const res = await asHandler(policyPurge)(
            makeReq('/api/t/acme/policies/pol-1/purge', {}),
            { params: { tenantSlug: 'acme', id: 'pol-1' } },
        );

        expect(res.status).toBeLessThan(400);
        expect(mockPurgePolicy).toHaveBeenCalled();
        // And nothing was audited as a denial, because nothing was denied.
        expect(denialEntries()).toEqual([]);
    });

    it('…and the same caller WITH policies.edit is admitted (positive companion)', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
        mockBulkDeletePolicy.mockResolvedValue({ deleted: 1 });

        const res = await asHandler(policiesBulkDelete)(
            makeReq('/api/t/acme/policies/bulk/delete', { policyIds: ['pol-1'] }),
            { params: { tenantSlug: 'acme' } },
        );

        expect(res.status).toBe(200);
        expect(mockBulkDeletePolicy).toHaveBeenCalledTimes(1);
    });
});
