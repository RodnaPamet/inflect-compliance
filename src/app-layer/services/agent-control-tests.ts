/**
 * THE FOUR AGENTIC CHECKS, AS AUTOMATED CONTROL TESTS.
 *
 * Nine prompts built agent governance. Every one of them produced state a
 * person can look at — a policy card, a tool pin, a review-quality report, a
 * drill row. None of them produced the thing an assessor actually asks for,
 * which is not "show me your kill switch" but "show me that it worked, last
 * month, on a Tuesday, without anybody being asked". That is a CONTROL TEST,
 * and this repo has had a runner for one since Epic G-2.
 *
 * So there is no second runner here and no new job. Four checks, one handler,
 * registered on the seam `control-test-runner.ts` already exposed:
 *
 *   ControlTestPlan(automationType=INTEGRATION, schedule=<cron>,
 *                   automationConfig={ check: '<one of AGENTIC_CHECK_IDS>' })
 *       ↓  control-test-scheduler claims it when its cron says it is due
 *   control-test-runner  →  this handler  →  one AgenticCheckOutcome
 *       ↓
 *   ControlTestRun(COMPLETED, PASS|FAIL|INCONCLUSIVE)
 *     + Evidence(TEXT, controlId-anchored)  + on FAIL, a Finding
 *
 * The evidence attach and the Finding are the runner's, not ours. A breach
 * raises a Finding through the path that already existed, which is the point:
 * a fifth way to raise one would be a fifth thing to keep in step.
 *
 * ── WHAT AN EMPTY TENANT GETS, AND WHY IT IS NOT A PASS ─────────────
 *
 * A control test that FAILS a tenant with no agents cries wolf at every
 * customer who has not adopted them. One that PASSES reports compliance nobody
 * earned — and it is the worse of the two, because it is silent.
 *
 * Both are refused here. A check with nothing to examine returns
 * `verdict: 'INCONCLUSIVE'` with `vacuous: true`, and the runner's existing
 * `isAttestingVerdict` — `PASS` or `FAIL`, never `INCONCLUSIVE` — then declines
 * to stamp `Control.lastTested`. So the control keeps reading as DUE, the
 * evidence row says `Examined: 0` in its first three lines, and no Finding is
 * raised. Nobody is woken and nobody is credited. That disposition is not
 * invented here: it is the one `attestControlTested` already documents for a
 * run that did not exercise the control, and reusing it is what keeps the
 * agentic surface and the rest of the product telling one story.
 *
 * `vacuous` is a FIELD rather than an inference from `population === 0`,
 * because the two come apart. A review-quality window holding four decisions
 * is INCONCLUSIVE — the engine's own `MIN_REPORTABLE_SAMPLE` refuses to
 * estimate from it — but four decisions is not nothing, and reporting it as
 * "no agents here" would hide a tenant that has begun.
 *
 * ── WHAT THESE COST ─────────────────────────────────────────────────
 *
 * The premise "four checks per tenant per tick, every five minutes" is worth
 * taking apart, because it is not what happens. `control-test-scheduler` ticks
 * every five minutes; `control-test-runner` executes a plan only on a tick
 * where that plan's own cron says it is DUE. A check on a daily cron costs
 * nothing on 287 of the 288 daily ticks. Per-tick cost is one existing
 * `findDueTestPlans` scan across all tenants, capped at 500 rows, and these
 * checks add no row to it that an operator did not schedule.
 *
 * What one FIRING costs, per check, all inside the transaction the runner has
 * already opened:
 *
 *   POLICY_CARD_CONFORMANCE   3 queries — agents, their cards, the head
 *                             versions of those cards. Bounded by
 *                             `AGENT_SCAN_CAP`, and `truncated` says so when
 *                             the cap bites.
 *   TOOL_MANIFEST_INTEGRITY   1 query, bounded by `PIN_SCAN_CAP`. The live
 *                             hashes are computed ONCE per process
 *                             (`liveManifestsByName`) — the definitions ship
 *                             with the build and cannot change under a
 *                             running worker.
 *   REVIEW_QUALITY            3 queries via the report's own
 *                             `loadReviewObservations`, capped at
 *                             `MAX_REPORT_ROWS`. The expensive one; put it on
 *                             a daily cron, not an hourly one.
 *   KILL_SWITCH_DRILL         2 point reads, both index-served
 *                             (`[tenantId, startedAt]`), plus one count.
 *
 * No check reads in a loop and none is unbounded, which is what
 * `tests/guardrails/query-shape-guardrails.test.ts` asks of anything under
 * `src/app-layer`.
 *
 * ── DIGEST DISCIPLINE ───────────────────────────────────────────────
 *
 * Every line these checks emit is a CODE, an IDENTIFIER or a COUNT. No tool
 * description, no proposal payload, no reviewer email, no prompt. The evidence
 * row lands in a store the retention policy does not erase, and this file sits
 * inside `local/no-raw-prompt-logging`'s scope (`services/agent-*.ts`) so the
 * rule holds the line on anything added later.
 */
