/**
 * THE KILL-SWITCH DRILL — scheduled, recorded, and it raises a Finding when it
 * fails.
 *
 * An untested stop control is an assumption. Every other signal this subsystem
 * emits fires when a control ACTS; a stop control that has quietly stopped
 * working emits nothing at all and looks exactly like a quiet week. So once a
 * day, per tenant that actually runs agents, this pulls the switch for real and
 * checks that the tool boundary refuses — and writes down what happened in a row
 * shaped to be read as evidence rather than as a log line.
 *
 * ## What the drill actually exercises, stated precisely
 *
 * Three scopes, and they are NOT exercised to the same depth. Saying so is the
 * point: a drill that reported one number for three different depths of
 * assurance would be the same defect as a cap that trims and continues.
 *
 *   AGENT — COMMITTED. A real `AgentKillSwitch` row is written, the boundary's
 *     own decision function is asked about it, the answer is checked to name the
 *     AGENT scope and not merely to be non-null, and the row is lifted. The
 *     target is `KILL_SWITCH_DRILL_AGENT_ID`, which resolves to no registered
 *     agent in any tenant — the reason `AgentKillSwitch.agentId` carries no
 *     foreign key. So the whole write -> decide -> lift lifecycle runs against
 *     production code and production tables, and no production agent is ever
 *     stopped.
 *
 *   TENANT and PLATFORM — PREDICATE ONLY, inside a transaction that is ROLLED
 *     BACK. These two cannot be drilled end to end without being an outage on a
 *     cron: a committed tenant-wide kill stops that tenant's real agents, and a
 *     committed platform kill stops every agent in the deployment. What IS
 *     checked is that `resolveKillState` — the single query the boundary asks —
 *     returns the right scope for a row of that shape, which is the regression
 *     class the AGENT arm cannot see (somebody narrowing the SQL's
 *     `agentId IS NULL OR agentId = $2` to `agentId = $2` breaks tenant-wide
 *     kills and leaves every agent-scope test green).
 *
 * The distinction is written onto the row (`detail`), so an auditor reading the
 * evidence is told which arm proved what.
 *
 * ## Why an answer naming the WRONG SCOPE is a FAILURE
 *
 * `boundaryRefusalReason` exists because "something refused" is not the claim.
 * The refusal an operator sees, and the person they are told can lift it, both
 * come from the SCOPE — so an agent-scope kill answered as TENANT sends them to
 * the wrong lever, and a pass/fail column could not show it. The drill records
 * `refused_for_another_reason` in that case, which fails the drill.
 *
 * ## HALTING IS NOT TRUNCATION
 *
 * Two places this rule bites, in opposite directions:
 *
 *   • WITHIN one tenant's drill, all three arms are attempted even after one
 *     fails, because the outcome the evidence needs is "which scopes are
 *     honoured", not "the first one that broke". That is complete measurement,
 *     not continuing past an error.
 *   • ACROSS tenants, one tenant's drill throwing does NOT abort the sweep and
 *     does NOT silently skip the rest. It is recorded as that tenant's own
 *     `ERROR` row — a recorded outcome, never a dropped one — and the loop goes
 *     on, because halting the sweep would leave every later tenant undrilled
 *     with nothing saying so.
 *
 * `ERROR` is deliberately not `FAILED`. A drill that could not RUN has proved
 * nothing; reporting it as "the control is broken" would raise a Finding about
 * the wrong thing and train people to close them.
 *
 * ## The Finding goes through the control-test path
 *
 * A FAILED drill produces the same artefact chain `control-test-runner` produces
 * on an automated FAIL: an `Evidence(type=TEXT, category='integration')` row
 * carrying the drill's own result, a `Finding(type=NONCONFORMITY, status=OPEN)`,
 * and a `FindingEvidence` bridging them — the codebase's existing way of
 * attaching a Finding to the thing that produced it. It is not a new mechanism,
 * because the point is that a failed stop control lands in the same queue a
 * failed control test lands in, in front of the same people.
 *
 * ## What this drill does NOT prove, said out loud
 *
 * That `authorizeToolCall` still CALLS the decision, and calls it first. See
 * `probeBoundaryDecision` for why that cannot be checked from inside the worker
 * and where it IS checked instead. An honest drill states its own boundary;
 * one that implied end-to-end coverage it does not have would be the same defect
 * as the control it is testing.
 */
import type { AgentKillSwitchDrillPayload, JobRunResult } from './types';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import { recordKillSwitchDrill } from '@/lib/observability/integration-metrics';
import {
    KILL_SCOPES,
    KILL_SWITCH_DRILL_AGENT_ID,
    resolveKillState,
    type KillScope,
} from '@/lib/agentic/kill-switch';
import { buildDelegatedJobContext } from '../context-system';
import { drainPages } from './drain-pages';

