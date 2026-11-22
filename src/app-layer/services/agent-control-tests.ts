/**
 * THE AGENTIC CHECKS, AS AUTOMATED CONTROL TESTS.
 *
 * Nine prompts built agent governance. Every one of them produced state a
 * person can look at — a policy card, a tool pin, a review-quality report, a
 * drill row. None of them produced the thing an assessor actually asks for,
 * which is not "show me your kill switch" but "show me that it worked, last
 * month, on a Tuesday, without anybody being asked". That is a CONTROL TEST,
 * and this repo has had a runner for one since Epic G-2.
 *
 * So there is no second runner here and no new job. Five checks, one handler,
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
 *   POLICY_CARD_CONFORMANCE   3 queries — agents, their cards, and one exact
 *                             (cardId, version) pair per card. The first two
 *                             are bounded by `AGENT_SCAN_CAP` and the third by
 *                             the card count; `truncated` says so when either
 *                             bites, and no cap is ever reported as a breach.
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
 *   A2A_INTEGRITY             4 queries — ACTIVE peers (`PEER_SCAN_CAP`), the
 *                             signing key in force, the newest
 *                             `RECEIPT_SAMPLE_SIZE` receipts, and the keys
 *                             those receipts name. Plus one LIVE card read per
 *                             pinned peer, through the same ≤15-minute copy
 *                             admission compares against, in parallel and
 *                             each bounded by the card fetch's own timeout.
 *                             The only check that leaves the database; see
 *                             `checkA2aIntegrity`.
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
import { recentAgentCard, type RecentCardResult } from '@/lib/agentic/a2a/card-cache';
import { compareAgentCard, pinnedCardHashesOf } from '@/lib/agentic/peer-agent-card';
import { storedReceiptVerificationKey, verifyStoredA2aReceipt } from '@/lib/agentic/a2a/receipt';

import { loadReviewObservations, DEFAULT_WINDOW_DAYS } from '../usecases/agent-review-quality';
import { auditProcedureHandler } from './audit-procedures';
import {
    runnerHandlerRegistry,
    type AutomationHandler,
    type AutomationHandlerInput,
    type AutomationHandlerResult,
} from '../jobs/control-test-runner';

// ─── The checks ─────────────────────────────────────────────────────

export const AGENTIC_CHECK_IDS = [
    'AGENTIC_POLICY_CARD_CONFORMANCE',
    'AGENTIC_TOOL_MANIFEST_INTEGRITY',
    'AGENTIC_REVIEW_QUALITY',
    'AGENTIC_KILL_SWITCH_DRILL',
    // Last on purpose: the setup reports the first check it cannot place, and a
    // tenant that set up the first four should hear about them first (#5305).
    'AGENTIC_A2A_INTEGRITY',
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
    AGENTIC_A2A_INTEGRITY: {
        id: 'AGENTIC_A2A_INTEGRITY',
        title: 'Peer agents still match their approved cards, keys and receipts',
        covers: ['ASI07'],
        severity: 'HIGH',
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
 * STATE cannot answer this question". The three below are per-call controls
 * proved in CI, which is where a wiring fact belongs — the same argument
 * `agent-kill-switch-drill.ts` makes for why its own drill probes state and
 * leaves the wiring to an integration test.
 *
 * ASI07 (inter-agent communication) was a fourth, on the claim that no A2A
 * transport shipped. A2A ships (#3673, #3679), and its state DRIFTS between
 * messages: a peer's card moves, a signing key ages, a stored receipt stops
 * verifying, a peer is registered and never pinned. So it left this list for
 * `AGENTIC_A2A_INTEGRITY` (owner decision 2026-11-14, #5305).
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
    const agentScanTruncated = scanned.length > AGENT_SCAN_CAP;
    const agents = agentScanTruncated ? scanned.slice(0, AGENT_SCAN_CAP) : scanned;
    const agentIds = agents.map((a) => a.id);

    const cards =
        agentIds.length === 0
            ? []
            : await db.agentPolicyCard.findMany({
                  where: { tenantId, agentId: { in: agentIds } },
                  select: { id: true, agentId: true, currentVersion: true },
                  take: AGENT_SCAN_CAP,
              });

    // Head versions in ONE query, keyed on the EXACT (cardId, version) PAIR each
    // card names. A per-card lookup would be an N+1 over the whole register; a
    // `take: 1` ordered by version descending would read "the newest version"
    // while meaning "the version in force", which is the coincidence
    // `policy-card-store.ts` refuses for the same reason.
    //
    // ── THE TRAP THE PAIR PREDICATE REPLACED ────────────────────────
    //
    // This used to filter `cardId IN (…) AND version IN (…)`, which is the
    // CROSS PRODUCT of the two sets and not one row per card, and then cap the
    // result at AGENT_SCAN_CAP. A tenant with 23 perfectly conformant cards
    // whose `currentVersion`s happened to be 23 distinct numbers, each card
    // holding all 23 of its versions, matched 23 × 23 = 529 rows against a take
    // of 500. Twenty-nine rows fell off the page, and the two cards whose OWN
    // head row was among them were counted as HEAD_UNRESOLVABLE breaches.
    //
    // Nothing in that tenant was wrong. FAIL is an attesting verdict, so the
    // fabricated result stamped `Control.lastTested`, rolled the cadence and
    // raised a HIGH-severity NONCONFORMITY Finding — and the evidence row said
    // `Truncated: no`, because the only cap anything watched was the AGENT
    // scan's and that one had not bitten. The bigger and healthier the tenant,
    // the likelier it fired.
    //
    // The pair form cannot do this: `@@unique([tenantId, cardId, version])`
    // means each OR arm matches AT MOST ONE row, so a take of exactly
    // `headPairs.length` can never elide a head row that exists.
    //
    // Bind-parameter budget, since the OR list grows with the tenant: `cards` is
    // bounded by the same AGENT_SCAN_CAP that bounds `agents`, because a card
    // belongs to exactly one agent (`@@unique([tenantId, agentId])`). Worst case
    // is 500 arms ≈ 1,001 parameters against Postgres's 65,535 — 1.5% of the
    // ceiling. Hence one query and no chunk loop: chunking would put a read
    // inside a loop to respect a bound the cap already makes unreachable.
    const headPairs = cards.map((c) => ({ cardId: c.id, version: c.currentVersion }));
    const versions =
        headPairs.length === 0
            ? []
            : await db.agentPolicyCardVersion.findMany({
                  where: { tenantId, OR: headPairs },
                  select: {
                      cardId: true,
                      version: true,
                      permittedTools: true,
                      maxDataScope: true,
                      maxAutonomyLevel: true,
                  },
                  take: headPairs.length,
              });
    const headByCard = new Map(versions.map((v) => [`${v.cardId}:${v.version}`, v] as const));
    const agentById = new Map(agents.map((a) => [a.id, a] as const));

    // A head row missing from a page that came back FULL was not necessarily
    // missing at all — it may simply not have fitted. That is a fact about the
    // QUERY; only the other case is a fact about the tenant, and the two must
    // never share a code. `HEAD_UNRESOLVABLE` means "the head row does not
    // exist", never "the head row did not fit in the page".
    //
    // Under the pair predicate above this branch is unreachable (each arm
    // matches at most one row and the take equals the arm count), which is
    // exactly why it is written down: it is the tripwire for a future
    // re-widening of that predicate, so the next person who reaches for an `in:`
    // gets `truncated: true` and a count of zero breaches instead of a Finding
    // against a healthy tenant.
    const headPageWasFull = versions.length >= headPairs.length;

    const facts: string[] = [];
    let breachedCards = 0;
    let headsLostToCap = 0;

    for (const card of cards) {
        const agent = agentById.get(card.agentId);
        if (!agent) continue;
        const head = headByCard.get(`${card.id}:${card.currentVersion}`);
        if (!head) {
            if (headPageWasFull) {
                headsLostToCap += 1;
                facts.push(
                    `agent=${card.agentId} code=HEAD_PAGE_TRUNCATED version=${card.currentVersion}`,
                );
                continue;
            }
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
            truncated: agentScanTruncated,
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
        // Either cap biting means the numbers cover a subset, and a head lost to
        // the version page is reported HERE rather than as a breach.
        truncated: agentScanTruncated || headsLostToCap > 0,
        facts: bounded([
            `agents=${agents.length}`,
            `cards=${population}`,
            `uncarded=${agents.length - population}`,
            `headsLostToCap=${headsLostToCap}`,
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
                annotationsHash: true,
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

// ─── 5. A2A integrity (ASI07) ───────────────────────────────────────

/** ACTIVE peers examined in one run. */
const PEER_SCAN_CAP = 100;

