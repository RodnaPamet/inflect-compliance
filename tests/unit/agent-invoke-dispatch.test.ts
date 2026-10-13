/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * #3471 — an automation rule may invoke a registered agent, and EVERY refusal
 * names its own cause.
 *
 * The plan asks that only an ACTIVE, scored, un-killed, un-latched agent be
 * invocable, "refused server-side, not only hidden in the picker". The audit
 * (finding F7) found the unscored case surfacing elsewhere as an autonomy
 * ceiling of −1 rather than as a named denial — so an operator reading it saw a
 * mis-set ceiling rather than an agent nobody had risk-assessed.
 *
 * These tests exist because collapsing the branches is the tempting
 * simplification: one "agent unavailable" would pass a test that only checked
 * the run did not start, while handing an operator a message that does not say
 * whether to re-activate, risk-assess, or lift a kill switch. So each case
 * asserts the NAMED refusal, not merely the absence of a run.
 */
jest.mock('@/lib/prisma', () => ({
    prisma: { registeredAgent: { findFirst: jest.fn() } },
}));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_n: string, fn: () => any) => fn()),
}));
jest.mock('@/lib/tenant-context', () => ({
    resolveTenantContext: jest.fn(async () => ({
        tenantSlug: 't1', role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: {},
    })),
}));
const startWorkflowRun = jest.fn(async () => ({ runId: 'run-1', status: 'COMPLETED', stepFailures: 0 }));
const resolveKillState = jest.fn(async () => null as unknown);
const readBreakerLatch = jest.fn(async () => null as unknown);
jest.mock('@/lib/agentic/kill-switch', () => ({ resolveKillState }));
jest.mock('@/lib/agentic/circuit-breaker-store', () => ({ readBreakerLatch }));
jest.mock('@/app-layer/usecases/workflow-runs', () => ({ startWorkflowRun }));

import { runAgentInvokeDispatch, MAX_AGENT_INVOKE_DEPTH } from '@/app-layer/jobs/agent-invoke-dispatch';
import { prisma } from '@/lib/prisma';
import { resolveTenantContext } from '@/lib/tenant-context';

const mockPrisma = prisma as any;

const payload = (over: Record<string, unknown> = {}) => ({
    tenantId: 't1',
    agentId: 'agent-1',
    workflowKey: 'wf-1',
    inputMapping: {},
    ownerUserId: 'owner-1',
    parentExecutionId: 'exec-parent',
    triggerEvent: 'RISK_CREATED',
    data: {},
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.registeredAgent.findFirst.mockResolvedValue({ id: 'agent-1', status: 'ACTIVE', riskTier: 'LOW' });
    resolveKillState.mockResolvedValue(null as never);
    readBreakerLatch.mockResolvedValue(null as never);
});

