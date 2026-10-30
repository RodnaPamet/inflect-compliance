/**
 * THE AGENT OWNER-ORPHAN PASS (#3670), proved on real rows.
 *
 * Each departure signal at each rung; no write at DRY_RUN; the kill and the
 * suspension at AUTOMATIC as the system actor, with audit rows that name no
 * person; the transfer task for the departed owner's manager; the ladder's
 * dwell; a lift refused before a completed transfer and allowed after it, to the
 * new owner, with the database trigger behind the usecase; the incident report
 * counting OWNER_DEPARTED kills apart; and two-tenant isolation.
 *
 * Fixtures, in T1: two OWNERs who govern (B proposes, C receives and lifts), the
 * owner of a healthy agent, and one owner per signal — DEACTIVATED, REMOVED,
 * ABSENT (no membership row: what the product's Remove action leaves), INVITED,
 * and an ACTIVE OWNER whose HR record is TERMINATED (matched across case and
 * whitespace), with a manager on record. Two decoys that must NOT be orphaned:
 * a "name twin" whose name matches a TERMINATED employee at another address, and
 * an owner whose address two employees share (ambiguous). T2 holds one orphan of
 * its own; T3 is at DRY_RUN with no agent at all.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { ORPHAN_PASS_ACTOR } from '@/lib/agentic/owner-orphan';
import { tenantSystemUserId } from '@/lib/tenant-system-user';
import { runAgentOwnerOrphanPass } from '@/app-layer/usecases/agent-owner-orphan-pass';
import { setAgentOrphanPassMode } from '@/app-layer/usecases/agent-owner-orphan-policy';
import { engageKillSwitch, liftKillSwitch, listKillSwitches } from '@/app-layer/usecases/agent-kill-switch';
import {
    completeAgentOwnershipTransfer,
    proposeAgentOwnershipTransfer,
} from '@/app-layer/usecases/agent-ownership-transfer';
import { buildIncidentHistoryReport } from '@/app-layer/usecases/agent-governance-reports';
import { listAllControlChecks } from '@/app-layer/usecases/integrations';
import { runAgentOwnerOrphanPassSweep } from '@/app-layer/jobs/agent-owner-orphan-pass';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

// Unique per run: `resetDatabase` does not truncate Tenant or User, so fixed ids
// would collide with a previous run's leftovers if its teardown was cut short.
const SUITE = randomUUID().slice(0, 8);
const T1 = `orphan-one-${SUITE}`;
const T2 = `orphan-two-${SUITE}`;
const T3 = `orphan-empty-${SUITE}`;
const TENANTS = [T1, T2, T3];

type Person =
    | 'ownerB'
    | 'ownerC'
    | 'healthy'
    | 'deactivated'
    | 'removed'
    | 'absent'
    | 'invited'
    | 'hrOwner'
    | 'manager'
    | 'nameTwin'
    | 'ambiguous';

const MEMBERSHIP: Record<Person, { role: Role; status: MembershipStatus } | null> = {
    ownerB: { role: Role.OWNER, status: MembershipStatus.ACTIVE },
    ownerC: { role: Role.OWNER, status: MembershipStatus.ACTIVE },
    healthy: { role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    deactivated: { role: Role.EDITOR, status: MembershipStatus.DEACTIVATED },
    removed: { role: Role.EDITOR, status: MembershipStatus.REMOVED },
    absent: null,
    invited: { role: Role.EDITOR, status: MembershipStatus.INVITED },
    hrOwner: { role: Role.OWNER, status: MembershipStatus.ACTIVE },
    manager: { role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    nameTwin: { role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    ambiguous: { role: Role.EDITOR, status: MembershipStatus.ACTIVE },
};
const PEOPLE = Object.keys(MEMBERSHIP) as Person[];
/** The owners whose agents must be orphaned, and the signal each should produce. */
const ORPHAN_OWNERS: Person[] = ['deactivated', 'removed', 'absent', 'invited', 'hrOwner'];

const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
const users: Record<string, Partial<Record<Person, string>>> = {};
const agents: Record<string, Partial<Record<Person, string>>> = {};
let seq = 0;
const DAY = 86_400_000;