/** The newest stored receipts re-verified in one run: a bounded recent sample. */
export const A2A_RECEIPT_SAMPLE_SIZE = 200;

/**
 * How old the tenant's IN-FORCE A2A signing key may be before the control reads
 * as failed: 365 days.
 *
 * Not the API-key rotation age (`apiKeyRotationDays`, 90 by default). That one
 * governs a BEARER secret presented on every request, which leaks by being
 * used; this is an Ed25519 signing key whose private half never leaves the
 * tenant's encrypted row. And rotating it is not free: it changes the tenant's
 * published card, so every peer must read and re-approve the card inside the
 * seven days the card keeps naming the previous key
 * (`A2A_PREVIOUS_KEY_GRACE_MS`). A quarterly cadence would put every partner
 * through that four times a year for a key nobody has presented. A year is the
 * short end of the one-to-three-year cryptoperiod NIST SP 800-57 Part 1 gives a
 * private signature key. A plan may set its own (`signingKeyMaxAgeDays`,
 * 30..1095 days).
 */
export const A2A_SIGNING_KEY_MAX_AGE_DAYS = 365;

/**
 * How long an ACTIVE peer may stay unpinned before it is a breach: seven days,
 * the life of the invitation code that connects two workspaces
 * (`peer-invitations.ts`). Invite, accept and approve the card are meant to
 * happen inside that life; a peer still unpinned after it has been LEFT
 * unpinned. Admission refuses every message to it meanwhile, so the breach is
 * about governance (a registration nobody finished reviewing), not traffic.
 */