describe('an automation rule invoking an agent', () => {
    it('starts the run under the RULE OWNER, stamped as a JOB', async () => {
        const { refusal } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBeNull();
        expect(startWorkflowRun).toHaveBeenCalledTimes(1);

        // The authority is the owner's, resolved NOW rather than snapshotted —
        // a rule outliving its author's role narrows with it.
        expect(resolveTenantContext).toHaveBeenCalledWith({ tenantId: 't1' }, 'owner-1');
        const ctx = startWorkflowRun.mock.calls[0][0] as any;
        expect(ctx.userId).toBe('owner-1');
        // …and the attribution is the job's. Both facts, kept apart.
        expect(ctx.actorType).toBe('JOB');
        expect(ctx.agentId).toBe('agent-1');
    });

    it('projects ONLY the mapped trigger fields into the run input', async () => {
        await runAgentInvokeDispatch(payload({
            inputMapping: { subject: 'riskTitle' },
            data: { riskTitle: 'Unpatched host', secretField: 'do not forward' },
        }) as never);
        const input = startWorkflowRun.mock.calls[0][2] as any;
        expect(input).toEqual({ subject: 'Unpatched host' });
        // An unmapped event field is not carried. The mapping is the bound on
        // what reaches prompt assembly, which is why it is typed fields and
        // never free text.
        expect(JSON.stringify(input)).not.toContain('do not forward');
    });

    it.each([
        ['agent_not_found', null],
        ['agent_not_active', { id: 'agent-1', status: 'SUSPENDED', riskTier: 'LOW' }],
        ['agent_unscored', { id: 'agent-1', status: 'ACTIVE', riskTier: null }],
    ])('refuses with the named cause %s, and starts nothing', async (expected, agentRow) => {
        mockPrisma.registeredAgent.findFirst.mockResolvedValue(agentRow);
        const { refusal, result } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBe(expected);
        expect(startWorkflowRun).not.toHaveBeenCalled();
        // Refused, not THROWN: a misconfigured rule must not put the job into
        // retry and turn one bad rule into sustained queue pressure. The job
        // returns a summary naming the refusal, so an operator reading the
        // execution row learns which term failed.
        expect((result as unknown as { summary: string }).summary).toContain(expected);
    });

    it('refuses a rule with no owner rather than reaching for a default', async () => {
        const { refusal } = await runAgentInvokeDispatch(payload({ ownerUserId: null }) as never);
        expect(refusal).toBe('rule_has_no_owner');
        expect(startWorkflowRun).not.toHaveBeenCalled();
        // Never resolve a context for a principal nobody named: that would be
        // an automation running with permissions nobody granted it.
        expect(resolveTenantContext).not.toHaveBeenCalled();
    });

    it('caps recursion — an agent run that re-fires its own rule cannot loop', async () => {
        const { refusal } = await runAgentInvokeDispatch(
            payload({ depth: MAX_AGENT_INVOKE_DEPTH + 1 }) as never,
        );
        expect(refusal).toBe('depth_exceeded');
        expect(startWorkflowRun).not.toHaveBeenCalled();
    });

    it('allows the last permitted depth — the cap is off-by-one safe', async () => {
        // Without this, a cap written `>=` would pass every test above while
        // refusing one lap earlier than it says it does.
        const { refusal } = await runAgentInvokeDispatch(
            payload({ depth: MAX_AGENT_INVOKE_DEPTH }) as never,
        );
        expect(refusal).toBeNull();
        expect(startWorkflowRun).toHaveBeenCalledTimes(1);
    });
    it('refuses a KILLED agent at dispatch, not one run later', async () => {
        // `flue/execute.ts` asks the same question when a turn is taken, so a
        // killed agent cannot act either way. Asking here is what stops an
        // hourly rule from minting an hourly run that can only ever refuse —
        // and it is the only place the SCOPE reaches the rule's own log line.
        resolveKillState.mockResolvedValue({
            scope: 'TENANT', switchId: 'ks-1', engagedAt: new Date(),
        } as never);
        const { refusal, result } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBe('agent_kill_switched');
        expect(startWorkflowRun).not.toHaveBeenCalled();
        // The scope, because lifting a TENANT switch and lifting a PLATFORM one
        // are two different conversations with two different people.
        expect((result as unknown as { summary: string }).summary).toContain('TENANT');
    });

    it('refuses a LATCHED breaker — the stop nothing else on this path makes', async () => {
        // `readBreakerLatch` had no caller outside its own store before this.
        readBreakerLatch.mockResolvedValue({ state: 'OPEN', anomalousStreak: 3 } as never);
        const { refusal } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBe('agent_breaker_latched');
        expect(startWorkflowRun).not.toHaveBeenCalled();
    });

    it('an agent the breaker has never observed still runs — null is not a refusal', async () => {
        // Deny-by-default lives in the tool grants, which are already
        // deny-by-default; the breaker is a control that LEARNS, and a
        // never-seen agent must be able to act. Without this, a `latch === null`
        // read written as a refusal would pass every test above.
        readBreakerLatch.mockResolvedValue(null as never);
        const { refusal } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBeNull();
        expect(readBreakerLatch).toHaveBeenCalledWith('t1', 'agent-1');
    });

    it('a CLOSED breaker is not a latch either', async () => {
        readBreakerLatch.mockResolvedValue({ state: 'CLOSED', anomalousStreak: 0 } as never);
        const { refusal } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBeNull();
    });

    it('asks neither stop for an agent already refused on its own record', async () => {
        // Order matters for cost, not only for the message: a suspended agent
        // must not cost two more queries per fire.
        mockPrisma.registeredAgent.findFirst.mockResolvedValue({
            id: 'agent-1', status: 'SUSPENDED', riskTier: 'LOW',
        });
        const { refusal } = await runAgentInvokeDispatch(payload() as never);
        expect(refusal).toBe('agent_not_active');
        expect(resolveKillState).not.toHaveBeenCalled();
        expect(readBreakerLatch).not.toHaveBeenCalled();
    });
});
