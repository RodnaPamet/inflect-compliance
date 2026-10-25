/**
 * Agentic workflow engine (Epic Agentic 1A) — the orchestration layer over the
 * MCP tools.
 *
 * THE LOAD-BEARING PROPERTY: an agentic workflow does MANY steps, some of which
 * PROPOSE writes. Every write STILL routes through the propose-not-commit
 * approval queue (`runProposeTool` → `createAgentProposal`) — the engine can
 * commit nothing a single MCP tool couldn't. Multi-step ≠ multi-privilege. The
 * engine adds orchestration + checkpoints + guardrails, NOT new authority.
 *
 * Steps execute SYNCHRONOUSLY until the run either completes or hits a
 * HUMAN_CHECKPOINT (→ AWAITING_APPROVAL) — where it PAUSES until a human calls
 * `resumeWorkflowRun`. Every step is an append-only `WorkflowStep` record + a
 * hash-chained audit entry. All tool calls run in the SAME tenant/RLS/permission
 * context as the MCP tools (inherited, not reinvented).
 *
 * "Inherited, not reinvented" is enforced rather than asserted: each execution
 * resolves an `McpInvocation` through `resolveMcpInvocation` — the same builder
 * `/api/mcp` uses — and every step runs on it, so an engine step gets the
 * principal-narrowed context, the per-tool permission check and the
 * deny-by-default tool allowlist that a direct tool call gets. Without that,
 * orchestration would be a way around the allowlist, which is the one thing this
 * engine promises it is not. (A resume re-enters `executeFrom` and therefore
 * re-resolves, so every settled term is re-read across a human checkpoint.)
 *
 * THE CONTEXT IS THE AGENT'S MEMORY, AND IT IS CHAINED. `contextJson`
 * accumulates across steps and every later step reads its instructions out of
 * it, so a value that got in once shapes behaviour long after the interaction
 * that produced it (OWASP ASI06). It is encrypted at rest, which protects
 * confidentiality and says nothing about whether the blob is the one the
 * previous step wrote. So every read validates the envelope against a schema
 * AND verifies a SHA-256 link against `WorkflowRun.contextHash`, and every
 * write re-seals — see `@/lib/agentic/context-integrity`. Any failure HALTS the
 * run (FAILED + the integrity code, an audit row and a metric). Nothing here
 * repairs, coerces or truncates: the executor previously swallowed a JSON parse
 * error and carried on with `{ input: {}, outputs: {} }`, which is a silent
 * memory reset — the worst available outcome and the one this closes.
 *
 * A TOOL RESULT'S PROVENANCE IS READ, NOT DROPPED. `runReadTool` labels every
 * payload with what it is made of and appends that label as a SECOND MCP
 * content block, so `content[0]` stays the exact JSON an external agent parses.
 * This engine used to take `content[0]` and return — so the tagging worked for
 * external clients and did nothing for the surface the product actually runs.
 * `parseToolResult` now returns both halves, the payload still goes into the
 * context unchanged, and the label lands on the step's audit row. It is
 * fail-closed: an absent, unreadable or unrecognised envelope reads as
 * `THIRD_PARTY_INGESTED`.
 *
 * REVOCATION IS CHECKED AT THE TOOL BOUNDARY, NOT AT DISPATCH. `authorizeToolCall`
 * re-reads the credential's live state before EVERY step's tool call, so revoking
 * a key stops a run already in flight at its next step. A status code cannot tell
 * that design from one that checks only at dispatch — both refuse the next
 * request — so the property is tested as "no further tool executed after the
 * revoke", with a spy on the tool itself.
 */
import { createHash } from 'node:crypto';
import { WorkflowRunStatus } from '@prisma/client';