export const A2A_UNPINNED_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The live-card reader, injectable so a test decides what each peer serves. */
export type A2aCardReader = (peer: { tenantId: string; peerId: string; cardUrl: string }) => Promise<RecentCardResult>;

type CardRead = RecentCardResult | { readonly ok: false; readonly reason: 'READ_THREW' };

/**
 * Is the tenant's A2A state still what was approved? Four drifts, each of
 * which the per-message path either cannot see or sees only when a message
 * happens to arrive:
 *
 *   • CARD_MOVED_SINCE_PIN: an ACTIVE, approved peer whose LIVE card no longer
 *     hashes to its pin. Admission refuses the next message within fifteen
 *     minutes, but a peer that sends nothing for a month is refused by nobody,
 *     and nobody is told. Read through `recentAgentCard`, the same ≤15-minute
 *     copy admission compares against, so the check and the gate cannot
 *     disagree about what the peer serves. The card's TEXT is never recorded:
 *     only which components moved.
 *   • SIGNING_KEY_PAST_ROTATION_AGE: the key in force is older than
 *     `A2A_SIGNING_KEY_MAX_AGE_DAYS` (or the plan's own age). Asked only while
 *     the tenant has an ACTIVE peer, which is when the key is in use.
 *   • RECEIPT_DOES_NOT_VERIFY: a stored receipt, among the newest
 *     `A2A_RECEIPT_SAMPLE_SIZE`, that no longer verifies against the key its
 *     row names (`storedReceiptVerificationKey`, the receipts list's own rule).
 *     The rows are write-once by trigger, so a failure is evidence of a change
 *     below the application or of a key row that moved.
 *   • PEER_LEFT_UNPINNED: an ACTIVE peer with no approved card past
 *     `A2A_UNPINNED_GRACE_DAYS`.
 *
 * FAIL CLOSED. A pinned peer whose live card cannot be read, or a receipt whose
 * key is not held here, is not a pass: with no breach elsewhere the result is
 * INCONCLUSIVE (`A2A_STATE_UNVERIFIABLE`), and a breach still FAILS. Zero
 * ACTIVE peers and zero stored receipts is `NO_A2A_PEERS`, vacuous: nothing to
 * check, never a PASS. A database read that throws throws, and the runner
 * records the run as errored.
 *
 * Unlike the other checks this one reads the network, inside the runner's
 * transaction (`AUTOMATED_RUN_TX_TIMEOUT_MS`, 120 s). The reads are parallel,
 * each is bounded by the card fetch's own timeout, and `PEER_SCAN_CAP` bounds
 * how many there are.
 */
