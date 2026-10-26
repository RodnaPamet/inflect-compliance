/**
 * WHAT A RUN WAS TAUGHT — pinned at admission, write-once at the database (#3666).
 *
 * Two halves, both against a real database:
 *
 *   1. The real start path writes `WorkflowRun.mountedSkills`: the declared
 *      skills' names, versions and hashes for a Flue run, `[]` for a run that
 *      mounts none — and refuses BEFORE the row exists when a declared skill
 *      cannot be mounted.
 *   2. The trigger refuses every later change to the column, including the
 *      NULL → value fill the policy-card pin still permits, and the CHECK
 *      refuses a value that is not an array.
 *
 * ── WHAT IS MOCKED, AND WHY ─────────────────────────────────────────────────
 *
 * The Flue half of admission needs three things a test database cannot supply:
 * a deployment that permits the engine (an env switch), a vouched registered
 * agent, and the worker the run is handed to. Those are mocked at their module
 * boundary — `resolveDriverForRun`, `evaluateAgentRegistration`, `enqueue` — so
 * the usecase, the resolver and the database are real.
 *
 * The mount gate is mocked to treat the two shipped skills as evaluated, with
 * a pin computed from their real instructions. The gate itself is proved
 * against fixtures in `tests/unit/agentic/skill-mount-gate.test.ts`; here the
 * question is whether its answer reaches the row.
 */