/**
 * The actor recorded on the canary kill row. Not a `User.id` and not pretending
 * to be one — `AgentKillSwitch.engagedByUserId` has no foreign key, and
 * inventing a person for a scheduled probe would put a name on the one row an
 * incident review reads for accountability.
 */
const DRILL_ACTOR = 'system:agent-kill-switch-drill';

/** Why the probe was refused, as the drill records it. */
type RefusalReason =
    /** The boundary refused, and said KILLED. The only passing answer. */
    | 'agent_killed'
    /** The boundary refused for something else — the stop control is not what
     *  stopped it, and the reordering that causes this is invisible to a status
     *  code. */
    | 'refused_for_another_reason'
    /** The boundary CLEARED the call while a kill was in force. */
    | 'not_refused';

export interface KillSwitchDrillResult {
    outcome: 'PASSED' | 'FAILED' | 'ERROR';
    scopesHonoured: KillScope[];
    scopesFailed: KillScope[];
    toolCallsAfterKill: number;
    boundaryRefusalReason: RefusalReason | null;
    detail: string;
    drillId: string | null;
    findingId: string | null;
}

/**
 * Ask the boundary's own question about a kill that is REALLY in force.
 *
 * `resolveKillState` is the function `assertNotKilled` — step 0 of
 * `authorizeToolCall` — calls on every tool call, and its `null` return is
 * EXACTLY what makes that step return without throwing, which is exactly what
 * lets `runReadTool` reach `tool.run`. So a `null` here is counted as a tool
 * call that would have executed.
 *
 * ## Why the drill stops here rather than driving `authorizeToolCall` itself
 *
 * It cannot, and the reason is worth writing down rather than leaving as an
 * apparent gap. This runs inside the BullMQ worker, a plain Node process, and
 * `tests/guards/worker-import-graph.test.ts` forbids any job module from
 * reaching `src/lib/auth.ts` — which `@/lib/mcp/authorize` does, transitively,
 * through `permission-middleware` -> `app-layer/context`. That is not a lint
 * technicality: the worker cannot evaluate that module tree (`next/headers` is
 * absent, and `src/auth.ts` builds its provider array at module scope), so a
 * drill that imported the gate would throw on import and record `ERROR` every
 * single night — a control whose self-test never runs, wearing a status.
 *
 * What that costs, stated plainly: this drill proves the DECISION in
 * production — the row is written, the index serves it, RLS does not hide it,
 * the precedence is right — and does not prove the WIRING. The wiring (that the
 * gate calls this, and calls it BEFORE the credential and exposure checks) is
 * proved in CI, behaviourally, by `tests/integration/agent-kill-switch.test.ts`,
 * which drives the real funnel and asserts a killed agent is refused with the
 * KILL refusal even when a later check would also have refused it. Wiring is a
 * compile-time fact and CI is where compile-time facts are checked; what varies
 * in production is state, and state is what this drills.
 */
async function probeBoundaryDecision(
    tenantId: string,
    expectedScope: KillScope,
): Promise<RefusalReason> {
    const verdict = await resolveKillState(tenantId, KILL_SWITCH_DRILL_AGENT_ID);
    if (verdict === null) return 'not_refused';
    // A verdict naming a DIFFERENT scope is not a pass. The refusal an operator
    // gets, and the person they are told can lift it, both come from the scope —
    // so answering TENANT for an agent-scope kill sends them to the wrong lever.
    return verdict.scope === expectedScope ? 'agent_killed' : 'refused_for_another_reason';
}

/**
 * The two scopes that cannot be committed, checked against the query the
 * boundary asks, inside a transaction that is rolled back.
 *
 * Returns the scopes whose predicate arm answered correctly. The rollback is
 * unconditional: the sentinel throw is the mechanism, and the `catch` below
 * re-throws anything that is not it, so a genuine database error is never
 * mistaken for a successful rollback.
 */
const ROLLBACK = Symbol('kill-switch-drill-rollback');