async function addPerson(tenantId: string, who: Person) {
    const email = emailOf(tenantId, who);
    const user = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: who === 'nameTwin' ? 'Dana Smith' : who },
    });
    users[tenantId][who] = user.id;
    const m = MEMBERSHIP[who];
    if (m) {
        await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role: m.role, status: m.status },
        });
    }
    return user.id;
}

async function makeAgent(tenantId: string, ownerUserId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DRAFT' = 'ACTIVE') {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `orphan host ${seq}`, ownerUserId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `orphan probe ${seq}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status,
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    // A credential speaking for the agent, so "no credential change" has
    // something to be about.
    await prisma.tenantApiKey.create({
        data: {
            tenantId,
            name: `key for ${agent.name}`,
            keyPrefix: `iflk_${seq}`.slice(0, 8),
            keyHash: `hash-${tenantId}-${seq}`,
            scopes: ['mcp:read'],
            createdById: ownerUserId,
            agentId: agent.id,
        },
    });
    return agent.id;
}

async function ctxAs(tenantId: string, who: Person): Promise<RequestContext> {
    const userId = users[tenantId][who] as string;
    const resolved = await resolveTenantContext({ tenantId }, userId);
    return makeRequestContext(resolved.role, {
        tenantId,
        tenantSlug: tenantId,
        userId,
        permissions: resolved.permissions,
        appPermissions: resolved.appPermissions,
    });
}

async function setMode(tenantId: string, mode: 'DISABLED' | 'DRY_RUN' | 'AUTOMATIC', dryRunSince: Date | null = null) {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        create: { tenantId, agentOrphanPassMode: mode, agentOrphanPassDryRunSince: dryRunSince },
        update: { agentOrphanPassMode: mode, agentOrphanPassDryRunSince: dryRunSince },
    });
}

const passRows = (tenantId: string) =>
    prisma.integrationExecution.findMany({
        where: { tenantId, automationKey: 'agentic.owner_orphan_pass' },
        orderBy: { executedAt: 'asc' },
    });

type Decision = {
    agentId: string;
    ownerUserId: string;
    signals: { kind: string; membership?: string; employeeId?: string }[];
    outcome: string;
    killSwitchId?: string;
    transferTask: { status: string; managerUserId?: string; taskId?: string };
    notified: number;
};

async function keySnapshot(tenantId: string) {
    return prisma.tenantApiKey.findMany({
        where: { tenantId },
        orderBy: { id: 'asc' },
        select: { id: true, revokedAt: true, expiresAt: true, agentId: true, updatedAt: true },
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const tenantId of [T1, T2, T3]) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        users[tenantId] = {};
        agents[tenantId] = {};
    }
    for (const who of PEOPLE) await addPerson(T1, who);
    for (const who of PEOPLE) {
        if (who === 'ownerB' || who === 'ownerC' || who === 'manager') continue;
        agents[T1][who] = await makeAgent(T1, users[T1][who] as string);
    }

    // HR. The terminated owner's record is spelled differently from their
    // login on purpose — case and surrounding whitespace — because emailKey
    // folds exactly those and nothing else.
    const manager = await prisma.employee.create({
        data: { tenantId: T1, fullName: 'The Manager', workEmail: ` ${emailOf(T1, 'manager').toUpperCase()} `, status: 'ACTIVE' },
    });
    await prisma.employee.create({
        data: {
            tenantId: T1,
            fullName: 'HR Owner',
            workEmail: `  ${emailOf(T1, 'hrOwner').toUpperCase()}`,
            status: 'TERMINATED',
            managerEmployeeId: manager.id,
        },
    });
    // The NAME TWIN: a terminated employee who shares the owner's name at a
    // different address, and the owner's own record, still ACTIVE.
    await prisma.employee.create({
        data: { tenantId: T1, fullName: 'Dana Smith', workEmail: 'dana.smith@elsewhere.test', status: 'TERMINATED' },
    });
    await prisma.employee.create({
        data: { tenantId: T1, fullName: 'Dana Smith', workEmail: emailOf(T1, 'nameTwin'), status: 'ACTIVE' },
    });
    // AMBIGUOUS: two rows whose addresses fold to one key, both terminated.
    await prisma.employee.create({
        data: { tenantId: T1, fullName: 'Amb One', workEmail: emailOf(T1, 'ambiguous'), status: 'TERMINATED' },
    });
    await prisma.employee.create({
        data: { tenantId: T1, fullName: 'Amb Two', workEmail: emailOf(T1, 'ambiguous').toUpperCase(), status: 'TERMINATED' },
    });

    // T2: one governing OWNER and one departed owner with one agent.
    await addPerson(T2, 'ownerB');
    await addPerson(T2, 'deactivated');
    agents[T2].deactivated = await makeAgent(T2, users[T2].deactivated as string);

    // T3: an OWNER and no agent.
    await addPerson(T3, 'ownerB');
});

