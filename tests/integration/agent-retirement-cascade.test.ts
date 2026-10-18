/**
 * THE RETIREMENT CASCADE (#3698) — what retiring an agent takes away, proved on
 * real rows.
 *
 * Retirement used to flip a status and stop there (and refuse while any
 * proposal was pending). Every other piece of the agent's authority survived the
 * flip: its API keys still authenticated, its grants still named tools, its card
 * could still be widened. Since 2a it is one act, under `admin.agent_registry`
 * alone, in one transaction:
 *
 *   keys       every `TenantApiKey` bound to the agent revoked — expired ones too
 *   scanner    every harness scanner signing key it holds revoked
 *   grants     every `RegisteredAgentTool` row deleted
 *   proposals  every PENDING `AgentProposal` moved to EXPIRED
 *   card       frozen: no further `AgentPolicyCardVersion`, history readable
 *   evidence   NOTHING withdrawn — no artefact is attributable to one agent
 *
 * Database triggers back the parts an in-flight writer could race: a PENDING
 * proposal, a card version, an unrevoked API key or scanner key and a tool
 * grant cannot be inserted for a RETIRED agent — each insert takes FOR SHARE on
 * the agent row, so it serialises with the retirement instead of landing behind
 * its cascade — and no status change leaves RETIRED. The unit suite
 * (`agent-registry-usecase.test.ts`) owns the ORDER; this one owns the rows and
 * the races.
 *
 * Every fixture is a fresh agent beside a NEIGHBOUR in the same tenant and a
 * twin in another tenant, both seeded identically: a cascade whose predicate
 * forgot the agent or the tenant would empty those too, and only rows that
 * should have survived can show it.
 */