import {
    computeReviewQuality,
    MIN_REPORTABLE_SAMPLE,
    type ReviewBiasSignal,
} from '@/lib/agentic/automation-bias';
import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';
import { dataScopeWithinCard, type PolicyDataScope } from '@/lib/agentic/policy-card';
import { withholdingReasonForTool } from '@/lib/agentic/policy-card-evaluation';
import { allToolDefinitions } from '@/lib/mcp/tool-definitions';
import {
    hashToolManifest,
    verifyToolManifest,
    type ToolDefinition,
    type ToolManifestHashes,
} from '@/lib/mcp/tool-manifest';
import type { PrismaTx } from '@/lib/db-context';

import { loadReviewObservations, DEFAULT_WINDOW_DAYS } from '../usecases/agent-review-quality';
import {
    runnerHandlerRegistry,
    type AutomationHandler,
    type AutomationHandlerInput,
    type AutomationHandlerResult,
} from '../jobs/control-test-runner';

// ─── The four checks ────────────────────────────────────────────────

export const AGENTIC_CHECK_IDS = [
    'AGENTIC_POLICY_CARD_CONFORMANCE',
    'AGENTIC_TOOL_MANIFEST_INTEGRITY',
    'AGENTIC_REVIEW_QUALITY',
    'AGENTIC_KILL_SWITCH_DRILL',
] as const;

export type AgenticCheckId = (typeof AGENTIC_CHECK_IDS)[number];

