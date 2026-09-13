/**
 * Epic G-5 — ControlException schema, RLS, FK, and CHECK-constraint
 * behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`)
 * confirms the canonical three policies + FORCE flag exist on the
 * table. These tests exercise the actual semantics against a live
 * Postgres so any future migration that quietly weakens them
 * breaks here even if the static surface still reads as correct.
 *
 * Coverage
 * --------
 *   1. INSERT under `app_user` with own tenantId → succeeds, default
 *      status is REQUESTED.
 *   2. INSERT under `app_user` with a foreign tenantId → blocked by
 *      tenant_isolation_insert.
 *   3. SELECT under `app_user` is tenant-scoped — TENANT_A cannot
 *      see TENANT_B's exceptions.
 *   4. Composite FK forbids cross-tenant control reference (a child
 *      row whose `(controlId, tenantId)` doesn't match a Control row
 *      is rejected by the FK regardless of RLS).
 *   5. Compensating-control composite FK — same cross-tenant
 *      protection applies.
 *   6. Renewal lineage — `renewedFromId` must point to a row in the
 *      same tenant; cross-tenant renewal is rejected.
 *   7. Self-renewal CHECK — a row cannot list itself in
 *      `renewedFromId`.
 *   8. APPROVAL CHECK — an APPROVED row missing the approver triple
 *      (approvedAt + approvedByUserId + expiresAt) is rejected.
 *   9. REJECTION CHECK — REJECTED requires rejectedAt + rejectedByUserId;
 *      `rejectionReason` on a non-rejected row is rejected.
 *  10. Tenant-scoped relation reachability — a renewal row reads
 *      back its `renewedFrom` cleanly via the join.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g5-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let USER_A_ID = '';
let USER_B_ID = '';
let CONTROL_A_ID = '';
let CONTROL_A_COMPENSATING_ID = '';
let CONTROL_B_ID = '';

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_A_ID },
        update: {},
        create: {
            id: TENANT_A_ID,
            name: `t ${SUITE_TAG}-a`,
            slug: `${SUITE_TAG}-a`,
        },
    });
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_B_ID },
        update: {},
        create: {
            id: TENANT_B_ID,
            name: `t ${SUITE_TAG}-b`,
            slug: `${SUITE_TAG}-b`,
        },
    });
    const ua = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-a@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-a@example.test`),
        },
    });
    USER_A_ID = ua.id;
    const ub = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-b@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-b@example.test`),
        },
    });
    USER_B_ID = ub.id;
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_A_ID,
            userId: USER_A_ID,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_B_ID,
            userId: USER_B_ID,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    const ctrlA = await globalPrisma.control.create({
        data: { tenantId: TENANT_A_ID, name: 'A: control under exception' },
    });
    CONTROL_A_ID = ctrlA.id;
    const ctrlAcomp = await globalPrisma.control.create({
        data: { tenantId: TENANT_A_ID, name: 'A: compensating control' },
    });
    CONTROL_A_COMPENSATING_ID = ctrlAcomp.id;
    const ctrlB = await globalPrisma.control.create({
        data: { tenantId: TENANT_B_ID, name: 'B: control' },
    });
    CONTROL_B_ID = ctrlB.id;
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.controlException.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.control.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    if (USER_A_ID) await globalPrisma.user.delete({ where: { id: USER_A_ID } });
    if (USER_B_ID) await globalPrisma.user.delete({ where: { id: USER_B_ID } });
    await globalPrisma.tenant.deleteMany({
        where: { id: { in: tenantIds } },
    });
}

describeFn('Epic G-5 — ControlException RLS + FK + CHECK constraints', () => {
    beforeAll(async () => {
        await seed();
    });

    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    afterEach(async () => {
        await globalPrisma.controlException.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
    });

    // ── 1. Default state + own-tenant insert ───────────────────────

    it('app_user INSERT with own tenantId succeeds and defaults status=REQUESTED', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const ex = await tx.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    justification: 'legacy system cannot enforce X',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            });
            return ex.id;
        });
        const persisted = await globalPrisma.controlException.findUnique({
            where: { id },
        });
        expect(persisted?.status).toBe('REQUESTED');
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.expiresAt).toBeNull();
        expect(persisted?.approvedAt).toBeNull();
    });

    // ── 2. Foreign tenant insert blocked ───────────────────────────

    it('app_user INSERT with a foreign tenantId is blocked', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.controlException.create({
                    data: {
                        tenantId: TENANT_B_ID, // wrong tenant
                        controlId: CONTROL_B_ID,
                        justification: 'rogue',
                        riskAcceptedByUserId: USER_A_ID,
                        createdByUserId: USER_A_ID,
                    },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    // ── 3. SELECT visibility tenant-scoped ─────────────────────────

    it('app_user SELECT only sees own-tenant exceptions', async () => {
        const aRow = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_A_ID,
                controlId: CONTROL_A_ID,
                justification: 'a-tenant',
                riskAcceptedByUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        const bRow = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_B_ID,
                controlId: CONTROL_B_ID,
                justification: 'b-tenant',
                riskAcceptedByUserId: USER_B_ID,
                createdByUserId: USER_B_ID,
            },
        });
        const visibleToA = await withTenantDb(TENANT_A_ID, async (tx) => {
            return tx.controlException.findMany({
                where: { id: { in: [aRow.id, bRow.id] } },
                select: { id: true },
            });
        });
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(aRow.id)).toBe(true);
        expect(ids.has(bRow.id)).toBe(false);
    });

    // ── 4. Composite FK — control must be in same tenant ──────────

    it('composite FK rejects an exception that names a control in another tenant', async () => {
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_B_ID, // tenant B's control
                    justification: 'cross-tenant claim',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ── 5. Compensating-control composite FK ───────────────────────

    it('composite FK rejects a compensatingControl in another tenant', async () => {
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    compensatingControlId: CONTROL_B_ID, // wrong tenant
                    justification: 'cross-tenant compensating',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ── 6. Renewal lineage — same tenant only ──────────────────────

    it('renewedFromId composite FK rejects cross-tenant renewals', async () => {
        const bRow = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_B_ID,
                controlId: CONTROL_B_ID,
                justification: 'b-original',
                riskAcceptedByUserId: USER_B_ID,
                createdByUserId: USER_B_ID,
            },
        });
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    renewedFromId: bRow.id, // points at TENANT_B row
                    justification: 'cross-tenant renewal',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ── 7. Self-renewal CHECK ──────────────────────────────────────

    it('CHECK rejects a row that names itself in renewedFromId', async () => {
        const id = `cex-${randomUUID()}`;
        await expect(
            globalPrisma.controlException.create({
                data: {
                    id,
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    renewedFromId: id, // self
                    justification: 'self',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    // ── 8. Approval CHECK shape ────────────────────────────────────

    it('CHECK — APPROVED without the full approver triple is rejected', async () => {
        // status APPROVED but missing expiresAt
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    status: 'APPROVED',
                    approvedAt: new Date(),
                    approvedByUserId: USER_A_ID,
                    // expiresAt missing
                    justification: 'incomplete approval',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    it('CHECK — APPROVED with the full triple succeeds', async () => {
        const ex = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_A_ID,
                controlId: CONTROL_A_ID,
                compensatingControlId: CONTROL_A_COMPENSATING_ID,
                status: 'APPROVED',
                approvedAt: new Date(),
                approvedByUserId: USER_A_ID,
                expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
                justification: 'complete approval',
                riskAcceptedByUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        expect(ex.status).toBe('APPROVED');
        expect(ex.compensatingControlId).toBe(CONTROL_A_COMPENSATING_ID);
    });

    // ── 9. Rejection CHECK shape ───────────────────────────────────

    it('CHECK — rejectionReason on a non-rejected row is rejected', async () => {
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    rejectionReason: 'malformed', // status is REQUESTED
                    justification: 'incomplete rejection',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    it('CHECK — REJECTED requires rejectedAt + rejectedByUserId', async () => {
        await expect(
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_A_ID,
                    controlId: CONTROL_A_ID,
                    status: 'REJECTED',
                    // rejectedAt + rejectedByUserId missing
                    justification: 'malformed reject',
                    riskAcceptedByUserId: USER_A_ID,
                    createdByUserId: USER_A_ID,
                },
            }),
        ).rejects.toThrow(/check constraint|violates/i);
    });

    // ── 10. Renewal join reachable ─────────────────────────────────

    it('renewal lineage reads back the prior row via the relation', async () => {
        const original = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_A_ID,
                controlId: CONTROL_A_ID,
                status: 'EXPIRED',
                approvedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
                approvedByUserId: USER_A_ID,
                expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
                justification: 'original',
                riskAcceptedByUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
        });
        const renewed = await globalPrisma.controlException.create({
            data: {
                tenantId: TENANT_A_ID,
                controlId: CONTROL_A_ID,
                renewedFromId: original.id,
                justification: 'renewed for another quarter',
                riskAcceptedByUserId: USER_A_ID,
                createdByUserId: USER_A_ID,
            },
            include: {
                renewedFrom: {
                    select: { id: true, status: true, justification: true },
                },
            },
        });
        expect(renewed.renewedFrom?.id).toBe(original.id);
        expect(renewed.renewedFrom?.status).toBe('EXPIRED');
        // justification is encrypted at rest; the read-side middleware
        // decrypts it via the manifest.
        expect(renewed.renewedFrom?.justification).toBe('original');
    });
});
