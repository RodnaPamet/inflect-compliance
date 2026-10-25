/**
 * A RUN SETTLED AS KILLED KEEPS THE CAP THAT ALSO LATCHED (#4230).
 *
 * `beforeModelCall` now reads the kill switch even after a cap has latched, so
 * a run can be both capped and killed when it settles. The STATUS and the
 * reason name the kill: an operator who pressed stop looks for that act in the
 * record. But `haltRunAtCap` does two things `haltRunAtKill` did not. It counts
 * `recordAgentRunCapHalt`, and it writes the cap's fields into the trail.
 * Settling as a kill alone would delete an instance of a budget ceiling doing
 * its job, which is the evidence an auditor asks for. So the kill carries the
 * cap beside it, with the order the engine observed the two in (#4209).
 */

/**
 * The audit entry's shape, declared on the mock. `jest.fn(async () => …)`
 * infers a zero-parameter signature, and `mock.calls[0][0]` then fails `tsc`
 * while the suite passes.
 */
interface AuditCall {
    action: string;
    detailsJson: Record<string, unknown>;
}

import { strictMock } from '../helpers/strict-mock';

const recordAgentRunCapHalt = jest.fn();
const appendAuditEntry = jest.fn(async (_entry: AuditCall) => undefined);
const runInTenantContext = jest.fn(async () => undefined);

jest.mock('@/lib/observability/metrics', () =>
    strictMock('@/lib/observability/metrics', jest.requireActual('@/lib/observability/metrics'), {
        recordAgentRunCapHalt,
        recordAgentGuardBlock: jest.fn(),
    }),
);
// STRICT, not a subset: `partial-mock-of-a-guarded-barrel` caps the suites that
// mock `@/lib/audit` as a subset, and that cap only falls.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), { appendAuditEntry }),
);
// The real module with the database call replaced. The real `@/lib/audit`
// loaded above reaches this module's extension, so only `runInTenantContext`
// is overridden.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext,
}));

import { haltRunAtKill } from '@/lib/agentic/drivers/run-settlement';
import type { RunCapHalt } from '@/lib/agentic/run-caps';
import { makeRequestContext } from '../helpers/make-context';

const CTX = makeRequestContext('ADMIN');
const KILL = { scope: 'TENANT', switchId: 'sw-1', engagedAt: new Date('2026-10-25T00:00:00Z') };
const CAP: RunCapHalt = {
    kind: 'TOOL_CALLS',
    source: 'POLICY_CARD',
    limit: 3,
    used: 3,
    refused: 1,
    message: 'run_cap_halted: TOOL_CALLS',
};

const auditOf = (call = 0): AuditCall => {
    const entry = appendAuditEntry.mock.calls[call]?.[0];
    if (!entry) throw new Error(`no audit entry at call ${call}`);
    return entry;
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('haltRunAtKill, with a cap beside the kill', () => {
    it('settles ABORTED and names the kill, not the cap', async () => {
        const status = await haltRunAtKill(CTX, 'run-1', KILL, 'stopped', { halt: CAP, observedFirst: 'CAP' });

        expect(status).toBe('ABORTED');
        expect(auditOf().action).toBe('WORKFLOW_RUN_AGENT_KILLED');
        expect(auditOf().detailsJson).toMatchObject({ killScope: 'TENANT', killSwitchId: 'sw-1', escalate: true });
        // One audit row: the cap is carried on the kill's, not written as a
        // second terminal settlement.
        expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    });

    it('counts the cap halt, the same metric haltRunAtCap counts', async () => {
        await haltRunAtKill(CTX, 'run-1', KILL, 'stopped', { halt: CAP, observedFirst: 'CAP' });

        expect(recordAgentRunCapHalt).toHaveBeenCalledWith({ cap: 'TOOL_CALLS', source: 'POLICY_CARD' });
    });

    it('puts the cap fields and the observed order on the row', async () => {
        await haltRunAtKill(CTX, 'run-1', KILL, 'stopped', { halt: CAP, observedFirst: 'KILL' });

        expect(auditOf().detailsJson).toMatchObject({
            cap: 'TOOL_CALLS',
            capSource: 'POLICY_CARD',
            capLimit: 3,
            capUsed: 3,
            observedFirst: 'KILL',
        });
    });
});

describe('haltRunAtKill, with no cap', () => {
    it('counts no cap halt and writes the cap fields as null', async () => {
        // The control. An implementation that always recorded a cap would pass
        // the tests above and invent ceiling instances that never fired.
        const status = await haltRunAtKill(CTX, 'run-1', KILL, 'stopped');

        expect(status).toBe('ABORTED');
        expect(recordAgentRunCapHalt).not.toHaveBeenCalled();
        expect(auditOf().detailsJson).toMatchObject({
            cap: null,
            capSource: null,
            capLimit: null,
            capUsed: null,
            observedFirst: null,
        });
    });
});