/** Remove every row this suite wrote. The table owner holds the DELETEs `app_user` does not. */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.notification.deleteMany({ where: t });
    await prisma.notificationOutbox.deleteMany({ where: t });
    await prisma.taskWatcher.deleteMany({ where: t }).catch(() => undefined);
    await prisma.task.deleteMany({ where: t });
    await prisma.taskKeySequence.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.agentKillSwitch.deleteMany({ where: t });
    await prisma.agentOwnershipTransfer.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.employee.updateMany({ where: t, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    const allUsers = Object.values(users).flatMap((byPerson) => Object.values(byPerson)) as string[];
    await prisma.user.deleteMany({ where: { id: { in: [...allUsers, ...TENANTS.map(tenantSystemUserId)] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('it is wired', () => {
    it('is scheduled at 05:15 UTC with one attempt, after the leaver at 05:00', () => {
        const entry = SCHEDULED_JOBS.find((j) => j.name === 'agent-owner-orphan-pass');
        expect(entry?.pattern).toBe('15 5 * * *');
        expect(SCHEDULED_JOBS.find((j) => j.name === 'identity-leaver-dispatch')?.pattern).toBe('0 5 * * *');
        expect(JOB_DEFAULTS['agent-owner-orphan-pass'].attempts).toBe(1);
    });
});

describe('DISABLED — the default — refuses, and says so on a row', () => {
    it('records MODE_DISABLED and touches no agent', async () => {
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect(result).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'MODE_DISABLED', mode: 'DISABLED' });
        const [row] = await passRows(T1);
        expect(row.status).toBe('NOT_APPLICABLE');
        expect(row.provider).toBe('agentic');
        expect((row.resultJson as { refusal: string }).refusal).toBe('MODE_DISABLED');
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: T1 } })).toBe(0);
        expect(await prisma.registeredAgent.count({ where: { tenantId: T1, status: 'SUSPENDED' } })).toBe(0);
    });
});

describe('DRY_RUN — every signal recorded, nothing written', () => {
    it('records each orphan by its signal, and writes no kill, suspension, task or credential change', async () => {
        await setMode(T1, 'DRY_RUN', new Date());
        const keysBefore = await keySnapshot(T1);
        const tasksBefore = await prisma.task.count({ where: { tenantId: T1 } });

        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect(result).toMatchObject({ mode: 'DRY_RUN', status: 'NOT_APPLICABLE', refusal: null });
        expect(result.orphans).toBe(ORPHAN_OWNERS.length);

        const rows = await passRows(T1);
        const row = rows[rows.length - 1];
        const json = row.resultJson as { decisions: Decision[]; notes: { agentId: string; note: string }[] };
        const byAgent = new Map(json.decisions.map((d) => [d.agentId, d]));

        // Each MEMBERSHIP signal, named for what was observed.
        for (const who of ['deactivated', 'removed', 'absent', 'invited'] as const) {
            const d = byAgent.get(agents[T1][who] as string);
            expect(d?.outcome).toBe('WOULD_SUSPEND_AND_KILL');
            expect(d?.signals).toEqual([
                { kind: 'MEMBERSHIP_NOT_ACTIVE', membership: who === 'absent' ? 'ABSENT' : who.toUpperCase() },
            ]);
        }
        // The HR signal, on an owner whose membership is still ACTIVE, matched
        // across case and whitespace — and their manager is known.
        const hr = byAgent.get(agents[T1].hrOwner as string);
        expect(hr?.signals.map((s) => s.kind)).toEqual(['HR_TERMINATED']);
        expect(hr?.transferTask).toEqual({ status: 'WOULD_OPEN', managerUserId: users[T1].manager });

        // NEVER BY NAME: the name twin is not an orphan, and the ambiguous
        // owner is noted rather than guessed at.
        expect(byAgent.has(agents[T1].nameTwin as string)).toBe(false);
        expect(byAgent.has(agents[T1].ambiguous as string)).toBe(false);
        expect(byAgent.has(agents[T1].healthy as string)).toBe(false);
        expect(json.notes).toContainEqual({ agentId: agents[T1].ambiguous, note: 'HR_MATCH_AMBIGUOUS' });

        // NOTHING WRITTEN. No kill, no suspension, no task, no credential change.
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: T1 } })).toBe(0);
        expect(await prisma.registeredAgent.count({ where: { tenantId: T1, status: { not: 'ACTIVE' } } })).toBe(0);
        expect(await prisma.task.count({ where: { tenantId: T1 } })).toBe(tasksBefore);
        expect(await keySnapshot(T1)).toEqual(keysBefore);
    });

    it('rings the workspace OWNERs, never the departed owner about their own agent', async () => {
        const hrAgent = agents[T1].hrOwner as string;
        const bells = await prisma.notification.findMany({
            where: { tenantId: T1, type: 'AGENT_OWNER_DEPARTED', linkUrl: `/t/${T1}/agents/${hrAgent}` },
            select: { userId: true, message: true },
        });
        expect(bells.map((b) => b.userId).sort()).toEqual([users[T1].ownerB, users[T1].ownerC].sort());
        expect(bells[0].message).toMatch(/DRY_RUN, so it was NOT stopped/);
    });
});

