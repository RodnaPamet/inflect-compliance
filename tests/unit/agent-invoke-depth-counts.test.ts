/**
 * #5716 — the `INVOKE_AGENT` recursion counter actually counts.
 *
 * `MAX_AGENT_INVOKE_DEPTH` (5) was always READ, off the job payload, and until
 * this change nothing WROTE the number it read. A run did not record its depth,
 * so the automation events its effects caused carried none, so every invoke
 * arrived at depth 1 and `depth_exceeded` could not trip through a real cycle.
 * An agent -> rule -> agent loop was bounded only by each lap needing an event
 * that a usecase the run's effects reach happens to emit — an accident of
 * reachability, not a counter.
 *
 * THE OLD CAP TEST PASSED THROUGHOUT. `agent-invoke-dispatch.test.ts` drives the
 * refusal with a hand-written `depth`, which proves the comparison and says
 * nothing about whether the number is ever anything but 1. That is the shape of
 * a dead gate staying green, so the links are tested here one at a time, each in
 * the module that owns it:
 *
 *   1. the BUS stamps the depth from the context       — this file
 *   2. a resumed run gets it back from its ROW          — this file
 *   3. `invokeAgent` enqueues one deeper                — action-executor.test.ts
 *   4. a SUB-FLOW does not launder it                   — action-executor.test.ts
 *   5. the run's context carries it to the run          — agent-invoke-dispatch.test.ts
 *   6. the dispatch refuses above the cap               — agent-invoke-dispatch.test.ts
 */
import { getAutomationBus } from '@/app-layer/automation/automation-bus';
import type { AutomationDomainEvent } from '@/app-layer/automation/event-contracts';
import type { RequestContext } from '@/app-layer/types';

const ctxAt = (depth?: number): RequestContext =>
    ({
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: {},
        ...(depth === undefined ? {} : { agentInvokeDepth: depth }),
    }) as unknown as RequestContext;

/** Emit through the real bus and return the event a subscriber saw. */
async function emitted(ctx: RequestContext, data: Record<string, unknown>): Promise<AutomationDomainEvent> {
    const bus = getAutomationBus();
    bus.reset();
    let seen: AutomationDomainEvent | null = null;
    bus.subscribe('RISK_CREATED', (e) => {
        seen = e;
    });
    await bus.emit(ctx, {
        event: 'RISK_CREATED',
        entityType: 'Risk',
        entityId: 'risk-1',
        actorUserId: 'user-1',
        data,
    } as never);
    if (!seen) throw new Error('the bus delivered nothing to the subscriber');
    return seen;
}

const DATA = { title: 'a risk', score: 9, category: null } as Record<string, unknown>;

describe('the bus stamps the recursion depth from the context', () => {
    afterEach(() => getAutomationBus().reset());

    it('puts the context depth on the event the subscribers see', async () => {
        const e = await emitted(ctxAt(3), DATA);
        expect((e.data as Record<string, unknown>).__agentInvokeDepth).toBe(3);
    });

    it('leaves an ordinary event untouched, because absent is depth zero', async () => {
        const e = await emitted(ctxAt(undefined), DATA);
        expect(e.data).toEqual(DATA);
        expect((e.data as Record<string, unknown>).__agentInvokeDepth).toBeUndefined();
    });

    it('keeps the payload the caller sent beside the stamp', async () => {
        const e = await emitted(ctxAt(2), DATA);
        expect(e.data).toEqual({ ...DATA, __agentInvokeDepth: 2 });
    });

    // NON-FORGEABLE, the way `tenantId` is. A caller that sets the key itself
    // does not get to choose its own recursion depth: the context wins, or a
    // rule could reset the counter by emitting a crafted payload.
    it('overrides a depth the caller put in the payload', async () => {
        const e = await emitted(ctxAt(4), { ...DATA, __agentInvokeDepth: 1 });
        expect((e.data as Record<string, unknown>).__agentInvokeDepth).toBe(4);
    });

    it('stamps zero as zero rather than dropping it', async () => {
        const e = await emitted(ctxAt(0), DATA);
        expect((e.data as Record<string, unknown>).__agentInvokeDepth).toBe(0);
    });
});