import { runInTenantContext, runInGlobalContext } from '@/lib/db/rls-middleware';
import { getPermissionsForRole } from '@/lib/permissions';
import { enqueue } from '@/app-layer/jobs/queue';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import { parseEnumListFilter } from '@/app-layer/domain/list-filter';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, notFound, forbidden } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { enforceMcpCapability, resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { isApprovalExpired } from '@/lib/agentic/approval-window';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import {
    provenanceOfToolResult,
    UNTRUSTED_PROVENANCE,
    type ContentProvenance,
} from '@/lib/agentic/content-provenance';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import { canonicalJson } from '@/lib/canonical-json';
import { SkillLoadError } from '@/lib/agentic/flue/skills';
import { resolveRunSkillMount } from '@/lib/agentic/flue/skills/tenant-mount';
import { pinForRow, type MountedSkillPin } from '@/lib/agentic/flue/skills/mount-gate';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { assertWithinMonthlyBudget } from '@/lib/agentic/monthly-budget-policy';
import {
    assertWithinConcurrencyCap,
    assertConcurrencyUnderLock,
} from '@/lib/agentic/run-concurrency-policy';
import { trackInFlightRun, untrackInFlightRun } from '@/lib/agentic/in-flight-runs';
import {
    recordAgentRunStarted,
    recordAgentRunSettled,
} from '@/lib/observability/metrics';
import { getRunRow } from '@/lib/agentic/drivers/run-store';
import { recordDecisionOutcome } from '@/app-layer/ai/decision-log';
import { captureReviewAttributionAfterRun } from './agent-harness-attribution';
import { captureAuditNarrativeAfterRun } from './audit-workpaper-narrative';
import { selectRunDriver, requestedDriver } from '@/lib/agentic/drivers';
import type { RunDriverOutcome } from '@/lib/agentic/drivers';
import { isReasoningEngine, type AgentDriver } from '@/lib/agentic/agent-driver';
import {
    estimateTokens,
    type WorkflowContext,
    type WorkflowDefinition,
} from '@/lib/agentic/workflow-types';
import {
    createRunBudget,
    ENGINE_RUN_CAPS,
    resolveRunCaps,
    RUN_CAP_KINDS,
    type RunBudget,
    type RunCapHalt,
} from '@/lib/agentic/run-caps';
import {
    ContextIntegrityError,
    describeContextHalt,
    openSealedContext,
    sealContext,
    type OpenedContext,
} from '@/lib/agentic/context-integrity';
import {
    recordAgenticFanOutHalt,
    recordAgenticMemberFailure,
    recordAgentRunCapHalt,
    recordAgentRunCapUtilisation,
    recordWorkflowContextBytes,
    recordWorkflowContextIntegrityHalt,
} from '@/lib/observability/metrics';
import {
    describeFailure,
    isAgenticFatal,
} from '@/lib/agentic/failure-isolation';
import type { A2aInboundOrigin, RequestContext } from '@/app-layer/types';
import { guardUntrustedInput, assertNoReviewRequired } from '@/app-layer/ai/guard';

// ─── Public API ─────────────────────────────────────────────────────

export interface StartWorkflowResult {
    runId: string;
    status: string;
    workflowKey: string;
    /**
     * How many steps FAILED and were isolated (see `continueOnFailure`).
     *
     * On the result rather than left to a query, because a batch that does not
     * say how many members failed is a batch that reports a partial pass as a
     * clean one. Zero is the ordinary answer and the common case; anything else
     * means this run reasoned over less than its definition asked for.
     */
    stepFailures: number;
}

/**
 * Start a workflow run. Run creation requires the `mcp:orchestrate` capability
 * for API-key callers (strictly more privileged than `mcp:propose`); human
 * callers require write permission. Executes synchronously until completion or
 * the first HUMAN_CHECKPOINT.
 */
/**
 * The STRING VALUES of a run input, joined — what an injection scanner should
 * read.
 *
 * Values only. Keys and JSON punctuation are developer-controlled and never
 * reach the model as content, so `JSON.stringify` would hand the scanner
 * material no prompt ever contains and score it as though it did.
 *
 * The same shape as `guardSubject` in `ai/identity-match/match-state-builder`,
 * deliberately NOT imported: that one is typed to `MatchState` and belongs to
 * a different domain, and widening its surface for a second caller is how a
 * helper becomes a shared dependency nobody owns — the argument
 * `entra-id/entitlement.ts` makes about `graphErrorCode` duplicating
 * `provisioner.ts`'s `bodyOf`. If a third caller appears, lift it to the guard
 * module, which is where "flatten a payload for scanning" belongs.
 */
function scannableInput(input: Record<string, unknown>): string {
    const out: string[] = [];
    const walk = (node: unknown): void => {
        if (typeof node === 'string') {
            out.push(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (node !== null && typeof node === 'object') {
            for (const value of Object.values(node)) walk(value);
        }
    };
    walk(input);
    return out.join('\n');
}

/**
 * Refuse a run whose definition declares `requiredInput` keys the caller did
 * not supply (#3600).
 *
 * BLANK COUNTS AS MISSING, and that is the point rather than a nicety. The
 * production defect this exists for supplied no key at all; the workflow then
 * substituted `''` to satisfy its own `string` type, and `''` is exactly the
 * value the two downstream tools disagree about — rejected by
 * `find_coverage_gaps`, read as "no key given" by `get_framework_status`, which
 * answers a different question entirely. A check that admitted `''` or `'   '`
 * would let the same wrong-scope read back in through the front door.
 *
 * A NON-STRING is missing too. `{ frameworkKey: 42 }` cannot name a framework,
 * and admitting it would push the type error down to the same tool validator
 * this check exists to stay out of.
 *
 * Reports EVERY missing key, not the first. A caller fixing one at a time
 * learns the shape of the request one round trip at a time.
 */
export function assertRequiredInputPresent(
    def: Pick<WorkflowDefinition, 'key' | 'requiredInput'>,
    input: Record<string, unknown>,
): void {
    const missing = (def.requiredInput ?? []).filter((k) => {
        const v = input[k];
        return typeof v !== 'string' || v.trim() === '';
    });
    if (missing.length === 0) return;
    throw badRequest(
        `Workflow ${def.key} requires a non-empty ${missing.join(', ')}. ` +
            `Supply ${missing.length === 1 ? 'it' : 'them'} in the run input.`,
    );
}

export async function startWorkflowRun(
    ctx: RequestContext,
    workflowKey: string,
    input: Record<string, unknown> = {},
    opts: {
        /**
         * The `AutomationExecution` that fired the rule that caused this run
         * (#3537). Omitted for a human- or credential-started run, which has
         * no parent — and inventing one would put a fiction in the column.
         *
         * A separate options bag rather than a fourth positional: `input` is
         * already a defaulted object, and a fifth caller passing the cause in
         * the input's place is a mistake the compiler cannot see.
         */
        parentExecutionId?: string | null;
        /**
         * THIS RUN NEEDS ONLY READ AUTHORITY (#3868 step 2, owner decision
         * 2026-10-22).
         *
         * Starting a run normally asserts WRITE, which is right for every
         * caller that existed before: an automation rule, a recertification
         * pass, an audit narrative. It is wrong for a person asking a question,
         * and the contradiction was found by an integration test rather than by
         * reading — five unit suites mock this function, so none of them could
         * see it. A READER could not start a run at all, while ADR 0004 had
         * determined by test that the answer cannot exceed the asker's own
         * reach and both routes were gated reader-level.
         *
         * VERIFIED, NOT TRUSTED. The claim is refused below unless the resolved
         * definition actually declares `readOnly: true` — so a caller cannot
         * claim read authority for a workflow that can propose. That check is
         * the whole safety of this option: without it the flag would be a way
         * to ask for less authority than the work requires.
         */
        readOnlyAuthority?: boolean;
    } = {},
): Promise<StartWorkflowResult> {
    if (ctx.apiKeyId) {
        enforceMcpCapability(ctx, 'orchestrate');
    } else if (opts.readOnlyAuthority) {
        // The narrowed assert. Its claim is checked against the definition a
        // few lines down, before anything else happens.
        assertCanRead(ctx);
    } else {
        assertCanWrite(ctx);
    }

    const def = getWorkflowDefinition(workflowKey);
    if (!def) throw badRequest(`Unknown workflow: ${workflowKey}`);

    // THE CARVE-OUT, VERIFIED. Deliberately here and not above: keeping the
    // authority check first means an unauthorised caller still cannot learn
    // whether a workflow key exists. Nothing happens between the two but a
    // registry lookup — no database read, no side effect — so a caller that
    // claimed read authority for a propose-capable workflow passes the first
    // check and gains nothing from it.
    if (opts.readOnlyAuthority && def.readOnly !== true) {
        throw forbidden(
            `read_only_authority_requires_a_read_only_workflow: ${workflowKey} does not declare ` +
                'readOnly, so it may be offered the propose surface and starting it needs write ' +
                'authority. A caller cannot ask for less authority than the work requires.',
        );
    }

    // PRE-FLIGHT: the inputs this definition cannot run without (#3600).
    //
    // Here, beside `Unknown workflow` above, because it is the same class of
    // refusal — the request does not make sense against this definition — and
    // because it must cost nothing: a malformed request should not consume the
    // tenant's monthly budget check, a concurrency slot, or a scanner call.
    //
    // It is also ABOVE `createSealedRun` for the reason the budget pre-flight
    // states below: a refusal after the row exists leaves a RUNNING run that
    // nothing will advance. A missing required input used to produce the FAILED
    // variant of the same mistake — a row that burned tokens and died inside a
    // tool validator two steps later. See `WorkflowDefinition.requiredInput`
    // for the 7 production runs that did exactly that.
    assertRequiredInputPresent(def, input);

    // PRE-FLIGHT: the tenant's monthly token budget.
    //
    // Here, and not one line later. Every per-run cap in `run-caps.ts` bounds a
    // SINGLE run and halts it at the boundary; nothing accumulates across runs,
    // so a tenant can stay inside every per-run cap and still spend without
    // limit by starting more of them. This is the only axis that spans runs and
    // it is checked exactly once, at the door.
    //
    // It sits ABOVE `createSealedRun` deliberately: a refusal after the row
    // exists leaves a RUNNING run nothing will ever advance, which the
    // `agentic-run-settlement` sweep would later reap as a crashed executor —
    // a refusal wearing the costume of an outage.
    //
    // No-ops for every tenant that has not configured a budget, which is all of
    // them until somebody sets one: a NULL column short-circuits before the
    // aggregate runs.
    await assertWithinMonthlyBudget(ctx);

    // THE SECOND AXIS: how many runs may execute AT ONCE (#3484).
    //
    // The budget above bounds spend over a MONTH, and ten runs at once cost it
    // the same as ten runs over ten hours — so a tenant well inside its budget
    // could start runs until the BullMQ worker pool was the limit, and that
    // pool is shared across tenants. One tenant's burst was everybody else's
    // queue depth.
    //
    // This is the EARLY, cheap refusal; it is not the exact one. Two requests
    // that both read "2 in flight, cap 3" both pass here. The exact gate is
    // `assertConcurrencyUnderLock`, inside the transaction that inserts the
    // run row, where a per-tenant advisory lock serialises concurrent starts —
    // see that function's header for why a concurrency cap cannot accept the
    // overshoot the monthly budget deliberately tolerates.
    //
    // No-ops for every tenant that has not configured a cap, which is all of
    // them until somebody sets one: a NULL column short-circuits before the
    // count runs.
    const concurrencyCap = (await assertWithinConcurrencyCap(ctx)).cap;

    // PRE-FLIGHT: the run's own input, scanned for prompt injection (#3468).
    //
    // Residual F5 of the Flue integration plan. Point 04 sandwiched every model
    // call — `guardUntrustedInput` on tenant content before prompt assembly,
    // `guardEgress` on model output and on proposed tool args — and the one
    // path it never covered was the input the run is STARTED with, which
    // reaches prompt assembly with nothing between it and the model.
    //
    // ── WHY BOTH ARMS REFUSE HERE, WHERE POINT 04 PARKS ────────────────────
    //
    // Mid-run, `flag` forces AWAITING_APPROVAL: the run exists, so parking it
    // is the natural move and a human decides. At the START there is nothing
    // to park. Creating a RUNNING row for input we have already decided to
    // distrust, purely so it can be parked, would invert this function's own
    // rule — the budget check above says a refusal after the row exists is "a
    // refusal wearing the costume of an outage". So both arms refuse, before
    // the row, and the caller gets a typed `forbidden` naming the rule ids.
    //
    // `assertNoReviewRequired` covers `flag` AND `block` (`reviewRequired` is
    // true for both), which is the same composition `usecases/assistant.ts`
    // applies to a user's question at its own door.
    //
    // ── WHAT THIS DOES NOT PROVE ──────────────────────────────────────────
    //
    // That the scanner catches any particular shape. #3466 measures the
    // injection scanner passing 11 of 13 hostile cases, three of them the
    // corpus's own, and that is the 6d lane's to fix. This is the WIRING: the
    // run's input now reaches the scanner and a non-clean verdict stops the
    // run from being created. A green test here is not evidence the guard is
    // accurate, and the test says so in as many words.
    assertNoReviewRequired(
        await guardUntrustedInput(ctx, scannableInput(input), {
            source: `workflow-run-input:${workflowKey}`,
        }),
    );

    const context: WorkflowContext = { input, outputs: {} };

    // WHICH VERSION of this agent's policy card the run opens under. Resolved
    // BEFORE the row is written, because the pin is write-once at the database
    // and a row inserted without it can only ever be filled in by the one
    // NULL → value transition the trigger still permits — which a later segment
    // would have to remember to make.
    //
    // It is the version at the START. A run re-resolves its invocation after
    // every human checkpoint, so a run spanning a card edit is authorized under
    // the newer card for its later segments, and each call's own audit row
    // carries the version that decided it. This column answers the question
    // those rows cannot once the card has moved on: what did this run open
    // under.
    const policyCardVersion = await resolvePolicyCardPin(ctx.tenantId, ctx.agentId);

    // WHICH ENGINE executes this run. Resolved here, beside the card pin,
    // because both are properties of the run's OPENING — the question is "what
    // did this run start under", and both answers stop being recoverable once
    // the configuration moves on.
    //
    // `DRIVER_IMPLEMENTED.flue` has been TRUE since #2770 flipped it. This
    // comment said it was false — written when it was, and left behind when it
    // stopped being — so a reader checking why every run came out `static` was
    // sent to the wrong term.
    //
    // It then decayed the same way a second time, inside the correction (#3469).
    // It went on to say the answer was `static` because NO registered
    // WorkflowDefinition sets `driver`. Two now do — `access-posture` and
    // `posture-review` both ask for `flue` — so a run on either is no longer
    // static by that term, and a reader checking why one of them came out
    // static would again be sent somewhere that is not the reason.
    //
    // THREE terms decide it, all fail-closed, and the definition's request is
    // only the first: `selectRunDriver` requires the DEFINITION to ask for the
    // engine; `resolveDriverForRun` requires the deployment to permit it (the
    // env switch AND the per-tenant toggle); and the register must vouch for
    // the run below. A `static` outcome means one of the three said no, and
    // which one is the question worth asking — `driverDecision.reason` carries
    // the answer for the deployment half.
    //
    // The decision is resolved and recorded regardless, and that is deliberate
    // — a seam whose first exercise is the diff that also makes it
    // load-bearing has never been observed working. This one is observable
    // from the run's audit entry before it can change any behaviour.
    const driverDecision = await resolveDriverForRun(ctx.tenantId, {
        requestId: ctx.requestId,
        workflowKey,
    });

    // WHAT WILL ACTUALLY WALK IT, which is not the same question.
    //
    // `driverDecision.driver` is what the deployment PERMITS. The definition
    // also gets a say, and `selectRunDriver` resolves any disagreement — and
    // any driver with no implementation — back to static. Recording the
    // permitted value as "which engine walked this run" is therefore a claim
    // about a different thing.
    //
    // That used to be harmless "only because both answers are always `static`".
    // They are not: with `access-posture` and `posture-review` asking for
    // `flue`, permitted and chosen can now differ on a real run, which is
    // precisely when conflating them would misreport which engine did the
    // work. Both are bound separately below and the audit entry takes the
    // CHOSEN one.
    //
    // Resolved here, before the audit write, because the entry is appended
    // before the walk begins and a hash-chained row cannot be corrected
    // afterwards. `selectRunDriver` is pure, so asking it twice — once here,
    // once inside `executeFrom` — costs nothing and cannot disagree.
    // Both bound to locals rather than called inside the audit payload. The
    // values are a closed `'static' | 'flue'` union either way; what changes is
    // that `no-raw-prompt-logging` can READ an identifier and cannot open a
    // call, so spelling the call at the sink buys four un-analysable holes in a
    // guard whose whole design is that its blind spots are counted.
    const requested: AgentDriver = requestedDriver(def);
    const chosenDriver: AgentDriver = selectRunDriver(def, driverDecision.driver).driver;

    // ── A FLUE RUN MUST BE VOUCHED FOR BY THE REGISTER ──────────────────────
    //
    // Plan point 1: "A Flue run must resolve an ACTIVE RegisteredAgent and
    // stamp WorkflowRun.agentId." The stamp was here; the resolve was not, and
    // nothing else on this path supplied it — the route calls getTenantCtx and
    // then this function, and `planFlueRun` refuses only on driver, steps and
    // model. So a key bound to a SUSPENDED or RETIRED agent, or a signed-in
    // human with no binding at all, could start a reasoning loop.
    //
    // The human case is the worse one: with `ctx.agentId` null,
    // `buildMcpInvocation` leaves `grantedTools` null, which is NO ALLOWLIST
    // TERM — the deny-by-default tool list is keyed on the registered agent,
    // so an unbound caller skips it rather than being narrowed by it.
    //
    // UNCONDITIONAL, and deliberately stricter than `assertRegisteredAgent`.
    // That helper honours the tenant's `requireRegisteredAgent` toggle, which
    // is right for an MCP call: an unbound caller there still carries the
    // key's own scopes. A Flue run is an autonomous loop that chooses its own
    // tool calls, so "this tenant has not switched enforcement on" is not a
    // reason to let one start unvouched. `standing === 'vouched'` means
    // resolved AND ACTIVE; every other standing refuses here.
    //
    // ABOVE `createSealedRun`, for the reason the budget check above it is:
    // a refusal after the row exists leaves a RUNNING run nothing will
    // advance, which the reaper later reports as a crashed executor — a
    // refusal wearing the costume of an outage.
    if (isReasoningEngine(chosenDriver)) {
        const gate = await evaluateAgentRegistration(ctx);
        if (gate.standing !== 'vouched') {
            throw forbidden(
                `flue_requires_registered_agent: a Flue run must be started by an ACTIVE ` +
                    `registered agent (standing: ${gate.standing}). The reasoning loop's tool ` +
                    `allowlist is keyed on the register, so an unvouched run would have none.`,
            );
        }
    }

    // ── WHAT THIS RUN WILL BE TAUGHT, PINNED BEFORE ITS ROW EXISTS (#3666) ──
    //
    // A Flue run mounts the skills its definition declares; a static run mounts
    // none, and records the empty list rather than NULL, because "mounted
    // nothing" and "predates the pin" are different facts. Resolving here also
    // applies the mount gate and the text scan: a skill that has no passing
    // evaluation record, or that the scan refused, stops the run BEFORE its row
    // is written — the reason the registration check above sits here too.
    //
    // A Flue run in this tenant also mounts the tenant's OWN approved skills
    // that name this workflow (#3680), through the same gate, and pins them
    // beside the repository's, marked `origin: 'tenant'`.
    const mountedSkills = isReasoningEngine(chosenDriver) ? await pinSkillsOrRefuse(ctx, def) : [];

    // Row + first chain link (seq 0, prev null), one transaction. An `input`
    // already over the size cap fails here and no run is created.
    //
    // The pins are passed IN rather than resolved inside: `createSealedRun` owns
    // the seal, not the authority question, and both pins have to be resolved
    // before the row exists because they are write-once at the database.
    const run = await createSealedRun(
        ctx, workflowKey, context, policyCardVersion, chosenDriver, concurrencyCap,
        opts.parentExecutionId ?? null, mountedSkills,
    );

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: run.id,
        action: 'WORKFLOW_RUN_STARTED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            workflowKey,
            agentId: ctx.agentId ?? null,
            // The pin, in the trail as well as on the row. The row can be
            // deleted with its tenant; the hash-chained entry is what survives.
            policyCardVersion,
            // …and WHAT IT WAS TAUGHT, as a digest over the row's pin rather
            // than the pin itself. The trail then binds the write-once column:
            // an auditor recomputes SHA-256 over the canonical JSON of
            // `mountedSkills` and compares. A digest also keeps the payload a
            // shape `no-raw-prompt-logging` can read; the list, as an
            // identifier, is a field bag it cannot.
            mountedSkillCount: mountedSkills.length,
            mountedSkillsDigest: createHash('sha256').update(canonicalJson(mountedSkills.map(pinForRow))).digest('hex'),
            // Which engine walked this run, and — when it was not the one
            // configured — why not. In the hash-chained trail rather than only
            // in a log line, because "which engine executed this" is a question
            // an incident review asks about a run that has long since finished,
            // and log retention is not the audit trail's retention.
            // THREE facts, because a single one cannot explain an engine
            // choice, and the gaps between them are what an incident review is
            // actually asking about:
            //
            //   driverRequested — what the DEFINITION asked for
            //   driverAllowed   — what the DEPLOYMENT permits (env ∧ tenant ∧
            //                     implemented), with `driverReason` naming why
            //                     when it is not what was configured
            //   driver          — what actually WALKED the run
            //
            // A definition cannot widen its own authority, so `driver` is the
            // intersection and never more than either. Recording only the
            // permitted value — which is what this entry used to do — answers
            // "what was this tenant allowed" under a key that says "which
            // engine walked this run", and those diverge the moment a
            // definition asks for something it cannot have.
            driverRequested: requested,
            driverAllowed: driverDecision.driver,
            driverReason: driverDecision.reason,
            driver: chosenDriver,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);

    // ── WHERE THE RUN ACTUALLY EXECUTES ─────────────────────────────────────
    //
    // Flue runs go to the WORKER; static runs stay in the request.
    //
    // Not symmetry for its own sake. A static run is a walk over a
    // hand-written step array with no model call in it — bounded by
    // `ENGINE_CAPS.MAX_STEPS`, deterministic, and finished well inside a
    // request. A Flue run is a reasoning loop: it decides for itself how many
    // tools to call and how long to keep going, and the plan is explicit that
    // it belongs in the worker, "never the web tier". The worker also already
    // has the shutdown drain, which is what makes a SIGTERM mid-run survivable.
    //
    // Moving BOTH would change the contract of every existing run — the route
    // returns a terminal status today — for no benefit the static engine needs.
    if (isReasoningEngine(chosenDriver)) {
        await enqueue('agent-run-execute', { tenantId: ctx.tenantId, runId: run.id });
        // RUNNING is what `createSealedRun` wrote (the column's default), and
        // it is reported rather than a synthesised QUEUED. The reaper already
        // understands a RUNNING row that stops moving; a new enum value would
        // have to be learned by every reader — list page, reaper, breaker —
        // to mean something the existing one already covers.
        return { runId: run.id, status: 'RUNNING', workflowKey, stepFailures: 0 };
    }

    const { status, stepFailures } = await executeFrom(
        ctx,
        run.id,
        def,
        0,
        Date.now(),
        driverDecision.driver,
    );
    return { runId: run.id, status, workflowKey, stepFailures };
}

/**
 * Resume a paused (AWAITING_APPROVAL / PAUSED) run after a human has acted on
 * its checkpoint. A privileged human action. Marks the pending checkpoint DONE
 * and continues from the next step.
 */
export async function resumeWorkflowRun(
    ctx: RequestContext,
    runId: string,
): Promise<{ status: string; stepFailures: number }> {
    assertCanWrite(ctx);
    const { run, def } = await loadRunAndDef(ctx, runId);
    if (run.status !== 'AWAITING_APPROVAL' && run.status !== 'PAUSED') {
        throw badRequest(`Run is ${run.status}, cannot resume`);
    }

    // ── THE HUMAN'S WINDOW, CHECKED BEFORE ANYTHING IS DISPATCHED ──────────
    //
    // A checkpoint pins `approvalExpiresAt` when the run parks, from that
    // step's mandatory `approvalWindow`. Past it the decision was not taken in
    // time, and resuming would execute steps a human was supposed to gate on
    // the strength of an approval given outside the window it was given in.
    //
    // REFUSED AT THE DOOR rather than left to the engine, and that is the
    // whole point of the window existing. Before it, the only thing bounding
    // the wait was `WALL_CLOCK_MS` — sixty minutes meant for unattended
    // execution — so a late approval produced a run that dispatched, charged
    // its budget and halted mid-flight with a RUNTIME_MS message naming a cap
    // the reviewer had never heard of. This names what actually happened.
    if (isApprovalExpired(run.approvalExpiresAt, new Date())) {
        throw badRequest(
            `approval_window_closed: this run's approval window closed at `
            + `${run.approvalExpiresAt?.toISOString()}. Start the workflow again — `
            + `a decision taken after the window is not the decision it parked for.`,
        );
    }

    // ── RESOLVED FIRST, BECAUSE THE GATE BELOW NEEDS IT ────────────────────
    //
    // RE-RESOLVED, not inherited from the start. A resume is a fresh
    // authorization moment — the same reason the run re-resolves its
    // invocation and its policy card — and an operator who switched the tenant
    // off a driver between the checkpoint and the approval meant it.
    //
    // Before this, `executeFrom` was called without the argument at all, so a
    // resumed segment took the parameter's `STATIC_DRIVER` default whatever the
    // tenant was configured for, and no audit entry said so either way.
    //
    // HOISTED above the checkpoint close so the register gate can run before
    // anything is mutated: a refusal after the step is DONE and the row is
    // RUNNING leaves a run nothing will advance, which the reaper later reports
    // as a crashed executor — a refusal wearing the costume of an outage. The
    // start path makes the same argument for putting its gate above
    // `createSealedRun`.
    const resumeDecision = await resolveDriverForRun(ctx.tenantId, {
        requestId: ctx.requestId,
        workflowKey: run.workflowKey,
    });
    const resumeRequested: AgentDriver = requestedDriver(def);
    const resumeDriver: AgentDriver = selectRunDriver(def, resumeDecision.driver).driver;

    // ── THE SECOND DOOR INTO THE FLUE ENGINE ───────────────────────────────
    //
    // The start path refuses a Flue run that no ACTIVE `RegisteredAgent`
    // vouches for, and the worker's resume re-checks the agent and rebuilds
    // the run's principal. THIS path did neither. It re-resolved the driver
    // and went straight to `executeFrom` with a signed-in human's context, in
    // which `ctx.agentId` is undefined — `getTenantCtx` sets no `agentId`.
    //
    // What that unbound context does downstream is the whole of the register's
    // authority, silently dropped:
    //
    //   · `grantedTools` resolves null, and `toolIsLoadable` SKIPS the
    //     allowlist term when it is null rather than narrowing by it — the
    //     deny-by-default tool list is keyed on the registered agent;
    //   · both agent-side autonomy terms vanish, so the ceiling is computed
    //     over an empty set and comes back UNCLAMPED — the exact hazard
    //     #2399 closed, where suspending a CRITICAL agent PROMOTED it;
    //   · `settleAtGuard` latches the circuit breaker only when `ctx.agentId`
    //     is set, so a guard block on a resumed segment is never counted;
    //   · the Art 12 row names no AI system.
    //
    // And this is not a rare path — it is the one the guard arms BUILT. A
    // FLAGGED verdict settles the run `AWAITING_APPROVAL` precisely so a human
    // comes here and approves it. Flag, approve, and the continuation ran
    // unvouched, unclamped and unallowlisted.
    //
    // The fix is the worker's, not a new one: re-check the agent is still in
    // service, and restore the binding the run was started under.
    if (isReasoningEngine(resumeDriver) && !(await runAgentStillInService(ctx.tenantId, run.agentId))) {
        throw forbidden(
            'resume_agent_no_longer_in_service: the registered agent this run was started ' +
                'by is no longer ACTIVE, so the run does not resume on its behalf. ' +
                'Re-activate the agent, or abort the run.',
        );
    }

    // THE RUN'S BINDING, not the approver's. The human stays the ACTOR — the
    // audit entry below records them and the checkpoint step takes their
    // `userId` — while the execution carries the agent the run was authorised
    // under, so every register term applies to the continuation exactly as it
    // applied to the first segment. Same shape as `rebuildRunContext`'s
    // `...(row.agentId ? { agentId: row.agentId } : {})` on the worker path.
    const execCtx: RequestContext = run.agentId ? { ...ctx, agentId: run.agentId } : ctx;

    // Close the pending checkpoint step (the one that paused the run).
    const resumedFrom = await runInTenantContext(ctx, async (db) => {
        const pending = await db.workflowStep.findFirst({
            where: { runId, tenantId: ctx.tenantId, status: 'PENDING' },
            orderBy: { seq: 'desc' },
        });
        if (pending) {
            await db.workflowStep.update({
                where: { id: pending.id },
                data: { status: 'DONE', actorUserId: ctx.userId },
            });
        }
        await db.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
        // ═══ ART 14: A RESUME IS AN ACCEPTANCE ═══
        //
        // The run is the reviewable event for a model call. A Flue run that the
        // content guard FLAGGED parks at AWAITING_APPROVAL precisely so a human
        // decides whether it may go on, and `resumeWorkflowRun` is that
        // decision — so every decision row the run has written so far is
        // ACCEPTED, keyed on the run id the recorder put in `sessionRef`.
        //
        // NOT the proposal digest, which is what the three existing stampers
        // use: that digest is taken over `{ kind, payload, rationale }` and the
        // model-call row's is taken over the run PROMPT. Same shape, different
        // content, never equal — so a digest-keyed stamp here would report
        // `count: 0` and leave the loop looking closed. See
        // `flue/model-decision.ts` for the full argument.
        //
        // In the SAME transaction as the checkpoint close, for the reason
        // `rejectAgentProposal` gives: a human decision recorded on the run but
        // not on the decision log is a register that says a model call is still
        // awaiting a review that has already happened.
        //
        // A static run matches nothing here and that costs one indexed
        // `updateMany` — the engine that writes no decision rows has none to
        // stamp, and branching on the driver would put the engine's identity in
        // a place that does not otherwise need to know it.
        await recordDecisionOutcome(db, ctx, runId, 'ACCEPTED');
        return pending?.seq ?? run.stepCount - 1;
    });

    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_RESUMED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            // Which engine walks THIS SEGMENT. `WorkflowRun.driver` records the
            // one the run opened under and deliberately does not move, so the
            // trail is the only place a mid-run change is visible.
            driverRequested: resumeRequested,
            driverAllowed: resumeDecision.driver,
            driverReason: resumeDecision.reason,
            driver: resumeDriver,
        },
    }).catch(() => undefined);

    // THE RUN'S OWN START, not this resume's. `Date.now()` here handed every
    // resumed run a fresh wall clock, so the hour-long `RUNTIME_MS` cap bounded
    // a SEGMENT and not a run — and a workflow with two checkpoints could span
    // three hours while every segment reported itself well inside the ceiling.
    // The same defect `actionsAlready` already fixed for the action budget, on
    // the one axis where the wrong answer looks most like the right one,
    // because a paused run genuinely is not spending anything.
    //
    // A run that sat at a checkpoint for a day has spent a day, and that is the
    // intended reading: `WALL_CLOCK_MS` is documented as "max wall-clock a run
    // may span (ACROSS RESUMES)".
    // ── THE SECOND DOOR INTO THE ENGINE, AND IT WENT TO THE WEB TIER ────────
    //
    // `startWorkflowRun` enqueues a Flue run and says why: a reasoning loop
    // "belongs in the worker, 'never the web tier'", and the worker is where
    // the shutdown drain lives, which is what makes a SIGTERM mid-run
    // survivable. This path branched on the driver for the register gate above
    // and then called `executeFrom` inline regardless — so an approval ran the
    // whole model loop inside a Next.js POST handler, bounded only by
    // `WALL_CLOCK_MS`, with no drain behind it.
    //
    // The resume door is not the lesser one. A guard FLAG parks a Flue run at
    // AWAITING_APPROVAL precisely so a human decides whether it continues, so
    // this is the designed way a flagged run resumes reasoning.
    //
    // The static engine stays inline, for the reason the start path gives: a
    // walk over a hand-written step array with no model call in it is bounded,
    // deterministic and finished well inside a request, and moving it would
    // change the contract of every existing run for no benefit.
    if (isReasoningEngine(resumeDriver)) {
        // THE RESUME POINT, MADE DURABLE FIRST. The worker resumes from
        // `row.stepCount`; this path had computed `resumedFrom + 1` and passed
        // it as an argument, which does not survive the hop. Writing it is what
        // makes the two the same number — without it a run that paused at a
        // checkpoint would resume wherever the engine last persisted, which is
        // not where this transaction just decided it should.
        await runInTenantContext(ctx, (db) =>
            db.workflowRun.update({
                where: { id: runId },
                data: { stepCount: resumedFrom + 1 },
            }),
        );
        await enqueue('agent-run-execute', { tenantId: ctx.tenantId, runId });
        // RUNNING, matching what `startWorkflowRun` returns for the same
        // engine. The transaction above already wrote it; this reports it
        // rather than synthesising a QUEUED the reaper and the list page would
        // both have to learn.
        return { status: 'RUNNING', stepFailures: 0 };
    }

    const { status, stepFailures } = await executeFrom(
        // BOUND, not the bare human context — see the register gate above.
        execCtx,
        runId,
        def,
        resumedFrom + 1,
        // THE ENGINE CLOCK RE-BASES ON RESUME, and only now is that safe.
        //
        // `RUNTIME_MS` is the one cap whose `used` is READ from the clock
        // rather than accumulated, so handing it the run's ORIGINAL start
        // charged the run for every minute a human spent deciding. A
        // five-day approval window is inert against a sixty-minute ceiling
        // measured from a start five days ago: the resume would halt before
        // executing a step.
        //
        // The objection this used to answer — "a workflow with two
        // checkpoints could span three hours with every segment reporting
        // itself well inside an hour" — was correct while NOTHING ELSE
        // bounded the run's calendar life. Something does now, explicitly
        // and per step: `approvalExpiresAt`, refused above. The two caps
        // divide the question they used to share — this one bounds a stretch
        // of UNATTENDED EXECUTION, that one bounds HUMAN DELIBERATION — and
        // the axes that bound total WORK (STEPS, TOKENS, PROPOSALS) still
        // accumulate across resumes untouched, so a resumed run buys itself
        // wall clock and never more work.
        //
        // NOT applied to `executeQueuedWorkflowRun`: that path is a SIGTERM
        // retry of a RUNNING row, where nobody is deliberating and the same
        // unattended work is resuming. Re-basing there would let a wedged run
        // buy a fresh hour on every retry.
        Date.now(),
        resumeDecision.driver,
    );
    return { status, stepFailures };
}