describe('leaving DRY_RUN is refused before the seven-day dwell', () => {
    it('refuses after one day, refuses a window with no recorded pass, allows after seven with a pass', async () => {
        const owner = await ctxAs(T1, 'ownerB');
        // One day in: refused, whatever the pass count.
        await setMode(T1, 'DRY_RUN', new Date(Date.now() - DAY));
        await expect(setAgentOrphanPassMode(owner, { mode: 'AUTOMATIC' })).rejects.toThrow(/1 of 7 required days/);

        // Thirty days in, but the window opened AFTER every recorded pass.
        await setMode(T1, 'DRY_RUN', new Date(Date.now() + 1000));
        await expect(
            setAgentOrphanPassMode(owner, { mode: 'AUTOMATIC' }, new Date(Date.now() + 30 * DAY)),
        ).rejects.toThrow(/0 owner-orphan passes since the window opened/);

        // An ADMIN does not hold the key at all.
        await prisma.tenantMembership.updateMany({
            where: { tenantId: T1, userId: users[T1].manager },
            data: { role: Role.ADMIN },
        });
        const admin = await ctxAs(T1, 'manager');
        await expect(setAgentOrphanPassMode(admin, { mode: 'DISABLED' })).rejects.toBeInstanceOf(ForbiddenError);
        await prisma.tenantMembership.updateMany({
            where: { tenantId: T1, userId: users[T1].manager },
            data: { role: Role.EDITOR },
        });

        // Eight days in, with the DRY_RUN pass above inside the window.
        await setMode(T1, 'DRY_RUN', new Date(Date.now() - 8 * DAY));
        await expect(setAgentOrphanPassMode(owner, { mode: 'AUTOMATIC' })).resolves.toEqual({
            mode: 'AUTOMATIC',
            dryRunSince: null,
        });
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'AGENT_ORPHAN_PASS_MODE_CHANGED' },
        });
        expect((audit.detailsJson as { category: string }).category).toBe('access');
    });
});

