/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `deleteTenantUnderOrg` (soft-delete / "remove tenant"
 * from the org admin panel).
 *
 * Contract:
 *   - Only a tenant that belongs to THIS org and isn't already removed
 *     is reachable (org-scoped findFirst). A foreign/unknown id is a
 *     notFound — never touches another org's tenant.
 *   - On success it sets `deletedAt` (soft-delete; data retained) and
 *     does NOT delete the row or its children.
 *   - On success it also REVOKES every membership that still grants
 *     access, in the SAME transaction (#2747). `deletedAt` alone is a
 *     claim about every current query remembering the filter; the grants
 *     themselves otherwise survive the whole 90-day retention window.
 */

const findFirst = jest.fn();
const update = jest.fn();
const membershipUpdateMany = jest.fn();
const membershipDeleteMany = jest.fn();
const userUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
/** Call order across the statements — the trigger exemption depends on it. */
const calls: string[] = [];
/**
 * One entry per `$transaction` call, listing the writes that ran INSIDE it.
 *
 * Replaces `txnBatchSizes`, which counted the entries of a `$transaction([...])`
 * array. #3173 moved the usecase to the interactive form — the array can only
 * hold prebuilt Prisma promises, and the audit append is a function needing the
 * open transaction — so there is no array left to measure. The property being
 * asserted is unchanged and so is the reason for asserting it this way: call
 * ORDER cannot distinguish "inside the transaction" from "immediately after
 * it", because both produce the same sequence. Grouping can.
 */
const transactions: string[][] = [];
let openTx: string[] | null = null;
const record = (label: string) => {
    calls.push(label);
    if (openTx) openTx.push(label);
    else transactions.push([`OUTSIDE-ANY-TRANSACTION:${label}`]);
};
const appendAuditEntryWithin = jest.fn(async (..._a: unknown[]) => {
    record('appendAuditEntryWithin');
    return { id: 'audit-1', entryHash: 'h', previousHash: null };
});
/**
 * The org-chain append (#3173). Records whether it ran with a transaction still
 * open, rather than going through `record()`.
 *
 * It MUST be outside one — `appendOrgAuditEntry` opens its own `$transaction`
 * for a per-org advisory lock, so it cannot join the delete transaction. Routing
 * it through `record()` would file it as `OUTSIDE-ANY-TRANSACTION:…`, which the
 * atomicity test asserts is empty — and being outside is correct here, so that
 * would be the harness contradicting the design rather than checking it.
 */
const orgAppendFromInsideTx: boolean[] = [];
const appendOrgAuditEntry = jest.fn(async (..._a: unknown[]) => {
    orgAppendFromInsideTx.push(openTx !== null);
    return { id: 'org-audit-1', entryHash: 'h', previousHash: null };
});

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findFirst: (...a: unknown[]) => findFirst(...a),
            update: (...a: unknown[]) => update(...a),
        },
        tenantMembership: {
            updateMany: (...a: unknown[]) => membershipUpdateMany(...a),
            // Present so "did it erase instead of revoke?" is an assertion
            // rather than an absence the mock could not have expressed.
            deleteMany: (...a: unknown[]) => membershipDeleteMany(...a),
        },
        // #3166 — session invalidation. Mocked so the bump is assertable;
        // without it the call would throw and the test would fail for the
        // wrong reason.
        user: {
            updateMany: (...a: unknown[]) => userUpdateMany(...a),
        },
        // Interactive transaction (#3173). The callback receives a client that
        // records every write against the transaction it ran in, so atomicity
        // is asserted by GROUPING rather than by a count or a sequence.
        //
        // The array form is still handled: a mutation that reverts the usecase
        // to `$transaction([...])` must fail on an assertion that names the
        // defect, not on the mock throwing because it got the wrong type.
        $transaction: (arg: unknown) => {
            const writes: string[] = [];
            const outer = openTx;
            openTx = writes;
            const finish = () => { openTx = outer; transactions.push(writes); };
            if (typeof arg === 'function') {
                const tx = {
                    tenant: { update: (...a: unknown[]) => update(...a) },
                    tenantMembership: {
                        updateMany: (...a: unknown[]) => membershipUpdateMany(...a),
                        deleteMany: (...a: unknown[]) => membershipDeleteMany(...a),
                    },
                    user: { updateMany: (...a: unknown[]) => userUpdateMany(...a) },
                    // `appendAuditEntryWithin` issues raw SQL; present so a
                    // direct call on the tx cannot fail for a missing method.
                    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
                    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
                };
                return Promise.resolve((arg as (c: unknown) => Promise<unknown>)(tx))
                    .finally(finish);
            }
            return Promise.all(arg as unknown[]).finally(finish);
        },
        // recordTenantDeleted resolves plan via a BillingAccount lookup
        // (SAAS mode only). Mock it so the call is safe under any mode.
        billingAccount: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
    },
}));
// org-tenants.ts pulls these in at module load.
jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: jest.fn(() => ({ wrapped: 'x' })),
}));
jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    provisionAllOrgAdminsToTenant: jest.fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The real writer issues raw SQL against a live chain. Mocked here so the unit
// test can assert WHAT the usecase appends and WHERE — the writer's own
// behaviour is covered where it lives.
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntryWithin: (...a: unknown[]) => appendAuditEntryWithin(...a),
}));
jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: (...a: unknown[]) => appendOrgAuditEntry(...a),
}));

import { deleteTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    orgSlug: 'acme',
    requestId: 'req-1',
    orgRole: 'ORG_ADMIN',
    // Was `{}`, which was harmless while `deleteTenantUnderOrg` had no
    // permission check of its own. It now asserts `canManageTenants` (added
    // with the org denial-audit work, #2147), so an empty set refuses the very
    // ORG_ADMIN this context is meant to represent.
    permissions: { canManageTenants: true },
} as unknown as OrgContext;

/** The same org, seen by someone who may not manage tenants. */
const readerCtx = {
    organizationId: 'org-1',
    userId: 'user-reader',
    orgSlug: 'acme',
    requestId: 'req-2',
    orgRole: 'ORG_READER',
    permissions: { canManageTenants: false },
} as unknown as OrgContext;

/**
 * ONE reset, called from every `beforeEach` in this file.
 *
 * It was nested inside the first `describe`, so the #3173 block added at the
 * bottom — a sibling, not a child — inherited none of it and its mocks
 * accumulated across tests: a "called once" assertion saw two, then five. A
 * reset that only some blocks get is worse than none, because the blocks that
 * miss it fail for a reason that has nothing to do with what they assert.
 */
function installMocks() {
    findFirst.mockReset();
    update.mockReset();
    membershipUpdateMany.mockReset();
    membershipDeleteMany.mockReset();
    calls.length = 0;
    transactions.length = 0;
    openTx = null;
    appendAuditEntryWithin.mockClear();
    appendOrgAuditEntry.mockClear();
    appendOrgAuditEntry.mockImplementation(async () => {
        orgAppendFromInsideTx.push(openTx !== null);
        return { id: 'org-audit-1', entryHash: 'h', previousHash: null };
    });
    orgAppendFromInsideTx.length = 0;
    update.mockImplementation(() => {
        record('tenant.update');
        return Promise.resolve({});
    });
    membershipUpdateMany.mockImplementation(() => {
        record('tenantMembership.updateMany');
        return Promise.resolve({ count: 3 });
    });
    // Returns a BatchPayload like the real delegate, so swapping the
    // usecase to `deleteMany` fails on the assertion that names the
    // defect rather than on the mock returning undefined. A mutation
    // that crashes the harness proves the harness, not the assertion.
    membershipDeleteMany.mockImplementation(() => {
        record('tenantMembership.deleteMany');
        return Promise.resolve({ count: 3 });
    });
    // #3166 — same treatment: records its position so the ORDER assertion
    // can see it, and returns a BatchPayload like the real delegate.
    userUpdateMany.mockReset();
    userUpdateMany.mockImplementation(() => {
        record('user.updateMany');
        return Promise.resolve({ count: 3 });
    });
}