async function probeUncommittableScopes(
    tenantId: string,
): Promise<{ honoured: KillScope[]; failed: KillScope[] }> {
    const honoured: KillScope[] = [];
    const failed: KillScope[] = [];

    try {
        await prisma.$transaction(async (tx) => {
            // TENANT scope: a row with agentId NULL must be seen by a lookup for
            // ANY agent in the tenant, including one the register does not know.
            await tx.agentKillSwitch.create({
                data: {
                    tenantId,
                    agentId: null,
                    reason: 'Scheduled kill-switch drill (rolled back)',
                    engagedByUserId: DRILL_ACTOR,
                },
            });
            const tenantVerdict = await resolveKillState(
                tenantId,
                KILL_SWITCH_DRILL_AGENT_ID,
                tx,
            );
            (tenantVerdict?.scope === 'TENANT' ? honoured : failed).push('TENANT');

            // PLATFORM scope: it must OUTRANK the tenant row already present, so
            // this checks the precedence at the same time as the arm. Reporting
            // AGENT or TENANT here would mean an operator who stopped the
            // deployment is told a tenant admin can lift it.
            await tx.platformAgentKillSwitch.create({
                data: {
                    reason: 'Scheduled kill-switch drill (rolled back)',
                    engagedByRef: DRILL_ACTOR,
                },
            });
            const platformVerdict = await resolveKillState(
                tenantId,
                KILL_SWITCH_DRILL_AGENT_ID,
                tx,
            );
            (platformVerdict?.scope === 'PLATFORM' ? honoured : failed).push('PLATFORM');

            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }

    return { honoured, failed };
}

/**
 * Run one tenant's drill and record it. Never throws for a drill FAILURE — that
 * is a recorded outcome — and converts an unexpected throw into a recorded
 * `ERROR` row rather than losing it.
 */
export async function runKillSwitchDrill(
    tenantId: string,
    jobRunId: string,
): Promise<KillSwitchDrillResult> {
    const startedAt = new Date();
    let canaryId: string | null = null;

    try {
        // Resolved FIRST: the drill's record needs a real `User.id` for its
        // Evidence row's foreign key, and a drill that ran and could not be
        // written down is worse than one that did not run — it would look like a
        // tenant nobody drilled.
        const actor = await resolveDrillActor(tenantId);
        if (!actor) {
            return recordDrill(tenantId, jobRunId, startedAt, {
                outcome: 'ERROR',
                scopesHonoured: [],
                scopesFailed: [],
                toolCallsAfterKill: 0,
                boundaryRefusalReason: null,
                detail:
                    'Drill could not run: this tenant has no ACTIVE member to attribute ' +
                    'the drill record to. The kill switch itself is untested here until ' +
                    'one exists — this is not evidence that it works.',
                drillId: null,
                findingId: null,
            });
        }

        // A canary kill left behind by a drill that died mid-run would make the
        // partial unique index refuse this one. Lifting it first is safe by
        // construction: this id is reserved and the usecase refuses it, so no
        // row here was ever engaged by a human.
        await prisma.agentKillSwitch.updateMany({
            where: { tenantId, agentId: KILL_SWITCH_DRILL_AGENT_ID, liftedAt: null },
            data: {
                liftedAt: new Date(),
                liftedByUserId: DRILL_ACTOR,
                liftReason: 'Superseded by a later drill — the previous run did not finish.',
            },
        });

        const canary = await prisma.agentKillSwitch.create({
            data: {
                tenantId,
                agentId: KILL_SWITCH_DRILL_AGENT_ID,
                reason: 'Scheduled kill-switch drill — canary target, no real agent.',
                engagedByUserId: DRILL_ACTOR,
            },
            select: { id: true },
        });
        canaryId = canary.id;

        const refusal = await probeBoundaryDecision(tenantId, 'AGENT');
        const uncommittable = await probeUncommittableScopes(tenantId);

        const scopesHonoured = [
            ...(refusal === 'agent_killed' ? (['AGENT'] as KillScope[]) : []),
            ...uncommittable.honoured,
        ];
        const scopesFailed = [
            ...(refusal === 'agent_killed' ? [] : (['AGENT'] as KillScope[])),
            ...uncommittable.failed,
        ];

        const outcome = scopesFailed.length === 0 ? 'PASSED' : 'FAILED';
        return recordDrill(tenantId, jobRunId, startedAt, {
            outcome,
            scopesHonoured,
            scopesFailed,
            toolCallsAfterKill: refusal === 'not_refused' ? 1 : 0,
            boundaryRefusalReason: refusal,
            detail: describeDrill(outcome, refusal, scopesHonoured, scopesFailed),
            drillId: null,
            findingId: null,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('agentic: kill-switch drill could not run', {
            tenantId,
            jobRunId,
            // The message, NAMED, and nothing else. No invocation, no context,
            // no spread — this file is on the agentic path.
            errorMessage: message,
        });
        return recordDrill(tenantId, jobRunId, startedAt, {
            outcome: 'ERROR',
            scopesHonoured: [],
            scopesFailed: [],
            toolCallsAfterKill: 0,
            boundaryRefusalReason: null,
            detail:
                'Drill could not run to completion, so it proves nothing about the ' +
                `kill switch either way. Cause: ${message}`,
            drillId: null,
            findingId: null,
        });
    } finally {
        if (canaryId) {
            // ALWAYS lifted, including when the drill failed or threw. A drill
            // that leaves its own kill in force would be a control that breaks
            // the thing it tests — and while this canary stops no real agent,
            // leaving it would make the next run read its own leftover state.
            await prisma.agentKillSwitch
                .updateMany({
                    where: { id: canaryId, liftedAt: null },
                    data: {
                        liftedAt: new Date(),
                        liftedByUserId: DRILL_ACTOR,
                        liftReason: 'Drill complete.',
                    },
                })
                .catch((err: unknown) => {
                    logger.error('agentic: kill-switch drill could not lift its canary', {
                        tenantId,
                        killSwitchId: canaryId,
                        errorMessage: err instanceof Error ? err.message : String(err),
                    });
                });
        }
    }
}

/** The sentence an auditor reads. Digest-level: no prompts, no payloads. */
function describeDrill(
    outcome: string,
    refusal: RefusalReason,
    honoured: KillScope[],
    failed: KillScope[],
): string {
    const arms =
        "The boundary's own decision function (resolveKillState, which step 0 of " +
        'authorizeToolCall calls on every tool call) was exercised for all three ' +
        'scopes against real rows. AGENT scope additionally exercised the COMMITTED ' +
        'write and lift lifecycle, against a canary target that resolves to no ' +
        'registered agent; TENANT and PLATFORM scopes were exercised inside a ' +
        'transaction that was ROLLED BACK, because committing either would stop ' +
        'real agents. That the tool gate CALLS this decision, and calls it before ' +
        'the credential and exposure checks, is proved in CI by ' +
        'tests/integration/agent-kill-switch.test.ts and not here: loading the gate ' +
        'inside the worker would pull a module tree the worker cannot evaluate.';
    const verdict =
        outcome === 'PASSED'
            ? `All ${honoured.length} scopes honoured. No tool call cleared the boundary ` +
              'while a kill was in force.'
            : `Scopes honoured: ${honoured.join(', ') || 'none'}. Scopes NOT honoured: ` +
              `${failed.join(', ') || 'none'}.` +
              (refusal === 'not_refused'
                  ? ' The tool boundary CLEARED a call while a kill was in force — the ' +
                    'stop control did not stop anything.'
                  : refusal === 'refused_for_another_reason'
                    ? ' The tool boundary refused the call, but NOT because of the kill ' +
                      'switch. Something else refused it first, which means the kill ' +
                      'check is no longer reached — every status code still looks right.'
                    : '');
    return `${verdict} ${arms}`;
}

/**
 * The person a drill record is attributed to.
 *
 * The tenant's longest-standing ACTIVE member, OWNERs first. A drill row and its
 * Evidence need a real `User.id` for their foreign keys, and the accountable
 * human for "are this tenant's agents stoppable" is the same person accountable
 * for the register. Returns `null` when there is nobody — which is recorded as
 * `ERROR`, not silently skipped.
 */
async function resolveDrillActor(tenantId: string): Promise<string | null> {
    const member = await prisma.tenantMembership.findFirst({
        where: { tenantId, status: 'ACTIVE' },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: { userId: true },
    });
    return member?.userId ?? null;
}

/**
 * Write the drill row, its Evidence, and — on FAILED — the Finding.
 *
 * The artefact chain is `control-test-runner`'s, deliberately: Evidence(TEXT,
 * category 'integration') → Finding(NONCONFORMITY, OPEN) → FindingEvidence. A
 * failed stop control lands in the same queue, in front of the same people, as a
 * failed control test.
 */
async function recordDrill(
    tenantId: string,
    jobRunId: string,
    startedAt: Date,
    result: KillSwitchDrillResult,
): Promise<KillSwitchDrillResult> {
    recordKillSwitchDrill({ outcome: result.outcome });

    const actor = await resolveDrillActor(tenantId);
    if (!actor) {
        // Nothing to attribute the row to. Reported to the caller so the job
        // result counts it, rather than returning a result that claims a
        // recorded drill nobody can find.
        logger.error('agentic: kill-switch drill has no member to attribute its record to', {
            tenantId,
            jobRunId,
            outcome: result.outcome,
        });
        return result;
    }

    const ctx = buildDelegatedJobContext({
        tenantId,
        job: 'agent-kill-switch-drill',
        onBehalfOf: actor,
        requestId: jobRunId,
    });

    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.create({
            data: {
                tenantId,
                type: 'TEXT',
                title: `Agent kill-switch drill — ${result.outcome}`,
                content: result.detail,
                // Mirrors control-test-runner's convention so these filter
                // alongside every other automated artefact.
                category: 'integration',
                status: 'APPROVED',
                ownerUserId: actor,
            },
            select: { id: true },
        });

        let findingId: string | null = null;
        if (result.outcome === 'FAILED') {
            const finding = await db.finding.create({
                data: {
                    tenantId,
                    title: 'Agent kill switch did not stop an agent at the tool boundary',
                    description: result.detail,
                    severity: 'CRITICAL',
                    type: 'NONCONFORMITY',
                    status: 'OPEN',
                },
                select: { id: true },
            });
            findingId = finding.id;
            // The codebase's existing Finding ↔ producing-artefact bridge:
            // `Finding` has no direct link column, so the Evidence row is it.
            await db.findingEvidence.create({
                data: { tenantId, findingId, evidenceId: evidence.id },
            });
        }

        const row = await db.agentKillSwitchDrill.create({
            data: {
                tenantId,
                jobRunId,
                startedAt,
                completedAt: new Date(),
                outcome: result.outcome,
                scopesHonoured: result.scopesHonoured,
                scopesFailed: result.scopesFailed,
                toolCallsAfterKill: result.toolCallsAfterKill,
                boundaryRefusalReason: result.boundaryRefusalReason,
                detail: result.detail,
                evidenceId: evidence.id,
                findingId,
            },
            select: { id: true },
        });

        return { ...result, drillId: row.id, findingId };
    });
}

/**
 * The scheduled entry point.
 *
 * With a `tenantId` it drills one tenant; without one it drills every tenant
 * that has at least one live registered agent. Tenants with no agents are not
 * drilled and that is not a gap being hidden: there is no agent there for the
 * control to stop, and a PASSED row for such a tenant would be evidence of
 * nothing while making the evidence set look complete.
 *
 * The tenant set is DRAINED, not `take`-capped. A bare cap and a true total are
 * indistinguishable at the boundary, and the tail here is other people's tenants
 * going undrilled indefinitely under a green job run.
 */
export async function runKillSwitchDrillJob(
    payload: AgentKillSwitchDrillPayload,
    jobRunId: string,
): Promise<{ tenants: number; passed: number; failed: number; errored: number }> {
    const tenantIds = payload.tenantId
        ? [payload.tenantId]
        : [
              ...new Set(
                  (
                      await drainPages((cursor) =>
                          prisma.registeredAgent.findMany({
                              where: { deletedAt: null, isLegacyPlaceholder: false },
                              select: { id: true, tenantId: true },
                              orderBy: { id: 'asc' },
                              take: 500,
                              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                          }),
                      )
                  ).map((a) => a.tenantId),
              ),
          ];

    let passed = 0;
    let failed = 0;
    let errored = 0;

    for (const tenantId of tenantIds) {
        // One tenant's drill never aborts the sweep — see the header. Each
        // outcome is RECORDED, including the ones that could not run.
        const result = await runKillSwitchDrill(tenantId, jobRunId);
        if (result.outcome === 'PASSED') passed += 1;
        else if (result.outcome === 'FAILED') failed += 1;
        else errored += 1;
    }

    if (failed > 0) {
        logger.error('agentic: kill-switch drill FAILED for one or more tenants', {
            jobRunId,
            tenants: tenantIds.length,
            failed,
        });
    }

    return { tenants: tenantIds.length, passed, failed, errored };
}

/** BullMQ executor body. */
export async function runAgentKillSwitchDrillJob(
    payload: AgentKillSwitchDrillPayload,
): Promise<JobRunResult> {
    return runJob('agent-kill-switch-drill', async () => {
        const jobRunId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const r = await runKillSwitchDrillJob(payload, jobRunId);
        const completedAt = new Date();
        return {
            jobName: 'agent-kill-switch-drill',
            jobRunId,
            // The JOB succeeded whenever it ran every tenant it set out to.
            // A FAILED drill is a finding about the product, not a broken job:
            // marking the job failed would put it in the queue's retry path and
            // re-run the drill three times in 35 seconds, which changes nothing
            // and writes three Findings.
            success: true,
            startedAt,
            completedAt: completedAt.toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: r.tenants,
            itemsActioned: r.failed,
            itemsSkipped: r.errored,
            details: {
                scopes: [...KILL_SCOPES],
                passed: r.passed,
                failed: r.failed,
                errored: r.errored,
            },
        };
    }, { tenantId: payload.tenantId });
}