jest.mock('@/lib/agentic/agent-driver-policy', () => ({
    ...jest.requireActual('@/lib/agentic/agent-driver-policy'),
    resolveDriverForRun: jest.fn(async () => ({ driver: 'flue', reason: null })),
}));
jest.mock('@/lib/agentic/agent-registration-gate', () => ({
    ...jest.requireActual('@/lib/agentic/agent-registration-gate'),
    evaluateAgentRegistration: jest.fn(async () => ({ standing: 'vouched' })),
}));
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));
jest.mock('@/lib/agentic/flue/skills/mount-gate', () => {
    const actual = jest.requireActual('@/lib/agentic/flue/skills/mount-gate');
    const { skillContentHash } = jest.requireActual('@/lib/agentic/flue/skills/evaluation-record');
    const EVALUATED = new Set(['soa-authoring', 'evidence-sufficiency']);
    return {
        ...actual,
        checkSkillMountable: (skill: { name: string; instructions: string; metadata: { version?: string } }) =>
            EVALUATED.has(skill.name)
                ? { ok: true, pin: { name: skill.name, version: skill.metadata.version ?? '', contentHash: skillContentHash(skill.instructions) } }
                : { ok: false, reason: 'NO_RECORD', detail: 'no evaluation-record.json' },
    };
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { loadSkill } from '@/lib/agentic/flue/skills';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { resetSkillCache } from '@/lib/agentic/flue/skills/resolve';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { enqueue } from '@/app-layer/jobs/queue';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `pin-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const WF_TWO = `pin-two-${SUITE}`;
const WF_NONE = `pin-none-${SUITE}`;
const WF_UNKNOWN = `pin-unknown-${SUITE}`;
const WF_UNEVALUATED = `pin-unevaluated-${SUITE}`;

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

const STEPS = [{ kind: 'SYNTHESIS' as const, label: 'summary', synthesize: () => ({ text: 'done' }) }];

describeFn('a run pins the skills it was taught (real DB)', () => {
    beforeAll(async () => {
        resetSkillCache();
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.create({ data: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        registerWorkflow({ key: WF_TWO, name: 'Two skills', description: 'mounts two', driver: 'flue', skills: ['soa-authoring', 'evidence-sufficiency'], steps: STEPS });
        registerWorkflow({ key: WF_NONE, name: 'No skills', description: 'mounts none', driver: 'flue', steps: STEPS });
        registerWorkflow({ key: WF_UNKNOWN, name: 'Unknown skill', description: 'declares a skill nobody ships', driver: 'flue', skills: ['no-such-skill'], steps: STEPS });
        registerWorkflow({ key: WF_UNEVALUATED, name: 'Unevaluated', description: 'declares a skill with no record', driver: 'flue', skills: ['dora-register-duties'], steps: STEPS });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('writes each declared skill’s name, version and hash, in declaration order', async () => {
        const { runId } = await startWorkflowRun(ctx(), WF_TWO, {});
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { mountedSkills: true } });
        const expected = ['soa-authoring', 'evidence-sufficiency'].map((name) => {
            const s = loadSkill(name);
            return { name, version: s.metadata.version, contentHash: skillContentHash(s.instructions) };
        });
        expect(row.mountedSkills).toEqual(expected);
    });

    it('records an empty list — not NULL — for a run that mounts nothing', async () => {
        const { runId } = await startWorkflowRun(ctx(), WF_NONE, {});
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { mountedSkills: true } });
        expect(row.mountedSkills).toEqual([]);
    });

    // ── WHAT A REASONING ENGINE IS OWED (Step 0a) ─────────────────────────
    //
    // The registration gate and the worker hand-off ask `isReasoningEngine`
    // rather than compare with 'flue'. These two cases are what make that
    // behavioural: with `isReasoningEngine('flue')` answering false, an
    // unvouched caller would get a run, and a Flue run would execute inline in
    // the request. Both are asserted on the real start path.
    it('refuses a reasoning-engine run from an unvouched caller, before its row exists', async () => {
        // Counted against the workflow before and after, so a run another case
        // created can neither satisfy nor spoil it.
        const before = await prisma.workflowRun.count({ where: { tenantId: TENANT, workflowKey: WF_NONE } });
        jest.mocked(evaluateAgentRegistration).mockResolvedValueOnce({ standing: 'no_binding' } as never);
        await expect(startWorkflowRun(ctx(), WF_NONE, {})).rejects.toThrow(/flue_requires_registered_agent/);
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT, workflowKey: WF_NONE } })).toBe(before);
    });

    it('records the engine the run executes on, by its stored name', async () => {
        // `WorkflowRun.driver` is written by `recordedModeOf` (#4285), a total mapping
        // over `AGENT_DRIVERS` (Step 0H). It was a two-way ternary, which
        // would have recorded a third engine's runs as STATIC.
        const { runId } = await startWorkflowRun(ctx(), WF_NONE, {});
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { driver: true } });
        expect(row.driver).toBe('FLUE');
    });

    it('hands a reasoning-engine run to the worker rather than running it in the request', async () => {
        jest.mocked(enqueue).mockClear();
        const { runId, status } = await startWorkflowRun(ctx(), WF_NONE, {});
        expect(status).toBe('RUNNING');
        expect(jest.mocked(enqueue)).toHaveBeenCalledWith('agent-run-execute', { tenantId: TENANT, runId });
    });

    it.each([
        [WF_UNKNOWN, /skill_not_mountable: .*not in the shipped corpus/],
        [WF_UNEVALUATED, /skill_not_mountable: .*NO_RECORD/],
    ])('refuses %s before its row exists', async (key, message) => {
        await expect(startWorkflowRun(ctx(), key, {})).rejects.toThrow(message);
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT, workflowKey: key } })).toBe(0);
    });
});

describeFn('the pin is write-once at the database', () => {
    const T = `t-wo-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    });
    afterAll(async () => {
        await prisma.workflowRun.deleteMany({ where: { tenantId: T } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: T } });
        await prisma.$disconnect();
    });

    const create = (mountedSkills?: unknown) =>
        prisma.workflowRun.create({
            data: {
                tenantId: T,
                workflowKey: 'wo',
                status: 'RUNNING',
                ...(mountedSkills === undefined ? {} : { mountedSkills: mountedSkills as object }),
            },
            select: { id: true },
        });

    it('refuses a change to a written pin', async () => {
        const { id } = await create([{ name: 'soa-authoring', version: '1', contentHash: 'sha256:aa' }]);
        await expect(
            prisma.workflowRun.update({ where: { id }, data: { mountedSkills: [{ name: 'soa-authoring', version: '1', contentHash: 'sha256:bb' }] } }),
        ).rejects.toThrow(/IMMUTABLE_SKILL_PIN/);
    });

    it('refuses filling in a row that predates the pin', async () => {
        const { id } = await create();
        await expect(prisma.workflowRun.update({ where: { id }, data: { mountedSkills: [] } })).rejects.toThrow(/IMMUTABLE_SKILL_PIN/);
    });

    it('lets the rest of the row move', async () => {
        const { id } = await create([]);
        await prisma.workflowRun.update({ where: { id }, data: { status: 'COMPLETED', stepCount: 3 } });
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id }, select: { status: true, mountedSkills: true } });
        expect(row).toEqual({ status: 'COMPLETED', mountedSkills: [] });
    });

    it('refuses a pin that is not a list', async () => {
        await expect(create({ name: 'soa-authoring' })).rejects.toThrow(/WorkflowRun_mounted_skills_is_array|check constraint/i);
    });
});
