/**
 * DSAR register — two-tenant isolation.
 *
 * THIS TEST IS A COMPENSATING CONTROL, not a nice-to-have.
 *
 * `DataSubjectRequest` has no `tenantId`, so it is on neither isolation axis:
 * no `tenant_isolation` RLS policy exists for the table, and every structural
 * guardrail (rls-coverage, tenant-isolation-*, the forward-lock) iterates
 * tenant-scoped models and therefore cannot see it. `runInTenantContext` sets
 * `app.tenant_id` but no policy consults it here.
 *
 * That leaves `scopedToTenantMembers()` in `usecases/dsar-register.ts` as the
 * ONLY thing standing between a tenant admin and every rights request on the
 * platform — and a query that drops the join returns other tenants' rows while
 * CI stays green. These assertions are what would catch that.
 *
 * RUN: npx jest tests/integration/dsar-register-isolation.test.ts
 */
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    listDsarRequests,
    recordDsarRequest,
    transitionDsarRequest,
} from '@/app-layer/usecases/dsar-register';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('DSAR register — tenant isolation (integration)', () => {
    const runId = randomUUID().slice(0, 12);
    let tenantA = '';
    let tenantB = '';
    let userA = '';
    let userB = '';
    let dsarA = '';
    let dsarB = '';
    let staffA = '';
    let staffB = '';
    let ctxA: ReturnType<typeof makeRequestContext>;
    let ctxB: ReturnType<typeof makeRequestContext>;

    beforeAll(async () => {
        const [tA, tB] = await Promise.all([
            prisma.tenant.create({ data: { name: `dsarA-${runId}`, slug: `dsara-${runId}` } }),
            prisma.tenant.create({ data: { name: `dsarB-${runId}`, slug: `dsarb-${runId}` } }),
        ]);
        tenantA = tA.id;
        tenantB = tB.id;

        const [uA, uB] = await Promise.all([
            prisma.user.create({ data: { email: `dsar-a-${runId}@test.com`, name: 'Subject A' } }),
            prisma.user.create({ data: { email: `dsar-b-${runId}@test.com`, name: 'Subject B' } }),
        ]);
        userA = uA.id;
        userB = uB.id;

        // Each subject is an ACTIVE member of exactly one tenant.
        await prisma.tenantMembership.createMany({
            data: [
                { tenantId: tenantA, userId: userA, role: Role.READER, status: 'ACTIVE' },
                { tenantId: tenantB, userId: userB, role: Role.READER, status: 'ACTIVE' },
            ],
        });

        const [dA, dB] = await Promise.all([
            prisma.dataSubjectRequest.create({ data: { userId: userA, type: 'EXPORT', status: 'RECEIVED' } }),
            prisma.dataSubjectRequest.create({ data: { userId: userB, type: 'ERASURE', status: 'RECEIVED' } }),
        ]);
        dsarA = dA.id;
        dsarB = dB.id;

        // Real staff rows: `handledById` is a FK to User, and the default
        // `user-1` from makeRequestContext does not exist in the database.
        const [sA, sB] = await Promise.all([
            prisma.user.create({ data: { email: `dsar-staff-a-${runId}@test.com`, name: 'Staff A' } }),
            prisma.user.create({ data: { email: `dsar-staff-b-${runId}@test.com`, name: 'Staff B' } }),
        ]);
        staffA = sA.id;
        staffB = sB.id;

        ctxA = makeRequestContext(Role.ADMIN, { tenantId: tenantA, tenantSlug: tA.slug, userId: staffA });
        ctxB = makeRequestContext(Role.ADMIN, { tenantId: tenantB, tenantSlug: tB.slug, userId: staffB });
    });

    afterAll(async () => {
        // Replica-mode teardown. The transitions under test call `logEvent`,
        // which writes AuditLog rows; deleting the tenants cascades into them
        // and trips the IMMUTABLE_AUDIT_LOG trigger, failing the whole SUITE
        // (not a test) with "UPDATE operations on AuditLog are forbidden".
        // `session_replication_role = 'replica'` disables triggers for the
        // transaction so fixtures can be cleaned up without weakening the
        // trigger itself. Same pattern as tests/integration/task-filters.test.ts.
        await prisma.dataSubjectRequest.deleteMany({ where: { id: { in: [dsarA, dsarB] } } });
        await deleteAuditRowsForTenants(prisma, [tenantA, tenantB]);
        await prisma.$transaction(async (tx: typeof prisma) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            for (const id of [tenantA, tenantB]) {
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, id);
            }
        });
        await prisma.user.deleteMany({ where: { id: { in: [userA, userB, staffA, staffB] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    });

    it("tenant A sees only its own member's request", async () => {
        const rows = await listDsarRequests(ctxA);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(dsarA);
        expect(ids).not.toContain(dsarB);
    });

    it("tenant B sees only its own member's request", async () => {
        const rows = await listDsarRequests(ctxB);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(dsarB);
        expect(ids).not.toContain(dsarA);
    });

    it('a guessed id from another tenant cannot be transitioned', async () => {
        // The scoping predicate must ride on the READ inside the transition,
        // not just the list — otherwise knowing an id is enough to mutate it.
        await expect(
            transitionDsarRequest(ctxA, dsarB, { to: 'VERIFIED' }),
        ).rejects.toThrow(/not found/i);

        const untouched = await prisma.dataSubjectRequest.findUnique({ where: { id: dsarB } });
        expect(untouched?.status).toBe('RECEIVED');
    });

    it('cannot record a request against a non-member', async () => {
        await expect(
            recordDsarRequest(ctxA, { userId: userB, type: 'EXPORT' }),
        ).rejects.toThrow(/no active member/i);
    });

    it('a DEACTIVATED membership stops surfacing the subject', async () => {
        // Stricter than the request gate on purpose: someone who has left the
        // tenant should not have their rights request visible to its staff.
        await prisma.tenantMembership.updateMany({
            where: { tenantId: tenantA, userId: userA },
            data: { status: 'DEACTIVATED' },
        });
        try {
            const rows = await listDsarRequests(ctxA);
            expect(rows.map((r) => r.id)).not.toContain(dsarA);
        } finally {
            await prisma.tenantMembership.updateMany({
                where: { tenantId: tenantA, userId: userA },
                data: { status: 'ACTIVE' },
            });
        }
    });

    it('records fulfilment provenance and never writes an export URL', async () => {
        const moved = await transitionDsarRequest(ctxA, dsarA, {
            to: 'VERIFIED',
            notes: 'Identity confirmed by phone callback.',
        });
        expect(moved.status).toBe('VERIFIED');
        expect(moved.handledBy?.id).toBe(ctxA.userId);
        expect(moved.fulfilmentNotes).toBe('Identity confirmed by phone callback.');

        // Nothing in this module produces a bundle — the column must stay null.
        const raw = await prisma.dataSubjectRequest.findUnique({ where: { id: dsarA } });
        expect(raw?.exportUrl).toBeNull();
        expect(raw?.exportExpiresAt).toBeNull();
    });
});
