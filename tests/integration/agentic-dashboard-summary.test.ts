/**
 * THE DASHBOARD SUMMARY COUNTS THE REGISTER BY STANDING (#2560).
 *
 * The widget was asked for "count by standing, open approvals, and any kill
 * switch in force", and for a widget that appears "when any agent is
 * registered". Two of those four shipped. `getAgenticDashboardSummary`
 * returned five numbers and not one of them was a census: the only `status`
 * term in the whole function was a FILTER inside `activeUnscored` — a
 * risk-tier fact that happens to be restricted to one standing.
 *
 * So a workspace with twelve SUSPENDED agents and one ACTIVE one read
 * identically to a workspace with a single ACTIVE agent, and a workspace with
 * NO agents read as a governed fleet with nothing wrong.
 *
 * ── WHAT EACH ASSERTION HERE IS FOR ─────────────────────────────────────────
 *
 * The census itself is the easy half. The two rails around it are the half
 * that produce a PLAUSIBLE WRONG NUMBER rather than a crash, which is why each
 * is asserted against a second, independently-derived figure rather than
 * against the census alone:
 *
 *   · SOFT DELETE. `byStanding.ACTIVE` is asserted beside a raw
 *     `prisma.registeredAgent.count` over the same standing with NO
 *     `deletedAt` predicate. The two numbers differ by exactly the seeded
 *     tombstone, so an implementation that forgot `deletedAt: null` makes the
 *     two sides equal and this file says which one moved.
 *   · TENANT. Tenant B's three SUSPENDED agents are seeded before tenant A's
 *     summary is read, so "SUSPENDED: 1" is a number that had a wrong answer
 *     available to it.
 *
 * ── WHAT THE TENANT ASSERTION ACTUALLY CERTIFIES, MEASURED ──────────────────
 *
 * Not the `tenantId` term in the where-clause. That term was REMOVED and this
 * file stayed green, because the read runs inside `runInTenantContext`, which
 * does `SET LOCAL ROLE app_user` and sets `app.tenant_id`; `RegisteredAgent`
 * carries FORCED row-level security whose `tenant_isolation` policy is
 * `"tenantId" = current_setting('app.tenant_id')`, and `app_user` is not a
 * superuser, so Postgres is the operative guard and the predicate beside it is
 * defence in depth.
 *
 * What DOES redden it is moving the `groupBy` off the tenant transaction onto
 * the bare client — i.e. disabling the real mechanism. That is the mutation
 * that certifies this assertion, and it is recorded here so a later reader
 * does not mistake a green run after dropping the predicate for proof that the
 * predicate is what holds.
 *
 * ── ZERO-FILL ───────────────────────────────────────────────────────────────
 *
 * `groupBy` returns NO ROW for a standing with no agents. Tenant C holds only
 * ACTIVE agents and its census is asserted as an exact four-key object, so an
 * implementation that folds the rows into an empty record leaves
 * `SUSPENDED` undefined and fails here — the state in which a consumer renders
 * a blank or `NaN` where a `0` belongs.
 */
import { PrismaClient, AgentStatus, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getAgenticDashboardSummary } from '@/app-layer/usecases/agent-registry';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

/** A mixed register: every standing occupied, plus one tombstone. */
const T1 = 'agentcensus-tenant-one';
/** SUSPENDED-only, and seeded alongside — the wrong answer tenant A must not give. */
const T2 = 'agentcensus-tenant-two';
/** ACTIVE-only — the tenant whose census proves the zero-fill. */
const T3 = 'agentcensus-tenant-three';
const TENANTS = [T1, T2, T3] as const;

const ownerOf: Record<string, string> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: ownerOf[tenantId],
    });

/**
 * One row of the seed. `aiSystemId` is UNIQUE on `RegisteredAgent` — the link
 * is 1:1 — so every agent gets its own host system, seeded alongside it.
 */
interface Seed {
    tenant: string;
    status: AgentStatus;
    deleted: boolean;
}