export async function checkA2aIntegrity(
    db: PrismaTx,
    tenantId: string,
    now: Date,
    opts: { signingKeyMaxAgeDays?: number; readCard?: A2aCardReader } = {},
): Promise<AgenticCheckOutcome> {
    const maxKeyAgeDays = opts.signingKeyMaxAgeDays ?? A2A_SIGNING_KEY_MAX_AGE_DAYS;
    const readCard: A2aCardReader = opts.readCard ?? ((key) => recentAgentCard(key));

    const scannedPeers = await db.peerAgent.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: {
            id: true,
            cardUrl: true,
            createdAt: true,
            pinnedCardHash: true,
            pinnedTextHash: true,
            pinnedEndpointHash: true,
            pinnedOtherHash: true,
            pinRevision: true,
        },
        orderBy: { id: 'asc' },
        take: PEER_SCAN_CAP + 1,
    });
    const peerScanTruncated = scannedPeers.length > PEER_SCAN_CAP;
    const peers = peerScanTruncated ? scannedPeers.slice(0, PEER_SCAN_CAP) : scannedPeers;

    const sampled = await db.peerAgentMessage.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
            peerId: true,
            direction: true,
            receiptJson: true,
            signature: true,
            signerKeyFingerprint: true,
            body: true,
        },
        take: A2A_RECEIPT_SAMPLE_SIZE + 1,
    });
    const receiptSampleFull = sampled.length > A2A_RECEIPT_SAMPLE_SIZE;
    const receipts = receiptSampleFull ? sampled.slice(0, A2A_RECEIPT_SAMPLE_SIZE) : sampled;

    if (peers.length === 0 && receipts.length === 0) {
        return {
            checkId: 'AGENTIC_A2A_INTEGRITY',
            verdict: 'INCONCLUSIVE',
            basis: 'NO_A2A_PEERS',
            vacuous: true,
            population: 0,
            breaches: 0,
            truncated: false,
            facts: ['activePeers=0', 'receiptsSampled=0'],
        };
    }

    // The keys the sampled receipts name: the peers' registered keys (any
    // status, so a receipt from a peer since suspended still verifies) and the
    // tenant's own, in force or retired. Public halves only; the seed is never
    // selected.
    const receiptPeerIds = [...new Set(receipts.filter((r) => r.direction === 'INBOUND').map((r) => r.peerId))];
    const ownFingerprints = [
        ...new Set(receipts.filter((r) => r.direction === 'OUTBOUND').map((r) => r.signerKeyFingerprint)),
    ];
    const receiptPeers =
        receiptPeerIds.length === 0
            ? []
            : await db.peerAgent.findMany({
                  where: { tenantId, id: { in: receiptPeerIds } },
                  select: { id: true, signingPublicKey: true, signingKeyFingerprint: true },
                  take: receiptPeerIds.length,
              });
    const ownKeys =
        ownFingerprints.length === 0
            ? []
            : await db.tenantA2aSigningKey.findMany({
                  where: { tenantId, fingerprint: { in: ownFingerprints } },
                  select: { fingerprint: true, publicKey: true },
                  take: ownFingerprints.length,
              });
    const inForce = await db.tenantA2aSigningKey.findFirst({
        where: { tenantId, retiredAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
    });

    const facts: string[] = [];
    let breaches = 0;
    let unverifiable = 0;

    // ── Peers: left unpinned, or a live card that moved off its pin ──
    let awaitingPin = 0;
    const pinned: { id: string; cardUrl: string; pin: NonNullable<ReturnType<typeof pinnedCardHashesOf>> }[] = [];
    for (const peer of peers) {
        const pin = pinnedCardHashesOf(peer);
        if (pin) {
            pinned.push({ id: peer.id, cardUrl: peer.cardUrl, pin });
            continue;
        }
        const ageDays = (now.getTime() - peer.createdAt.getTime()) / DAY_MS;
        if (ageDays > A2A_UNPINNED_GRACE_DAYS) {
            breaches += 1;
            facts.push(`peer=${peer.id} code=PEER_LEFT_UNPINNED ageDays=${Math.floor(ageDays)}`);
        } else {
            awaitingPin += 1;
        }
    }

    const reads: CardRead[] = await Promise.all(
        pinned.map((p) =>
            readCard({ tenantId, peerId: p.id, cardUrl: p.cardUrl }).catch(
                (): CardRead => ({ ok: false, reason: 'READ_THREW' }),
            ),
        ),
    );
    pinned.forEach((p, i) => {
        const read = reads[i];
        if (!read.ok) {
            unverifiable += 1;
            facts.push(`peer=${p.id} code=PEER_CARD_UNREADABLE reason=${read.reason}`);
            return;
        }
        const verdict = compareAgentCard(read.hashes, p.pin);
        if (verdict.status === 'CHANGED') {
            breaches += 1;
            facts.push(
                `peer=${p.id} code=CARD_MOVED_SINCE_PIN revision=${verdict.revision} ` +
                    `moved=${verdict.moved.join('|') || 'CARD'}`,
            );
        }
    });

    // ── The signing key in force ─────────────────────────────────────
    let keyExamined = 0;
    if (peers.length > 0) {
        if (!inForce) {
            facts.push('signingKey=none');
        } else {
            keyExamined = 1;
            const ageDays = (now.getTime() - inForce.createdAt.getTime()) / DAY_MS;
            if (ageDays > maxKeyAgeDays) {
                breaches += 1;
                facts.push(
                    `signingKey=${inForce.id} code=SIGNING_KEY_PAST_ROTATION_AGE ` +
                        `ageDays=${Math.floor(ageDays)} maxAgeDays=${maxKeyAgeDays}`,
                );
            }
        }
    }

    // ── Stored receipts ──────────────────────────────────────────────
    const peerById = new Map(receiptPeers.map((p) => [p.id, p] as const));
    const ownKeyByFingerprint = new Map(ownKeys.map((k) => [k.fingerprint, k.publicKey] as const));
    let receiptsFailing = 0;
    for (const r of receipts) {
        const key = storedReceiptVerificationKey(r, peerById.get(r.peerId) ?? null, ownKeyByFingerprint);
        if (key === null) {
            unverifiable += 1;
            facts.push(`receipt=${r.id} peer=${r.peerId} direction=${r.direction} code=RECEIPT_KEY_NOT_HELD`);
            continue;
        }
        if (!verifyStoredA2aReceipt(r, key, r.signerKeyFingerprint)) {
            receiptsFailing += 1;
            facts.push(`receipt=${r.id} peer=${r.peerId} direction=${r.direction} code=RECEIPT_DOES_NOT_VERIFY`);
        }
    }
    breaches += receiptsFailing;

    const verdict: AgenticCheckOutcome['verdict'] =
        breaches > 0 ? 'FAIL' : unverifiable > 0 ? 'INCONCLUSIVE' : 'PASS';
    const basis =
        breaches > 0 ? 'A2A_STATE_DRIFTED' : unverifiable > 0 ? 'A2A_STATE_UNVERIFIABLE' : 'A2A_STATE_AS_APPROVED';

    return {
        checkId: 'AGENTIC_A2A_INTEGRITY',
        verdict,
        basis,
        vacuous: false,
        population: peers.length + keyExamined + receipts.length,
        breaches,
        // The receipts are a SAMPLE: when more exist than it holds, the numbers
        // cover the newest of them, not the whole.
        truncated: peerScanTruncated || receiptSampleFull,
        facts: bounded([
            `activePeers=${peers.length}`,
            `pinnedPeers=${pinned.length}`,
            `awaitingPin=${awaitingPin}`,
            `unpinnedGraceDays=${A2A_UNPINNED_GRACE_DAYS}`,
            `signingKeyMaxAgeDays=${maxKeyAgeDays}`,
            `receiptsSampled=${receipts.length}`,
            `receiptSampleSize=${A2A_RECEIPT_SAMPLE_SIZE}`,
            `receiptsFailing=${receiptsFailing}`,
            `unverifiable=${unverifiable}`,
            ...facts,
        ]),
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
    /** A2A_INTEGRITY only. How old the in-force signing key may be, in days. */
    signingKeyMaxAgeDays?: number;
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

    const signingKeyMaxAgeDays =
        typeof raw.signingKeyMaxAgeDays === 'number' &&
        Number.isInteger(raw.signingKeyMaxAgeDays) &&
        raw.signingKeyMaxAgeDays >= 30 &&
        raw.signingKeyMaxAgeDays <= 1095
            ? raw.signingKeyMaxAgeDays
            : undefined;

    return { check: check as AgenticCheckId, windowDays, maxAgeHours, signingKeyMaxAgeDays };
}

/** Run one check by id. Exported so a test drives the check without the runner. */
export async function runAgenticCheck(
    db: PrismaTx,
    tenantId: string,
    config: AgenticCheckConfig,
    now: Date,
    deps: { readCard?: A2aCardReader } = {},
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
        case 'AGENTIC_A2A_INTEGRITY':
            return checkA2aIntegrity(db, tenantId, now, {
                signingKeyMaxAgeDays: config.signingKeyMaxAgeDays,
                readCard: deps.readCard,
            });
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
 *
 * ── ONE SLOT, TWO ENGINE FAMILIES ───────────────────────────────────────────
 *
 * `runnerHandlerRegistry` holds one handler per automation type and throws on
 * a second registration, and this handler holds INTEGRATION. The auditor
 * agent's audit procedures (#3676, `./audit-procedures`) are the second family
 * on it: a config naming `check` is one of the four checks above, a config
 * naming `procedure` is an audit procedure, and anything else is declined by
 * both and goes down the manual path. Neither family answers for the other's
 * plans, and there is still one runner.
 */
export const agenticControlTestHandler: AutomationHandler = async (
    input: AutomationHandlerInput,
): Promise<AutomationHandlerResult | null> => {
    const config = parseAgenticCheckConfig(input.automationConfig);
    if (!config) return auditProcedureHandler(input);

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