export interface AgenticCheckDefinition {
    id: AgenticCheckId;
    /** Operator-facing name. Also the evidence-row title stem. */
    title: string;
    /**
     * The OWASP Agentic Top 10 requirement keys a run of this check produces
     * evidence for. Read by `tests/guardrails/agentic-evidence-coverage.test.ts`
     * against the LIBRARY's own key set, so a risk that gains a check and a risk
     * that loses one both show up in the same place.
     */
    covers: readonly string[];
    /** Severity of the Finding a breach raises through the runner. */
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export const AGENTIC_CHECKS: Readonly<Record<AgenticCheckId, AgenticCheckDefinition>> = {
    AGENTIC_POLICY_CARD_CONFORMANCE: {
        id: 'AGENTIC_POLICY_CARD_CONFORMANCE',
        title: 'Agent policy cards still match what was approved',
        // ASI02 is the permitted-TOOL half of a card; ASI03 is its autonomy and
        // data-scope half. The two are one row and one check, but they answer
        // two different risks and an assessor cites them separately.
        covers: ['ASI02', 'ASI03'],
        severity: 'HIGH',
    },
    AGENTIC_TOOL_MANIFEST_INTEGRITY: {
        id: 'AGENTIC_TOOL_MANIFEST_INTEGRITY',
        title: 'Every pinned tool manifest still matches the live definition',
        covers: ['ASI04'],
        severity: 'CRITICAL',
    },
    AGENTIC_REVIEW_QUALITY: {
        id: 'AGENTIC_REVIEW_QUALITY',
        title: 'Agent proposal reviews show no automation-bias signal',
        covers: ['ASI09'],
        severity: 'MEDIUM',
    },
    AGENTIC_KILL_SWITCH_DRILL: {
        id: 'AGENTIC_KILL_SWITCH_DRILL',
        title: 'The most recent kill-switch drill passed',
        covers: ['ASI08', 'ASI10'],
        severity: 'CRITICAL',
    },
};

/**
 * Agentic risks with NO automated control test, each with the reason.
 *
 * Read as an allowlist by the coverage ratchet: a risk that is neither covered
 * nor listed here fails CI, and a risk that is BOTH fails too — a stale
 * exemption sitting beside a working check is how a control set stops meaning
 * what it says.
 *
 * The bar for landing here is not "hard"; it is "a periodic re-read of tenant
 * STATE cannot answer this question". Three of the four below are per-call
 * controls proved in CI, which is where a wiring fact belongs — the same
 * argument `agent-kill-switch-drill.ts` makes for why its own drill probes
 * state and leaves the wiring to an integration test.
 */
export const AGENTIC_CONTROL_EXEMPTIONS: Readonly<Record<string, string>> = {
    ASI01:
        'Goal hijack is judged PER INVOCATION by the guard in ' +
        '`lib/agentic/context-integrity.ts`, and the verdict is already recorded on ' +
        'every `AiDecisionLog` row. There is no tenant state that DRIFTS between ' +
        'invocations for a scheduled pass to re-read: re-deriving a hijack after the ' +
        'fact would mean re-running the guard over stored inputs, which is the one ' +
        'thing this subsystem will not do with content. A refusal-RATE threshold is ' +
        'the honest future check, and it is a metric alert rather than a control test.',
    ASI05:
        'Unexpected code execution is bounded structurally: `lib/agentic/bounded-exec.ts` ' +
        'is the only execution seam and `tests/guards/tool-execution-is-bounded.test.ts` ' +
        'fails CI if a second one appears. That is a COMPILE-TIME fact about the build, ' +
        'and a scheduled read of a customer database cannot observe it — every tenant ' +
        'runs the same binary, so the check would return the same answer for all of ' +
        'them and would be evidence about CI wearing a tenant control test\'s clothes.',
    ASI06:
        'Context poisoning is caught by the per-step hash chain over ' +
        '`WorkflowRun.contextJson` (`lib/agentic/context-integrity.ts`), verified on ' +
        'every step as it runs. A periodic re-verification would have to decrypt every ' +
        'stored context to re-hash it, moving unvetted content through the worker for a ' +
        'signal the step boundary already produced at the only moment it could act on it.',
    ASI07:
        'No inter-agent transport ships in this build — there is no agent-to-agent ' +
        'channel, so there is no state whose integrity could drift and nothing for a ' +
        'periodic check to read. This exemption expires the day a multi-agent surface ' +
        'lands; it is the one entry here that is about absence rather than about where ' +
        'the control lives.',
};

// ─── Outcome shape ──────────────────────────────────────────────────

export interface AgenticCheckOutcome {
    checkId: AgenticCheckId;
    /** Maps 1:1 onto `TestResult`. `INCONCLUSIVE` never attests the control. */
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    /** A stable code saying WHY. Never prose, never a value from the tenant. */
    basis: string;
    /**
     * TRUE when this tenant had nothing for the control to be about — no
     * agents, no pins, no decisions. Explicit rather than inferred from
     * `population === 0`: a below-threshold sample is neither empty nor
     * reportable, and the two must not read the same.
     */
    vacuous: boolean;
    /** How many things were examined. The denominator, always reported. */
    population: number;
    /** How many of them breached. */
    breaches: number;
    /** TRUE when a scan cap bit — the numbers cover a suffix, not the whole. */
    truncated: boolean;
    /** Digest-level lines. Codes, ids and counts only. Bounded by `MAX_FACTS`. */
    facts: string[];
}

/** How many fact lines reach the evidence row before it says "and N more". */
const MAX_FACTS = 40;

/** Agents examined by the policy-card check in one run. */
const AGENT_SCAN_CAP = 500;
/** Manifest pins examined in one run. Bounded above by the build's catalogue. */
const PIN_SCAN_CAP = 500;
/** How stale the newest PASSED drill may be before the control reads as failed. */
const DEFAULT_DRILL_MAX_AGE_HOURS = 48;

function bounded(facts: string[]): string[] {
    if (facts.length <= MAX_FACTS) return facts;
    return [...facts.slice(0, MAX_FACTS), `… and ${facts.length - MAX_FACTS} more`];
}

// ─── 1. Policy-card conformance (ASI02, ASI03) ──────────────────────

/**
 * Does every card's HEAD version still sit inside the declaration it was
 * approved against?
 *
 * The write path checks all three of these, and none of them stays checked.
 * That asymmetry is the whole reason this check exists rather than being
 * "already handled by `updateAgentPolicyCard`":
 *
 *   • `assertDeclarationsExercisable` compares the card against the tier
 *     ceiling AT WRITE TIME. Re-assessing an agent UPWARDS lowers that ceiling
 *     and does not reach back to the card, so a card written under LIMITED is
 *     silently above the ceiling the moment the agent is re-scored CRITICAL.
 *   • `assertDataScopeRaiseWithinDeclaration` refuses only a WIDENING, and says
 *     so deliberately: a card already above the register's declaration is a
 *     reachable state, because narrowing `RegisteredAgent.dataAccessScope` is
 *     never refused and never rewrites the card. Refusing the resulting VALUE
 *     would fight the operator repairing it. So the write path CANNOT report
 *     this state and a periodic read is the only thing that can.
 *   • `withholdingReasonForTool` is evaluated against the catalogue THIS BUILD
 *     carries. A deploy that removes a tool leaves every card naming it
 *     declaring something the boundary refuses on every call.
 *
 * Each of those is a card that has stopped matching what was approved while
 * every write to it was legal. That is the sentence this check turns into a row.
 */
export async function checkPolicyCardConformance(
    db: PrismaTx,
    tenantId: string,
): Promise<AgenticCheckOutcome> {
    const scanned = await db.registeredAgent.findMany({
        where: { tenantId, deletedAt: null, isLegacyPlaceholder: false },
        select: { id: true, riskTier: true, dataAccessScope: true },
        orderBy: { id: 'asc' },
        take: AGENT_SCAN_CAP + 1,
    });
    const truncated = scanned.length > AGENT_SCAN_CAP;
    const agents = truncated ? scanned.slice(0, AGENT_SCAN_CAP) : scanned;
    const agentIds = agents.map((a) => a.id);

    const cards =
        agentIds.length === 0
            ? []
            : await db.agentPolicyCard.findMany({
                  where: { tenantId, agentId: { in: agentIds } },
                  select: { id: true, agentId: true, currentVersion: true },
                  take: AGENT_SCAN_CAP,
              });

    // Head versions in ONE query keyed on the distinct version NUMBERS the
    // cards named, then paired in memory. A per-card lookup would be an N+1
    // over the whole register; a `take: 1` ordered by version descending would
    // read "the newest version" while meaning "the version in force", which is
    // the coincidence `policy-card-store.ts` refuses for the same reason.
    const headVersionNumbers = [...new Set(cards.map((c) => c.currentVersion))];
    const versions =
        cards.length === 0
            ? []
            : await db.agentPolicyCardVersion.findMany({
                  where: {
                      tenantId,
                      cardId: { in: cards.map((c) => c.id) },
                      version: { in: headVersionNumbers },
                  },
                  select: {
                      cardId: true,
                      version: true,
                      permittedTools: true,
                      maxDataScope: true,
                      maxAutonomyLevel: true,
                  },
                  take: AGENT_SCAN_CAP,
              });
    const headByCard = new Map(versions.map((v) => [`${v.cardId}:${v.version}`, v] as const));
    const agentById = new Map(agents.map((a) => [a.id, a] as const));

    const facts: string[] = [];
    let breachedCards = 0;

    for (const card of cards) {
        const agent = agentById.get(card.agentId);
        if (!agent) continue;
        const head = headByCard.get(`${card.id}:${card.currentVersion}`);
        if (!head) {
            breachedCards += 1;
            facts.push(
                `agent=${card.agentId} code=HEAD_UNRESOLVABLE version=${card.currentVersion}`,
            );
            continue;
        }

        const codes: string[] = [];

        const tierCeiling = ceilingForRiskTier(agent.riskTier);
        if (head.maxAutonomyLevel > tierCeiling) {
            codes.push(
                `AUTONOMY_ABOVE_TIER card=${head.maxAutonomyLevel} tierCap=${tierCeiling} ` +
                    `tier=${agent.riskTier ?? 'UNSCORED'}`,
            );
        }

        const declared: PolicyDataScope = agent.dataAccessScope;
        if (!dataScopeWithinCard(head.maxDataScope, declared)) {
            codes.push(
                `DATA_SCOPE_ABOVE_DECLARATION card=${head.maxDataScope} declared=${declared}`,
            );
        }

        for (const toolName of head.permittedTools) {
            const withheld = withholdingReasonForTool(toolName, {
                maxDataScope: head.maxDataScope,
                maxAutonomyLevel: head.maxAutonomyLevel,
            });
            if (withheld) {
                codes.push(
                    `TOOL_UNEXERCISABLE tool=${withheld.toolName} reason=${withheld.reason} ` +
                        `requires=${withheld.requires} permits=${withheld.permits}`,
                );
            }
        }

        if (codes.length > 0) {
            breachedCards += 1;
            for (const code of codes) {
                facts.push(`agent=${card.agentId} version=${head.version} code=${code}`);
            }
        }
    }

    const population = cards.length;
    if (population === 0) {
        return {
            checkId: 'AGENTIC_POLICY_CARD_CONFORMANCE',
            verdict: 'INCONCLUSIVE',
            basis: agents.length === 0 ? 'NO_AGENTS_REGISTERED' : 'NO_POLICY_CARDS',
            vacuous: true,
            population: 0,
            breaches: 0,
            truncated,
            facts: [`agents=${agents.length}`, 'cards=0'],
        };
    }

    return {
        checkId: 'AGENTIC_POLICY_CARD_CONFORMANCE',
        verdict: breachedCards === 0 ? 'PASS' : 'FAIL',
        basis: breachedCards === 0 ? 'ALL_CARDS_CONFORMANT' : 'CARD_OUTSIDE_DECLARATION',
        vacuous: false,
        population,
        breaches: breachedCards,
        truncated,
        facts: bounded([
            `agents=${agents.length}`,
            `cards=${population}`,
            `uncarded=${agents.length - population}`,
            ...facts,
        ]),
    };
}

// ─── 2. Tool-manifest integrity (ASI04) ─────────────────────────────

/**
 * The live definitions, hashed ONCE per process.
 *
 * The catalogue ships with the build and no code path mutates it, so a fresh
 * hash per tenant per run would be the same twenty SHA-256s recomputed for no
 * new information. Memoised at module scope rather than per call, because the
 * worker holds the module for its whole life.
 */
let liveManifestCache: Map<string, { def: ToolDefinition; hashes: ToolManifestHashes }> | null =
    null;

function liveManifestsByName(): Map<string, { def: ToolDefinition; hashes: ToolManifestHashes }> {
    if (liveManifestCache) return liveManifestCache;
    liveManifestCache = new Map(
        allToolDefinitions().map((def) => [def.name, { def, hashes: hashToolManifest(def) }]),
    );
    return liveManifestCache;
}

/** Test-only. Drops the memoised catalogue so a fixture can change it. */
export function _resetLiveManifestCache(): void {
    liveManifestCache = null;
}

/**
 * Does every pin still describe the definition this build ships?
 *
 * The boundary already refuses a drifted tool on the next call
 * (`verifyToolManifest(...).mustRefuse`). What it cannot do is tell anyone
 * BEFORE that call — a tenant whose agent runs weekly learns that a tool
 * description was rewritten when the agent next runs, and the evidence that it
 * had NOT been rewritten for the six days before that exists nowhere. This
 * check is that evidence.
 *
 * `UNPINNED` is not a breach and is reported as a count. Trust-on-first-use is
 * the documented design (see `tool-manifest.ts`): a tool nobody has called yet
 * has no pin because nothing has observed it, which is a fact about traffic
 * rather than about integrity. A pin naming a tool this build no longer defines
 * is likewise inert — the boundary can never reach it — so it is a fact too.
 */
export async function checkToolManifestIntegrity(
    db: PrismaTx,
    tenantId: string,
): Promise<AgenticCheckOutcome> {
    const live = liveManifestsByName();
    const scanned = await db.mcpToolManifestPin.findMany({
        where: { tenantId },
        select: {
            toolName: true,
            descriptionHash: true,
            schemaHash: true,
            manifestHash: true,
            revision: true,
            approvedByUserId: true,
            approvalSource: true,
        },
        orderBy: { toolName: 'asc' },
        take: PIN_SCAN_CAP + 1,
    });
    const truncated = scanned.length > PIN_SCAN_CAP;
    const pins = truncated ? scanned.slice(0, PIN_SCAN_CAP) : scanned;

    const facts: string[] = [];
    let drifted = 0;
    let orphaned = 0;

    for (const pin of pins) {
        const entry = live.get(pin.toolName);
        if (!entry) {
            orphaned += 1;
            facts.push(`tool=${pin.toolName} code=PIN_FOR_TOOL_NOT_IN_BUILD revision=${pin.revision}`);
            continue;
        }
        const verdict = verifyToolManifest(entry.def, pin);
        if (verdict.isSecurityEvent) {
            drifted += 1;
            facts.push(
                `tool=${pin.toolName} code=${verdict.status} revision=${pin.revision} ` +
                    `source=${pin.approvalSource} refusing=${verdict.mustRefuse}`,
            );
        }
    }

    const population = pins.length;
    if (population === 0) {
        return {
            checkId: 'AGENTIC_TOOL_MANIFEST_INTEGRITY',
            verdict: 'INCONCLUSIVE',
            basis: 'NO_TOOL_PINS',
            vacuous: true,
            population: 0,
            breaches: 0,
            truncated,
            facts: [`toolsInBuild=${live.size}`, 'pins=0'],
        };
    }

    return {
        checkId: 'AGENTIC_TOOL_MANIFEST_INTEGRITY',
        verdict: drifted === 0 ? 'PASS' : 'FAIL',
        basis: drifted === 0 ? 'ALL_PINS_MATCH_BUILD' : 'PINNED_DEFINITION_CHANGED',
        vacuous: false,
        population,
        breaches: drifted,
        truncated,
        facts: bounded([
            `toolsInBuild=${live.size}`,
            `pins=${population}`,
            `unpinned=${Math.max(0, live.size - (population - orphaned))}`,
            `orphanPins=${orphaned}`,
            ...facts,
        ]),
    };
}

// ─── 3. Review quality (ASI09) ──────────────────────────────────────

/**
 * Are the approvals showing the automation-bias signals the report computes?
 *
 * Reads through `loadReviewObservations` — the report's OWN loader, not a
 * second copy of it. Two loaders would be two denominators, and a page that
 * says "no signals" beside a control test that says FAIL is worse evidence
 * than either alone.
 *
 * The report is a PULL detector: it fires when an admin opens the page, so a
 * tenant that never opens it is never alerted. That limitation is stated in
 * `agent-review-quality.ts` and the honest fix named there is "a scheduled
 * pass". This check IS that pass — but it deliberately calls the loader plus
 * the pure engine rather than `computeAgentReviewQuality`, because that usecase
 * writes a deduplicated ALERT row as a side effect. A control test that alerts
 * every time it runs is a control test nobody reads.
 *
 * Below `MIN_REPORTABLE_SAMPLE` the engine refuses to estimate, so this returns
 * INCONCLUSIVE rather than a PASS built on four decisions. Zero decisions and
 * four decisions are different bases and only the first is `vacuous`.
 */
export async function checkReviewQuality(
    db: PrismaTx,
    tenantId: string,
    now: Date,
    windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<AgenticCheckOutcome> {
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const { observations, truncated } = await loadReviewObservations(db, tenantId, since);
    const report = computeReviewQuality(observations);

    const head = [
        `windowDays=${windowDays}`,
        `decided=${report.decided}`,
        `approved=${report.approved}`,
        `rejected=${report.rejected}`,
        `reviewers=${report.reviewers.length}`,
        `minReportableSample=${MIN_REPORTABLE_SAMPLE}`,
    ];

    if (report.decided < MIN_REPORTABLE_SAMPLE) {
        return {
            checkId: 'AGENTIC_REVIEW_QUALITY',
            verdict: 'INCONCLUSIVE',
            basis: report.decided === 0 ? 'NO_DECISIONS_IN_WINDOW' : 'BELOW_REPORTABLE_SAMPLE',
            vacuous: report.decided === 0,
            population: report.decided,
            breaches: 0,
            truncated,
            facts: head,
        };
    }

    const signalFacts = report.signals.map(
        (s: ReviewBiasSignal) =>
            `code=${s.code} scope=${s.scope} subject=${s.subjectId ?? 'unattributed'} ` +
            `observed=${s.observed} threshold=${s.threshold} sample=${s.sampleSize}`,
    );

    return {
        checkId: 'AGENTIC_REVIEW_QUALITY',
        verdict: report.signals.length === 0 ? 'PASS' : 'FAIL',
        basis: report.signals.length === 0 ? 'NO_BIAS_SIGNALS' : 'AUTOMATION_BIAS_SIGNAL',
        vacuous: false,
        population: report.decided,
        breaches: report.signals.length,
        truncated,
        facts: bounded([...head, ...signalFacts]),
    };
}

// ─── 4. Kill-switch drill outcome (ASI08, ASI10) ────────────────────

/**
 * Did the most recent drill PASS, and was it recent enough to mean anything?
 *
 * Three refusals sit behind the obvious one, and each is a state that would
 * otherwise read as a pass:
 *
 *   • NO DRILL AT ALL, on a tenant that HAS agents, once the oldest agent is
 *     older than the staleness window. "Never ran" and "ran and found nothing"
 *     look identical from the outside; this is the check that separates them.
 *     Inside the window it is `AWAITING_FIRST_DRILL` — not vacuous, because
 *     there are agents, and not a failure, because the nightly job has not had
 *     its turn.
 *   • A STALE PASS. The drill runs nightly. A newest-PASSED row two days old
 *     means the job has stopped, and a control whose self-test has stopped
 *     running is indistinguishable from one that is passing.
 *   • AN OUTCOME THIS BUILD DOES NOT RECOGNISE. Sorted to INCONCLUSIVE rather
 *     than falling through to PASS, the same direction `coerceStoredMode` takes
 *     for an unknown identity write mode.
 *
 * `ERROR` is INCONCLUSIVE and not FAIL, which is the distinction the
 * `AgentKillSwitchDrill.outcome` column exists to preserve: a drill that could
 * not run has proved nothing, and raising a nonconformity about the control
 * would be a Finding about the wrong thing.
 */
export async function checkKillSwitchDrill(
    db: PrismaTx,
    tenantId: string,
    now: Date,
    maxAgeHours: number = DEFAULT_DRILL_MAX_AGE_HOURS,
): Promise<AgenticCheckOutcome> {
    const agents = await db.registeredAgent.count({
        where: { tenantId, deletedAt: null, isLegacyPlaceholder: false },
    });
    if (agents === 0) {
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: 'INCONCLUSIVE',
            basis: 'NO_AGENTS_REGISTERED',
            vacuous: true,
            population: 0,
            breaches: 0,
            truncated: false,
            facts: ['agents=0'],
        };
    }

    const latest = await db.agentKillSwitchDrill.findFirst({
        where: { tenantId },
        orderBy: { startedAt: 'desc' },
        select: {
            id: true,
            outcome: true,
            startedAt: true,
            scopesHonoured: true,
            scopesFailed: true,
            toolCallsAfterKill: true,
            boundaryRefusalReason: true,
            findingId: true,
        },
    });

    if (!latest) {
        const oldest = await db.registeredAgent.findFirst({
            where: { tenantId, deletedAt: null, isLegacyPlaceholder: false },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
        });
        const ageHours = oldest
            ? (now.getTime() - oldest.createdAt.getTime()) / 3_600_000
            : 0;
        const waiting = ageHours < maxAgeHours;
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: waiting ? 'INCONCLUSIVE' : 'FAIL',
            basis: waiting ? 'AWAITING_FIRST_DRILL' : 'NO_DRILL_ON_RECORD',
            vacuous: false,
            population: 0,
            breaches: waiting ? 0 : 1,
            truncated: false,
            facts: [
                `agents=${agents}`,
                'drills=0',
                `oldestAgentAgeHours=${Math.floor(ageHours)}`,
                `maxAgeHours=${maxAgeHours}`,
            ],
        };
    }

