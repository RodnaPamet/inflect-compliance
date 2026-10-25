import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { appendAuditEntry } from '@/lib/audit';
import { recordAgentGuardBlock } from '@/lib/observability/metrics';
import type { RunCapHalt } from '@/lib/agentic/run-caps';
import { recordAgentRunCapHalt } from '@/lib/observability/metrics';

/**
 * HOW A RUN ROW IS SETTLED — shared by every driver.
 *
 * Extracted from `static-driver.ts` for the same reason `recordStep` was: a
 * second engine is coming, and "how a run reaches a terminal state" is not a
 * property of one engine. A driver that settled runs its own way would not
 * merely duplicate this — it would decide, separately, whether a stopped run
 * gets a `WORKFLOW_RUN_FAILED` audit row, and the two answers would drift.
 *
 * The import specifier is `@/lib/db/rls-middleware` rather than the
 * `@/lib/db-context` re-export, deliberately: several unit suites partially
 * mock that module as `{ runInTenantContext }`, and reaching the same function
 * through a different module makes those mocks miss. That cost a green suite
 * once already, on a change that moved no logic.
 */
export async function updateRun(
    ctx: RequestContext,
    runId: string,
    data: Record<string, unknown>,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.workflowRun.update({ where: { id: runId }, data: data as never }),
    );
}

/**
 * Settle a run FAILED with a message an operator reads.
 *
 * The audit row is `.catch`-swallowed on purpose and the run update is not:
 * the row is the thing that stops the run, and an audit backend having a bad
 * minute must not leave a run RUNNING forever. The reverse — updating the
 * trail but not the row — is the state that cannot be recovered from.
 */
export async function failRun(
    ctx: RequestContext,
    runId: string,
    message: string,
): Promise<string> {
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: message,
    });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: 'WORKFLOW_RUN_FAILED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', reason: message },
    }).catch(() => undefined);
    return 'FAILED';
}

/**
 * Settle a run the CONTENT GUARD stopped, and say which way it stopped.
 *
 * ── WHY NOT `failRun` ───────────────────────────────────────────────────────
 *
 * The same argument `haltRunAtCap` makes below, for the same reason: `failRun`
 * says a step went wrong, and nothing went wrong here. The engine worked, the
 * model worked, and a control refused what was moving. Those are different
 * operator actions — read the verdict and the rule ids, versus debug a broken
 * workflow — and an `errorMessage` that reads like a tool error sends people to
 * the wrong one. Before this, a guard block left `flue_run_failed: <the throw's
 * message>`, which is the shape of a crash.
 *
 * ── TWO OUTCOMES, BECAUSE THE GUARD HAS TWO ─────────────────────────────────
 *
 *   QUARANTINED — blocked. There is nothing for a human to approve: the content
 *                 was refused and never moved. The run is ABORTED, and the step
 *                 ledger carries the verdict and the rule ids.
 *   FLAGGED     — `policy.ts` states this verdict's contract as "allow, but
 *                 force human review; NEVER auto-commit". AWAITING_APPROVAL is
 *                 the status that means precisely that, and `resumeWorkflowRun`
 *                 is how a human acts on it. Leaving a flagged run COMPLETED
 *                 was the gap: the guard ran, recorded its verdict, and the run
 *                 reported success — a control that reports itself working.
 *
 * ── NO NEW STATUS VALUE ─────────────────────────────────────────────────────
 *
 * Deliberately, and `haltRunAtCap` below carries the full argument: adding an
 * enum member is safe to WRITE under a rolling deploy and unsafe to READ,
 * because a container still on the old build cannot deserialise a status its
 * client does not know and takes the whole run list down for the rollout. Both
 * values used here already ship and are already read.
 *
 * `completedAt` is stamped on the ABORTED arm and NOT on the flagged one: a run
 * awaiting a human is not finished, and the reaper leaves AWAITING_APPROVAL
 * alone however old it is precisely because someone is expected to come back
 * to it.
 */