/** Abort a run (operator kill-switch). No mutation is left half-applied — writes
 *  are proposals, so aborting simply stops the run. */
export async function abortWorkflowRun(ctx: RequestContext, runId: string): Promise<void> {
    assertCanWrite(ctx);
    const run = await getRunRow(ctx, runId);
    if (['COMPLETED', 'ABORTED', 'FAILED'].includes(run.status)) {
        throw badRequest(`Run is already ${run.status}`);
    }
    await runInTenantContext(ctx, async (db) => {
        await db.workflowRun.update({
            where: { id: runId },
            data: { status: 'ABORTED', completedAt: new Date() },
        });
        // ═══ ART 14: AN ABORT IS A REJECTION ═══
        //
        // The other half of the resume above, and the same key. A human
        // stopping a run refuses what it decided, so its model-call decision
        // rows move PENDING → REJECTED rather than sitting at "awaiting review"
        // for ever after the review that killed the run.
        //
        // One-way, so a run aborted after a resume keeps the ACCEPTED the
        // resume wrote: `recordDecisionOutcome` filters `humanOutcome:
        // 'PENDING'` and the DB trigger enforces the same. That is the right
        // reading — the human accepted what the run had done at the checkpoint,
        // and then refused what it did next.
        await recordDecisionOutcome(db, ctx, runId, 'REJECTED');
    });
    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_ABORTED',
        requestId: ctx.requestId, detailsJson: { category: 'access' },
    }).catch(() => undefined);
}