    const ageHours = (now.getTime() - latest.startedAt.getTime()) / 3_600_000;
    const facts = [
        `agents=${agents}`,
        `drill=${latest.id}`,
        `outcome=${latest.outcome}`,
        `ageHours=${Math.floor(ageHours)}`,
        `maxAgeHours=${maxAgeHours}`,
        `toolCallsAfterKill=${latest.toolCallsAfterKill}`,
        `scopesHonoured=${latest.scopesHonoured.join('|') || 'none'}`,
        `scopesFailed=${latest.scopesFailed.join('|') || 'none'}`,
        `boundaryRefusalReason=${latest.boundaryRefusalReason ?? 'none'}`,
        `drillFindingId=${latest.findingId ?? 'none'}`,
    ];

    if (latest.outcome === 'FAILED') {
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: 'FAIL',
            basis: 'LAST_DRILL_FAILED',
            vacuous: false,
            population: 1,
            breaches: 1,
            truncated: false,
            facts,
        };
    }
    if (latest.outcome === 'ERROR') {
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: 'INCONCLUSIVE',
            basis: 'LAST_DRILL_ERRORED',
            vacuous: false,
            population: 1,
            breaches: 0,
            truncated: false,
            facts,
        };
    }
    if (latest.outcome !== 'PASSED') {
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: 'INCONCLUSIVE',
            basis: 'UNRECOGNISED_DRILL_OUTCOME',
            vacuous: false,
            population: 1,
            breaches: 0,
            truncated: false,
            facts,
        };
    }
    if (ageHours > maxAgeHours) {
        return {
            checkId: 'AGENTIC_KILL_SWITCH_DRILL',
            verdict: 'FAIL',
            basis: 'LAST_DRILL_STALE',
            vacuous: false,
            population: 1,
            breaches: 1,
            truncated: false,
            facts,
        };
    }
    return {
        checkId: 'AGENTIC_KILL_SWITCH_DRILL',
        verdict: 'PASS',
        basis: 'LAST_DRILL_PASSED',
        vacuous: false,
        population: 1,
        breaches: 0,
        truncated: false,
        facts,
    };
}