export async function haltRunAtGuard(
    ctx: RequestContext,
    runId: string,
    verdict: 'FLAGGED' | 'QUARANTINED',
    ruleIds: readonly string[],
): Promise<string> {
    const blocked = verdict === 'QUARANTINED';
    const status = blocked ? 'ABORTED' : 'AWAITING_APPROVAL';
    // The rule ids, never the content that tripped them — the same rule the
    // adapter's `ReviewFlag` follows. What an operator needs is which rule
    // fired; the text that matched it is the thing the guard exists to contain.
    const message = blocked
        ? `flue_run_guard_blocked: the content guard refused this run's traffic (${ruleIds.join(', ') || 'no rule ids recorded'}). Nothing was committed.`
        : `flue_run_guard_flagged: the content guard requires human review before this run may continue (${ruleIds.join(', ') || 'no rule ids recorded'}).`;

    await updateRun(ctx, runId, {
        status,
        ...(blocked ? { completedAt: new Date() } : {}),
        errorMessage: message,
    });
    // THE GUARD-BLOCK COUNTER (#3484), at the one place a block settles a run.
    // The verdict is a label rather than two counters: QUARANTINED (stopped,
    // nothing committed) and FLAGGED (parked for review) are different
    // operational problems — agents being blocked versus reviewers with a
    // queue — and one counter with a label lets a dashboard read either
    // without knowing both names.
    recordAgentGuardBlock({ verdict });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: blocked ? 'WORKFLOW_RUN_GUARD_BLOCKED' : 'WORKFLOW_RUN_GUARD_FLAGGED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', reason: message, verdict, ruleIds: [...ruleIds] },
    }).catch(() => undefined);
    return status;
}

/**
 * A cap that also latched on a run settled as KILLED, and which of the two the
 * engine observed first (#4230). The order is the engine's own observation, not
 * a comparison of clocks (#4209).
 */
export interface CapBesideKill {
    readonly halt: RunCapHalt;
    readonly observedFirst: 'CAP' | 'KILL';
}

/**
 * Settle a run stopped by a KILL SWITCH.
 *
 * ── WHY NOT `failRun` ───────────────────────────────────────────────────────
 *
 * The same argument `haltRunAtGuard` and `haltRunAtCap` make: `failRun` says a
 * step went wrong, and nothing went wrong here. An operator engaged a switch
 * and the engine obeyed it. Those are different operator actions — debug the
 * workflow, versus decide whether the switch should still be engaged.
 *
 * ABORTED rather than a new status, for the reason `haltRunAtCap` records at
 * length: adding an enum value is safe to WRITE under a rolling deploy and
 * unsafe to READ, because a container on the old build cannot deserialise a
 * status its client does not know. ABORTED already exists and already means
 * "a control stopped this", which is exactly what happened.
 *
 * The message names the SCOPE and who can lift it. It deliberately does not
 * echo the reason text an administrator typed: that is tenant content, and the
 * thing being told about the refusal is the thing that was just stopped — the
 * same rule `assertNotKilled` follows at the tool boundary.
 *
 * ── A RUN THAT WAS ALSO CAPPED (#4230) ──────────────────────────────────────
 *
 * The status and the reason name the kill: an operator who pressed stop looks
 * for that act in the record. The cap is not dropped. `alsoCapped` counts the
 * same metric `haltRunAtCap` counts and puts the cap's fields on this row, so
 * a run settled as killed still shows the ceiling that fired. `observedFirst`
 * says which of the two this process saw first (#4209). Every cap key is
 * present and `null` on a kill with no cap, so "no cap latched" is a value a
 * reader can see rather than an absent key.
 */