export async function getWorkflowRun(ctx: RequestContext, runId: string) {
    assertCanRead(ctx);
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: {
                steps: { orderBy: { seq: 'asc' } },
                // WHAT THIS RUN PROPOSED, by step.
                //
                // An explicit SELECT, never the whole row. This usecase is
                // returned VERBATIM by `GET /agent-runs/:id`, so widening the
                // include widens what that route emits — and an `AgentProposal`
                // carries `payloadJson`, the one column the proposals surface
                // deliberately refuses to send to a browser. Naming the fields
                // keeps a convenience here from becoming a leak there.
                //
                // Ordered by `stepSeq` so the grouping a caller does is over a
                // sorted list; `null` sorts first, which is correct for a
                // proposal that names no step.
                proposals: {
                    select: {
                        id: true,
                        kind: true,
                        operation: true,
                        status: true,
                        stepSeq: true,
                        guardVerdict: true,
                        createdAt: true,
                    },
                    orderBy: { stepSeq: 'asc' },
                },
            },
        }),
    );
    if (!run) throw notFound('Workflow run not found');
    return run;
}

export async function listWorkflowRuns(
    ctx: RequestContext,
    opts: {
        status?: string;
        take?: number;
        /**
         * #3472 — narrow to ONE registered agent's runs.
         *
         * `WorkflowRun.agentId` is written at create time and is NULL for a
         * human-started run, so this filter means "the runs this agent
         * authorised" and deliberately cannot match the human ones. That is
         * the question the agent detail page asks: the register should reach
         * the work it admitted, and a list that mixed in runs a person started
         * would be answering a different one.
         */
        agentId?: string;
    } = {},
) {
    assertCanRead(ctx);
    // `opts.status` is a raw `?status=` query-string value — the `as never`
    // this replaces silenced the compiler but not Prisma, which 500'd on a
    // comma-joined multi-select or a status from another entity's enum.
    const status = parseEnumListFilter<WorkflowRunStatus>(
        opts.status,
        Object.values(WorkflowRunStatus),
        'workflow run status',
    );
    return runInTenantContext(ctx, (db) =>
        db.workflowRun.findMany({
            where: {
                tenantId: ctx.tenantId,
                status,
                // Omitted rather than `agentId: undefined` when absent —
                // which Prisma treats the same way, and which a reader has to
                // know to be sure. Spread so the shape says it.
                ...(opts.agentId ? { agentId: opts.agentId } : {}),
            },
            orderBy: { startedAt: 'desc' },
            take: opts.take ?? 50,
            // HOW MANY PROPOSALS ARE ACTUALLY WAITING on this run.
            //
            // A filtered relation count rather than a join, because the list
            // needs the NUMBER and never the rows. It exists because
            // `AWAITING_APPROVAL` does not mean "there are proposals to
            // approve": a HUMAN_CHECKPOINT pauses a run whether or not it
            // queued anything, and a content-guard flag pauses one that
            // queued nothing at all. Without this the list can only guess,
            // and it guessed wrong in one direction for every such run.
            include: {
                _count: { select: { proposals: { where: { status: 'PENDING' } } } },
            },
        }),
    );
}