// ─── Dispatch ───────────────────────────────────────────────────────

/** The `automationConfig` shape a plan carries to select one of these checks. */
export interface AgenticCheckConfig {
    check: AgenticCheckId;
    /** REVIEW_QUALITY only. Days of lookback. */
    windowDays?: number;
    /** KILL_SWITCH_DRILL only. How stale a PASSED drill may be. */
    maxAgeHours?: number;
}

/**
 * Read a plan's `automationConfig`, or `null` if it names no check of ours.
 *
 * `null` is the DECLINE the runner routes to the manual path. It has to be
 * possible: `runnerHandlerRegistry` is keyed by `automationType`, so
 * registering on INTEGRATION claims every INTEGRATION plan in the product, and
 * answering for somebody else's connector plan would be worse than not
 * running at all.
 */
export function parseAgenticCheckConfig(config: unknown): AgenticCheckConfig | null {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
    const raw = config as Record<string, unknown>;
    const check = raw.check;
    if (typeof check !== 'string') return null;
    if (!(AGENTIC_CHECK_IDS as readonly string[]).includes(check)) return null;

    const windowDays =
        typeof raw.windowDays === 'number' &&
        Number.isInteger(raw.windowDays) &&
        raw.windowDays >= 1 &&
        raw.windowDays <= 365
            ? raw.windowDays
            : undefined;
    const maxAgeHours =
        typeof raw.maxAgeHours === 'number' &&
        Number.isInteger(raw.maxAgeHours) &&
        raw.maxAgeHours >= 1 &&
        raw.maxAgeHours <= 24 * 90
            ? raw.maxAgeHours
            : undefined;

    return { check: check as AgenticCheckId, windowDays, maxAgeHours };
}

