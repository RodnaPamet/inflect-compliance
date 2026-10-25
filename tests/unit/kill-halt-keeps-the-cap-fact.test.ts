/**
 * A KILLED RUN THAT WAS ALSO CAPPED KEEPS BOTH FACTS (#4196).
 *
 * `assertMayCallModel` refuses a model call for either reason — an operator's
 * kill switch, or a run cap that has already latched — and both leave through
 * the same throw. `executeFlueRun` then settles the run, and it must choose one
 * STATUS and one reason.
 *
 * It reports the KILL, because an operator who pressed stop looks for their act
 * in the record, and concluding that the switch did nothing erodes a safety
 * control. But `haltRunAtCap` does two things `haltRunAtKill` did not: it calls
 * `recordAgentRunCapHalt`, and it writes `cap` / `capSource` / `limit` / `used`
 * into the trail. So settling as a kill ALONE would silently delete an instance
 * of an automated budget ceiling doing its job — which is the exact evidence an
 * auditor asks to see, and a figure that quietly loses instances is worse than
 * one that is visibly wrong.
 *
 * Ordering the two by which latched FIRST would be better and is not available:
 * `RunCapHalt` carries no timestamp, and a kill's `engagedAt` is the operator's
 * clock rather than our observation, so comparing them would be false
 * precision. Keeping both facts is what makes the precedence a display choice
 * rather than a causal claim.
 */

/**
 * The audit entry's shape is declared on the mock rather than inferred.
 *
 * `jest.fn(async () => undefined)` infers a ZERO-parameter signature, so
 * `appendAuditEntry.mock.calls[0][0]` is `Tuple type '[]' … has no element at
 * index '0'` — the suite passes at runtime and `tsc` rejects it, which is the
 * shape that reaches CI as a red Typecheck beside a green Test.
 */
interface AuditCall {
    action: string;
    detailsJson: Record<string, unknown>;
}

import { strictMock } from '../helpers/strict-mock';

const recordAgentRunCapHalt = jest.fn();
const appendAuditEntry = jest.fn(async (_entry: AuditCall) => undefined);
const runInTenantContext = jest.fn(async () => undefined);

jest.mock('@/lib/observability/metrics', () => ({
    recordAgentRunCapHalt,
    recordAgentGuardBlock: jest.fn(),
}));
// STRICT, not a subset. `@/lib/audit` re-exports `appendAuditEntryOrQueue`,
// the no-silent-drop wrapper: a factory supplying only one export resolves the
// others to `undefined`, so a call meant to guarantee an audit row does nothing
// and every assertion still passes. `partial-mock-of-a-guarded-barrel` caps the
// number of suites doing that and the cap is a DOWNWARD ratchet, so this uses
// the helper the guard names rather than raising it by one.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), { appendAuditEntry }),
);
// THE REAL MODULE, with one function replaced — and that is the deliberate
// statement `strictMock` asks for rather than a shortcut around it.
//
// `requireActual` on `@/lib/audit` above loads the REAL audit module, which
// reaches `withRlsTripwireExtension` from this one. A subset factory resolved
// that to `undefined`; a strict one threw and NAMED it, which is how I know it
// is genuinely needed here. The real extension is wanted — only the database
// call is not — so everything else is spread and `runInTenantContext` alone is
// overridden. Unlike `@/lib/audit` this module is not a guarded barrel, so a
// spread is not borrowing against a downward ratchet.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext,
}));

import { haltRunAtKill } from '@/lib/agentic/drivers/run-settlement';
import { makeRequestContext } from '../helpers/make-context';

const CTX = makeRequestContext('ADMIN');
const KILL = { scope: 'TENANT', switchId: 'sw-1', engagedAt: new Date('2026-10-25T00:00:00Z') };
const CAP = { kind: 'TOOL_CALLS', source: 'TENANT', limit: 1, used: 1 };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('haltRunAtKill', () => {
    it('settles ABORTED and names the kill', async () => {
        const status = await haltRunAtKill(CTX, 'run-1', KILL, 'stopped by an operator');

        expect(status).toBe('ABORTED');
        const details = appendAuditEntry.mock.calls[0]![0]!.detailsJson;
        expect(details).toMatchObject({ killScope: 'TENANT', killSwitchId: 'sw-1', escalate: true });
    });

    it('does NOT invent a cap when none latched', async () => {
        // The control. Without it, an implementation that always recorded a cap
        // halt would pass the test below and corrupt the metric in the other
        // direction — inventing ceiling instances that never fired.
        await haltRunAtKill(CTX, 'run-1', KILL, 'stopped');

        expect(recordAgentRunCapHalt).not.toHaveBeenCalled();
        const details = appendAuditEntry.mock.calls[0]![0]!.detailsJson;
        expect(details).not.toHaveProperty('cap');
    });

    it('COUNTS the cap halt when one had latched, even reporting the kill', async () => {
        // The automated control's instance survives. This is the assertion that
        // keeps a killed-and-capped run from erasing evidence the ceiling
        // worked.
        const status = await haltRunAtKill(CTX, 'run-1', KILL, 'stopped', CAP);

        expect(status).toBe('ABORTED');
        expect(recordAgentRunCapHalt).toHaveBeenCalledWith({
            cap: 'TOOL_CALLS',
            source: 'TENANT',
        });
    });

    it('carries the cap into the trail beside the kill, field by field', async () => {
        // Named individually rather than spread, the rule
        // `WORKFLOW_RUN_CAP_HALTED` already states: each is a structural fact
        // about a ceiling, and none can become content when the halt type grows
        // a field.
        await haltRunAtKill(CTX, 'run-1', KILL, 'stopped', CAP);

        const details = appendAuditEntry.mock.calls[0]![0]!.detailsJson;
        expect(details).toMatchObject({
            killScope: 'TENANT',
            cap: 'TOOL_CALLS',
            capSource: 'TENANT',
            capLimit: 1,
            capUsed: 1,
        });
        // And the run is still reported as a kill, not as a cap.
        expect(appendAuditEntry.mock.calls[0]![0]!.action).toBe('WORKFLOW_RUN_AGENT_KILLED');
    });
});
