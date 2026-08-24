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
jest.mock('@/app-layer/usecases/policy', () => ({
    bulkDeletePolicy: (...a: unknown[]) => mockBulkDeletePolicy(...a),
    bulkArchivePolicy: (...a: unknown[]) => mockBulkArchivePolicy(...a),
    purgePolicy: (...a: unknown[]) => mockPurgePolicy(...a),
    restorePolicy: (...a: unknown[]) => mockRestorePolicy(...a),
}));

const mockBulkDeleteVendor = jest.fn();
jest.mock('@/app-layer/usecases/vendor', () => ({
    bulkDeleteVendor: (...a: unknown[]) => mockBulkDeleteVendor(...a),
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

// ─── Fixtures ──────────────────────────────────────────────────────

type Handler = (
    req: NextRequest,
    routeArgs: { params: { tenantSlug: string; id?: string } },
) => Promise<Response>;

function makeReq(path: string, body?: unknown): NextRequest {
    return {
        method: 'POST',
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
        const res = await (evidenceBulkDelete as Handler)(
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
    params: { tenantSlug: string; id?: string };
    body?: unknown;
    key: string;
    usecase: jest.Mock;
    /** Args the handler must forward on the success path. */
    forwards: unknown[];
    result: unknown;
}> = [
    {
        name: 'POST /evidence/bulk/delete',
        handler: evidenceBulkDelete as Handler,
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
        handler: evidencePurge as Handler,
        path: '/api/t/acme/evidence/ev-1/purge',
        params: { tenantSlug: 'acme', id: 'ev-1' },
        key: 'admin.manage',
        usecase: mockPurgeEvidence,
        forwards: ['ev-1'],
        result: { purged: true },
    },
    {
        name: 'POST /evidence/[id]/restore',
        handler: evidenceRestore as Handler,
        path: '/api/t/acme/evidence/ev-1/restore',
        params: { tenantSlug: 'acme', id: 'ev-1' },
        key: 'admin.manage',
        usecase: mockRestoreEvidence,
        forwards: ['ev-1'],
        result: { restored: true },
    },
    {
        name: 'POST /policies/bulk/delete',
        handler: policiesBulkDelete as Handler,
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
        handler: policiesBulkArchive as Handler,
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
        handler: policyPurge as Handler,
        path: '/api/t/acme/policies/pol-1/purge',
        params: { tenantSlug: 'acme', id: 'pol-1' },
        key: 'admin.manage',
        usecase: mockPurgePolicy,
        forwards: ['pol-1'],
        result: { purged: true },
    },
    {
        name: 'POST /policies/[id]/restore',
        handler: policyRestore as Handler,
        path: '/api/t/acme/policies/pol-1/restore',
        params: { tenantSlug: 'acme', id: 'pol-1' },
        key: 'admin.manage',
        usecase: mockRestorePolicy,
        forwards: ['pol-1'],
        result: { restored: true },
    },
    {
        name: 'POST /vendors/bulk/delete',
        handler: vendorsBulkDelete as Handler,
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
        handler: testPlansBulkDelete as Handler,
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
        handler: testPlansBulkRestore as Handler,
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
        handler: tasksBulkDelete as Handler,
        path: '/api/t/acme/tasks/bulk/delete',
        params: { tenantSlug: 'acme' },
        body: { taskIds: ['t-1'] },
        key: 'admin.manage',
        usecase: mockBulkDeleteTask,
        forwards: [['t-1']],
        result: { deleted: 1 },
    },
];

describe.each(ROUTES.map((r) => [r.name, r] as const))('%s', (_name, route) => {
    it('an ADMIN still reaches the usecase', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
        route.usecase.mockResolvedValue(route.result);

        const res = await route.handler(makeReq(route.path, route.body), {
            params: route.params,
        });

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

    it('an EDITOR is refused BEFORE the usecase runs', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('EDITOR'));

        const res = await route.handler(makeReq(route.path, route.body), {
            params: route.params,
        });

        expect(res.status).toBe(403);
        expect(route.usecase).not.toHaveBeenCalled();
    });

    it('the refusal WRITES an AUTHZ_DENIED row naming the key', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('EDITOR'));

        await route.handler(makeReq(route.path, route.body), { params: route.params });

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
        expect(entry.detailsJson.method).toBe('POST');
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
        ['delete', policiesBulkDelete as Handler, '/api/t/acme/policies/bulk/delete', mockBulkDeletePolicy],
        ['archive', policiesBulkArchive as Handler, '/api/t/acme/policies/bulk/archive', mockBulkArchivePolicy],
    ])('bulk/%s refuses admin.manage-without-policies.edit, and records it', async (
        _verb,
        handler,
        path,
        usecase,
    ) => {
        mockGetTenantCtx.mockResolvedValue(adminWithoutPolicyEdit());

        const res = await handler(makeReq(path, { policyIds: ['pol-1'] }), {
            params: { tenantSlug: 'acme' },
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

        const res = await (policyPurge as Handler)(
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

        const res = await (policiesBulkDelete as Handler)(
            makeReq('/api/t/acme/policies/bulk/delete', { policyIds: ['pol-1'] }),
            { params: { tenantSlug: 'acme' } },
        );

        expect(res.status).toBe(200);
        expect(mockBulkDeletePolicy).toHaveBeenCalledTimes(1);
    });
});