/** Run one check by id. Exported so a test drives the check without the runner. */
export async function runAgenticCheck(
    db: PrismaTx,
    tenantId: string,
    config: AgenticCheckConfig,
    now: Date,
): Promise<AgenticCheckOutcome> {
    switch (config.check) {
        case 'AGENTIC_POLICY_CARD_CONFORMANCE':
            return checkPolicyCardConformance(db, tenantId);
        case 'AGENTIC_TOOL_MANIFEST_INTEGRITY':
            return checkToolManifestIntegrity(db, tenantId);
        case 'AGENTIC_REVIEW_QUALITY':
            return checkReviewQuality(db, tenantId, now, config.windowDays);
        case 'AGENTIC_KILL_SWITCH_DRILL':
            return checkKillSwitchDrill(db, tenantId, now, config.maxAgeHours);
    }
}

/** The outcome as the evidence row's body. Codes, ids and counts only. */
export function renderAgenticCheckEvidence(
    outcome: AgenticCheckOutcome,
    scheduledFor: Date,
): string {
    const definition = AGENTIC_CHECKS[outcome.checkId];
    return [
        `Agentic control test: ${outcome.checkId}`,
        definition.title,
        `Covers: ${definition.covers.join(', ')}`,
        '',
        `Verdict: ${outcome.verdict}`,
        `Basis: ${outcome.basis}`,
        `Examined: ${outcome.population}`,
        `Breaches: ${outcome.breaches}`,
        `Vacuous: ${outcome.vacuous ? 'yes' : 'no'}`,
        `Truncated: ${outcome.truncated ? 'yes' : 'no'}`,
        `Scheduled for: ${scheduledFor.toISOString()}`,
        '',
        ...outcome.facts,
    ].join('\n');
}