// ─── The executor ───────────────────────────────────────────────────


/**
 * Execute a run, and tell this process it is doing so.
 *
 * The tracking lives HERE rather than at the two call sites (`startWorkflowRun`
 * and `resumeWorkflowRun`) so a third caller cannot be added without it. What
 * it buys is at `src/lib/agentic/in-flight-runs.ts`: on SIGTERM the shutdown
 * handler moves exactly these runs to PAUSED, so a rolling deploy leaves them
 * resumable instead of abandoned RUNNING for `agent-run-reaper` to settle to
 * FAILED a wall-clock budget plus ten minutes later.
 *
 * `finally`, not `then` — a run that threw is no longer executing, and leaving
 * it tracked would have the drain pause a row that has already settled.
 */
/**
 * Which third-party principal a run's columns say started it — the whole of the
 * decision, with no database in it.
 *
 * Separated from the read so it can be tested directly, because the thing that
 * matters is not reachable from the start of a run: `withInboundOrigin` rebuilds
 * this flag on EVERY later segment — a person's resume and a queued Flue segment
 * alike — and the two narrowings keyed on it (the `PROPOSE_ONLY` clamp, R17, and
 * the refusal of an outbound send, R14) are lost on that segment if this returns
 * undefined. A run that starts clamped and resumes able to write is the failure,
 * and it is invisible to a test that only checks the start.
 *
 * Either pair, never both: a CHECK holds that at the database, and each pair is
 * all-or-nothing there too, because a HALF-written origin would restore nothing
 * at all. Peer is tried first only because it is the older arm — the two are not
 * ordered by precedence and cannot both be present.
 */
