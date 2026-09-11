/**
 * AMEND A REGISTERED AGENT (#2447) — nine fields, and the one rule that is not
 * symmetric.
 *
 * `PATCH /admin/agents/:id` and `updateRegisteredAgent` have existed since the
 * register shipped, validating all nine fields and enforcing the risk-tier
 * autonomy ceiling. NO .tsx FILE CALLED IT. So autonomy — the central authority
 * dial — was set at creation and frozen: an agent granted too much could not be
 * turned DOWN without somebody issuing an API call by hand. That is a governance
 * gap rather than an inconvenience, which is why this is the highest-priority of
 * the nine headless capabilities.
 *
 * ── THE ASYMMETRY IS THE POINT ──────────────────────────────────────
 *
 * LOWERING is always permitted, including for an UNSCORED agent, and needs no
 * re-assessment. RAISING is capped by the assessed tier. If those were symmetric
 * — if lowering also required a current assessment — then the safest action
 * available during an incident would be gated on paperwork, and an operator
 * wanting to reduce an agent's authority would be told to complete a risk
 * assessment first. The tests below pin the direction, not just the rule.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    getRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TENANT = 'amend-tenant';
const EMAIL = 'amend-owner@example.test';
const EMAIL2 = 'amend-owner-2@example.test';

let ownerId = '';
let owner2Id = '';

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerId });

async function clearProbeRows() {
    await resetDatabase(prisma);
    // FK order, child before parent. `TenantMembership` refuses the tenant
    // delete, and `resetDatabase` does not reach it — its roots do not include
    // the membership table, so it survives the TRUNCATE and then blocks cleanup.
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, EMAIL2] } } });
}

/**
 * A fresh agent per test — amend is a mutation, so shared state would leak.
 *
 * And a fresh AI SYSTEM with it: `RegisteredAgent_aiSystemId_key` is UNIQUE, so
 * the register holds at most one agent per AI system. Reusing one system across
 * tests fails on the second create, which surfaces as five tests failing on a
 * constraint that has nothing to do with what any of them assert.
 */
let systemSeq = 0;
async function makeAgent(over: Record<string, unknown> = {}) {
    const sys = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `amend host ${(systemSeq += 1)}`, ownerUserId: ownerId },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: sys.id,
            name: 'amend probe',
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: ownerId,
            status: 'ACTIVE',
            ...over,
        },
    });
}

beforeAll(async () => {
    await clearProbeRows();
    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    const u1 = await prisma.user.create({ data: { email: EMAIL, name: 'Amend Owner' } });
    const u2 = await prisma.user.create({ data: { email: EMAIL2, name: 'Second Owner' } });
    ownerId = u1.id;
    owner2Id = u2.id;
    for (const u of [u1, u2]) {
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: u.id, role: 'ADMIN', status: 'ACTIVE' },
        });
    }
});

afterAll(clearProbeRows);

describe('all nine fields are amendable', () => {
    it('accepts a patch touching every one of them', async () => {
        const agent = await makeAgent({ riskTier: 'LOW', riskTierScoredAt: new Date() });

        await updateRegisteredAgent(ctx(), agent.id, {
            name: 'amended name',
            description: 'amended description',
            autonomyLevel: 1,
            dataAccessScope: 'READ_METADATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            modelRef: 'gpt-probe-1',
            ownerUserId: owner2Id,
            vendorId: null,
        });

        const after = await getRegisteredAgent(ctx(), agent.id);
        // Asserted FIELD BY FIELD rather than by a snapshot: a snapshot passes
        // when a field silently stops being written, because the expected value
        // is regenerated from the same broken behaviour.
        expect(after.name).toBe('amended name');
        expect(after.description).toBe('amended description');
        expect(after.autonomyLevel).toBe(1);
        expect(after.dataAccessScope).toBe('READ_METADATA');
        expect(after.reversibility).toBe('COMPENSABLE');
        expect(after.provenance).toBe('FIRST_PARTY');
        expect(after.modelRef).toBe('gpt-probe-1');
        expect(after.ownerUserId).toBe(owner2Id);
        expect(after.vendorId).toBeNull();
    });
});

describe('lowering autonomy is always allowed', () => {
    it('lowers a SCORED agent', async () => {
        const agent = await makeAgent({ riskTier: 'LOW', riskTierScoredAt: new Date() });
        await updateRegisteredAgent(ctx(), agent.id, { autonomyLevel: 0 });
        expect((await getRegisteredAgent(ctx(), agent.id)).autonomyLevel).toBe(0);
    });

    it('lowers an UNSCORED agent, whose ceiling refuses every raise', async () => {
        // The asymmetry, stated as a test. An unscored agent sits at the DENY
        // ceiling, so raising is refused — and if lowering were gated on the
        // same check, the safest action available would be the one blocked.
        const agent = await makeAgent({ riskTier: null, autonomyLevel: 4 });
        await updateRegisteredAgent(ctx(), agent.id, { autonomyLevel: 2 });
        expect((await getRegisteredAgent(ctx(), agent.id)).autonomyLevel).toBe(2);
    });
});

describe('raising past the assessed tier is refused', () => {
    it('refuses an UNSCORED agent and says to assess it', async () => {
        const agent = await makeAgent({ riskTier: null, autonomyLevel: 1 });
        await expect(
            updateRegisteredAgent(ctx(), agent.id, { autonomyLevel: 5 }),
        ).rejects.toThrow(/risk assessment/i);
        // …and the write did not land. A usecase that threw AFTER writing would
        // pass the assertion above.
        expect((await getRegisteredAgent(ctx(), agent.id)).autonomyLevel).toBe(1);
    });

    it('refuses a SCORED agent above its tier ceiling, naming the cap', async () => {
        const agent = await makeAgent({
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            autonomyLevel: 1,
        });
        await expect(
            updateRegisteredAgent(ctx(), agent.id, { autonomyLevel: 6 }),
        ).rejects.toThrow(/assessed risk tier/i);
        expect((await getRegisteredAgent(ctx(), agent.id)).autonomyLevel).toBe(1);
    });

    it('PERMITS a raise that stays within the ceiling', async () => {
        // The paired positive. Without it, a usecase that refused EVERY raise
        // would pass both refusals above and read as a working cap.
        const agent = await makeAgent({
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            autonomyLevel: 0,
        });
        await updateRegisteredAgent(ctx(), agent.id, { autonomyLevel: 1 });
        expect((await getRegisteredAgent(ctx(), agent.id)).autonomyLevel).toBe(1);
    });
});