/**
 * The handler the runner calls. Declines anything that is not one of ours.
 *
 * Every field it returns is derived from the outcome above, so the evidence
 * row, the run's notes and the Finding's description cannot disagree about
 * what happened.
 */
export const agenticControlTestHandler: AutomationHandler = async (
    input: AutomationHandlerInput,
): Promise<AutomationHandlerResult | null> => {
    const config = parseAgenticCheckConfig(input.automationConfig);
    if (!config) return null;

    const definition = AGENTIC_CHECKS[config.check];
    const outcome = await runAgenticCheck(input.db, input.tenantId, config, new Date());

    return {
        result: outcome.verdict,
        evidenceTitle: `Agentic control test — ${definition.title} (${outcome.verdict})`,
        evidenceContent: renderAgenticCheckEvidence(outcome, input.scheduledFor),
        notes:
            `${outcome.checkId}: ${outcome.verdict} (${outcome.basis}). ` +
            `Examined ${outcome.population}, breaches ${outcome.breaches}` +
            (outcome.vacuous ? ', nothing to examine in this tenant' : '') +
            '.',
        findingSummary:
            outcome.verdict === 'FAIL'
                ? `${outcome.breaches} of ${outcome.population} examined breached ` +
                  `${outcome.checkId} (${outcome.basis}). Covers ${definition.covers.join(', ')}. ` +
                  `Details: ${outcome.facts.join(' | ')}`
                : undefined,
        findingSeverity: definition.severity,
    };
};

/**
 * Register the handler on the runner's INTEGRATION slot.
 *
 * Idempotent for OUR handler and loud for anybody else's: a second engine
 * claiming INTEGRATION is a real conflict that the registry's own duplicate
 * check should surface at start-up rather than resolve by coin toss.
 */
export function registerAgenticControlTestHandler(): void {
    if (runnerHandlerRegistry.get('INTEGRATION') === agenticControlTestHandler) return;
    runnerHandlerRegistry.register('INTEGRATION', agenticControlTestHandler);
}