describe('AUTOMATIC — each orphan suspended and killed, as the system actor', () => {
    it('engages an OWNER_DEPARTED kill and suspends every orphan, and nothing else', async () => {
        await setMode(T1, 'AUTOMATIC');
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect(result).toMatchObject({ mode: 'AUTOMATIC', status: 'PASSED', failed: 0 });
        expect(result.contained).toBe(ORPHAN_OWNERS.length);

        // Read through the usecase: `reason` is encrypted at rest, and the
        // test client does not carry the field-encryption extension.
        const { history } = await listKillSwitches(await ctxAs(T1, 'ownerB'));
        for (const who of ORPHAN_OWNERS) {
            const agentId = agents[T1][who] as string;
            const agent = await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } });
            expect(agent.status).toBe('SUSPENDED');
            const kill = history.find((k) => k.agentId === agentId);
            expect(kill?.scope).toBe('AGENT');
            expect(kill?.reasonCode).toBe('OWNER_DEPARTED');
            expect(kill?.engagedByUserId).toBe(ORPHAN_PASS_ACTOR);
            expect(kill?.reason.startsWith('OWNER_DEPARTED')).toBe(true);
            expect(kill?.liftedAt).toBeNull();
        }
        expect(history).toHaveLength(ORPHAN_OWNERS.length);
        // The decoys and the healthy agent are untouched.
        for (const who of ['healthy', 'nameTwin', 'ambiguous'] as const) {
            const agentId = agents[T1][who] as string;
            expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe('ACTIVE');
            expect(await prisma.agentKillSwitch.count({ where: { agentId } })).toBe(0);
        }
    });

    it('writes audit rows of actor type JOB that name no person', async () => {
        const everyUserId = Object.values(users).flatMap((byPerson) => Object.values(byPerson)) as string[];
        const kills = await prisma.agentKillSwitch.findMany({ where: { tenantId: T1, reasonCode: 'OWNER_DEPARTED' } });
        expect(kills.length).toBe(ORPHAN_OWNERS.length);
        for (const kill of kills) {
            const engaged = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: T1, action: 'AGENT_KILL_ENGAGED', entityId: kill.id },
            });
            const suspended = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: T1, action: 'AGENT_SUSPENDED', entityId: kill.agentId as string },
            });
            for (const row of [engaged, suspended]) {
                expect(row.actorType).toBe('JOB');
                expect(row.userId).toBeNull();
                const text = JSON.stringify([row.detailsJson, row.metadataJson, row.details]);
                for (const id of everyUserId) expect(text).not.toContain(id);
            }
            // Every audit row about the kill — the pass's own and the write
            // extension's — carries no user, whatever its actor type.
            const aboutKill = await prisma.auditLog.findMany({ where: { tenantId: T1, entityId: kill.id } });
            expect(aboutKill.length).toBeGreaterThan(0);
            expect(aboutKill.every((r) => r.userId === null)).toBe(true);
            expect((engaged.detailsJson as { after: Record<string, unknown> }).after).toEqual({
                killScope: 'AGENT',
                agentId: kill.agentId,
                engagedByUserId: ORPHAN_PASS_ACTOR,
                reasonCode: 'OWNER_DEPARTED',
            });
        }
    });

    it('opens the ownership-transfer task for the departed owner\'s manager, and for nobody else', async () => {
        const tasks = await prisma.task.findMany({ where: { tenantId: T1, source: 'INTEGRATION' } });
        expect(tasks).toHaveLength(1);
        const [task] = tasks;
        expect(task.assigneeUserId).toBe(users[T1].manager);
        // #4400 — written as the tenant's SYSTEM user. It used to name the
        // manager as its author, under an ADMIN-shaped context.
        expect(task.createdByUserId).toBe(tenantSystemUserId(T1));
        const created = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'TASK_CREATED', entityId: task.id },
        });
        expect(created.userId).toBe(tenantSystemUserId(T1));
        expect(created.actorType).toBe('JOB');
        expect(task.metadataJson).toMatchObject({
            kind: 'AGENT_OWNERSHIP_TRANSFER',
            agentId: agents[T1].hrOwner,
            reasonCode: 'OWNER_DEPARTED',
        });
        const rows = await passRows(T1);
        const decisions = (rows[rows.length - 1].resultJson as { decisions: Decision[] }).decisions;
        expect(decisions.find((d) => d.agentId === agents[T1].hrOwner)?.transferTask).toEqual({
            status: 'OPENED',
            managerUserId: users[T1].manager,
            taskId: task.id,
        });
        expect(decisions.filter((d) => d.transferTask.status === 'NO_MANAGER_KNOWN')).toHaveLength(4);
    });

    it('is idempotent: a suspended orphan is not seen again; a reactivated one is re-suspended, its kill not doubled', async () => {
        const absentAgent = agents[T1].absent as string;
        // Somebody reactivates it without a transfer.
        await prisma.registeredAgent.update({ where: { id: absentAgent }, data: { status: 'ACTIVE' } });
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect(result.orphans).toBe(1);
        const rows = await passRows(T1);
        const [decision] = (rows[rows.length - 1].resultJson as { decisions: Decision[] }).decisions;
        expect(decision).toMatchObject({ agentId: absentAgent, outcome: 'SUSPENDED_KILL_ALREADY_IN_FORCE' });
        expect(decision.transferTask.status).toBe('NO_MANAGER_KNOWN');
        expect(await prisma.agentKillSwitch.count({ where: { agentId: absentAgent } })).toBe(1);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: absentAgent } })).status).toBe('SUSPENDED');
        expect(await prisma.task.count({ where: { tenantId: T1, source: 'INTEGRATION' } })).toBe(1);
    });

    it('never touches another tenant', async () => {
        const other = agents[T2].deactivated as string;
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: other } })).status).toBe('ACTIVE');
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: T2 } })).toBe(0);
        expect(await prisma.integrationExecution.count({ where: { tenantId: T2 } })).toBe(0);
    });
});