export function inboundOriginFromRow(
    row:
        | {
              readonly inboundPeerId: string | null;
              readonly inboundMessageId: string | null;
              readonly inboundHostConsumerId: string | null;
              readonly inboundHostMessageId: string | null;
          }
        | null
        | undefined,
): A2aInboundOrigin | undefined {
    if (!row) return undefined;
    if (row.inboundPeerId && row.inboundMessageId) {
        return { kind: 'PEER', peerId: row.inboundPeerId, messageId: row.inboundMessageId };
    }
    if (row.inboundHostConsumerId && row.inboundHostMessageId) {
        return {
            kind: 'HOST_CONSUMER',
            hostConsumerId: row.inboundHostConsumerId,
            messageId: row.inboundHostMessageId,
        };
    }
    return undefined;
}

async function withInboundOrigin(ctx: RequestContext, runId: string): Promise<RequestContext> {
    const row = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            select: {
                inboundPeerId: true,
                inboundMessageId: true,
                inboundHostConsumerId: true,
                inboundHostMessageId: true,
            },
        }),
    );
    const a2aInbound = inboundOriginFromRow(row) ?? ctx.a2aInbound;
    return a2aInbound ? { ...ctx, a2aInbound } : ctx;
}

async function executeFrom(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    // NO DEFAULT, deliberately. It was `= STATIC_DRIVER`, and a default is
    // exactly how the resolved decision came to be computed, audited, and then
    // dropped on the floor: both call sites simply omitted the argument and
    // the fallback made that look intentional. Required, the compiler asks
    // every caller the question rather than answering it for them.
    permittedDriver: AgentDriver,
): Promise<RunDriverOutcome> {
    // WHICH ENGINE, resolved here rather than inside the walk. The definition's
    // request is intersected with what the deployment permits, and any
    // disagreement resolves to static — see `selectRunDriver`.
    // ONE call, both facts. It was two — one for `run` and one for the label —
    // which this file's own comment at the resolution site argues against:
    // `selectRunDriver` is pure, so asking twice cannot disagree, but a reader
    // has to prove that to themselves and the second call is free to drift
    // onto a different argument. It also made
    // `assertion-needle-uniqueness-ratchet` red, correctly: a second
    // occurrence turns any whole-file `toMatch(/selectRunDriver/)` into a
    // needle that two positions satisfy.
    const { run, driver } = selectRunDriver(def, permittedDriver);
    const driverLabel = driver === 'flue' ? 'FLUE' : 'STATIC';

    // ── A RUN AN A2A PEER STARTED CARRIES THAT ON EVERY SEGMENT (#3679) ──────
    //
    // Restored HERE, from the run's own write-once columns, because this is the
    // one seam a start, a human's resume and a queued Flue segment all pass
    // through. A resume runs on the RESUMING person's context, and a context
    // that forgot where the run came from would lift R17 (no external write
    // above PROPOSE_ONLY) and R14 (no outbound A2A send) for every step after
    // the checkpoint. It only ever narrows: an origin already on the context is
    // kept if the row somehow carried none.
    const runCtx = await withInboundOrigin(ctx, runId);

    // THE ONE SEAM BOTH ENGINES PASS THROUGH (#3484). The static driver and
    // Flue each settle their own runs — four `status: 'COMPLETED'` sites
    // between them, plus the halt paths — so instrumenting the drivers would
    // mean the same counter at six call sites, and the seventh would be the
    // one somebody forgot. This function already brackets the walk for the
    // in-flight registry, which is exactly the lifecycle the counters measure.
    recordAgentRunStarted({ driver: driverLabel });

    trackInFlightRun(runId);
    try {
        const outcome = await run(runCtx, runId, def, fromSeq, runStartMs);
        await recordRunSettlementMetrics(runCtx, runId, driverLabel, outcome.status);
        // A COMPLETED discovered-agent review's owner suggestion is parsed and
        // stored here (#3728), at the same one seam for the same reason: both
        // engines settle their own runs, and only this function sees every
        // settlement. A no-op for every other workflow; never throws.
        await captureReviewAttributionAfterRun(runCtx, runId, def.key, outcome.status);
        // …and a COMPLETED audit narrative run's narratives (#3749), held to
        // their workpapers first. The same seam, the same never-throws rule.
        await captureAuditNarrativeAfterRun(runCtx, runId, def.key, outcome.status);
        return outcome;
    } catch (err) {
        // A THROW IS A FAILED RUN for metric purposes, and it has to be
        // counted here: the settlement path that writes FAILED is reached by
        // `failRun` from the CALLER, so a throw that propagated past this
        // function would otherwise count a start with no settlement — and a
        // started-minus-settled gap is the first thing an operator reads as a
        // leak.
        recordAgentRunSettled({ driver: driverLabel, outcome: 'failed' });
        throw err;
    } finally {
        untrackInFlightRun(runId);
    }
}

/**
 * Record the step and token histograms for a run that reached a terminal
 * status, and nothing for one that merely paused.
 *
 * ONE QUERY, at run end. `RunDriverOutcome` carries `stepFailures` and not the
 * step count or the token total, so the figures come from the row — and a run
 * end is the right place to pay for a read, unlike the per-step path.
 *
 * NEVER THROWS. A metric is not worth failing a settled run over: the run has
 * already completed and the caller is about to return it.
 */
async function recordRunSettlementMetrics(
    ctx: RequestContext,
    runId: string,
    driver: string,
    status: string,
): Promise<void> {
    const outcome =
        status === 'COMPLETED' ? 'completed'
        : status === 'FAILED' ? 'failed'
        : status === 'ABORTED' ? 'aborted'
        : null;
    // AWAITING_APPROVAL and PAUSED are not settlements. Counting them would
    // make "settled" mean "stopped for now", and the started-minus-settled gap
    // — the figure that says how many runs are outstanding — would read zero
    // while a queue of them waited on people.
    if (outcome === null) return;
    try {
        const row = await runInTenantContext(ctx, (db) =>
            db.workflowRun.findFirst({
                where: { id: runId, tenantId: ctx.tenantId },
                select: { stepCount: true, costTokens: true },
            }),
        );
        recordAgentRunSettled({
            driver,
            outcome,
            steps: row?.stepCount ?? null,
            tokens: row?.costTokens ?? null,
        });
    } catch {
        // The read failed. Count the settlement anyway — the outcome is the
        // figure that matters, and dropping it to protect two histograms would
        // leave the counter wrong in the direction that looks like a leak.
        recordAgentRunSettled({ driver, outcome });
    }
}


// ─── Helpers ────────────────────────────────────────────────────────











/**
 * Create the run row and seal its FIRST chain link (seq 0, prev null) in ONE
 * transaction.
 *
 * Two statements rather than one because the link binds the run id and the id
 * does not exist until the row does. Both in the same transaction so a row can
 * never be committed with a context and no head — that state would read as
 * `CONTEXT_UNSEALED` and halt a run that had done nothing wrong.
 *
 * A caller's `input` that is already over the cap therefore fails HERE and the
 * run is never created: the transaction rolls back and the caller gets a 400
 * naming the cap. That is the same halt-and-report the executor does mid-run,
 * moved to the only place a start can report it — there is no run yet to mark
 * FAILED.
 */
/**
 * The skills a Flue run mounts, as pins — its definition's repository skills
 * and this tenant's approved skills on the workflow (#3680) — or a named 400
 * when any of them cannot be mounted (unknown, refused by the text scan,
 * without a passing evaluation record, or, for a tenant skill, not approved or
 * no longer matching its approved hash). The skill loader's own error names the
 * skill and the reason, never the skill's text.
 */
async function pinSkillsOrRefuse(ctx: RequestContext, def: WorkflowDefinition): Promise<MountedSkillPin[]> {
    try {
        return (await resolveRunSkillMount(ctx, def, 'admission')).pins;
    } catch (err) {
        if (err instanceof SkillLoadError) throw badRequest(`skill_not_mountable: ${err.message}`);
        throw err;
    }
}

