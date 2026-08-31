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

// ── Tranche 3: routes that gated on the coarse `assertCanWrite` ──
const mockArchiveEvidence = jest.fn();
jest.mock('@/app-layer/usecases/evidence-retention', () => ({
    archiveEvidence: (...a: unknown[]) => mockArchiveEvidence(...a),
}));
const mockDeleteNode = jest.fn();
// `linkRisk` / `unlinkRisk` join the SAME factory rather than a second
// jest.mock of this module — a duplicate call would silently replace this one
// and leave `deleteNode` undefined for the row above it.
const mockLinkRisk = jest.fn();
const mockUnlinkRisk = jest.fn();
jest.mock('@/app-layer/usecases/risk-hierarchy', () => ({
    deleteNode: (...a: unknown[]) => mockDeleteNode(...a),
    linkRisk: (...a: unknown[]) => mockLinkRisk(...a),
    unlinkRisk: (...a: unknown[]) => mockUnlinkRisk(...a),
    updateNode: jest.fn(),
    aggregateByHierarchy: jest.fn(),
}));

// ── Tranche 4 (#2189): the link/detach verbs on the risk + asset graph ──
const mockUnlinkAssetEvidence = jest.fn();
jest.mock('@/app-layer/usecases/asset', () => ({
    unlinkAssetEvidence: (...a: unknown[]) => mockUnlinkAssetEvidence(...a),
}));
const mockUnmapAssetFromRisk = jest.fn();
jest.mock('@/app-layer/usecases/traceability', () => ({
    unmapAssetFromRisk: (...a: unknown[]) => mockUnmapAssetFromRisk(...a),
}));
const mockUnlinkRiskEvidence = jest.fn();
jest.mock('@/app-layer/usecases/risk', () => ({
    unlinkRiskEvidence: (...a: unknown[]) => mockUnlinkRiskEvidence(...a),
}));
const mockSetCorrelation = jest.fn();
const mockRemoveCorrelation = jest.fn();
jest.mock('@/app-layer/usecases/risk-correlation', () => ({
    setCorrelation: (...a: unknown[]) => mockSetCorrelation(...a),
    removeCorrelation: (...a: unknown[]) => mockRemoveCorrelation(...a),
    getCorrelationMatrix: jest.fn(),
}));
const mockDeleteKri = jest.fn();
jest.mock('@/app-layer/usecases/key-risk-indicator', () => ({
    deleteKri: (...a: unknown[]) => mockDeleteKri(...a),
    updateKri: jest.fn(),
}));
const mockDeleteSchedule = jest.fn();
jest.mock('@/app-layer/usecases/risk-report', () => ({
    deleteSchedule: (...a: unknown[]) => mockDeleteSchedule(...a),
    updateSchedule: jest.fn(),
}));
const mockArchiveScenario = jest.fn();
jest.mock('@/app-layer/usecases/risk-scenario', () => ({
    archiveScenario: (...a: unknown[]) => mockArchiveScenario(...a),
    getScenario: jest.fn(),
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
const mockUnlinkEvidenceFromRun = jest.fn();
jest.mock('@/app-layer/usecases/control', () => ({
    bulkDeleteTestPlan: (...a: unknown[]) => mockBulkDeleteTestPlan(...a),
    bulkRestoreTestPlan: (...a: unknown[]) => mockBulkRestoreTestPlan(...a),
    unlinkEvidenceFromRun: (...a: unknown[]) => mockUnlinkEvidenceFromRun(...a),
}));

// ── #2117 group A: routes an EXISTING key already gated correctly ──
const mockRevokeAuditorAccount = jest.fn();
const mockGrantAuditorAccess = jest.fn();
const mockRevokeAuditorAccess = jest.fn();
jest.mock('@/app-layer/usecases/audit-readiness', () => ({
    revokeAuditorAccount: (...a: unknown[]) => mockRevokeAuditorAccount(...a),
    grantAuditorAccess: (...a: unknown[]) => mockGrantAuditorAccess(...a),
    revokeAuditorAccess: (...a: unknown[]) => mockRevokeAuditorAccess(...a),
}));

const mockArchiveAutomationRule = jest.fn();
const mockUpdateAutomationRule = jest.fn();
const mockToggleAutomationRule = jest.fn();
jest.mock('@/app-layer/usecases/automation-rules', () => ({
    // The rules/[id] route file also exports GET, which imports this one. It is
    // not under test — the module factory has to supply it or the import of the
    // route file throws.
    getAutomationRule: jest.fn(),
    updateAutomationRule: (...a: unknown[]) => mockUpdateAutomationRule(...a),
    toggleAutomationRule: (...a: unknown[]) => mockToggleAutomationRule(...a),
    archiveAutomationRule: (...a: unknown[]) => mockArchiveAutomationRule(...a),
}));

const mockRemoveBundleItem = jest.fn();
const mockAddBundleItem = jest.fn();
const mockFreezeBundle = jest.fn();
jest.mock('@/app-layer/usecases/vendor-audit', () => ({
    getEvidenceBundle: jest.fn(),
    addBundleItem: (...a: unknown[]) => mockAddBundleItem(...a),
    freezeBundle: (...a: unknown[]) => mockFreezeBundle(...a),
    removeBundleItem: (...a: unknown[]) => mockRemoveBundleItem(...a),
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

import { POST as evidenceArchive } from '@/app/api/t/[tenantSlug]/evidence/[id]/archive/route';
import { DELETE as riskNodeDelete } from '@/app/api/t/[tenantSlug]/risks/hierarchy/[nodeId]/route';
import { DELETE as kriDelete } from '@/app/api/t/[tenantSlug]/risks/kri/[kriId]/route';
import { DELETE as scheduleDelete } from '@/app/api/t/[tenantSlug]/risks/reports/schedules/[scheduleId]/route';
import { DELETE as scenarioDelete } from '@/app/api/t/[tenantSlug]/risks/scenarios/[scenarioId]/route';
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
import { DELETE as auditorAccountRevoke } from '@/app/api/t/[tenantSlug]/audits/auditors/[auditorId]/route';
import {
    POST as auditorAccessGrant,
    DELETE as auditorAccessRevoke,
} from '@/app/api/t/[tenantSlug]/audits/auditors/access/route';
import {
    PUT as automationRuleUpdate,
    PATCH as automationRulePatch,
    DELETE as automationRuleArchive,
} from '@/app/api/t/[tenantSlug]/automation/rules/[id]/route';
import {
    POST as vendorBundleItemAdd,
    DELETE as vendorBundleItemRemove,
} from '@/app/api/t/[tenantSlug]/vendors/[vendorId]/bundles/[bundleId]/route';
import { DELETE as testRunEvidenceUnlink } from '@/app/api/t/[tenantSlug]/tests/runs/[runId]/evidence/[linkId]/route';
import { DELETE as assetEvidenceDetach } from '@/app/api/t/[tenantSlug]/assets/[id]/evidence/attached/[evidenceId]/route';
import { DELETE as assetRiskUnmap } from '@/app/api/t/[tenantSlug]/assets/[id]/risks/[riskId]/route';
import { DELETE as riskEvidenceDetach } from '@/app/api/t/[tenantSlug]/risks/[id]/evidence/attached/[evidenceId]/route';
import { PUT as correlationSet, DELETE as correlationRemove } from '@/app/api/t/[tenantSlug]/risks/correlations/route';
import { POST as hierarchyLinkAdd, DELETE as hierarchyLinkRemove } from '@/app/api/t/[tenantSlug]/risks/hierarchy/[nodeId]/links/route';
import { assertCanManageAuditors } from '@/app-layer/policies/audit-readiness.policies';

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
function makeReq(
    path: string,
    body?: unknown,
    method: string = 'POST',
    /**
     * Query string WITHOUT the leading `?`, for the one handler that reads its
     * target out of the search params rather than the path. It is appended to
     * `url` only: `nextUrl.pathname` is what `auditPermissionDenied` copies
     * into the row, and a path assertion that silently absorbed a query string
     * would stop describing the route.
     */
    query?: string,
): NextRequest {
    return {
        method,
        url: `https://app.example.com${path}${query ? `?${query}` : ''}`,
        headers: new Headers(),
        nextUrl: {
            pathname: path,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(query ?? ''),
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
    // DERIVED from the table, not hand-listed beside it.
    //
    // This was a literal roster of every usecase mock, carrying a comment
    // warning that omitting one leaves stale calls and fails the "usecase was
    // not reached" assertion for a reason unrelated to the gate. The warning
    // did not prevent it: tranche 4 added seven rows, omitted seven names, and
    // got exactly the seven failures the comment predicted.
    //
    // A roster that must be edited in lockstep with another list, in the same
    // file, is bookkeeping — so it is computed. `ROUTES.map(r => r.usecase)`
    // makes the row its own registration, and a mock can no longer be missed
    // because there is nothing left to remember. `usecase` is the only mock a
    // row owns; the mixed-module extras below are reset with it because they
    // are reached by the same handlers.
    //
    // Referencing ROUTES from inside the callback is safe even though it is
    // declared further down: the callback runs at test time, long after the
    // module body has finished evaluating.
    [
        mockGetTenantCtx,
        mockAppendAuditEntry,
        ...ROUTES.map((r) => r.usecase),
        // Reached by handlers the table exercises but never asserts on
        // directly, so they own no row and cannot be derived from one.
        mockUpdateAutomationRule,
        mockToggleAutomationRule,
        mockAddBundleItem,
        mockFreezeBundle,
        mockGrantAuditorAccess,
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
    /** Success status when the route does not return 200 (e.g. a 201 create). */
    successStatus?: number;
    /** Query string (no leading `?`) for handlers that read search params. */
    query?: string;
}> = [
    // ── Tranche 3 ─────────────────────────────────────────────────────
    // These five gated ONLY on `assertCanWrite`, which reads
    // `permissions.canWrite` — computed from the built-in role tier alone,
    // ignoring custom-role overrides — and writes nothing when it refuses.
    // `deniedRole` is READER, not the table's EDITOR default: `risks.edit`
    // and `evidence.edit` are both TRUE for EDITOR, so an EDITOR is correctly
    // admitted here and would make a denial assertion vacuous.
    {
        name: 'POST /evidence/[id]/archive',
        handler: asHandler(evidenceArchive),
        path: '/api/t/acme/evidence/ev-1/archive',
        params: { tenantSlug: 'acme', id: 'ev-1' },
        key: 'evidence.edit',
        usecase: mockArchiveEvidence,
        forwards: ['ev-1'],
        result: { archived: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/hierarchy/[nodeId]',
        handler: asHandler(riskNodeDelete),
        path: '/api/t/acme/risks/hierarchy/node-1',
        params: { tenantSlug: 'acme', nodeId: 'node-1' },
        key: 'risks.edit',
        usecase: mockDeleteNode,
        forwards: ['node-1'],
        result: { success: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/kri/[kriId]',
        handler: asHandler(kriDelete),
        path: '/api/t/acme/risks/kri/kri-1',
        params: { tenantSlug: 'acme', kriId: 'kri-1' },
        key: 'risks.edit',
        usecase: mockDeleteKri,
        forwards: ['kri-1'],
        result: { success: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/reports/schedules/[scheduleId]',
        handler: asHandler(scheduleDelete),
        path: '/api/t/acme/risks/reports/schedules/sch-1',
        params: { tenantSlug: 'acme', scheduleId: 'sch-1' },
        key: 'risks.edit',
        usecase: mockDeleteSchedule,
        forwards: ['sch-1'],
        result: { success: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/scenarios/[scenarioId]',
        handler: asHandler(scenarioDelete),
        path: '/api/t/acme/risks/scenarios/scn-1',
        params: { tenantSlug: 'acme', scenarioId: 'scn-1' },
        key: 'risks.edit',
        usecase: mockArchiveScenario,
        forwards: ['scn-1'],
        result: { success: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
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

    // ── #2117 group A: an EXISTING key already mirrored the assert ──
    //
    // The first three run ADMIN-allowed / EDITOR-refused because their
    // asserts sit at the coarse admin tier. The last two flip to
    // EDITOR-allowed / READER-refused, because `vendors.edit` and
    // `tests.execute` are the exact `appPermissions` flags their policy
    // helpers read — an EDITOR is the population that legitimately uses
    // those routes, so denying one would be a real access change rather
    // than the recording change this is.
    {
        name: 'DELETE /audits/auditors/[auditorId]',
        handler: asHandler(auditorAccountRevoke),
        path: '/api/t/acme/audits/auditors/aud-1',
        params: { tenantSlug: 'acme', auditorId: 'aud-1' },
        method: 'DELETE',
        key: 'admin.manage',
        usecase: mockRevokeAuditorAccount,
        forwards: ['aud-1'],
        result: { id: 'aud-1', status: 'REVOKED' },
    },
    {
        name: 'DELETE /audits/auditors/access',
        handler: asHandler(auditorAccessRevoke),
        path: '/api/t/acme/audits/auditors/access',
        params: { tenantSlug: 'acme' },
        body: { auditorId: 'aud-1', packId: 'pack-1' },
        method: 'DELETE',
        key: 'admin.manage',
        usecase: mockRevokeAuditorAccess,
        forwards: ['aud-1', 'pack-1'],
        result: { revoked: true },
    },
    {
        // The grant half of the same file. Included because the gate runs
        // BEFORE the body is parsed now — a regression that reordered them
        // would send an unauthorized caller's payload through Zod first.
        name: 'POST /audits/auditors/access',
        handler: asHandler(auditorAccessGrant),
        path: '/api/t/acme/audits/auditors/access',
        params: { tenantSlug: 'acme' },
        body: { auditorId: 'aud-1', packId: 'pack-1' },
        key: 'admin.manage',
        usecase: mockGrantAuditorAccess,
        forwards: ['aud-1', 'pack-1'],
        result: { granted: true },
        successStatus: 201,
    },
    {
        name: 'DELETE /automation/rules/[id]',
        handler: asHandler(automationRuleArchive),
        path: '/api/t/acme/automation/rules/ar-1',
        params: { tenantSlug: 'acme', id: 'ar-1' },
        method: 'DELETE',
        key: 'admin.manage',
        usecase: mockArchiveAutomationRule,
        forwards: ['ar-1'],
        result: { id: 'ar-1', status: 'ARCHIVED' },
    },
    {
        name: 'DELETE /vendors/[vendorId]/bundles/[bundleId]',
        handler: asHandler(vendorBundleItemRemove),
        path: '/api/t/acme/vendors/v-1/bundles/b-1',
        params: { tenantSlug: 'acme', vendorId: 'v-1', bundleId: 'b-1' },
        method: 'DELETE',
        query: 'itemId=item-1',
        key: 'vendors.edit',
        usecase: mockRemoveBundleItem,
        forwards: ['b-1', 'item-1'],
        result: { removed: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /tests/runs/[runId]/evidence/[linkId]',
        handler: asHandler(testRunEvidenceUnlink),
        path: '/api/t/acme/tests/runs/run-1/evidence/link-1',
        params: { tenantSlug: 'acme', runId: 'run-1', linkId: 'link-1' },
        method: 'DELETE',
        key: 'tests.execute',
        usecase: mockUnlinkEvidenceFromRun,
        forwards: ['run-1', 'link-1'],
        // The route returns a fixed body; the usecase resolves undefined.
        result: { ok: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },

    // ── Tranche 4 (#2189): link/detach verbs on the risk + asset graph ──
    // All seven gated ONLY on a coarse role-tier predicate — `assertCanWrite`
    // reading `permissions.canWrite`, or (on the asset↔risk unmap) a file-local
    // `assertCanManage` testing `ctx.role` against a literal role list. Neither
    // writes anything when it refuses, and neither consults the custom-role
    // overrides `appPermissions` carries.
    //
    // `deniedRole` is READER throughout: `risks.edit` and `assets.edit` are both
    // TRUE for EDITOR, so an EDITOR is correctly admitted here and a denial
    // assertion against one would be vacuous.
    {
        name: 'DELETE /assets/[id]/evidence/attached/[evidenceId]',
        handler: asHandler(assetEvidenceDetach),
        path: '/api/t/acme/assets/a-1/evidence/attached/ev-1',
        params: { tenantSlug: 'acme', id: 'a-1', evidenceId: 'ev-1' },
        method: 'DELETE',
        key: 'assets.edit',
        usecase: mockUnlinkAssetEvidence,
        forwards: ['a-1', 'ev-1'],
        result: { detached: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /assets/[id]/risks/[riskId]',
        handler: asHandler(assetRiskUnmap),
        path: '/api/t/acme/assets/a-1/risks/r-1',
        params: { tenantSlug: 'acme', id: 'a-1', riskId: 'r-1' },
        method: 'DELETE',
        key: 'assets.edit',
        usecase: mockUnmapAssetFromRisk,
        forwards: ['a-1', 'r-1'],
        // Fixed body; the usecase resolves undefined.
        result: { ok: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/[id]/evidence/attached/[evidenceId]',
        handler: asHandler(riskEvidenceDetach),
        path: '/api/t/acme/risks/r-1/evidence/attached/ev-1',
        params: { tenantSlug: 'acme', id: 'r-1', evidenceId: 'ev-1' },
        method: 'DELETE',
        key: 'risks.edit',
        usecase: mockUnlinkRiskEvidence,
        forwards: ['r-1', 'ev-1'],
        result: { detached: true },
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        // The PUT is here, not just the DELETE. Overwriting a coefficient is
        // how you erase a correlation without removing its row.
        name: 'PUT /risks/correlations',
        handler: asHandler(correlationSet),
        path: '/api/t/acme/risks/correlations',
        params: { tenantSlug: 'acme' },
        method: 'PUT',
        body: { riskAId: 'r-1', riskBId: 'r-2', coefficient: 0.5 },
        key: 'risks.edit',
        usecase: mockSetCorrelation,
        forwards: [{ riskAId: 'r-1', riskBId: 'r-2', coefficient: 0.5 }],
        result: { success: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/correlations',
        handler: asHandler(correlationRemove),
        path: '/api/t/acme/risks/correlations',
        params: { tenantSlug: 'acme' },
        method: 'DELETE',
        body: { riskAId: 'r-1', riskBId: 'r-2' },
        key: 'risks.edit',
        usecase: mockRemoveCorrelation,
        forwards: ['r-1', 'r-2'],
        result: { success: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'POST /risks/hierarchy/[nodeId]/links',
        handler: asHandler(hierarchyLinkAdd),
        path: '/api/t/acme/risks/hierarchy/node-1/links',
        params: { tenantSlug: 'acme', nodeId: 'node-1' },
        method: 'POST',
        body: { riskId: 'r-1' },
        key: 'risks.edit',
        usecase: mockLinkRisk,
        forwards: ['r-1', 'node-1'],
        result: { success: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
    {
        name: 'DELETE /risks/hierarchy/[nodeId]/links',
        handler: asHandler(hierarchyLinkRemove),
        path: '/api/t/acme/risks/hierarchy/node-1/links',
        params: { tenantSlug: 'acme', nodeId: 'node-1' },
        method: 'DELETE',
        body: { riskId: 'r-1' },
        key: 'risks.edit',
        usecase: mockUnlinkRisk,
        forwards: ['r-1', 'node-1'],
        result: { success: true },
        usecaseReturns: undefined,
        allowedRole: 'EDITOR',
        deniedRole: 'READER',
    },
];

/**
 * A table-driven suite hides its own deletions: remove a row and the three
 * tests it generated simply stop existing, and the run is still green. The
 * count is therefore asserted, and it only goes up — 11 after the first
 * tranche, 17 after the second, 23 after group A, 30 after tranche 4.
 */
it('the migrated population does not silently shrink', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(30);
    // Every row must name a distinct HANDLER, so a copy-paste that leaves two
    // rows pointing at the same one reads as coverage it is not. The key is
    // (method, path) rather than path alone: `/audits/auditors/access` carries
    // a POST and a DELETE that gate separately, and a path-only key would have
    // made covering both impossible while claiming to forbid duplication.
    const handlers = ROUTES.map((r) => `${r.method ?? 'POST'} ${r.path}`);
    expect(new Set(handlers).size).toBe(ROUTES.length);
});

describe.each(ROUTES.map((r) => [r.name, r] as const))('%s', (_name, route) => {
    const method = route.method ?? 'POST';
    const allowed = route.allowedRole ?? 'ADMIN';
    const denied = route.deniedRole ?? 'EDITOR';
    const req = () => makeReq(route.path, route.body, method, route.query);

    it(`an authorized ${allowed} still reaches the usecase`, async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext(allowed));
        route.usecase.mockResolvedValue(
            'usecaseReturns' in route ? route.usecaseReturns : route.result,
        );

        const res = await route.handler(req(), { params: route.params });

        expect(res.status).toBe(route.successStatus ?? 200);
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

// ─── The auditor routes' key choice is load-bearing ────────────────

describe('the auditor routes gate on admin.manage, NOT audits.manage', () => {
    /**
     * Both keys admit exactly {OWNER, ADMIN} among the BUILT-IN roles, so a
     * "use the domain key, it reads better" change would look free. It is not,
     * and this is the caller that shows why.
     *
     * `assertCanManageAuditors` reads `ctx.role` — the membership's base role,
     * which a custom role does NOT change. `audits.manage` is an
     * `appPermissions` flag, and it is precisely the flag a tenant would grant
     * an EDITOR-based "audit coordinator" custom role. Under an audits.manage
     * gate that caller PASSES the middleware and is then thrown out by the
     * usecase, which writes nothing — the exact invisible denial #2117 exists
     * to remove, reintroduced in a new place.
     *
     * The first assertion proves the usecase really would refuse them (so the
     * scenario is not hypothetical); the rest prove the route refuses them at
     * the gate instead, on the record.
     */
    const auditCoordinator = () =>
        makeRequestContext('EDITOR', {
            appPermissions: {
                ...getPermissionsForRole('EDITOR'),
                audits: { ...getPermissionsForRole('EDITOR').audits, manage: true },
            },
        });

    it('the usecase assert refuses this caller and records nothing', () => {
        expect(() => assertCanManageAuditors(auditCoordinator())).toThrow(/OWNER or ADMIN/i);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it.each([
        [
            'DELETE /audits/auditors/[auditorId]',
            asHandler(auditorAccountRevoke),
            '/api/t/acme/audits/auditors/aud-1',
            { tenantSlug: 'acme', auditorId: 'aud-1' },
            mockRevokeAuditorAccount,
        ],
        [
            'DELETE /audits/auditors/access',
            asHandler(auditorAccessRevoke),
            '/api/t/acme/audits/auditors/access',
            { tenantSlug: 'acme' },
            mockRevokeAuditorAccess,
        ],
    ])('%s refuses an audits.manage-only caller, and RECORDS it', async (
        _name,
        handler,
        path,
        params,
        usecase,
    ) => {
        mockGetTenantCtx.mockResolvedValue(auditCoordinator());

        const res = await handler(
            makeReq(path, { auditorId: 'aud-1', packId: 'pack-1' }, 'DELETE'),
            { params: params as RouteParams },
        );

        expect(res.status).toBe(403);
        expect(usecase).not.toHaveBeenCalled();
        // Naming the key is the point: swap the gate to audits.manage and this
        // caller sails through the middleware, so both of the assertions above
        // flip AND no row is written.
        expect(denialEntries()).toEqual([
            expect.objectContaining({ entityId: 'admin.manage' }),
        ]);
    });

    it('an ADMIN is still admitted — the gate did not narrow the population', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
        mockRevokeAuditorAccount.mockResolvedValue({ id: 'aud-1', status: 'REVOKED' });

        const res = await asHandler(auditorAccountRevoke)(
            makeReq('/api/t/acme/audits/auditors/aud-1', undefined, 'DELETE'),
            { params: { tenantSlug: 'acme', auditorId: 'aud-1' } },
        );

        expect(res.status).toBe(200);
        expect(mockRevokeAuditorAccount).toHaveBeenCalledTimes(1);
        expect(denialEntries()).toEqual([]);
    });
});

// ─── The parseJsonBody composition, pinned from both sides ─────────

describe('the body-reading gated handlers authorize BEFORE they parse', () => {
    /**
     * Five handlers in this diff read a JSON body inside a `requirePermission`
     * wrapper rather than composing `withValidatedBody` — the two cannot stack,
     * because both want the third handler argument (the wrapper puts the parsed
     * body there, the gate puts `ctx`).
     *
     * The ordering that buys is testable, and both directions matter:
     *
     *   - an unauthorized caller sending UNPARSEABLE JSON must get 403, not
     *     400. A 400 would mean the body was read first, which is a route that
     *     does work on behalf of someone it is about to refuse — and, worse,
     *     never reaches `auditPermissionDenied`, so the refusal is invisible
     *     again. That is the regression a revert to `withValidatedBody` causes.
     *   - an authorized caller sending a TYPE-INVALID body must still get 400.
     *     Otherwise "gate first" was achieved by dropping validation.
     */
    const badJsonReq = (path: string, method: string): NextRequest => {
        const req = makeReq(path, undefined, method);
        (req as unknown as { json: () => Promise<unknown> }).json = async () => {
            throw new SyntaxError('Unexpected token');
        };
        return req;
    };

    const CASES: ReadonlyArray<{
        name: string;
        handler: Handler;
        path: string;
        params: RouteParams;
        method: string;
        key: string;
        usecase: jest.Mock;
        /** A body that parses as JSON but fails the schema. */
        invalidBody: unknown;
        deniedRole: string;
        allowedRole: string;
    }> = [
        {
            name: 'POST /audits/auditors/access',
            handler: asHandler(auditorAccessGrant),
            path: '/api/t/acme/audits/auditors/access',
            params: { tenantSlug: 'acme' },
            method: 'POST',
            key: 'admin.manage',
            usecase: mockGrantAuditorAccess,
            invalidBody: { auditorId: '', packId: 42 },
            deniedRole: 'EDITOR',
            allowedRole: 'ADMIN',
        },
        {
            name: 'DELETE /audits/auditors/access',
            handler: asHandler(auditorAccessRevoke),
            path: '/api/t/acme/audits/auditors/access',
            params: { tenantSlug: 'acme' },
            method: 'DELETE',
            key: 'admin.manage',
            usecase: mockRevokeAuditorAccess,
            invalidBody: { auditorId: '', packId: 42 },
            deniedRole: 'EDITOR',
            allowedRole: 'ADMIN',
        },
        {
            name: 'PATCH /automation/rules/[id]',
            handler: asHandler(automationRulePatch),
            path: '/api/t/acme/automation/rules/ar-1',
            params: { tenantSlug: 'acme', id: 'ar-1' },
            method: 'PATCH',
            key: 'admin.manage',
            usecase: mockToggleAutomationRule,
            // Neither status nor priority — the schema's own refine rejects it.
            invalidBody: {},
            deniedRole: 'EDITOR',
            allowedRole: 'ADMIN',
        },
        {
            name: 'PUT /automation/rules/[id]',
            handler: asHandler(automationRuleUpdate),
            path: '/api/t/acme/automation/rules/ar-1',
            params: { tenantSlug: 'acme', id: 'ar-1' },
            method: 'PUT',
            key: 'admin.manage',
            usecase: mockUpdateAutomationRule,
            invalidBody: { priority: 'not-a-number' },
            deniedRole: 'EDITOR',
            allowedRole: 'ADMIN',
        },
        {
            name: 'POST /vendors/[vendorId]/bundles/[bundleId]',
            handler: asHandler(vendorBundleItemAdd),
            path: '/api/t/acme/vendors/v-1/bundles/b-1',
            params: { tenantSlug: 'acme', vendorId: 'v-1', bundleId: 'b-1' },
            method: 'POST',
            key: 'vendors.edit',
            usecase: mockAddBundleItem,
            invalidBody: { entityType: 'NOT_A_KIND', entityId: 'x' },
            deniedRole: 'READER',
            allowedRole: 'EDITOR',
        },
    ];

    it.each(CASES.map((c) => [c.name, c] as const))(
        '%s answers an unauthorized caller with 403 even on unparseable JSON, and RECORDS it',
        async (_name, c) => {
            mockGetTenantCtx.mockResolvedValue(makeRequestContext(c.deniedRole));

            const res = await c.handler(badJsonReq(c.path, c.method), { params: c.params });

            expect(res.status).toBe(403);
            expect(c.usecase).not.toHaveBeenCalled();
            expect(denialEntries()).toEqual([
                expect.objectContaining({ entityId: c.key, action: 'AUTHZ_DENIED' }),
            ]);
        },
    );

    it.each(CASES.map((c) => [c.name, c] as const))(
        '%s still SCHEMA-validates an authorized caller\'s body',
        async (_name, c) => {
            mockGetTenantCtx.mockResolvedValue(makeRequestContext(c.allowedRole));

            const res = await c.handler(
                makeReq(c.path, c.invalidBody, c.method),
                { params: c.params },
            );

            expect(res.status).toBe(400);
            expect(c.usecase).not.toHaveBeenCalled();
            // A schema rejection is not an authorization event.
            expect(denialEntries()).toEqual([]);
        },
    );

    it('the newly-gated write siblings admit their authorized caller', async () => {
        // Without this, every assertion above is satisfied by a handler that
        // refuses everyone — and gating PUT/PATCH/POST alongside their DELETE
        // would then be a silent lockout rather than a recording change.
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
        mockToggleAutomationRule.mockResolvedValue({ id: 'ar-1', status: 'DISABLED' });

        const res = await asHandler(automationRulePatch)(
            makeReq('/api/t/acme/automation/rules/ar-1', { status: 'DISABLED' }, 'PATCH'),
            { params: { tenantSlug: 'acme', id: 'ar-1' } },
        );

        expect(res.status).toBe(200);
        expect(mockToggleAutomationRule).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1' }),
            'ar-1',
            'DISABLED',
        );
        expect(denialEntries()).toEqual([]);
    });

    it('the bundle POST freeze branch is gated too — it never reads a body', async () => {
        // The freeze branch returns before `parseJsonBody`, so the "unparseable
        // JSON still 403s" case above cannot reach it. It is the branch that
        // makes a bundle IMMUTABLE, so assert its refusal is recorded directly.
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('READER'));

        const res = await asHandler(vendorBundleItemAdd)(
            makeReq('/api/t/acme/vendors/v-1/bundles/b-1', undefined, 'POST', 'action=freeze'),
            { params: { tenantSlug: 'acme', vendorId: 'v-1', bundleId: 'b-1' } },
        );

        expect(res.status).toBe(403);
        expect(mockFreezeBundle).not.toHaveBeenCalled();
        expect(denialEntries()).toEqual([
            expect.objectContaining({ entityId: 'vendors.edit' }),
        ]);
    });
});