describe('an OWNER_DEPARTED kill lifts only after a completed transfer, by the new owner', () => {
    it('refuses before the transfer, refuses the wrong person after it, and lets the new owner lift with a reason', async () => {
        const agentId = agents[T1].deactivated as string;
        const kill = await prisma.agentKillSwitch.findFirstOrThrow({ where: { agentId, liftedAt: null } });
        const ownerB = await ctxAs(T1, 'ownerB');
        const ownerC = await ctxAs(T1, 'ownerC');

        // Before any transfer: refused, and the row is untouched.
        await expect(liftKillSwitch(ownerC, kill.id, { liftReason: 'back to work' })).rejects.toBeInstanceOf(
            ConflictError,
        );
        // A PENDING transfer is not a completed one.
        const proposed = await proposeAgentOwnershipTransfer(ownerB, agentId, { toOwnerUserId: users[T1].ownerC });
        await expect(liftKillSwitch(ownerC, kill.id, { liftReason: 'back to work' })).rejects.toBeInstanceOf(
            ConflictError,
        );
        expect((await prisma.agentKillSwitch.findUniqueOrThrow({ where: { id: kill.id } })).liftedAt).toBeNull();

        await completeAgentOwnershipTransfer(ownerC, agentId, { transferId: proposed.id });

        // The kill-switch key alone is not enough: B holds it, and is not the new owner.
        await expect(liftKillSwitch(ownerB, kill.id, { liftReason: 'lifting for C' })).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        // The new owner lifts it, with a reason.
        const lifted = await liftKillSwitch(ownerC, kill.id, { liftReason: 'C owns it now and has reviewed it' });
        expect(lifted).toMatchObject({ reasonCode: 'OWNER_DEPARTED', liftedByUserId: users[T1].ownerC });
        expect(lifted.liftReason).toBe('C owns it now and has reviewed it');
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'AGENT_KILL_LIFTED', entityId: kill.id },
        });
        expect((audit.detailsJson as { after: { reasonCode: string } }).after.reasonCode).toBe('OWNER_DEPARTED');
    });

    it('the database refuses the lift, and the code\'s removal, for any writer that skips the usecase', async () => {
        const agentId = agents[T1].removed as string;
        const kill = await prisma.agentKillSwitch.findFirstOrThrow({ where: { agentId, liftedAt: null } });
        await expect(
            prisma.agentKillSwitch.update({
                where: { id: kill.id },
                data: { liftedAt: new Date(), liftedByUserId: users[T1].ownerB, liftReason: 'raw write' },
            }),
        ).rejects.toThrow(/AGENT_OWNER_DEPARTED_LIFT_REFUSED/);
        await expect(
            prisma.agentKillSwitch.update({ where: { id: kill.id }, data: { reasonCode: null } }),
        ).rejects.toThrow(/AGENT_KILL_REASON_CODE_IMMUTABLE/);
        // And no row can carry the code unless the system actor engaged it.
        await expect(
            prisma.agentKillSwitch.create({
                data: {
                    tenantId: T1,
                    agentId: agents[T1].healthy as string,
                    reason: 'forged',
                    reasonCode: 'OWNER_DEPARTED',
                    engagedByUserId: users[T1].ownerB as string,
                },
            }),
        ).rejects.toThrow(/AgentKillSwitch_reasonCode_shape/);
    });

    it('a person typing OWNER_DEPARTED makes an ordinary kill: liftable at once, and an incident', async () => {
        const ownerB = await ctxAs(T1, 'ownerB');
        const forged = await engageKillSwitch(ownerB, { agentId: agents[T1].healthy, reason: 'OWNER_DEPARTED' });
        expect(forged.reasonCode).toBeNull();
        const report = await buildIncidentHistoryReport(ownerB);
        const m = report.metrics as Record<string, { value?: number }>;
        // Five OWNER_DEPARTED kills, one lifted above; the forged one is an incident.
        expect(m['incidents.owner_departed_engagements']?.value).toBe(ORPHAN_OWNERS.length);
        expect(m['incidents.owner_departed_in_force_now']?.value).toBe(ORPHAN_OWNERS.length - 1);
        expect(m['incidents.kill_engagements']?.value).toBe(1);
        expect(m['incidents.kills_in_force_now']?.value).toBe(1);
        expect(report.body.kills.map((k) => k.id)).toEqual([forged.id]);
        expect(report.body.ownerDepartedKills.every((k) => k.reasonCode === 'OWNER_DEPARTED')).toBe(true);
        expect(report.definitions.map((d) => d.id)).toEqual(
            expect.arrayContaining(['incidents.owner_departed_engagements', 'incidents.owner_departed_in_force_now']),
        );

        await expect(liftKillSwitch(ownerB, forged.id, { liftReason: 'test kill' })).resolves.toMatchObject({
            reasonCode: null,
        });
    });
});