import { randomBytes } from 'crypto';
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { checkCredentialLiveness } from '@/lib/agentic/agent-credential-state';
import {
    activateRegisteredAgent,
    getRegisteredAgent,
    retireRegisteredAgent,
    suspendRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import {
    createAgentPolicyCard,
    getAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { approveAgentProposal, createAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { createFakeScanner } from '../helpers/agent-harness-fake-scanner';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'retire-cascade-one';
const T2 = 'retire-cascade-two';
const TENANTS = [T1, T2];
const owners: Record<string, string> = {};
let seq = 0;

const ctxFor = (tenantId: string, overrides: Partial<RequestContext> = {}) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: owners[tenantId],
        ...overrides,
    });

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AiDecisionLog" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.agentPolicyCard.deleteMany({ where: t });
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

/** A scored, ACTIVE agent of its own. `RegisteredAgent.aiSystemId` is UNIQUE, so each gets a host. */
async function makeAgent(tenantId: string, name = 'cascade probe') {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `cascade host ${seq}`, ownerUserId: owners[tenantId] },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `${name} ${seq}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: owners[tenantId],
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

const HOUR = 60 * 60 * 1000;

/**
 * The authority one agent holds: four keys (two live, one revoked last week, one
 * expired but never revoked), a scanner key, three grants, and two PENDING plus
 * two decided proposals.
 */
async function seedAuthority(tenantId: string, agentId: string) {
    const key = (name: string, extra: { expiresAt?: Date | null; revokedAt?: Date | null }) =>
        prisma.tenantApiKey.create({
            data: {
                tenantId,
                name,
                keyPrefix: 'iflk_rc',
                keyHash: `retire-cascade-${randomBytes(12).toString('hex')}`,
                createdById: owners[tenantId],
                agentId,
                expiresAt: extra.expiresAt ?? null,
                revokedAt: extra.revokedAt ?? null,
            },
        });
    const keys = {
        liveForever: await key('live, no expiry', {}),
        liveUntilLater: await key('live, expires later', { expiresAt: new Date(Date.now() + HOUR) }),
        revokedEarlier: await key('revoked last week', { revokedAt: new Date(Date.now() - 7 * 24 * HOUR) }),
        expiredUnrevoked: await key('expired, never revoked', { expiresAt: new Date(Date.now() - HOUR) }),
    };
    const scannerKey = await prisma.agentHarnessScannerKey.create({
        data: {
            tenantId,
            agentId,
            publicKey: randomBytes(32).toString('hex'),
            keyFingerprint: randomBytes(32).toString('hex'),
            createdByUserId: owners[tenantId],
        },
    });
    for (const toolName of ['list_risks', 'list_controls', 'propose_risks']) {
        await prisma.registeredAgentTool.create({
            data: { tenantId, agentId, toolName, grantedByUserId: owners[tenantId] },
        });
    }
    const proposal = (status: 'PENDING' | 'ACCEPTED' | 'REJECTED') =>
        prisma.agentProposal.create({
            data: { tenantId, agentId, kind: 'RISK', payloadJson: '{"title":"cascade"}', status },
        });
    const proposals = {
        pendingA: await proposal('PENDING'),
        pendingB: await proposal('PENDING'),
        accepted: await proposal('ACCEPTED'),
        rejected: await proposal('REJECTED'),
    };
    return { keys, scannerKey, proposals };
}

async function authorityOf(agentId: string) {
    return {
        unrevokedKeys: await prisma.tenantApiKey.count({ where: { agentId, revokedAt: null } }),
        unrevokedScannerKeys: await prisma.agentHarnessScannerKey.count({
            where: { agentId, revokedAt: null },
        }),
        grants: await prisma.registeredAgentTool.count({ where: { agentId } }),
        pending: await prisma.agentProposal.count({ where: { agentId, status: 'PENDING' } }),
    };
}

async function auditRow(tenantId: string, entityId: string, action: string) {
    return prisma.auditLog.findFirstOrThrow({ where: { tenantId, entityId, action } });
}

/**
 * Hold a transaction that has written RETIRED onto the agent — retirement's
 * first write, which holds the agent row until commit — until `release()`.
 */
async function holdRetirementStatus(agentId: string) {
    let markUpdated!: () => void;
    const updated = new Promise<void>((resolve) => (markUpdated = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const done = prisma.$transaction(
        async (tx) => {
            await tx.registeredAgent.update({ where: { id: agentId }, data: { status: 'RETIRED' } });
            markUpdated();
            await held;
        },
        { timeout: 30_000, maxWait: 10_000 },
    );
    await updated;
    return { done, release };
}

/** Settle a promise into a value, recording whether it has settled yet. */
function track<T>(p: Promise<T>) {
    const state = { settled: false };
    const outcome = p.then(
        (value) => {
            state.settled = true;
            return { ok: true as const, value, err: null };
        },
        (err: unknown) => {
            state.settled = true;
            return { ok: false as const, value: null, err };
        },
    );
    return { state, outcome };
}

const LOCK_WAIT_PROBE_MS = 750;

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const id of TENANTS) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        owners[id] = user.id;
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('retirement leaves the agent holding nothing', () => {
    it('zero live keys, zero grants and zero open proposals — and nobody else loses anything', async () => {
        const agent = await makeAgent(T1);
        const neighbour = await makeAgent(T1, 'neighbour');
        const twin = await makeAgent(T2, 'twin');
        const seeded = await seedAuthority(T1, agent.id);
        await seedAuthority(T1, neighbour.id);
        await seedAuthority(T2, twin.id);

        // The authority is really there before — otherwise every zero below is vacuous.
        expect(await authorityOf(agent.id)).toEqual({
            unrevokedKeys: 3,
            unrevokedScannerKeys: 1,
            grants: 3,
            pending: 2,
        });

        const result = await retireRegisteredAgent(ctxFor(T1), agent.id);
        expect(result.status).toBe('RETIRED');

        expect(await authorityOf(agent.id)).toEqual({
            unrevokedKeys: 0,
            unrevokedScannerKeys: 0,
            grants: 0,
            pending: 0,
        });
        // "Live" is not ours to define — it is what the tool boundary re-asks on
        // every call. Every key bound to the agent now answers revoked, the
        // already-expired one included.
        const now = new Date();
        for (const k of [seeded.keys.liveForever, seeded.keys.liveUntilLater, seeded.keys.expiredUnrevoked]) {
            expect(await checkCredentialLiveness(k.id, T1, now)).toBe('revoked');
        }
        // A key revoked before keeps the instant it was revoked: the cascade
        // revokes, it does not rewrite history.
        const earlier = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: seeded.keys.revokedEarlier.id } });
        expect(earlier.revokedAt).toEqual(seeded.keys.revokedEarlier.revokedAt);

        // The scanner key is revoked BY the retiring actor.
        const scanner = await prisma.agentHarnessScannerKey.findUniqueOrThrow({ where: { id: seeded.scannerKey.id } });
        expect(scanner.revokedByUserId).toBe(owners[T1]);

        // The pending proposals EXPIRED — kept, unreviewed — and the decided ones are untouched.
        const after = await prisma.agentProposal.findMany({
            where: { agentId: agent.id },
            select: { id: true, status: true, reviewedByUserId: true, agentId: true },
        });
        const byId = new Map(after.map((p) => [p.id, p]));
        for (const p of [seeded.proposals.pendingA, seeded.proposals.pendingB]) {
            expect(byId.get(p.id)).toEqual({ id: p.id, status: 'EXPIRED', reviewedByUserId: null, agentId: agent.id });
        }
        expect(byId.get(seeded.proposals.accepted.id)?.status).toBe('ACCEPTED');
        expect(byId.get(seeded.proposals.rejected.id)?.status).toBe('REJECTED');

        // The neighbour in the same tenant, and the twin in the other, keep everything.
        for (const other of [neighbour.id, twin.id]) {
            expect(await authorityOf(other)).toEqual({
                unrevokedKeys: 3,
                unrevokedScannerKeys: 1,
                grants: 3,
                pending: 2,
            });
        }
    });

    it('an expired proposal can no longer be approved', async () => {
        const agent = await makeAgent(T1);
        const { proposals } = await seedAuthority(T1, agent.id);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        await expect(approveAgentProposal(ctxFor(T1), proposals.pendingA.id)).rejects.toThrow(
            /already EXPIRED/,
        );
    });

    it('the retire dialog previews exactly what the cascade then reports', async () => {
        // The detail read's `_count` is what the dialog states before the
        // click. The keys figure is LIVE keys — what stops being accepted — so
        // it equals the cascade's `liveApiKeysRevoked`; the cascade also revokes
        // the key that had already expired, and says so separately.
        const agent = await makeAgent(T1);
        await seedAuthority(T1, agent.id);
        const preview = await getRegisteredAgent(ctxFor(T1), agent.id);
        expect(preview._count).toMatchObject({ apiKeys: 2, tools: 3, proposals: 2 });

        await retireRegisteredAgent(ctxFor(T1), agent.id);
        const row = await auditRow(T1, agent.id, 'AGENT_RETIRED');
        const cascade = (row.detailsJson as { cascade: Record<string, unknown> }).cascade;
        expect(cascade.liveApiKeysRevoked).toBe(preview._count.apiKeys);
        expect(cascade.toolGrantsDropped).toBe(preview._count.tools);
        expect(cascade.proposalsExpired).toBe(preview._count.proposals);
        expect(cascade.apiKeysRevoked).toBe(3);
        expect(cascade.scannerKeysRevoked).toBe(1);
    });

    it('writes one audit row per effect, each naming what it changed', async () => {
        const agent = await makeAgent(T1);
        const seeded = await seedAuthority(T1, agent.id);
        await retireRegisteredAgent(ctxFor(T1), agent.id);

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, entityId: agent.id },
            select: { action: true, detailsJson: true },
        });
        expect(rows.map((r) => r.action).sort()).toEqual(
            [
                'AGENT_RETIRED',
                'AGENT_RETIREMENT_KEYS_REVOKED',
                'AGENT_RETIREMENT_SCANNER_KEYS_REVOKED',
                'AGENT_RETIREMENT_TOOLS_DROPPED',
                'AGENT_RETIREMENT_PROPOSALS_EXPIRED',
            ].sort(),
        );
        const details = (action: string) =>
            rows.find((r) => r.action === action)?.detailsJson as Record<string, unknown>;
        expect(new Set(details('AGENT_RETIREMENT_KEYS_REVOKED').keyIds as string[])).toEqual(
            new Set([seeded.keys.liveForever.id, seeded.keys.liveUntilLater.id, seeded.keys.expiredUnrevoked.id]),
        );
        expect(new Set(details('AGENT_RETIREMENT_PROPOSALS_EXPIRED').proposalIds as string[])).toEqual(
            new Set([seeded.proposals.pendingA.id, seeded.proposals.pendingB.id]),
        );
        expect(details('AGENT_RETIREMENT_TOOLS_DROPPED').before).toEqual({
            toolNames: ['list_risks', 'list_controls', 'propose_risks'],
        });
    });

    it('a role holding admin.agent_registry and no narrower key runs the whole cascade', async () => {
        // 0e: one act under one key. The standalone verbs each take a narrower
        // key — revoking a key `admin.manage`, dropping a grant
        // `agent_tool_exposure`, editing a card `agent_policy_card` — and
        // retirement must not have borrowed any of them.
        const agent = await makeAgent(T1);
        await seedAuthority(T1, agent.id);
        const base = ctxFor(T1);
        const registryOnly = makeRequestContext('EDITOR', {
            tenantId: T1,
            tenantSlug: T1,
            userId: owners[T1],
            appPermissions: {
                ...base.appPermissions,
                admin: {
                    ...base.appPermissions.admin,
                    manage: false,
                    members: false,
                    agent_tool_exposure: false,
                    agent_policy_card: false,
                    agent_registry: true,
                },
            },
        });
        await retireRegisteredAgent(registryOnly, agent.id);
        expect(await authorityOf(agent.id)).toEqual({
            unrevokedKeys: 0,
            unrevokedScannerKeys: 0,
            grants: 0,
            pending: 0,
        });
    });

    it("another tenant's caller cannot retire the agent, and it keeps its authority", async () => {
        const agent = await makeAgent(T1);
        await seedAuthority(T1, agent.id);
        await expect(retireRegisteredAgent(ctxFor(T2), agent.id)).rejects.toThrow(/not found/i);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('ACTIVE');
        expect((await authorityOf(agent.id)).unrevokedKeys).toBe(3);
    });

    it('a second retirement is a conflict, and writes no second cascade', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        await expect(retireRegisteredAgent(ctxFor(T1), agent.id)).rejects.toBeInstanceOf(ConflictError);
        expect(
            await prisma.auditLog.count({ where: { tenantId: T1, entityId: agent.id, action: 'AGENT_RETIRED' } }),
        ).toBe(1);
    });
});

describe('the evidence effect: nothing is attributable to one agent, so nothing is withdrawn', () => {
    it('leaves every population-level artefact CURRENT, deletes no evidence, and records the basis', async () => {
        // An `AgenticEvidenceArtefact` is a tenant-wide monthly aggregate over
        // EVERY agent's receipts or decisions. Withdrawing one at retirement
        // would retract true evidence about the other agents and about this
        // agent's own past actions.
        const agent = await makeAgent(T1);
        const control = await prisma.control.create({ data: { tenantId: T1, name: 'Agent action logging' } });
        const evidence = await prisma.evidence.create({
            data: { tenantId: T1, type: 'TEXT', title: 'Agent action receipts — September' },
        });
        const artefact = await prisma.agenticEvidenceArtefact.create({
            data: {
                tenantId: T1,
                controlId: control.id,
                kind: 'AGENT_ACTION_RECEIPTS',
                periodStart: new Date('2026-09-01T00:00:00.000Z'),
                periodEnd: new Date('2026-10-01T00:00:00.000Z'),
                evidenceId: evidence.id,
                sourceDigest: 'a'.repeat(64),
                recordCount: 12,
            },
        });
        const evidenceBefore = await prisma.evidence.count({ where: { tenantId: T1 } });

        await retireRegisteredAgent(ctxFor(T1), agent.id);

        const after = await prisma.agenticEvidenceArtefact.findUniqueOrThrow({ where: { id: artefact.id } });
        expect(after.status).toBe('CURRENT');
        expect(after.withdrawnAt).toBeNull();
        expect(after.withdrawnReason).toBeNull();
        expect(await prisma.evidence.count({ where: { tenantId: T1 } })).toBe(evidenceBefore);
        const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
        expect(ev.isArchived).toBe(false);
        expect(ev.deletedAt).toBeNull();

        const row = await auditRow(T1, agent.id, 'AGENT_RETIRED');
        const cascade = (row.detailsJson as { cascade: Record<string, unknown> }).cascade;
        expect(cascade.evidenceArtefactsWithdrawn).toBe(0);
        expect(cascade.evidenceBasis).toBe('POPULATION_LEVEL_ONLY');
    });
});

describe('a retired agent can queue nothing — the backstop under app_user', () => {
    it('refuses a PENDING proposal insert, and admits a QUARANTINED one as evidence', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        const row = (status: 'PENDING' | 'QUARANTINED') => ({
            data: { tenantId: T1, agentId: agent.id, kind: 'RISK' as const, payloadJson: '{}', status },
        });
        await expect(asTenant(T1, (tx) => tx.agentProposal.create(row('PENDING')))).rejects.toThrow(/AGENT_RETIRED/);
        await expect(asTenant(T1, (tx) => tx.agentProposal.create(row('QUARANTINED')))).resolves.toMatchObject({
            status: 'QUARANTINED',
        });
        expect(await prisma.agentProposal.count({ where: { agentId: agent.id, status: 'PENDING' } })).toBe(0);
    });

    it('an insert racing the retirement waits for it, then is refused', async () => {
        // The race the trigger's `FOR SHARE` exists for: the retirement's status
        // UPDATE holds the agent row, and a proposal insert for that agent must
        // WAIT for it and then read the committed RETIRED — not read the stale
        // ACTIVE under its own snapshot and slip a PENDING row in behind the
        // cascade.
        const agent = await makeAgent(T1);
        let markUpdated!: () => void;
        const updated = new Promise<void>((resolve) => (markUpdated = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const retiring = prisma.$transaction(
            async (tx) => {
                await tx.registeredAgent.update({ where: { id: agent.id }, data: { status: 'RETIRED' } });
                markUpdated();
                await held;
            },
            { timeout: 30_000, maxWait: 10_000 },
        );
        await updated;

        let settled = false;
        const outcome = asTenant(T1, (tx) =>
            tx.agentProposal.create({
                data: { tenantId: T1, agentId: agent.id, kind: 'RISK', payloadJson: '{}', status: 'PENDING' },
            }),
        ).then(
            () => {
                settled = true;
                return null;
            },
            (err: unknown) => {
                settled = true;
                return err;
            },
        );
        // It is WAITING on the lock, not already done.
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(settled).toBe(false);

        release();
        await retiring;
        const err = await outcome;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('AGENT_RETIRED');
        expect(await prisma.agentProposal.count({ where: { agentId: agent.id, status: 'PENDING' } })).toBe(0);
    });

    it('the proposal usecase reports the refusal as a 403, not a database error', async () => {
        // In production the revoked key stops the agent at the tool boundary
        // first; this is the path where it was already past it when retired.
        const agent = await makeAgent(T1);
        await createAgentPolicyCard(ctxFor(T1), agent.id);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        const attempt = createAgentProposal(ctxFor(T1, { agentId: agent.id }), {
            kind: 'RISK',
            payload: { title: 'after retirement', description: 'A proposal from a retired agent.' },
            policyCardVersion: 1,
        });
        await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
            createAgentProposal(ctxFor(T1, { agentId: agent.id }), {
                kind: 'RISK',
                payload: { title: 'after retirement', description: 'A proposal from a retired agent.' },
                policyCardVersion: 1,
            }),
        ).rejects.toThrow(/can no longer queue proposals/);
        expect(await prisma.agentProposal.count({ where: { agentId: agent.id } })).toBe(0);
    });
});

describe("a retired agent's policy card is frozen, and still readable", () => {
    it('refuses an edit with a 409, refuses a new card, and keeps the history', async () => {
        const carded = await makeAgent(T1);
        const created = await createAgentPolicyCard(ctxFor(T1), carded.id);
        const uncarded = await makeAgent(T1);

        await retireRegisteredAgent(ctxFor(T1), carded.id);
        await retireRegisteredAgent(ctxFor(T1), uncarded.id);

        // A narrowing — the edit that is never refused on a live agent.
        const narrowed = { ...created.value, permittedTools: [] as string[] };
        const edit = updateAgentPolicyCard(ctxFor(T1), carded.id, { expectedVersion: 1, card: narrowed });
        await expect(edit).rejects.toBeInstanceOf(ConflictError);
        await expect(
            updateAgentPolicyCard(ctxFor(T1), carded.id, { expectedVersion: 1, card: narrowed }),
        ).rejects.toThrow(/policy card is frozen/);
        await expect(createAgentPolicyCard(ctxFor(T1), uncarded.id)).rejects.toThrow(/policy card is frozen/);

        // Read, not refused: the history is the record of what governed it.
        const read = await getAgentPolicyCard(ctxFor(T1), carded.id);
        expect(read.card?.currentVersion).toBe(1);
        expect(await prisma.agentPolicyCardVersion.count({ where: { cardId: created.cardId } })).toBe(1);

        // The summary row says where it was frozen.
        const frozen = await auditRow(T1, carded.id, 'AGENT_RETIREMENT_POLICY_CARD_FROZEN');
        expect((frozen.detailsJson as Record<string, unknown>).frozenAtVersion).toBe(1);
    });

    it('the database refuses a new version for a retired agent from any writer', async () => {
        const agent = await makeAgent(T1);
        const created = await createAgentPolicyCard(ctxFor(T1), agent.id);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        // Otherwise a valid version 2 — a copy of version 1 — so the only thing
        // that can refuse it is the agent being retired.
        const version = {
            tenantId: T1,
            cardId: created.cardId,
            version: 2,
            permittedTools: [...created.value.permittedTools],
            maxDataScope: created.value.maxDataScope,
            maxAutonomyLevel: created.value.maxAutonomyLevel,
            maxActionsPerRun: created.value.maxActionsPerRun,
            maxActionsPerDay: created.value.maxActionsPerDay,
            escalationTriggers: [...created.value.escalationTriggers],
            approvalRung: created.value.approvalRung,
            seeded: false,
            createdByUserId: owners[T1],
        };
        await expect(asTenant(T1, (tx) => tx.agentPolicyCardVersion.create({ data: version }))).rejects.toThrow(
            /AGENT_RETIRED/,
        );
        // The owning role too — a trigger is not a privilege.
        await expect(prisma.agentPolicyCardVersion.create({ data: version })).rejects.toThrow(/AGENT_RETIRED/);
    });
});

describe('a writer racing the retirement waits for it, then is refused — or is caught by the cascade', () => {
    /*
     * Each of these inserts reads the agent's status UNLOCKED in its usecase
     * (or not at all, on a raw write) and then inserts. Under READ COMMITTED
     * nothing else makes the insert wait for a retirement in flight: its FK
     * check takes FOR KEY SHARE, which does not conflict with the status
     * UPDATE's FOR NO KEY UPDATE, and the cascade's own UPDATE/DELETE cannot see
     * an uncommitted row. Only the insert trigger's FOR SHARE makes it wait —
     * so each test first proves the insert is WAITING, then that it is refused,
     * then that the agent holds nothing. Delete a trigger's FOR SHARE (or the
     * trigger) and the insert settles inside the probe window, unrefused.
     */

    it('a policy card version: waits, is refused, and the card stays at its frozen version', async () => {
        const agent = await makeAgent(T1);
        const created = await createAgentPolicyCard(ctxFor(T1), agent.id);
        const version = {
            tenantId: T1,
            cardId: created.cardId,
            version: 2,
            permittedTools: [...created.value.permittedTools],
            maxDataScope: created.value.maxDataScope,
            maxAutonomyLevel: created.value.maxAutonomyLevel,
            maxActionsPerRun: created.value.maxActionsPerRun,
            maxActionsPerDay: created.value.maxActionsPerDay,
            escalationTriggers: [...created.value.escalationTriggers],
            approvalRung: created.value.approvalRung,
            seeded: false,
            createdByUserId: owners[T1],
        };

        const retiring = await holdRetirementStatus(agent.id);
        const writing = track(asTenant(T1, (tx) => tx.agentPolicyCardVersion.create({ data: version })));
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(writing.state.settled).toBe(false);

        retiring.release();
        await retiring.done;
        const result = await writing.outcome;
        expect(result.ok).toBe(false);
        expect(String((result.err as Error | null)?.message)).toContain('AGENT_RETIRED');
        expect(await prisma.agentPolicyCardVersion.count({ where: { cardId: created.cardId } })).toBe(1);
    });

    it('an API key minted through createApiKey: waits, is refused as a 400, and no live key is bound', async () => {
        const agent = await makeAgent(T1);
        const retiring = await holdRetirementStatus(agent.id);
        const minting = track(
            createApiKey(ctxFor(T1), { name: 'minted at the moment of retirement', scopes: ['mcp:read'], agentId: agent.id }),
        );
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(minting.state.settled).toBe(false);

        retiring.release();
        await retiring.done;
        const result = await minting.outcome;
        expect(result.err).toBeInstanceOf(ValidationError);
        expect((result.err as Error).message).toMatch(/Agent is retired/);
        expect(await prisma.tenantApiKey.count({ where: { agentId: agent.id, revokedAt: null } })).toBe(0);
    });

    it('a tool grant through grantAgentTool: waits, is refused as a 400, and the agent holds no grant', async () => {
        const agent = await makeAgent(T1);
        const retiring = await holdRetirementStatus(agent.id);
        const granting = track(grantAgentTool(ctxFor(T1), agent.id, { toolName: 'list_risks' }));
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(granting.state.settled).toBe(false);

        retiring.release();
        await retiring.done;
        const result = await granting.outcome;
        expect(result.err).toBeInstanceOf(ValidationError);
        expect((result.err as Error).message).toMatch(/This agent is retired/);
        expect(await prisma.registeredAgentTool.count({ where: { agentId: agent.id } })).toBe(0);
    });

    it('a scanner key through addHarnessScannerKey: waits, is refused as a 400, and no live scanner key remains', async () => {
        const agent = await makeAgent(T1);
        const scanner = createFakeScanner();
        const retiring = await holdRetirementStatus(agent.id);
        const adding = track(addHarnessScannerKey(ctxFor(T1), { agentId: agent.id, publicKey: scanner.publicKeyHex }));
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(adding.state.settled).toBe(false);

        retiring.release();
        await retiring.done;
        const result = await adding.outcome;
        expect(result.err).toBeInstanceOf(ValidationError);
        expect((result.err as Error).message).toMatch(/retired agent cannot be given a scanner key/);
        expect(await prisma.agentHarnessScannerKey.count({ where: { agentId: agent.id, revokedAt: null } })).toBe(0);
    });

    it('a key inserted FIRST makes the retirement wait, and the cascade then revokes it and lists it', async () => {
        // The other order. The insert's trigger took FOR SHARE before the
        // retirement's status UPDATE, so the retirement waits for the insert to
        // commit — and then its cascade sees the row. Without the trigger the
        // retirement would not wait, its cascade would miss the uncommitted
        // key, and the key would commit afterwards, unrevoked.
        const agent = await makeAgent(T1);
        let markInserted!: () => void;
        const inserted = new Promise<void>((resolve) => (markInserted = resolve));
        let releaseInsert!: () => void;
        const insertHeld = new Promise<void>((resolve) => (releaseInsert = resolve));
        let keyId = '';
        const inserting = prisma.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T1}', true)`);
                const key = await tx.tenantApiKey.create({
                    data: {
                        tenantId: T1,
                        name: 'inserted first',
                        keyPrefix: 'iflk_rc',
                        keyHash: `retire-cascade-${randomBytes(12).toString('hex')}`,
                        createdById: owners[T1],
                        agentId: agent.id,
                    },
                });
                keyId = key.id;
                markInserted();
                await insertHeld;
            },
            { timeout: 30_000, maxWait: 10_000 },
        );
        await inserted;

        const retiring = track(retireRegisteredAgent(ctxFor(T1), agent.id));
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(retiring.state.settled).toBe(false);

        releaseInsert();
        await inserting;
        const result = await retiring.outcome;
        expect(result.ok).toBe(true);
        expect(result.value?.cascade.apiKeysRevoked).toBe(1);

        expect((await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).not.toBeNull();
        const row = await auditRow(T1, agent.id, 'AGENT_RETIREMENT_KEYS_REVOKED');
        expect(row.detailsJson).toMatchObject({ keyIds: [keyId], count: 1, idsTruncated: false });
    });

    it('after retirement, every writer is refused outright — the table owner included', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        const keyData = {
            tenantId: T1,
            name: 'after retirement',
            keyPrefix: 'iflk_rc',
            keyHash: `retire-cascade-${randomBytes(12).toString('hex')}`,
            createdById: owners[T1],
            agentId: agent.id,
        };
        await expect(asTenant(T1, (tx) => tx.tenantApiKey.create({ data: keyData }))).rejects.toThrow(/AGENT_RETIRED/);
        await expect(prisma.tenantApiKey.create({ data: keyData })).rejects.toThrow(/AGENT_RETIRED/);
        await expect(
            prisma.registeredAgentTool.create({
                data: { tenantId: T1, agentId: agent.id, toolName: 'list_risks', grantedByUserId: owners[T1] },
            }),
        ).rejects.toThrow(/AGENT_RETIRED/);
        await expect(
            prisma.agentHarnessScannerKey.create({
                data: {
                    tenantId: T1,
                    agentId: agent.id,
                    publicKey: randomBytes(32).toString('hex'),
                    keyFingerprint: randomBytes(32).toString('hex'),
                    createdByUserId: owners[T1],
                },
            }),
        ).rejects.toThrow(/AGENT_RETIRED/);
        // Re-binding an existing live key to the retired agent is the same hole.
        const unbound = await prisma.tenantApiKey.create({
            data: { ...keyData, keyHash: `retire-cascade-${randomBytes(12).toString('hex')}`, agentId: null },
        });
        await expect(
            prisma.tenantApiKey.update({ where: { id: unbound.id }, data: { agentId: agent.id } }),
        ).rejects.toThrow(/AGENT_RETIRED/);
        // An already-revoked key confers nothing and is history: admitted.
        await expect(
            prisma.tenantApiKey.create({
                data: {
                    ...keyData,
                    keyHash: `retire-cascade-${randomBytes(12).toString('hex')}`,
                    revokedAt: new Date(),
                },
            }),
        ).resolves.toMatchObject({ agentId: agent.id });
        expect(await authorityOf(agent.id)).toEqual({
            unrevokedKeys: 0,
            unrevokedScannerKeys: 0,
            grants: 0,
            pending: 0,
        });
    });
});

