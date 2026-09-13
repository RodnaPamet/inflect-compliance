/**
 * EP-3 — EvidenceControlLink RLS + composite-FK behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`) confirms the
 * canonical three policies + FORCE flag exist on the table. These tests drive
 * the actual semantics against a live Postgres through `withTenantDb`
 * (SET LOCAL ROLE app_user + app.tenant_id), so any future migration that
 * quietly weakens isolation breaks here even if the static surface still reads
 * as correct.
 *
 * Coverage
 * --------
 *   1. INSERT under app_user with own tenantId → succeeds.
 *   2. INSERT under app_user with a foreign tenantId → blocked by
 *      tenant_isolation_insert.
 *   3. SELECT under app_user is tenant-scoped — TENANT_A cannot see
 *      TENANT_B's links.
 *   4. The composite FK (evidenceId, tenantId) → Evidence(id, tenantId)
 *      forbids a link that references another tenant's evidence (a
 *      cross-tenant link is impossible at the DB level).
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

const SUITE_TAG = `ep3-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let USER_A_ID = '';
let USER_B_ID = '';
let CONTROL_A_ID = '';
let CONTROL_B_ID = '';
let EVIDENCE_A_ID = '';
let EVIDENCE_B_ID = '';

async function seed() {
    for (const [id, suffix] of [[TENANT_A_ID, 'a'], [TENANT_B_ID, 'b']] as const) {
        await globalPrisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: `t ${SUITE_TAG}-${suffix}`, slug: `${SUITE_TAG}-${suffix}` },
        });
    }
    const ua = await globalPrisma.user.create({
        data: { email: `${SUITE_TAG}-a@example.test`, emailHash: hashForLookup(`${SUITE_TAG}-a@example.test`) },
    });
    USER_A_ID = ua.id;
    const ub = await globalPrisma.user.create({
        data: { email: `${SUITE_TAG}-b@example.test`, emailHash: hashForLookup(`${SUITE_TAG}-b@example.test`) },
    });
    USER_B_ID = ub.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_A_ID, userId: USER_A_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_B_ID, userId: USER_B_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    const ctrlA = await globalPrisma.control.create({ data: { tenantId: TENANT_A_ID, name: 'A: control' } });
    CONTROL_A_ID = ctrlA.id;
    const ctrlB = await globalPrisma.control.create({ data: { tenantId: TENANT_B_ID, name: 'B: control' } });
    CONTROL_B_ID = ctrlB.id;
    const evA = await globalPrisma.evidence.create({
        data: { tenantId: TENANT_A_ID, type: 'TEXT', title: 'A: evidence' },
    });
    EVIDENCE_A_ID = evA.id;
    const evB = await globalPrisma.evidence.create({
        data: { tenantId: TENANT_B_ID, type: 'TEXT', title: 'B: evidence' },
    });
    EVIDENCE_B_ID = evB.id;
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.evidenceControlLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.evidence.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.control.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    // AuditLog is append-only (IMMUTABLE_AUDIT_LOG trigger); TenantMembership
    // carries the LAST_OWNER_GUARD — drop under replica role so the delete
    // sweep isn't blocked by those triggers.
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    if (USER_A_ID) await globalPrisma.user.delete({ where: { id: USER_A_ID } });
    if (USER_B_ID) await globalPrisma.user.delete({ where: { id: USER_B_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describeFn('EP-3 — EvidenceControlLink RLS + composite FK', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.evidenceControlLink.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
    });

    it('app_user INSERT with own tenantId succeeds', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const link = await tx.evidenceControlLink.create({
                data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, controlId: CONTROL_A_ID },
            });
            return link.id;
        });
        const persisted = await globalPrisma.evidenceControlLink.findUnique({ where: { id } });
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.evidenceId).toBe(EVIDENCE_A_ID);
        expect(persisted?.controlId).toBe(CONTROL_A_ID);
    });

    it('app_user INSERT with a foreign tenantId is blocked', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceControlLink.create({
                    data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, controlId: CONTROL_B_ID },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates|foreign key/i);
    });

    it('app_user SELECT only sees own-tenant links', async () => {
        const aLink = await globalPrisma.evidenceControlLink.create({
            data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, controlId: CONTROL_A_ID },
        });
        const bLink = await globalPrisma.evidenceControlLink.create({
            data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, controlId: CONTROL_B_ID },
        });
        const visibleToA = await withTenantDb(TENANT_A_ID, async (tx) => {
            return tx.evidenceControlLink.findMany({
                where: { id: { in: [aLink.id, bLink.id] } },
                select: { id: true },
            });
        });
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(aLink.id)).toBe(true);
        expect(ids.has(bLink.id)).toBe(false);
    });

    it('composite FK rejects a link that references another tenant\'s evidence', async () => {
        // tenantId=A but evidenceId points at B's evidence — (evidenceB, A)
        // has no matching Evidence(id, tenantId) row, so the composite FK
        // rejects it regardless of RLS.
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceControlLink.create({
                    data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_B_ID, controlId: CONTROL_A_ID },
                });
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });
});