describe('two tenants', () => {
    it('another tenant cannot see or lift the kill, and its own pass sees only its own agents', async () => {
        const kill = await prisma.agentKillSwitch.findFirstOrThrow({
            where: { agentId: agents[T1].invited as string, liftedAt: null },
        });
        const t2Owner = await ctxAs(T2, 'ownerB');
        await expect(liftKillSwitch(t2Owner, kill.id, { liftReason: 'cross-tenant' })).rejects.toBeInstanceOf(
            NotFoundError,
        );
        expect((await listKillSwitches(t2Owner)).history).toEqual([]);

        await setMode(T2, 'DRY_RUN', new Date());
        const result = await runAgentOwnerOrphanPass({ tenantId: T2, tenantSlug: T2 });
        expect(result.orphans).toBe(1);
        const [row] = await passRows(T2);
        const decisions = (row.resultJson as { decisions: Decision[] }).decisions;
        expect(decisions.map((d) => d.agentId)).toEqual([agents[T2].deactivated]);
    });
});

describe('every refusal records a row; and the sweep', () => {
    it('a DRY_RUN tenant with no ACTIVE agent records NO_ACTIVE_AGENTS — zero is not complete', async () => {
        await setMode(T3, 'DRY_RUN', new Date());
        const result = await runAgentOwnerOrphanPass({ tenantId: T3, tenantSlug: T3 });
        expect(result).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_ACTIVE_AGENTS' });
        const [row] = await passRows(T3);
        expect((row.resultJson as { refusal: string }).refusal).toBe('NO_ACTIVE_AGENTS');
    });

    it('the sweep discovers tenants with agents AND tenants with a mode set, and runs each', async () => {
        const runId = `sweep-${SUITE}`;
        const r = await runAgentOwnerOrphanPassSweep({}, runId);
        // Every tenant of this suite is discovered — T3 by its mode alone,
        // having no agent — and each wrote its row under the sweep's run id.
        expect(r.results.map((x) => x.tenantId)).toEqual(expect.arrayContaining(TENANTS));
        expect(
            await prisma.integrationExecution.count({ where: { jobRunId: runId, tenantId: { in: TENANTS } } }),
        ).toBe(3);
    });

    it('the rows never reach the tenant-wide control-check list', async () => {
        const ownerB = await ctxAs(T1, 'ownerB');
        const checks = await listAllControlChecks(ownerB);
        expect(checks.filter((c) => c.automationKey === 'agentic.owner_orphan_pass')).toEqual([]);
        expect(await prisma.integrationExecution.count({ where: { tenantId: T1, provider: 'agentic' } })).toBeGreaterThan(0);
    });
});