describe('RETIRED is terminal', () => {
    it('activate and suspend both refuse a retired agent, and its status stays RETIRED', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        await expect(activateRegisteredAgent(ctxFor(T1), agent.id)).rejects.toBeInstanceOf(ConflictError);
        await expect(suspendRegisteredAgent(ctxFor(T1), agent.id)).rejects.toBeInstanceOf(ConflictError);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('RETIRED');
    });

    it('the database refuses a status change out of RETIRED from any writer, and nothing else', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxFor(T1), agent.id);
        await expect(
            prisma.registeredAgent.update({ where: { id: agent.id }, data: { status: 'ACTIVE' } }),
        ).rejects.toThrow(/AGENT_RETIRED/);
        // Scoped to the transition: the row's other columns stay writable.
        await expect(
            prisma.registeredAgent.update({ where: { id: agent.id }, data: { name: 'renamed after retirement' } }),
        ).resolves.toMatchObject({ status: 'RETIRED' });
    });

    it('a live agent still suspends and reactivates — the reversible stop is untouched', async () => {
        const agent = await makeAgent(T1);
        await seedAuthority(T1, agent.id);
        await suspendRegisteredAgent(ctxFor(T1), agent.id);
        await activateRegisteredAgent(ctxFor(T1), agent.id);
        // Suspension takes nothing away: the keys and grants are still there.
        expect(await authorityOf(agent.id)).toEqual({
            unrevokedKeys: 3,
            unrevokedScannerKeys: 1,
            grants: 3,
            pending: 2,
        });
    });
});