const SEED: readonly Seed[] = [
    { tenant: T1, status: AgentStatus.ACTIVE, deleted: false },
    { tenant: T1, status: AgentStatus.ACTIVE, deleted: false },
    { tenant: T1, status: AgentStatus.SUSPENDED, deleted: false },
    { tenant: T1, status: AgentStatus.DRAFT, deleted: false },
    { tenant: T1, status: AgentStatus.RETIRED, deleted: false },
    // The tombstone. ACTIVE on the row, gone from the register — the one row
    // that separates a census with `deletedAt: null` from one without it.
    { tenant: T1, status: AgentStatus.ACTIVE, deleted: true },
    { tenant: T2, status: AgentStatus.SUSPENDED, deleted: false },
    { tenant: T2, status: AgentStatus.SUSPENDED, deleted: false },
    { tenant: T2, status: AgentStatus.SUSPENDED, deleted: false },
    { tenant: T3, status: AgentStatus.ACTIVE, deleted: false },
    { tenant: T3, status: AgentStatus.ACTIVE, deleted: false },
];

async function clearOwnRows(): Promise<void> {
    const where = { tenantId: { in: [...TENANTS] } };
    await prisma.workflowRun.deleteMany({ where });
    await prisma.registeredAgent.deleteMany({ where });
    await prisma.aiSystem.deleteMany({ where });
    await deleteAuditRowsForTenants(prisma, [...TENANTS]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [...TENANTS],
        );
    });
    await prisma.user.deleteMany({
        where: {
            emailHash: { in: TENANTS.map((t) => hashForLookup(`owner@${t}.test`)) },
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [...TENANTS] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const tenantId of TENANTS) {
        await prisma.tenant.create({
            data: { id: tenantId, name: `Census ${tenantId}`, slug: tenantId },
        });
        const email = `owner@${tenantId}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerOf[tenantId] = user.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
    }

    let seq = 0;
    for (const row of SEED) {
        const n = seq++;
        const aiSystem = await prisma.aiSystem.create({
            data: {
                id: `agentcensus-sys-${String(n).padStart(3, '0')}`,
                tenantId: row.tenant,
                name: `Host ${n}`,
                ownerUserId: ownerOf[row.tenant],
            },
        });
        await prisma.registeredAgent.create({
            data: {
                tenantId: row.tenant,
                aiSystemId: aiSystem.id,
                name: `census-agent-${n}`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                status: row.status,
                ownerUserId: ownerOf[row.tenant],
                createdByUserId: ownerOf[row.tenant],
                deletedAt: row.deleted ? new Date() : null,
            },
        });
    }

    // ── Runs in flight. T1 has two RUNNING; T2 has none of any kind; T3 has
    // three rows that are NOT in flight, one per non-RUNNING state that could
    // plausibly be mistaken for one. A fixture with only RUNNING rows would
    // pass against `count({})` — i.e. against no status predicate at all.
    await prisma.workflowRun.createMany({
        data: [
            { tenantId: T1, workflowKey: 'wf-a', status: 'RUNNING' },
            { tenantId: T1, workflowKey: 'wf-b', status: 'RUNNING' },
            { tenantId: T1, workflowKey: 'wf-c', status: 'COMPLETED' },
            { tenantId: T3, workflowKey: 'wf-d', status: 'AWAITING_APPROVAL' },
            { tenantId: T3, workflowKey: 'wf-e', status: 'PAUSED' },
            { tenantId: T3, workflowKey: 'wf-f', status: 'FAILED' },
        ],
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('runs in flight', () => {
    it('counts the RUNNING rows, and only those', async () => {
        // T1 holds three runs and two of them are RUNNING.
        expect((await getAgenticDashboardSummary(ctxFor(T1))).runsInFlight).toBe(2);
    });

    it('does not count a run that is waiting on a human or drained by a deploy', async () => {
        // T3 holds AWAITING_APPROVAL, PAUSED and FAILED. All three are runs
        // that exist and none of them is executing.
        expect((await getAgenticDashboardSummary(ctxFor(T3))).runsInFlight).toBe(0);
    });

    it('is scoped to the tenant, like every other figure in the summary', async () => {
        // T2 has no runs at all, and T1's two must not reach it.
        expect((await getAgenticDashboardSummary(ctxFor(T2))).runsInFlight).toBe(0);
    });
});

describe('the census counts every standing, and the total is the sum of it', () => {
    it('reports all four standings for a mixed register', async () => {
        const { byStanding, totalRegistered } = await getAgenticDashboardSummary(ctxFor(T1));

        // EXACT, not `toMatchObject`: a partial match would pass for a summary
        // that reported ACTIVE and dropped the other three, which is the shape
        // of the defect (`activeUnscored` was already ACTIVE-only).
        expect(byStanding).toStrictEqual({
            [AgentStatus.DRAFT]: 1,
            [AgentStatus.ACTIVE]: 2,
            [AgentStatus.SUSPENDED]: 1,
            [AgentStatus.RETIRED]: 1,
        });
        expect(totalRegistered).toBe(5);
    });

    it('the total is the sum of the buckets, not a second count', async () => {
        // Two statements over one population can disagree under a concurrent
        // write; one cannot. This is the assertion that says the sum is where
        // the total comes from.
        const { byStanding, totalRegistered } = await getAgenticDashboardSummary(ctxFor(T1));
        const summed = Object.values(byStanding).reduce((a, b) => a + b, 0);
        expect(summed).toBe(totalRegistered);
    });
});

describe('the soft-deleted row is out of the census', () => {
    it('counts 2 ACTIVE where the table holds 3', async () => {
        const { byStanding, totalRegistered } = await getAgenticDashboardSummary(ctxFor(T1));
        // The second number, printed beside the first. Without it "ACTIVE: 2"
        // is just a number; with it the assertion names the row it excluded.
        const activeRowsIncludingDeleted = await prisma.registeredAgent.count({
            where: { tenantId: T1, status: AgentStatus.ACTIVE },
        });
        const allRowsIncludingDeleted = await prisma.registeredAgent.count({
            where: { tenantId: T1 },
        });

        expect(activeRowsIncludingDeleted).toBe(3);
        expect(byStanding[AgentStatus.ACTIVE]).toBe(2);
        expect(allRowsIncludingDeleted).toBe(6);
        expect(totalRegistered).toBe(5);
    });
});

describe('the census is tenant-scoped', () => {
    it("tenant A's SUSPENDED count does not see tenant B's three", async () => {
        const a = await getAgenticDashboardSummary(ctxFor(T1));
        const b = await getAgenticDashboardSummary(ctxFor(T2));

        // Both sides, so the seed is proved to exist rather than assumed: a
        // fixture that failed to write tenant B's rows would satisfy the first
        // expectation on its own and certify nothing.
        expect(b.byStanding[AgentStatus.SUSPENDED]).toBe(3);
        expect(a.byStanding[AgentStatus.SUSPENDED]).toBe(1);
        expect(a.totalRegistered).toBe(5);
        expect(b.totalRegistered).toBe(3);
    });
});

describe('a standing with no agents is present and zero', () => {
    it('reports every member of AgentStatus for an ACTIVE-only register', async () => {
        const { byStanding, totalRegistered } = await getAgenticDashboardSummary(ctxFor(T3));

        expect(byStanding).toStrictEqual({
            [AgentStatus.DRAFT]: 0,
            [AgentStatus.ACTIVE]: 2,
            [AgentStatus.SUSPENDED]: 0,
            [AgentStatus.RETIRED]: 0,
        });
        // Stated separately as well, because a later change that made the
        // record sparse could still satisfy a value-by-value comparison for a
        // tenant whose every standing is occupied — and `undefined` here is
        // exactly the value a renderer turns into a blank or `NaN`.
        expect(Object.keys(byStanding).sort()).toStrictEqual(
            Object.values(AgentStatus).sort(),
        );
        expect(totalRegistered).toBe(2);
    });
});