describe('deleteTenantUnderOrg', () => {
    it('refuses a caller without canManageTenants — the check the route no longer owns', async () => {
        // Added with #2147: before it, this usecase had NO permission check and
        // the route was the only gate, so a non-HTTP caller reached it
        // unguarded. Moving that check into `requireOrgPermission` without this
        // would have removed the only check there was.
        await expect(
            deleteTenantUnderOrg(readerCtx, 'tenant-1'),
        ).rejects.toMatchObject({ name: 'ForbiddenError' });
    });

    beforeEach(installMocks);

    it('soft-deletes a tenant belonging to the org (sets deletedAt, no hard delete)', async () => {
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        const res = await deleteTenantUnderOrg(ctx, 't-1');

        // Looked it up scoped to the org + not-already-deleted.
        expect(findFirst.mock.calls[0][0].where).toMatchObject({
            id: 't-1',
            organizationId: 'org-1',
            deletedAt: null,
        });
        // Soft-delete: update sets deletedAt, targets the row by id.
        const upd = update.mock.calls[0][0];
        expect(upd.where).toEqual({ id: 't-1' });
        expect(upd.data.deletedAt).toBeInstanceOf(Date);
        expect(res.tenant).toEqual({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
    });

    it('rejects (notFound) a tenant not in this org — never updates', async () => {
        findFirst.mockResolvedValue(null);
        await expect(deleteTenantUnderOrg(ctx, 'foreign')).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();
        expect(membershipUpdateMany).not.toHaveBeenCalled();
    });

    it('revokes every membership that still grants access, with the deletion timestamp', async () => {
        // The gap #2747 names: `deletedAt` is a claim about every future
        // query remembering the filter. The grants themselves outlived the
        // tenant for the whole 90-day retention window — 113 of them.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        expect(membershipUpdateMany).toHaveBeenCalledTimes(1);
        const args = membershipUpdateMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: 't-1',
            // ACTIVE and INVITED are exactly what `resolveTenantContext`
            // lets through. Selecting on them (rather than "not
            // DEACTIVATED") also leaves a REMOVED row's terminal state and
            // an earlier revocation's `deactivatedAt` untouched.
            status: { in: ['ACTIVE', 'INVITED'] },
        });
        expect(args.data).toEqual({
            status: 'DEACTIVATED',
            deactivatedAt: expect.any(Date),
        });
        // ONE timestamp for both halves — "the tenant was removed" and
        // "access ended" are the same event, and an auditor reading the two
        // rows must not see them drift by a query's duration.
        const deletedAt = update.mock.calls[0][0].data.deletedAt as Date;
        expect(args.data.deactivatedAt.getTime()).toBe(deletedAt.getTime());
    });

    it('revokes rather than erases — the rows stay for "who had access?"', async () => {
        // The file's own docstring promises the data is "retained for
        // compliance and a possible restore". A deleteMany would answer an
        // auditor's question with silence.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        expect(membershipDeleteMany).not.toHaveBeenCalled();
        expect(membershipUpdateMany.mock.calls[0][0].data.status).toBe('DEACTIVATED');
    });

    /*
        ── Session invalidation on removal (#3166) ─────────────────────

        `deletedAt` and a DEACTIVATED membership are both server-side facts, and
        the workspace switcher reads neither: memberships are baked into the JWT
        at sign-in, where `auth.ts` filters `tenant: { deletedAt: null }` once
        and never again. Without a `sessionVersion` bump a removed tenant stays
        in every signed-in member's switcher until they happen to sign out.

        Observed in production before this: three tenants removed on 2026-09-09
        were still listed on 2026-10-04.
    */
    it('bumps sessionVersion for the members who still carry the tenant', async () => {
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
        await deleteTenantUnderOrg(ctx, 't-1');

        expect(userUpdateMany).toHaveBeenCalledTimes(1);
        const arg = userUpdateMany.mock.calls[0][0] as {
            data: { sessionVersion: { increment: number } };
        };
        expect(arg.data.sessionVersion.increment).toBe(1);
    });

    it('and scopes the bump to THIS tenant, not every user', async () => {
        /*
            The assertion that matters most here. `updateMany` with a loose
            filter would sign out the entire installation on one tenant
            removal — worse than the stale switcher it fixes, and it would
            read as an outage rather than a bug.
        */
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
        await deleteTenantUnderOrg(ctx, 't-1');

        const where = (userUpdateMany.mock.calls[0][0] as {
            where: { tenantMemberships?: { some?: { tenantId?: string } } };
        }).where;
        expect(where.tenantMemberships?.some?.tenantId).toBe('t-1');
    });

    it('inside the SAME transaction as the soft-delete, not after it', async () => {
        /*
            A session outliving a committed removal is the gap being closed, so
            the bump has to be part of the atom — and from #3173 so is the audit
            entry, which is the whole reason a removal is now recorded at all.

            Asserted on the GROUPING: one transaction, and every write named
            inside it. The call ORDER cannot express this — a statement moved to
            just after the transaction produces exactly the same sequence — so
            an order-only assertion would carry this name while being unable to
            fail for the reason it names. This replaces the `txnBatchSizes`
            count, which could only measure a `$transaction([...])` array.
        */
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
        await deleteTenantUnderOrg(ctx, 't-1');

        expect(transactions).toEqual([[
            'tenant.update',
            'tenantMembership.updateMany',
            'user.updateMany',
            'appendAuditEntryWithin',
        ]]);
        // Nothing reached the client with no transaction open.
        expect(transactions.flat().filter(w => w.startsWith('OUTSIDE'))).toEqual([]);
    });

    it('soft-deletes BEFORE revoking, which is what clears the last-OWNER trigger', async () => {
        // `tenant_membership_last_owner_guard` raises P0001 on deactivating a
        // tenant's last ACTIVE OWNER, and migration 20260922200000 exempts
        // only a tenant already carrying `deletedAt`. Reverse these two and
        // every deletion aborts against a real database while this file's
        // mocks — which have no triggers — stay green.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        /*
            The session bump joins the end of the sequence (#3166). It is listed
            here rather than loosening this to a `toContain`, because the FIRST
            two positions are the load-bearing part — the trigger exemption
            above depends on `deletedAt` already being written — and an
            order-insensitive assertion would stop saying so.

            Third is the right place for it: nothing about invalidating a
            session constrains the trigger, so it has no reason to precede
            either statement, and putting it last keeps the pair adjacent and
            readable as the unit they are.
        */
        expect(calls).toEqual([
            'tenant.update',
            'tenantMembership.updateMany',
            'user.updateMany',
            'appendAuditEntryWithin',
        ]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// #3173 — a removal that nothing recorded
// ═════════════════════════════════════════════════════════════════════

describe('the removal is written to the audit trail', () => {
    beforeEach(() => {
        installMocks();
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'PwC NIS2' });
    });

    /**
     * Measured on production 2026-10-04: nine tenants carry a `deletedAt` and
     * neither chain holds a row for any of them — `AuditLog` 3,714 rows,
     * `OrgAuditLog` 82, `AuditOutbox` 0. A REFUSED removal has been audited
     * since #2147; the act itself was not.
     */
    it('appends a TENANT_REMOVED entry on the tenant own chain', async () => {
        await deleteTenantUnderOrg(ctx, 't-1');

        expect(appendAuditEntryWithin).toHaveBeenCalledTimes(1);
        const [, input] = appendAuditEntryWithin.mock.calls[0] as unknown as [
            unknown,
            {
                tenantId: string; entity: string; entityId: string; action: string;
                userId: string | null; actorType: string; requestId: string;
                detailsJson: Record<string, unknown>;
            },
        ];
        expect(input).toMatchObject({
            tenantId: 't-1',
            entity: 'Tenant',
            entityId: 't-1',
            action: 'TENANT_REMOVED',
            // The org admin who did it — the field whose absence made the
            // production deletions unattributable.
            userId: 'u-1',
            actorType: 'USER',
            requestId: 'req-1',
        });
    });

    it('the payload is a structured entity_lifecycle event, not a text blob', async () => {
        await deleteTenantUnderOrg(ctx, 't-1');

        const [, input] = appendAuditEntryWithin.mock.calls[0] as unknown as [
            unknown, { detailsJson: Record<string, unknown>; details: string },
        ];
        expect(input.detailsJson).toMatchObject({
            category: 'entity_lifecycle',
            operation: 'soft_delete',
            entityName: 'PwC NIS2',
        });
        expect(input.details).toContain('pwc-nis2');
    });

    /**
     * The count the operator asks about next, and the one the `logger.info`
     * line has always carried. It can only be right if the append runs AFTER
     * the membership update inside the same transaction — read before it, this
     * would be whatever the mock's default is.
     */
    it('carries the number of memberships it revoked', async () => {
        membershipUpdateMany.mockImplementation(() => {
            record('tenantMembership.updateMany');
            return Promise.resolve({ count: 11 });
        });

        await deleteTenantUnderOrg(ctx, 't-1');

        const [, input] = appendAuditEntryWithin.mock.calls[0] as unknown as [
            unknown, { detailsJson: { revokedMemberships: number } },
        ];
        expect(input.detailsJson.revokedMemberships).toBe(11);
    });

    /**
     * LAST, so it fails closed: if the entry cannot be written, no workspace
     * disappears unrecorded. A row claiming a deletion that then rolled back
     * would be worse than none, because it would be on a hash chain.
     */
    it('a failing append aborts the whole removal', async () => {
        appendAuditEntryWithin.mockRejectedValueOnce(new Error('chain unavailable') as never);

        await expect(deleteTenantUnderOrg(ctx, 't-1')).rejects.toThrow('chain unavailable');
    });

    it('and a refused caller never reaches the append at all', async () => {
        // The control: an audit entry for a removal that did not happen would
        // be a false record, which is the one thing worse than a missing one.
        await expect(deleteTenantUnderOrg(readerCtx, 't-1')).rejects.toThrow();
        expect(appendAuditEntryWithin).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// #3173 — the org-level record, which is the READABLE one
// ═════════════════════════════════════════════════════════════════════

describe('the removal is also recorded where it can still be read', () => {
    beforeEach(() => {
        installMocks();
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'PwC NIS2' });
    });

    /**
     * WHY A SECOND ENTRY AT ALL. The durable one goes on the tenant's own chain,
     * and `resolveTenantContext` throws notFound on `deletedAt` — its own comment
     * calls itself "the single authoritative gate — every /t and /api/t request
     * resolves through here". So the instant the removal commits, all 59 route
     * groups under /api/t 404 for that tenant, its audit-log route included, and
     * the durable record is reachable by direct database query and nothing else.
     * The org audit log is the only surface that still answers.
     */
    it('appends ORG_TENANT_DELETED to the org chain', async () => {
        await deleteTenantUnderOrg(ctx, 't-1');

        expect(appendOrgAuditEntry).toHaveBeenCalledTimes(1);
        const [input] = appendOrgAuditEntry.mock.calls[0] as unknown as [{
            organizationId: string; actorUserId: string | null; actorType: string;
            action: string; targetUserId: string | null; requestId: string;
            detailsJson: Record<string, unknown>;
        }];
        expect(input).toMatchObject({
            organizationId: 'org-1',
            actorUserId: 'u-1',
            actorType: 'USER',
            action: 'ORG_TENANT_DELETED',
            // The target is a TENANT; `targetUserId` is for member lifecycle.
            targetUserId: null,
            requestId: 'req-1',
        });
        expect(input.detailsJson).toMatchObject({
            tenantId: 't-1', slug: 'pwc-nis2', name: 'PwC NIS2', revokedMemberships: 3,
        });
    });

    /**
     * It CANNOT be inside the delete transaction: `appendOrgAuditEntry` opens its
     * own for a per-org advisory lock, and an interactive transaction client has
     * no `$transaction` to join. Asserting it is outside pins the shape, so a
     * later edit that "tidies" it into the transaction fails here rather than at
     * runtime on a type error nobody sees until deploy.
     */
    it('from outside the delete transaction, which is the only place it can run', async () => {
        await deleteTenantUnderOrg(ctx, 't-1');

        expect(orgAppendFromInsideTx).toEqual([false]);
        // And the transaction still holds exactly the four durable statements.
        expect(transactions).toEqual([[
            'tenant.update',
            'tenantMembership.updateMany',
            'user.updateMany',
            'appendAuditEntryWithin',
        ]]);
    });

    /**
     * BEST-EFFORT, and the asymmetry is deliberate. The removal has already
     * committed by the time this runs, so throwing would report failure for work
     * that succeeded — the exact defect #3175 fixed in the module toggle. The
     * durable record exists either way; this entry is about reachability.
     */
    it('a failing org append does not fail a removal that already committed', async () => {
        appendOrgAuditEntry.mockRejectedValueOnce(new Error('org chain locked') as never);

        await expect(deleteTenantUnderOrg(ctx, 't-1')).resolves.toMatchObject({
            tenant: { id: 't-1', slug: 'pwc-nis2' },
        });
        // The durable half still happened — that is what makes failing open safe.
        expect(appendAuditEntryWithin).toHaveBeenCalledTimes(1);
    });

    it('and says so, rather than going quiet', async () => {
        // A silently dropped audit entry is the failure mode #2657 exists to
        // remove. Best-effort has to mean logged, not ignored.
        const { logger } = jest.requireMock('@/lib/observability/logger') as {
            logger: { warn: jest.Mock };
        };
        appendOrgAuditEntry.mockRejectedValueOnce(new Error('org chain locked') as never);

        await deleteTenantUnderOrg(ctx, 't-1');

        const warned = logger.warn.mock.calls.map(c => c[0] as string);
        expect(warned).toContain('org-audit.emit_failed');
    });

    /**
     * THE CONTROL for the asymmetry: the two records fail in opposite directions
     * on purpose, and without this the suite could not tell a deliberate
     * fail-open from a missing throw.
     */
    it('while a failing DURABLE append still aborts the whole removal', async () => {
        appendAuditEntryWithin.mockRejectedValueOnce(new Error('chain unavailable') as never);

        await expect(deleteTenantUnderOrg(ctx, 't-1')).rejects.toThrow('chain unavailable');
        // Never reached — the transaction rolled back, so there is nothing to
        // record at org level either.
        expect(appendOrgAuditEntry).not.toHaveBeenCalled();
    });
});