async function createSealedRun(
    ctx: RequestContext,
    workflowKey: string,
    context: WorkflowContext,
    policyCardVersion: number,
    driver: AgentDriver,
    /**
     * The tenant's concurrent-run cap, already read by the early check at the
     * top of `startWorkflowRun`. Passed in rather than re-read: the value
     * cannot have changed in the microseconds between, and a second settings
     * query on the hot path buys nothing. `null` means no cap and the exact
     * check below returns immediately.
     */
    concurrencyCap: number | null,
    /**
     * WHAT CAUSED THIS RUN (#3537), or null when nothing did.
     *
     * Written in the CREATE rather than updated afterwards, for the reason the
     * two columns beside it give: a run that crashes mid-step still has to be
     * able to say what caused it, and an UPDATE after the walk is a write that
     * a crash skips.
     */
    parentExecutionId: string | null,
    /**
     * WHAT THE RUN WILL BE TAUGHT (#3666): each mounted skill's name, version
     * and content hash. Written in the CREATE because the column is write-once
     * at the database from the moment the row exists.
     */
    mountedSkills: readonly MountedSkillPin[],
): Promise<{ id: string }> {
    try {
        return await runInTenantContext(ctx, async (db) => {
            // THE EXACT CONCURRENCY GATE, inside this transaction and BEFORE
            // the insert (#3484). A refusal therefore rolls back and leaves no
            // row — which is the same rule this function's own header states
            // about the budget: a refusal after the row exists leaves a
            // RUNNING run nothing will ever advance, and the settlement sweep
            // later reaps it as a crashed executor.
            await assertConcurrencyUnderLock(db, ctx, concurrencyCap);
            const created = await db.workflowRun.create({
                data: {
                    tenantId: ctx.tenantId,
                    workflowKey,
                    status: 'RUNNING',
                    startedByUserId: ctx.userId,
                    triggeredViaKeyId: ctx.apiKeyId ?? null,
                    // WHICH registered agent this run belongs to. `null` for a
                    // human-started run — a person is not an agent, and inventing
                    // one to satisfy the column would put a fiction in the
                    // register's own attribution. Written explicitly either way;
                    // `local/require-agent-attribution` refuses a write site that
                    // leaves the field out.
                    agentId: ctx.agentId ?? null,
                    // …and under WHICH VERSION of that agent's declared policy.
                    // `NO_POLICY_CARD` (0) for a human-started run — the question
                    // was asked and the answer was "none", which is a different
                    // fact from the NULL a pre-pinning row carries. Written in
                    // the CREATE, not the seal update below: the pin is
                    // write-once at the database, so the row must arrive
                    // carrying it.
                    policyCardVersion,
                // CAUSE, beside the authority. `startedByUserId` above is the
                // rule OWNER on an automation-started run, which is correct
                // attribution and not causation — see the column's docstring.
                parentExecutionId,
                    // …and on WHICH ENGINE. Written in the CREATE rather than
                    // updated after the walk: a run that crashes mid-step still
                    // has to be able to say what was executing it.
                    driver: driver === 'flue' ? 'FLUE' : 'STATIC',
                    // …and, for a run an A2A peer's task started, WHICH peer
                    // and WHICH verified message (#3679). Write-once at the
                    // database; R17 and R14 are keyed on it.
                    // …and, for a run a third party's request started, WHICH
                    // principal and WHICH record (#3679 for a peer, #3861 for a
                    // host consumer). Write-once at the database; R17 and R14
                    // are keyed on these columns, and `withInboundOrigin` reads
                    // them back on every later segment — which is why a host
                    // consumer has its OWN pair rather than borrowing
                    // `inboundPeerId`.
                    inboundPeerId: ctx.a2aInbound?.kind === 'PEER' ? ctx.a2aInbound.peerId : null,
                    // Guarded on `kind` too, not just taken from the union: a
                    // bare `?.messageId` would write the host consumer's id
                    // into the PEER column as well, and `WorkflowRun_one_inbound_origin`
                    // refuses a row with both pairs set — so every
                    // host-consumer run would have failed at insert.
                    inboundMessageId: ctx.a2aInbound?.kind === 'PEER' ? ctx.a2aInbound.messageId : null,
                    inboundHostConsumerId:
                        ctx.a2aInbound?.kind === 'HOST_CONSUMER' ? ctx.a2aInbound.hostConsumerId : null,
                    inboundHostMessageId:
                        ctx.a2aInbound?.kind === 'HOST_CONSUMER' ? ctx.a2aInbound.messageId : null,
                    // …and what it was TAUGHT. `[]` for a run that mounts no
                    // skill, never NULL: NULL means the row predates the pin.
                    mountedSkills: mountedSkills.map(pinForRow),
                },
                select: { id: true },
            });
            const sealed = sealContext({
                tenantId: ctx.tenantId,
                runId: created.id,
                seq: 0,
                previousHash: null,
                context,
            });
            await db.workflowRun.update({
                where: { id: created.id },
                data: { contextJson: sealed.json, contextHash: sealed.hash },
            });
            recordWorkflowContextBytes(sealed.bytes);
            return created;
        });
    } catch (err) {
        if (err instanceof ContextIntegrityError) {
            recordWorkflowContextIntegrityHalt({ code: err.code });
            throw badRequest(describeContextHalt(err));
        }
        throw err;
    }
}





/**
 * What the worker did with a queued run.
 *
 * A union rather than an optional field: "it executed and here is the status"
 * and "it correctly declined, for this reason" are different outcomes, and a
 * caller that has to check whether `status` happens to be set will eventually
 * forget to.
 */
export type QueuedRunOutcome =
    | { status: string; stepFailures: number }
    | { skipped: string };

/**
 * EXECUTE A RUN THAT WAS ENQUEUED — the worker's entry point.
 *
 * ── WHY THE PRINCIPAL IS REBUILT, NOT SUBSTITUTED ───────────────────────────
 *
 * The obvious shape, and the one several jobs in this repo already use, is
 * `buildCtx(tenantId)` — find the first active OWNER/ADMIN and run as them.
 * That is right for a sweep that belongs to the platform. It is wrong here,
 * and not by a little: a run's authority is the intersection of the agent's
 * registration, the key's scopes, the autonomy ceiling and the policy card of
 * the principal who STARTED it. Executing it as an admin would hand the run a
 * different — almost certainly wider — authority than the one it was
 * authorised under, in a subsystem whose entire claim is that multi-step does
 * not mean multi-privilege.
 *
 * So the principal comes off the run row, which already records every term:
 * `startedByUserId`, `triggeredViaKeyId`, `agentId`, `policyCardVersion`.
 *
 * ── WHAT IS RE-READ RATHER THAN PINNED, AND WHY ─────────────────────────────
 *
 * The ROLE and the key's SCOPES are read at execution time, not carried from
 * the enqueue. Authority is current: a principal whose membership was revoked
 * between enqueue and execution must not have a queued job act for them, and
 * a key whose scopes were narrowed must not widen again by having been used
 * earlier. The policy card is the deliberate exception — `policyCardVersion`
 * is pinned on the row precisely so a run is judged by the rules in force when
 * it started.
 *
 * FAIL CLOSED: no active membership, no execution. The run is settled FAILED
 * with a message naming the reason rather than left RUNNING for the reaper,
 * because "the person who started this lost access" is an answer an operator
 * wants, and a wedged row is not.
 *
 * ── WHY `fromSeq` COMES FROM THE LEDGER ─────────────────────────────────────
 *
 * Not from the payload. A SIGTERM mid-run leaves the committed steps in place
 * and the row RUNNING; BullMQ retries; this reads how many steps actually
 * landed and resumes after them. A payload-carried index would re-execute a
 * step the run had already committed — and the steps that call tools are not
 * idempotent.
 *
 * ── AND WHY IT READS BOTH THE LEDGER AND THE COUNTER (#3602) ────────────────
 *
 * This used to read `row.stepCount` alone, under that same comment. The column
 * is NOT the ledger: it is a denormalised counter written by the engine, and
 * every path that dies before its writer leaves it behind the committed rows.
 * Measured in production — a `posture-review` run on 2026-09-24 carried
 * `stepCount 0` with FOUR committed `TOOL_CALL` rows, because the segment was
 * killed mid-dispatch before `settleTurns` ran. Had the retry arrived inside
 * the wall-clock hour instead of 3h34m later, this function would have resumed
 * that run at seq 0 and re-executed all four tool calls — the precise outcome
 * the paragraph above promises cannot happen.
 *
 * So the resume point is the GREATER of the two, which is the only combination
 * that is safe in both directions. The ledger stops a stale counter resuming
 * behind committed work. The counter is still consulted because the human
 * resume path writes it deliberately — `resumeWorkflowRun` stores
 * `resumedFrom + 1` precisely because an argument "does not survive the hop" —
 * and a run released from a checkpoint must not resume behind the point that
 * transaction chose.
 */