export async function haltRunAtKill(
    ctx: RequestContext,
    runId: string,
    kill: { scope: string; switchId: string; engagedAt: Date },
    reason: string,
    alsoCapped: CapBesideKill | null = null,
): Promise<string> {
    const message = `flue_run_agent_killed: ${reason}`;
    if (alsoCapped) {
        recordAgentRunCapHalt({ cap: alsoCapped.halt.kind, source: alsoCapped.halt.source });
    }
    await updateRun(ctx, runId, {
        status: 'ABORTED',
        completedAt: new Date(),
        errorMessage: message,
    });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: 'WORKFLOW_RUN_AGENT_KILLED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            reason: message,
            killScope: kill.scope,
            killSwitchId: kill.switchId,
            killEngagedAt: kill.engagedAt.toISOString(),
            escalate: true,
            // Named at the sink, never spread, as on `WORKFLOW_RUN_CAP_HALTED`.
            cap: alsoCapped?.halt.kind ?? null,
            capSource: alsoCapped?.halt.source ?? null,
            capLimit: alsoCapped?.halt.limit ?? null,
            capUsed: alsoCapped?.halt.used ?? null,
            observedFirst: alsoCapped?.observedFirst ?? null,
        },
    }).catch(() => undefined);
    return 'ABORTED';
}

/**
 * Mark a run HALTED AT A CAP, and record WHICH cap and how much work is left.
 *
 * Separate from `failRun` on purpose, and the separation is the requirement
 * rather than tidiness. `failRun` says a step went wrong; this says nothing
 * went wrong at all — the run was working exactly as designed and was stopped
 * because it reached a ceiling somebody set. Those are different operator
 * actions (debug the workflow vs. decide whether the ceiling is right), and an
 * `errorMessage` that reads like a tool error sends people to the first one.
 *
 * `stepsNotRun` is the part that makes this a halt rather than a trim. Without
 * it a halted run is indistinguishable from a completed one to anything reading
 * the row: same `FAILED` status a broken step leaves, same absent tail. With
 * it, the remaining work is a recorded number in a hash-chained row that is
 * never deleted — visibly not-done rather than quietly gone.
 *
 * ── AND WHY IT IS NULLABLE (#3602) ──────────────────────────────────────────
 *
 * `null` means THE REMAINDER WAS NEVER ENUMERABLE, which is the truth for a
 * model-driven run and a different statement from `0`. The static engine walks
 * a declared array, so `def.steps.length - seq` is exactly the work it will not
 * now do. Flue is handed that array as a SPECIFICATION and decides its own
 * calls, so the same subtraction mixes two scales and produces a number that is
 * wrong in whichever direction the ledger happens to sit.
 *
 * Both directions were observed. A `posture-review` halt recorded
 * `stepsNotRun: 5` — all five declared steps unrun — for a run that had already
 * committed four `TOOL_CALL` rows. And `access-posture` declares 3 steps while
 * its runs commit 4 to 6, so the same expression goes NEGATIVE there.
 *
 * `0` could not be used instead: on the static path it is a real and meaningful
 * value (a run halted after its last step), so overloading it would make the
 * honest zero unreadable.
 *
 * The run stays `FAILED` rather than gaining a `HALTED` status of its own.
 * Adding an enum value is safe to WRITE under a rolling deploy and unsafe to
 * READ: a container still running the old build would fail to deserialise a
 * status its client does not know, taking the whole run list down for the
 * duration of the rollout. The cap is carried by the audit action, the details
 * and the message instead — all three of which an old build reads as strings.
 */
export async function haltRunAtCap(
    ctx: RequestContext,
    runId: string,
    halt: RunCapHalt,
    stepsNotRun: number | null,
): Promise<string> {
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: halt.message,
    });
    recordAgentRunCapHalt({ cap: halt.kind, source: halt.source });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        // A distinct action, not a `WORKFLOW_RUN_FAILED` with a special
        // message. An operator filtering the trail for cap halts must not have
        // to grep prose to find them.
        action: 'WORKFLOW_RUN_CAP_HALTED',
        requestId: ctx.requestId,
        // Every field named at the sink, none spread. All six are structural
        // facts about the ceiling — a cap kind, two integers, a source, and how
        // much work stopped. None of them is content, and none of them can
        // become content when the halt type grows a field.
        detailsJson: {
            category: 'access',
            cap: halt.kind,
            capSource: halt.source,
            limit: halt.limit,
            used: halt.used,
            refused: halt.refused,
            stepsNotRun,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);
    return 'FAILED';
}
