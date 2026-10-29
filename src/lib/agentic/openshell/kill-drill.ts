/**
 * PROVE A SANDBOX IS GONE — the kill-switch drill's sandbox arm (5.4, #3974).
 *
 * The issue's done-when is unusually precise: "a test proves the deletion
 * actually happened rather than that the call returned". That distinction is
 * the entire reason this module exists separately from `deleteSandboxQuietly`
 * in `executor.ts`, which deliberately does the opposite.
 *
 * ═══ WHY THE TOOL PATH AND THE DRILL PATH MUST DIFFER ═══
 *
 * `deleteSandboxQuietly` returns as soon as the outcome is in
 * `DELETION_IS_SETTLED`, trusting `COMPLETED` and `ALREADY_ABSENT`. That is
 * correct there: a tool that ran has produced output the caller needs, and the
 * module records that losing it is worse than any other failure in that path.
 * Trust is the cheap, right default when the alternative costs a user's result.
 *
 * A drill has no result to protect. Its only product is a claim about whether
 * the control works, so it must take the one step the tool path skips: ask
 * whether the sandbox is ACTUALLY ABSENT, whatever the delete call said. A
 * gateway that returns `COMPLETED` and leaks the sandbox is precisely the
 * failure `H4.kill_switch_drilled` would otherwise evidence as a pass, and
 * `DELETION_OUTCOME_COMPLETED` is a claim by the thing under test.
 *
 * So: delete, then `awaitDeleted` UNCONDITIONALLY, under a bounded signal.
 *
 * ═══ WHAT EACH OUTCOME MEANS FOR THE DRILL'S VERDICT ═══
 *
 * The drill already distinguishes PASSED from FAILED from ERROR, and refuses to
 * report a drill that could not RUN as a broken control — "reporting it as 'the
 * control is broken' would raise a Finding about the wrong thing and train
 * people to close them". These outcomes map onto that trichotomy and nothing
 * else, which is why there is no generic `failed`.
 */
import { logger } from '@/lib/observability/logger';

import {
    DELETION_IS_SETTLED,
    SandboxUnreachableError,
    type SandboxTransport,
} from './transport';

/** Label the drill stamps on its own sandbox, so a leak is attributable. */
export const KILL_DRILL_LABEL = 'inflect.dev/kill-switch-drill';

export const SANDBOX_DRILL_OUTCOMES = [
    /** Deleted, and confirmed absent afterwards. The only passing answer. */
    'deleted_and_absent',
    /**
     * The delete call reported success and the sandbox is STILL THERE. The
     * reason this arm exists: a trusted outcome would have scored this a pass.
     */
    'delete_returned_but_sandbox_present',
    /** The delete call itself refused or threw. The control did not act. */
    'delete_refused',
    /**
     * No sandbox runtime answered, so nothing was exercised. NOT a pass and NOT
     * a failure — `SandboxUnreachableError` is thrown both by the unconfigured
     * transport this build ships and by a real transport whose gateway is down,
     * and the error type cannot tell them apart. The message is carried out so
     * an operator reading the evidence can.
     */
    'not_exercised_unreachable',
] as const;
export type SandboxDrillOutcome = (typeof SANDBOX_DRILL_OUTCOMES)[number];

export interface SandboxDrillReport {
    readonly outcome: SandboxDrillOutcome;
    /** Present whenever a sandbox was created, so a leak can be chased. */
    readonly sandboxId: string | null;
    /** What the delete call claimed, when it returned at all. */
    readonly reportedOutcome: string | null;
    readonly detail: string;
}

/**
 * Create a throwaway sandbox, delete it, and prove it is gone.
 *
 * `absenceTimeoutMs` bounds the proof, and a timeout is read as PRESENT rather
 * than as an inconclusive result. That asymmetry is deliberate: the arm's
 * question is "can this control be evidenced", and an unproven deletion
 * evidences nothing. Reading a timeout as "probably fine" is how a stop control
 * acquires a passing status it has not earned.
 */
export async function drillSandboxDeletion(
    transport: SandboxTransport,
    absenceTimeoutMs: number,
): Promise<SandboxDrillReport> {
    let sandboxId: string | null = null;

    try {
        const created = await transport.createSandbox({
            labels: { [KILL_DRILL_LABEL]: 'true' },
        });
        sandboxId = created.id;
    } catch (err) {
        if (err instanceof SandboxUnreachableError) {
            return {
                outcome: 'not_exercised_unreachable',
                sandboxId: null,
                reportedOutcome: null,
                detail: `no sandbox runtime answered: ${err.message}`,
            };
        }
        throw err;
    }

    let reportedOutcome: string | null = null;
    try {
        const { outcome } = await transport.deleteSandbox({ sandboxId });
        reportedOutcome = outcome;
    } catch (err) {
        return {
            outcome: 'delete_refused',
            sandboxId,
            reportedOutcome: null,
            detail: `deleteSandbox threw: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // UNCONDITIONALLY, including after `COMPLETED`. The outcome is a claim by
    // the component under test; absence is the fact.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), absenceTimeoutMs);
    try {
        await transport.awaitDeleted({ sandboxId, signal: controller.signal });
    } catch (err) {
        logger.error('kill-switch drill: sandbox deletion could not be confirmed', {
            component: 'agentic-openshell',
            sandboxId,
            reportedOutcome,
            error: err instanceof Error ? err.message : String(err),
        });
        return {
            outcome: 'delete_returned_but_sandbox_present',
            sandboxId,
            reportedOutcome,
            detail:
                `deleteSandbox reported ${reportedOutcome} but the sandbox was not absent ` +
                `within ${absenceTimeoutMs}ms`,
        };
    } finally {
        clearTimeout(timer);
    }

    return {
        outcome: 'deleted_and_absent',
        sandboxId,
        reportedOutcome,
        detail:
            `created, deleted (${reportedOutcome}) and confirmed absent` +
            // Worth recording on the evidence row: a settled outcome was still
            // verified rather than trusted, which is what separates this arm
            // from the tool path.
            (DELETION_IS_SETTLED.includes(reportedOutcome as never)
                ? ' — absence confirmed despite a settled outcome, not because of it'
                : ''),
    };
}