/**
 * WHERE A QUEUED RUN RESUMES, given the ledger's high-water mark and the run
 * row's counter (#3602).
 *
 * `ledgerMaxSeq` is `max(WorkflowStep.seq)` for the run, or `-1` when it has
 * committed nothing. `stepCount` is the denormalised counter on the run row.
 *
 * THE GREATER OF THE TWO, because neither is safe alone and they fail in
 * opposite directions:
 *
 *   • The COUNTER can sit behind the ledger. It has a single writer by design —
 *     see `settleTurns` in `flue/execute.ts`, where a second writer for the same
 *     number was rejected as the way the two drift — so any path that dies
 *     before that writer leaves it stale. Measured in production: a
 *     `posture-review` run carried `stepCount 0` with FOUR committed TOOL_CALL
 *     rows after its segment was killed mid-dispatch. Resuming at 0 would have
 *     re-executed four non-idempotent tool calls, which is exactly what the
 *     caller's own header says cannot happen.
 *   • The LEDGER can sit behind the counter. `resumeWorkflowRun` writes
 *     `resumedFrom + 1` deliberately when releasing a run from a human
 *     checkpoint, because an argument "does not survive the hop" to the worker.
 *     A run released past a checkpoint must not resume before the point that
 *     transaction chose.
 *
 * So the max is not a hedge between two guesses. Each input is authoritative
 * about a different thing — what HAS run, and what a human decided should run
 * next — and the resume point must respect both.
 *
 * Extracted and exported because nothing exercised this arithmetic:
 * `executeQueuedWorkflowRun` needs Prisma, a registered agent and a dispatch to
 * reach, which is why reading a stale counter survived in it unnoticed.
 */
export function resumePositionOf(ledgerMaxSeq: number, stepCount: number): number {
    return Math.max(ledgerMaxSeq + 1, stepCount);
}

export async function executeQueuedWorkflowRun(
    tenantId: string,
    runId: string,
): Promise<QueuedRunOutcome> {
    // Read the row BEFORE there is a context to read it with — the one place
    // that is unavoidable, and scoped by BOTH ids so a wrong tenant cannot
    // reach another's run even here.
    const row = await runInGlobalContext((db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId },
            select: {
                id: true, tenantId: true, workflowKey: true, status: true,
                startedByUserId: true, triggeredViaKeyId: true, agentId: true,
                stepCount: true, startedAt: true,
            },
        }),
    );
    if (!row) return { skipped: 'NOT_FOUND' };

    // IDEMPOTENT. A retry that arrives after the run already settled — or
    // after a human aborted it — must not restart it. Only a RUNNING row has
    // work left, and BullMQ can deliver a job more than once.
    if (row.status !== 'RUNNING') return { skipped: `NOT_RUNNING:${row.status}` };

    const def = getWorkflowDefinition(row.workflowKey);
    if (!def) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'workflow_definition_missing: the workflow this run was started from no longer exists.',
        );
        return { skipped: 'NO_DEFINITION' };
    }

    if (!(await runAgentStillInService(tenantId, row.agentId))) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'run_agent_no_longer_in_service: the registered agent this run was started by ' +
                'is no longer ACTIVE, so the run does not resume on its behalf.',
        );
        return { skipped: 'AGENT_NOT_ACTIVE' };
    }

    const ctx = await rebuildRunContext(row);
    if (!ctx) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'run_principal_no_longer_authorised: the principal that started this run ' +
                'no longer holds an active membership in this workspace.',
        );
        return { skipped: 'PRINCIPAL_REVOKED' };
    }

    const permitted = (
        await resolveDriverForRun(ctx.tenantId, {
            requestId: ctx.requestId,
            workflowKey: row.workflowKey,
        })
    ).driver;
    // `max(seq) + 1` rather than `count(*)`: a gap in the sequence must not pull
    // the resume point back on top of a step that already committed.
    const ledger = await runInTenantContext(ctx, (db) =>
        db.workflowStep.aggregate({
            where: { runId, tenantId: ctx.tenantId },
            _max: { seq: true },
        }),
    );

    const { status, stepFailures } = await executeFrom(
        ctx,
        runId,
        def,
        // The ledger's answer OR the counter's, whichever is further on — see
        // `resumePositionOf` for why neither alone is safe.
        resumePositionOf(ledger._max.seq ?? -1, row.stepCount),
        row.startedAt.getTime(),
        permitted,
    );
    return { status, stepFailures };
}


/**
 * Rebuild the principal who started a run, from the row that recorded them.
 *
 * Returns `null` when that principal can no longer act — which is the whole
 * point of the function. A queued job must not be a way for authority to
 * outlive the grant that created it.
 *
 * The API key is re-read for the same reason: `triggeredViaKeyId` says which
 * key started the run, and the SCOPES it carries now are the ones it may use
 * now. A key that was narrowed, or revoked, between enqueue and execution
 * narrows the run with it.
 */
async function rebuildRunContext(row: {
    tenantId: string;
    startedByUserId: string | null;
    triggeredViaKeyId: string | null;
    agentId: string | null;
}): Promise<RequestContext | null> {
    if (!row.startedByUserId) return null;

    const membership = await runInGlobalContext((db) =>
        db.tenantMembership.findFirst({
            where: { tenantId: row.tenantId, userId: row.startedByUserId as string, status: 'ACTIVE' },
            select: { role: true, customRoleId: true },
        }),
    );
    // FAIL CLOSED. No active membership, no context, no execution.
    if (!membership) return null;

    let apiKeyScopes: string[] | undefined;
    if (row.triggeredViaKeyId) {
        const now = new Date();
        const key = await runInGlobalContext((db) =>
            db.tenantApiKey.findFirst({
                where: {
                    id: row.triggeredViaKeyId as string,
                    tenantId: row.tenantId,
                    revokedAt: null,
                    // EXPIRY COUNTS TOO. A key that lapsed while the job sat in
                    // the queue is as gone as a revoked one; only `revokedAt`
                    // would let a run continue on a credential that no live
                    // request could use.
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                select: { scopes: true },
            }),
        );
        // A revoked or lapsed key is the same answer as a revoked membership:
        // the grant that authorised this run is gone, so the run does not
        // continue on it.
        if (!key) return null;
        // `scopes` is a Json column holding an array of strings. Narrowed
        // rather than asserted: a malformed value yields NO scopes, which
        // fails closed, where a cast would hand the run whatever was there.
        apiKeyScopes = Array.isArray(key.scopes)
            ? key.scopes.filter((v): v is string => typeof v === 'string')
            : [];
    }

    const appPermissions = getPermissionsForRole(membership.role);
    return {
        // Correlates every log line and audit row of this attempt back to the
        // run, which is what an operator has when they open the page.
        requestId: `agent-run-${row.tenantId}-${row.startedByUserId}`,
        userId: row.startedByUserId,
        tenantId: row.tenantId,
        role: membership.role,
        // Derived from the granular set exactly as `risk-appetite-jobs`
        // does — the coarse five are a projection of it, not a second source.
        permissions: {
            canRead: appPermissions.risks.view,
            canWrite: appPermissions.risks.edit,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
        // NOT `actorType: 'JOB'`. The worker is only where this runs; the run
        // was asked for by a person or a key, and the audit trail must keep
        // saying so or a review cannot tell an agent's work from a sweep's.
        ...(row.triggeredViaKeyId ? { apiKeyId: row.triggeredViaKeyId, apiKeyScopes } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
    } as RequestContext;
}

/**
 * Is the agent this run was started by STILL in service?
 *
 * The gap this closes, found by an adversarial review of point 1: the worker
 * re-read the membership and failed closed on revocation, re-read the key and
 * failed closed on revoke or expiry — and then restored `ctx.agentId` with no
 * check of the agent at all. The one principal that IS an agent was the one
 * principal not re-validated.
 *
 * Authority is current, exactly as it is for the membership and the key. An
 * agent suspended or retired while its run sat in the queue must not have that
 * run resume on its behalf — suspension is an operator stopping an agent, and
 * a queue is not a way around it.
 *
 * Returns true when there is no agent to check. A run with no `agentId` cannot
 * be a Flue run (the start path now refuses those), so this is the static
 * engine's row and the register has nothing to say about it.
 */
async function runAgentStillInService(tenantId: string, agentId: string | null): Promise<boolean> {
    if (!agentId) return true;
    const agent = await runInGlobalContext((db) =>
        db.registeredAgent.findFirst({
            where: { id: agentId, tenantId, status: 'ACTIVE' },
            select: { id: true },
        }),
    );
    return Boolean(agent);
}

async function loadRunAndDef(ctx: RequestContext, runId: string) {
    const run = await getRunRow(ctx, runId);
    const def = getWorkflowDefinition(run.workflowKey);
    if (!def) throw forbidden('Workflow definition no longer exists');
    return { run, def };
}


