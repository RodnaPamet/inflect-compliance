/**
 * WHAT EACH NUMBER MEANS — shipped in the same payload as the number.
 *
 * A report that renders is not a report that is true. "12 agents" is not a fact
 * until somebody has written down which twelve: over what population, at what
 * moment, counting retired ones or not. An assessor asks that about every
 * figure, and a number whose definition nobody wrote down is one nobody can
 * defend — so the definition travels WITH the figure rather than living in a
 * wiki that the query will outlive.
 *
 * Three fields carry the weight, and each answers a question that has actually
 * been asked of a compliance report:
 *
 *   • `population` — which ROWS. Not "agents" but "rows in `RegisteredAgent`
 *     for this tenant". The table is the only unambiguous name for a
 *     population.
 *   • `moment` — WHEN it is true of. `AS_OF_GENERATION` is a snapshot that
 *     changes under you; `OVER_WINDOW` is a period, and a period-scoped number
 *     compared against a snapshot one is a category error.
 *   • `includes` / `excludes` — the edges. Every exclusion here is a decision
 *     somebody could reasonably have made the other way, which is exactly why
 *     it has to be stated: soft-deleted rows, the legacy placeholder agent, the
 *     drill canary's kills. A reader who disagrees with an exclusion can at
 *     least SEE it.
 *
 * ## Why a registry rather than a comment beside each query
 *
 * Because the payload has to carry it. A comment binds the module; a registry
 * entry can be serialised next to the figure it describes, and the report
 * builder resolves every metric key through here — so a metric that ships
 * without a definition is a detectable defect rather than an oversight nobody
 * can see. `tests/integration/agentic-reports.test.ts` asserts the coverage is
 * total in both directions.
 *
 * Pure data. No clock, no I/O.
 */

/** Whether a figure is a snapshot or a period. */
export type MetricMoment = 'AS_OF_GENERATION' | 'OVER_WINDOW';

export interface MetricDefinition {
    readonly id: string;
    /** Short human label. Not a definition — the three fields below are. */
    readonly label: string;
    /** The rows counted, named by table wherever a table is the honest answer. */
    readonly population: string;
    readonly moment: MetricMoment;
    /** What is deliberately counted IN. */
    readonly includes: readonly string[];
    /** What is deliberately counted OUT, and therefore arguable. */
    readonly excludes: readonly string[];
}

/** Shared exclusions, written once so two metrics cannot drift apart. */
const AGENT_ROW_EXCLUSIONS = [
    'soft-deleted agents (RegisteredAgent.deletedAt IS NOT NULL)',
    'the legacy placeholder row (isLegacyPlaceholder = true), which adopts ' +
        'pre-register proposals and is never a real agent',
] as const;

function agentPopulation(qualifier: string): string {
    return `rows in RegisteredAgent for this tenant${qualifier ? `, ${qualifier}` : ''}`;
}

/**
 * The dictionary. Keys are stable external identifiers — an assessor may cite
 * one in a finding, so they are authored, never generated, and never renamed.
 */
export const METRIC_DEFINITIONS = {
    // ── Inventory ────────────────────────────────────────────────────
    'inventory.registered_agents': {
        id: 'inventory.registered_agents',
        label: 'Registered agents',
        population: agentPopulation(''),
        moment: 'AS_OF_GENERATION',
        includes: [
            'every lifecycle status — DRAFT, ACTIVE, SUSPENDED and RETIRED',
            'agents currently stopped by a kill switch (the row still exists)',
        ],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'inventory.active_agents': {
        id: 'inventory.active_agents',
        label: 'Agents in ACTIVE status',
        population: agentPopulation('status = ACTIVE'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents an unlifted kill switch is currently stopping — status is ' +
                'the register’s state, the kill is a separate axis reported ' +
                'per row as killState',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'DRAFT agents, which have never been admitted',
            'SUSPENDED and RETIRED agents',
        ],
    },
    'inventory.retired_agents': {
        id: 'inventory.retired_agents',
        label: 'Agents in RETIRED status',
        population: agentPopulation('status = RETIRED'),
        moment: 'AS_OF_GENERATION',
        includes: ['agents retired at any time, however long ago'],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'soft-deleted agents, which are a different end state from retirement',
        ],
    },
    'inventory.unscored_agents': {
        id: 'inventory.unscored_agents',
        label: 'Agents with no risk tier',
        population: agentPopulation('riskTier IS NULL'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents registered but never assessed — the state between insert ' +
                'and the first completed scoring run',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents whose assessment is COMPLETED but has since gone stale — ' +
                'those carry a tier and are counted by inventory.stale_assessments',
        ],
    },
    'inventory.stale_assessments': {
        id: 'inventory.stale_assessments',
        label: 'Agents whose assessment is stale',
        population: agentPopulation(
            'with a COMPLETED AgentRiskAssessment whose staleAt IS NOT NULL',
        ),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents whose autonomy, tool grants, data scope, reversibility or ' +
                'declared model moved after the tier was scored',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'never-assessed agents — an absent judgement is not a stale one',
        ],
    },
    'inventory.unattended_agents': {
        id: 'inventory.unattended_agents',
        label: 'Agents at unattended autonomy',
        population: agentPopulation('autonomyLevel >= UNATTENDED_AUTONOMY (5)'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'the REGISTERED autonomy level, which is a declaration by the ' +
                'operator, not an observation of what the agent did',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'any narrowing a policy card’s autonomy ceiling imposes at the ' +
                'tool boundary — the ceiling is enforcement, this column is the claim',
        ],
    },
    'inventory.third_party_agents': {
        id: 'inventory.third_party_agents',
        label: 'Third-party agents',
        population: agentPopulation('provenance = THIRD_PARTY'),
        moment: 'AS_OF_GENERATION',
        includes: ['agents supplied by a named vendor (the schema requires one)'],
        excludes: [...AGENT_ROW_EXCLUSIONS, 'FIRST_PARTY agents'],
    },
    'inventory.agents_without_policy_card': {
        id: 'inventory.agents_without_policy_card',
        label: 'Agents with no policy card',
        population: agentPopulation('with no AgentPolicyCard row'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents registered before the policy card existed, for which the ' +
                'tool boundary contributes no card term',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents holding a card whose current version grants nothing — that ' +
                'is a card, and a restrictive one',
        ],
    },

    // ── ASI01–ASI10 coverage ────────────────────────────────────────
    'asi.agents_in_scope': {
        id: 'asi.agents_in_scope',
        label: 'Agents the coverage matrix covers',
        population: agentPopulation(''),
        moment: 'AS_OF_GENERATION',
        includes: ['every registered agent, whatever its status'],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'asi.risks_in_framework': {
        id: 'asi.risks_in_framework',
        label: 'Distinct agentic risks in the installed framework',
        population:
            'distinct FrameworkRequirement.code rows across EVERY installed ' +
            'representation of the OWASP Agentic Top 10 (the seeded and the ' +
            'library-synced framework rows are one family)',
        moment: 'AS_OF_GENERATION',
        includes: ['codes present in either representation'],
        excludes: ['deprecated requirement rows (deprecatedAt IS NOT NULL)'],
    },
    'asi.agents_fully_covered': {
        id: 'asi.agents_fully_covered',
        label: 'Agents with no uncovered agentic risk',
        population: agentPopulation('scored against the installed framework'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents for which every risk resolves to covered or partially ' +
                'covered by a direct or inherited control',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents with any risk in the review-needed bucket — a route that ' +
                'needs a human decision is not coverage',
            'risks the register shows do not apply to that agent (zero tool ' +
                'grants for ASI02, autonomy 0 for ASI08) — they are neither ' +
                'covered nor a gap, so they cannot keep an agent out of this count',
        ],
    },
    'asi.risks_covered_by_no_agent': {
        id: 'asi.risks_covered_by_no_agent',
        label: 'Agentic risks no agent covers',
        population: 'the distinct risk codes counted by asi.risks_in_framework',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a risk that is uncovered or review-needed for every agent it ' +
                'applies to, and applies to at least one of them',
        ],
        excludes: [
            'risks covered for at least one agent, however many others leave ' +
                'them open — this is a floor, not an average',
            'risks that apply to no agent in the population — nobody covering ' +
                'a risk nobody is exposed to is not a gap',
        ],
    },

    // ── Approval statistics ──────────────────────────────────────────
    'approvals.decided': {
        id: 'approvals.decided',
        label: 'Proposals a human decided',
        population:
            'rows in AgentProposal with status in (ACCEPTED, EDITED, REJECTED), ' +
            'reviewedByUserId set and reviewedAt inside the window',
        moment: 'OVER_WINDOW',
        includes: ['decisions on proposals from any agent, including unattributed ones'],
        excludes: [
            'PENDING proposals, which nobody has decided',
            'EXPIRED proposals, which closed without a decision',
            'decisions beyond the report row cap, which the payload flags as truncated',
        ],
    },
    'approvals.approved': {
        id: 'approvals.approved',
        label: 'Proposals approved',
        population: 'the decided proposals above with status in (ACCEPTED, EDITED)',
        moment: 'OVER_WINDOW',
        includes: ['EDITED, where the human changed the payload before accepting it'],
        excludes: ['REJECTED proposals'],
    },
    'approvals.rejected': {
        id: 'approvals.rejected',
        label: 'Proposals rejected',
        population: 'the decided proposals above with status = REJECTED',
        moment: 'OVER_WINDOW',
        includes: ['every rejection, whatever the reason'],
        excludes: ['proposals that expired unreviewed'],
    },
    'approvals.approval_rate': {
        id: 'approvals.approval_rate',
        label: 'Share of decisions that approved',
        population: 'approvals.approved over approvals.decided',
        moment: 'OVER_WINDOW',
        includes: ['a value in 0..1'],
        excludes: [
            'any figure at all when nothing was decided — an empty denominator ' +
                'reports NO_POPULATION rather than 0, which would read as ' +
                '"everything was rejected"',
        ],
    },
    'approvals.fastest_decision_seconds': {
        id: 'approvals.fastest_decision_seconds',
        label: 'Fastest decision in the window',
        population: 'the minimum decision latency across every reviewer in the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a single OBSERVATION, reported at any sample size — unlike the ' +
                'per-reviewer estimates, which the engine refuses below its floor',
        ],
        excludes: ['reviewers with no decision in the window'],
    },
    'approvals.reviewers': {
        id: 'approvals.reviewers',
        label: 'Distinct humans who decided something',
        population: 'distinct AgentProposal.reviewedByUserId inside the window',
        moment: 'OVER_WINDOW',
        includes: ['anyone who decided at least one proposal'],
        excludes: [
            'people with permission to review who did not — the queue records ' +
                'decisions, not eligibility',
        ],
    },
    'approvals.reviewers_below_reportable_sample': {
        id: 'approvals.reviewers_below_reportable_sample',
        label: 'Reviewers with too few decisions to estimate',
        population: 'reviewers whose decision count is under the engine’s minimum sample',
        moment: 'OVER_WINDOW',
        includes: [
            'reviewers for whom rate and median estimates are visibly REFUSED ' +
                'rather than computed from a handful of decisions',
        ],
        excludes: ['reviewers at or above the floor'],
    },
    'approvals.bias_signals': {
        id: 'approvals.bias_signals',
        label: 'Automation-bias patterns that fired',
        population: 'signals returned by the automation-bias engine over the window',
        moment: 'OVER_WINDOW',
        includes: [
            'bulk-approval bursts, implausibly fast decisions, fast medians, ' +
                'never-rejected reviewers and declared-but-unrecorded second approvers',
        ],
        excludes: [
            'whether the proposal content was ever actually read — the queue ' +
                'records decisions, never attention, and the payload names that ' +
                'question as unobservable rather than approximating it',
        ],
    },
    'approvals.pending_now': {
        id: 'approvals.pending_now',
        label: 'Proposals awaiting a decision',
        population: 'rows in AgentProposal with status = PENDING',
        moment: 'AS_OF_GENERATION',
        includes: [
            'every pending row regardless of age — this is a snapshot and NOT ' +
                'scoped to the report window, because queue depth now is what ' +
                'drives rubber-stamping now',
        ],
        excludes: ['proposals already moved to EXPIRED by the expiry sweep'],
    },
    'approvals.sample_audits_answered': {
        id: 'approvals.sample_audits_answered',
        label: 'Retrospective sample audits answered',
        population:
            'rows in AgentProposalSampleAudit sampled inside the window whose ' +
            'outcome has left PENDING',
        moment: 'OVER_WINDOW',
        includes: ['CONCURRED, DISSENTED and INDETERMINATE answers'],
        excludes: [
            'drawn-but-unanswered audits — counting them would improve the ' +
                'disagreement rate every time the sampler ran and nobody did the work',
        ],
    },
    'approvals.sample_audit_disagreement_rate': {
        id: 'approvals.sample_audit_disagreement_rate',
        label: 'Share of answered sample audits that dissented',
        population: 'DISSENTED over answered, inside the window',
        moment: 'OVER_WINDOW',
        includes: ['a value in 0..1 — the number the approval queue is judged on'],
        excludes: [
            'any figure when nothing was answered — a tenant with a perfect ' +
                'record and a tenant nobody reviewed both produce zero dissents',
        ],
    },

    // The content guard's three states. `guardVerdict` alone cannot tell a
    // clean scan from no scan — see `lib/agentic/proposal-guard-state.ts`.
    'approvals.guard_flagged': {
        id: 'approvals.guard_flagged',
        label: 'Proposals the content guard refused',
        population: "rows in AgentProposal whose guardVerdict is not CLEAN",
        moment: 'AS_OF_GENERATION',
        includes: [
            'both non-clean verdicts — FLAGGED (surfaced to a reviewer with its ' +
                'rule ids) and QUARANTINED (withheld from the review queue ' +
                'entirely). Both mean the guard looked and objected',
            'proposals since decided by a human — the guard\u2019s verdict is a ' +
                'record of what it saw, not of what happened next',
        ],
        excludes: [
            'proposals written before the guard existed, which carry the column ' +
                'default CLEAN and no guardInputDigest — those are counted ' +
                'separately by approvals.guard_unscanned',
        ],
    },
    'approvals.guard_unscanned': {
        id: 'approvals.guard_unscanned',
        label: 'Proposals no content guard ever scanned',
        population:
            'rows in AgentProposal with guardVerdict = CLEAN and guardInputDigest IS NULL',
        moment: 'AS_OF_GENERATION',
        includes: [
            'every proposal that entered the queue before the guard shipped — the ' +
                'column is NOT NULL DEFAULT CLEAN and the migration ran no ' +
                'backfill, so CLEAN on these rows means "not refused", never ' +
                '"scanned and found clean"',
        ],
        excludes: [
            'scanned proposals, whichever way the scan went — the digest is the ' +
                'discriminator, and it is written on every proposal the guard decides',
        ],
    },
    'approvals.guard_clean': {
        id: 'approvals.guard_clean',
        label: 'Proposals the content guard scanned and passed',
        population:
            'rows in AgentProposal with guardVerdict = CLEAN and a non-null guardInputDigest',
        moment: 'AS_OF_GENERATION',
        includes: [
            'the remainder: total proposals minus refused minus unscanned, so the ' +
                'three guard figures always sum to the population rather than ' +
                'being three counts that can disagree under a concurrent write',
        ],
        excludes: [
            'pre-guard rows, which look identical in the column and are counted ' +
                'by approvals.guard_unscanned instead',
        ],
    },

    // ── Incident and kill-switch history ─────────────────────────────
    'incidents.guard_blocks': {
        id: 'incidents.guard_blocks',
        label: 'Guard blocks',
        population:
            'QUARANTINED verdicts inside the window, across BOTH places one ' +
            'can land: AgentProposal rows the guard quarantined, and ' +
            'WorkflowStep rows a run was stopped at',
        moment: 'OVER_WINDOW',
        includes: [
            'blocks that produced a proposal, and blocks on a reasoning run ' +
                'that produced no proposal at all — the second is the only ' +
                'trace a Flue block leaves',
            'blocks on a run that began before the window; the step carries ' +
                'its own stamp, and a run blocked inside the window was ' +
                'blocked inside it',
        ],
        excludes: [
            'FLAGGED verdicts, which pause for review rather than stop — those ' +
                'are counted by approvals.guard_flagged',
            'runs the circuit breaker then latched; the trip is counted ' +
                'separately by incidents.breaker_trips, and one cause can ' +
                'produce both',
        ],
    },
    // ── RUNS BY STATUS (#3484, point 10's third outstanding item) ────
    //
    // The surface map marked `/agents/reports` open for "guard-block counts,
    // token spend, runs by status". Two of the three landed before this:
    // `incidents.guard_blocks` above, and spend through
    // `evaluateMonthlyBudgetForRun`. Runs by status was the one left.
    //
    // SIX MEASURES AND NOT ONE MAP, because the pack's measure vocabulary is
    // flat by design: every figure carries its own population, its own
    // includes and its own excludes, and a `Record<status, number>` would
    // carry one description for six different questions. It also makes each
    // one individually citable from a finding.
    //
    // The terminal three are OVER_WINDOW and the live three are AS_OF_GENERATION,
    // and that distinction is the whole reason this is not one number. "How
    // many runs failed last quarter" and "how many are stuck awaiting approval
    // right now" are different questions, and a single snapshot answers
    // neither: a completed run leaves the live count the moment it finishes,
    // so a snapshot of COMPLETED is a count of runs that happen to have
    // finished since the last sweep.
    'runs.completed': {
        id: 'runs.completed',
        label: 'Runs completed',
        population: 'WorkflowRun rows that reached COMPLETED, started inside the window',
        moment: 'OVER_WINDOW',
        includes: ['runs started by a person and runs started by an automation rule'],
        excludes: [
            'runs still in flight, which are counted by the three AT_GENERATION ' +
                'measures below',
            'runs started before the window, however they ended — the window is ' +
                'on startedAt, so a quarter reports the runs it began',
        ],
    },
    'runs.failed': {
        id: 'runs.failed',
        label: 'Runs failed',
        population: 'WorkflowRun rows that reached FAILED, started inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'runs the reaper settled as having no executor — a deploy that ' +
                'stranded a run looks like a failure here, which is honest: it ' +
                'did not complete',
        ],
        excludes: [
            'runs ABORTED by a guard block or a kill, counted separately — the ' +
                'cause is different and so is what an operator does about it',
        ],
    },
    'runs.aborted': {
        id: 'runs.aborted',
        label: 'Runs aborted',
        population: 'WorkflowRun rows that reached ABORTED, started inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'runs a guard BLOCKED, runs a kill switch stopped, and runs an ' +
                'operator aborted by hand',
        ],
        excludes: [
            'runs that FAILED, which nothing stopped deliberately',
            'the reason for each abort; this is a count, and the trail carries ' +
                'the cause per run',
        ],
    },
    'runs.in_flight': {
        id: 'runs.in_flight',
        label: 'Runs in flight now',
        population: 'WorkflowRun rows in RUNNING, at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: ['runs this deployment is executing and runs stranded by a deploy'],
        excludes: [
            'runs AWAITING_APPROVAL or PAUSED, which are in flight in the ' +
                'concurrent-run cap\'s sense but are waiting on a person rather ' +
                'than executing — those are their own measures',
        ],
    },
    'runs.awaiting_approval': {
        id: 'runs.awaiting_approval',
        label: 'Runs awaiting approval',
        population:
            'WorkflowRun rows in AWAITING_APPROVAL, at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: [
            'runs parked at a human checkpoint, and runs a guard FLAGGED for ' +
                'review',
        ],
        excludes: [
            'runs whose approval window has EXPIRED but whose status has not ' +
                'moved; the status is what this counts, and expiry is a ' +
                'separate question the approval-window measures answer',
        ],
    },
    'runs.paused': {
        id: 'runs.paused',
        label: 'Runs paused',
        population: 'WorkflowRun rows in PAUSED, at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: [
            'runs a SIGTERM paused on the way out of a deploy, which is the ' +
                'state that makes them resumable rather than reaped',
        ],
        excludes: ['runs awaiting a person, which are their own measure above'],
    },
    'incidents.kill_engagements': {
        id: 'incidents.kill_engagements',
        label: 'Kill switches engaged',
        population: 'rows in AgentKillSwitch engaged inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'both scopes — a tenant-wide kill (agentId IS NULL) and a per-agent one',
            'kills that have since been lifted; the row is the record of the window',
        ],
        excludes: [
            'the scheduled drill’s canary kills, which are exercises against ' +
                'an id no credential resolves to and are counted separately',
            'OWNER_DEPARTED kills (reasonCode = OWNER_DEPARTED), which the ' +
                'owner-orphan pass engages because an agent’s accountable owner ' +
                'left — a lifecycle containment, not an incident, counted ' +
                'separately as incidents.owner_departed_engagements',
            'the platform-wide kill, which is global and has no tenant to scope to',
        ],
    },
    'incidents.owner_departed_engagements': {
        id: 'incidents.owner_departed_engagements',
        label: 'Kills engaged because an agent’s owner left',
        population:
            'rows in AgentKillSwitch engaged inside the window with reasonCode = ' +
            'OWNER_DEPARTED',
        moment: 'OVER_WINDOW',
        includes: [
            'every OWNER_DEPARTED kill the owner-orphan pass engaged, as the system ' +
                'actor system:agent-owner-orphan-pass, whether or not it has since been ' +
                'lifted after a completed ownership transfer',
        ],
        excludes: [
            'kills a person engaged, whatever their reason text says — the code is a ' +
                'column only the system writes, never the free-text reason',
            'agents the pass found at DRY_RUN, which it recorded and did not stop',
            'the drill canary’s kills',
        ],
    },
    'incidents.owner_departed_in_force_now': {
        id: 'incidents.owner_departed_in_force_now',
        label: 'OWNER_DEPARTED kills currently in force',
        population:
            'rows in AgentKillSwitch with reasonCode = OWNER_DEPARTED and liftedAt IS NULL',
        moment: 'AS_OF_GENERATION',
        includes: [
            'kills engaged before the report window and still in force — each is an ' +
                'agent waiting for an ownership transfer to complete',
        ],
        excludes: ['kills a person engaged', 'drill canary kills', 'the global platform kill'],
    },
    'incidents.drill_canary_engagements': {
        id: 'incidents.drill_canary_engagements',
        label: 'Drill canary kills',
        population:
            'rows in AgentKillSwitch inside the window naming the drill canary agent id',
        moment: 'OVER_WINDOW',
        includes: ['exercises the scheduled drill engaged and lifted itself'],
        excludes: ['kills a human engaged against a real agent'],
    },
    'incidents.kills_in_force_now': {
        id: 'incidents.kills_in_force_now',
        label: 'Kill switches currently in force',
        population: 'rows in AgentKillSwitch with liftedAt IS NULL',
        moment: 'AS_OF_GENERATION',
        includes: [
            'kills engaged before the report window — a stop still in force is a ' +
                'fact about now, not about the window',
        ],
        excludes: [
            'drill canary kills',
            'OWNER_DEPARTED kills, counted as incidents.owner_departed_in_force_now',
            'the global platform kill',
        ],
    },
    'incidents.longest_kill_minutes': {
        id: 'incidents.longest_kill_minutes',
        label: 'Longest kill window in the report window',
        population: 'engaged-to-lifted duration of the kills counted above',
        moment: 'OVER_WINDOW',
        includes: [
            'a kill still in force, measured to the report generation instant ' +
                'and flagged per row as unlifted',
        ],
        excludes: [
            'drill canary kills',
            'OWNER_DEPARTED kills, which last as long as an ownership transfer takes ' +
                'and are not an incident’s duration',
        ],
    },
    'incidents.drills_run': {
        id: 'incidents.drills_run',
        label: 'Kill-switch drills run',
        population: 'rows in AgentKillSwitchDrill started inside the window',
        moment: 'OVER_WINDOW',
        includes: ['every outcome — PASSED, FAILED and ERROR'],
        excludes: ['drills started before the window'],
    },
    'incidents.drills_failed': {
        id: 'incidents.drills_failed',
        label: 'Drills that FAILED',
        population: 'the drills above with outcome = FAILED',
        moment: 'OVER_WINDOW',
        includes: ['drills where the stop control did not stop something'],
        excludes: [
            'ERROR drills, which proved nothing rather than proving the control ' +
                'broken — collapsing the two would raise a finding about the wrong thing',
        ],
    },
    'incidents.drills_errored': {
        id: 'incidents.drills_errored',
        label: 'Drills that could not run',
        population: 'the drills above with outcome = ERROR',
        moment: 'OVER_WINDOW',
        includes: ['drills that could not complete, and so evidence nothing'],
        excludes: ['FAILED drills'],
    },
    'incidents.tool_calls_after_kill': {
        id: 'incidents.tool_calls_after_kill',
        label: 'Tool calls that got through after a kill',
        population:
            'sum of AgentKillSwitchDrill.toolCallsAfterKill over the drills above ' +
            'that actually MEASURED something — a drill whose outcome is ERROR ' +
            'could not run and measured nothing',
        moment: 'OVER_WINDOW',
        includes: [
            'every call the boundary admitted while a kill was in force; anything ' +
                'other than zero is the control failing',
        ],
        excludes: [
            'any figure at all when no drill ran — summing an empty list to zero ' +
                'would make a tenant that never tested its stop control ' +
                'indistinguishable from one whose control is proven',
            'drills whose outcome is ERROR. Such a drill is a ROW but not a ' +
                'MEASUREMENT: it could not run, so it proves nothing either way, ' +
                'and `toolCallsAfterKill` is left at its column default of 0. ' +
                'Counting it summed that default into the strongest claim this ' +
                'product makes, so a tenant whose only drill BROKE read exactly ' +
                'like one whose stop control is proven. "Never drilled" and ' +
                '"drilled and the drill broke" demand different actions and now ' +
                'carry different bases',
        ],
    },
    'incidents.breaker_trips': {
        id: 'incidents.breaker_trips',
        label: 'Circuit breakers that tripped',
        population: 'rows in AgentCircuitBreaker whose trippedAt falls inside the window',
        moment: 'OVER_WINDOW',
        includes: ['a breaker that tripped and has since been closed'],
        excludes: [
            'breakers that have never tripped, and agents with no breaker row at all',
        ],
    },
    'incidents.breakers_open_now': {
        id: 'incidents.breakers_open_now',
        label: 'Circuit breakers currently open',
        population: 'rows in AgentCircuitBreaker with state = OPEN',
        moment: 'AS_OF_GENERATION',
        includes: [
            'breakers tripped before the window — nothing closes itself, so an ' +
                'open breaker is open until a human closes it',
        ],
        excludes: ['closed breakers, whatever their close reason'],
    },

    // The monthly token budget — the third stop control, alongside the kill
    // switch and the circuit breaker. It refuses a run AT THE DOOR rather than
    // truncating one mid-flight, so its figures are about admission, not damage.
    'incidents.monthly_token_budget': {
        id: 'incidents.monthly_token_budget',
        label: 'Monthly agent token budget',
        population:
            'TenantSecuritySettings.agentMonthlyTokenBudget for this tenant, the ' +
            'ceiling every run start is checked against',
        moment: 'AS_OF_GENERATION',
        includes: ['the configured number, whatever this month has actually spent'],
        excludes: [
            'an unconfigured budget, reported as NO_MONTHLY_BUDGET_CONFIGURED ' +
                'rather than as 0 — NULL means unlimited here, and a 0 would ' +
                'read as a ceiling that refuses every run',
        ],
    },
    'incidents.tokens_spent_this_month': {
        id: 'incidents.tokens_spent_this_month',
        label: 'Agent tokens spent this month',
        population:
            'the sum of costTokens over rows in WorkflowRun started on or after ' +
            'the first instant of the current UTC calendar month',
        moment: 'AS_OF_GENERATION',
        includes: [
            'the UTC calendar month rather than the report window — the budget ' +
                'this is measured against resets monthly, and a 90-day total ' +
                'would not be comparable to it',
            'runs in every terminal state, and runs still RUNNING: the tokens ' +
                'are spent whether or not the run finished',
        ],
        excludes: [
            'runs started before this month, however recently — the budget is ' +
                'a monthly allowance and last month\u2019s spend does not consume it',
        ],
    },
    'incidents.monthly_budget_remaining_tokens': {
        id: 'incidents.monthly_budget_remaining_tokens',
        label: 'Monthly token budget remaining',
        population:
            'the configured budget minus this month\u2019s spend, in tokens, for this tenant',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a NEGATIVE value when spend has passed the ceiling. The check is ' +
                'pre-flight and bounds a run by its own token cap, so an ' +
                'admitted run can still finish above the line — clamping to 0 ' +
                'would hide exactly that overshoot',
        ],
        excludes: [
            'any figure at all when no budget is configured, because subtracting ' +
                'from unlimited has no answer',
        ],
    },

    // ── Internal audit's re-performance of the auditor (#3677, step 3d) ──
    //
    // The auditor agent re-performs audit procedures and writes workpapers;
    // internal audit draws them (100% in the pilot) and re-performs each one.
    // These figures are the check on the auditor. Every one counts rows of
    // AuditWorkpaperSampleReview drawn inside the window, so the four states
    // below sum to `drawn`, and the two rates share one denominator.
    'assurance.workpaper_reviews_drawn': {
        id: 'assurance.workpaper_reviews_drawn',
        label: 'Auditor workpapers drawn for internal audit review',
        population:
            'rows in AuditWorkpaperSampleReview for this tenant whose sampledAt is inside ' +
            'the window — one per AuditWorkpaper the scheduled sweep drew at the ' +
            'tenant\u2019s rate (TenantSecuritySettings.workpaperReviewSamplePercent)',
        moment: 'OVER_WINDOW',
        includes: [
            'every state: awaiting an answer, UNASSIGNED, and answered',
            'workpapers of every procedure, period and auditor agent',
        ],
        excludes: [
            'workpapers the keyed draw passed over at a rate below 100% (at the ' +
                'pilot\u2019s 100% there are none)',
            'workpapers written since the last monthly sweep, which are not drawn yet',
        ],
    },
    'assurance.workpaper_reviews_unassigned': {
        id: 'assurance.workpaper_reviews_unassigned',
        label: 'Drawn workpapers nobody in internal audit can be asked to review',
        population:
            'the drawn rows above still PENDING with an unassignedReason: no ACTIVE ' +
            'third-line member, only the auditor agent\u2019s owner is third-line, or the ' +
            'auditor agent is no longer in the register',
        moment: 'OVER_WINDOW',
        includes: ['rows a later sweep may still assign, once somebody is eligible'],
        excludes: [
            'rows with an assigned reviewer, awaiting an answer — counted by ' +
                'assurance.workpaper_reviews_awaiting',
            'answered rows',
        ],
    },
    'assurance.workpaper_reviews_awaiting': {
        id: 'assurance.workpaper_reviews_awaiting',
        label: 'Drawn workpapers awaiting their assigned reviewer',
        population: 'the drawn rows still PENDING with an assigned third-line reviewer',
        moment: 'OVER_WINDOW',
        includes: ['rows however long they have waited — an unanswered review is the failure this counts'],
        excludes: ['UNASSIGNED rows', 'answered rows'],
    },
    'assurance.workpaper_reviews_indeterminate': {
        id: 'assurance.workpaper_reviews_indeterminate',
        label: 'Reviews that could not conclude',
        population: 'the drawn rows answered INDETERMINATE',
        moment: 'OVER_WINDOW',
        includes: [
            'answers where the reviewer could not judge the workpaper from the record — ' +
                'a finding about the record, not a vote either way',
        ],
        excludes: ['every other answer — INDETERMINATE is neither agreement nor disagreement'],
    },
    'assurance.workpaper_reviews_concluded': {
        id: 'assurance.workpaper_reviews_concluded',
        label: 'Reviews that concluded',
        population:
            'the drawn rows answered CONCURRED or DISSENTED — the denominator of both ' +
            're-performance rates',
        moment: 'OVER_WINDOW',
        includes: ['CONCURRED and DISSENTED answers, each recorded once by the assigned reviewer'],
        excludes: [
            'INDETERMINATE answers',
            'UNASSIGNED rows, which nobody could be asked to answer',
            'drawn but unreviewed rows',
        ],
    },
    'assurance.workpaper_reperformance_agreement_rate': {
        id: 'assurance.workpaper_reperformance_agreement_rate',
        label: 'Share of concluded reviews that concurred with the auditor agent',
        population: 'CONCURRED over (CONCURRED + DISSENTED), among the rows drawn inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a value in 0..1 — how often internal audit\u2019s re-performance reached the ' +
                'auditor agent\u2019s result',
        ],
        excludes: [
            'drawn but unreviewed workpapers, in neither the numerator nor the ' +
                'denominator — counting them as agreement would improve the rate every ' +
                'time the sweep ran and nobody did the work',
            'INDETERMINATE answers, which are neither agreement nor disagreement',
            'UNASSIGNED workpapers, which nobody could be asked to review',
            'any figure at all when no review concluded — zero concluded reviews is ' +
                'not "100% agreement"',
        ],
    },
    'assurance.workpaper_reperformance_disagreement_rate': {
        id: 'assurance.workpaper_reperformance_disagreement_rate',
        label: 'Share of concluded reviews that dissented from the auditor agent',
        population: 'DISSENTED over (CONCURRED + DISSENTED), among the rows drawn inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a value in 0..1, the complement of the agreement rate over the same ' +
                'denominator; each dissent queued one finding proposal for a person to decide',
        ],
        excludes: [
            'drawn but unreviewed workpapers',
            'INDETERMINATE answers',
            'UNASSIGNED workpapers',
            'any figure at all when no review concluded — a tenant whose internal ' +
                'audit concluded nothing and one that never disagreed both have zero dissents',
        ],
    },

    // ── The reliance pack (#3681) ───────────────────────────────────
    // The same rule as the two rates above over a different population: the
    // workpapers a reliance pack holds, i.e. those of a library v1 procedure
    // whose period lies wholly inside the audit cycle, not the rows drawn in
    // a rolling window. Two entries rather than a footnote on the two above,
    // because an external auditor cites the id and the population must be the
    // one the figure was computed over.
    'assurance.reliance_reperformance_agreement_rate': {
        id: 'assurance.reliance_reperformance_agreement_rate',
        label: 'Share of concluded reviews, of the workpapers relied on, that concurred with the auditor agent',
        population:
            'CONCURRED over (CONCURRED + DISSENTED), among AuditWorkpaperSampleReview rows of the ' +
            'AuditWorkpaper rows in the reliance pack: workpapers of a library v1 procedure whose ' +
            'period lies wholly inside the audit cycle’s period',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a value in 0..1, per control and once for the pack, computed when the pack was assembled',
        ],
        excludes: [
            'workpapers internal audit did not draw, listed beside the rate as not drawn',
            'drawn but unreviewed workpapers, in neither the numerator nor the denominator',
            'INDETERMINATE answers, which are neither agreement nor disagreement',
            'UNASSIGNED workpapers, which nobody could be asked to review',
            'any figure at all when no review concluded — zero concluded reviews is not "100% agreement"',
        ],
    },
    'assurance.reliance_reperformance_disagreement_rate': {
        id: 'assurance.reliance_reperformance_disagreement_rate',
        label: 'Share of concluded reviews, of the workpapers relied on, that dissented from the auditor agent',
        population:
            'DISSENTED over (CONCURRED + DISSENTED), over the same rows as ' +
            'assurance.reliance_reperformance_agreement_rate',
        moment: 'AS_OF_GENERATION',
        includes: ['a value in 0..1, the complement of the agreement rate over the same denominator'],
        excludes: [
            'workpapers not drawn, drawn but unreviewed, INDETERMINATE and UNASSIGNED, as for the agreement rate',
            'any figure at all when no review concluded',
        ],
    },

    // ── Third-party agent assessments ────────────────────────────────
    'thirdparty.agents': {
        id: 'thirdparty.agents',
        label: 'Third-party agents',
        population: agentPopulation('provenance = THIRD_PARTY'),
        moment: 'AS_OF_GENERATION',
        includes: ['every lifecycle status'],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'thirdparty.supplying_vendors': {
        id: 'thirdparty.supplying_vendors',
        label: 'Vendors supplying an agent',
        population: 'distinct Vendor rows named by a third-party agent',
        moment: 'AS_OF_GENERATION',
        includes: ['a vendor supplying several agents, counted once'],
        excludes: [
            'vendors in the register that supply no agent — this is the agentic ' +
                'supply chain, not the whole vendor book',
            'soft-deleted vendors, which are reported per agent as an unresolved supplier',
        ],
    },
    'thirdparty.vendors_without_completed_assessment': {
        id: 'thirdparty.vendors_without_completed_assessment',
        label: 'Supplying vendors with no completed assessment',
        population:
            'the supplying vendors above with no VendorAssessment in a terminal ' +
            'reviewed state (APPROVED, REVIEWED or CLOSED)',
        moment: 'AS_OF_GENERATION',
        includes: [
            'vendors with an assessment still in DRAFT, SENT, IN_PROGRESS, ' +
                'SUBMITTED or IN_REVIEW — started is not finished',
            'vendors whose only assessment was REJECTED, which is a completed ' +
                'process with an adverse result and is reported per row',
        ],
        excludes: ['vendors holding at least one terminal reviewed assessment'],
    },
    'thirdparty.tools_pinned': {
        id: 'thirdparty.tools_pinned',
        label: 'MCP tools with a pinned definition',
        population: 'rows in McpToolManifestPin for this tenant',
        moment: 'AS_OF_GENERATION',
        includes: [
            'BASELINE pins, taken on first observation with no human involved',
            'APPROVED pins, where a named human accepted a changed definition',
        ],
        excludes: [
            'tools this build serves that no agent has ever invoked here, which ' +
                'therefore have no pin',
        ],
    },
    'thirdparty.tools_human_approved': {
        id: 'thirdparty.tools_human_approved',
        label: 'Tool definitions a human accepted after a change',
        population: 'the pins above with approvalSource = APPROVED',
        moment: 'AS_OF_GENERATION',
        includes: ['pins whose definition moved and a named human re-approved it'],
        excludes: [
            'BASELINE pins — trust-on-first-use is not a human decision, and an ' +
                'auditor asking "did a person accept this description" must not ' +
                'have the two inferred from a timestamp',
        ],
    },
    'thirdparty.supplier_side_agent_changes': {
        id: 'thirdparty.supplier_side_agent_changes',
        label: 'Changes a supplier made to its own agent',
        population: 'nothing this platform can observe',
        moment: 'AS_OF_GENERATION',
        includes: [],
        excludes: [
            'everything — a third-party agent’s model, prompt and tool ' +
                'implementation live on the supplier’s side of the boundary. ' +
                'The register records what the operator DECLARES (modelRef, ' +
                'autonomy, scope) and the tool boundary records what the agent ' +
                'DID here. Neither is a view of the supplier’s build, and a ' +
                'figure derived from either would be a claim about the supplier ' +
                'made out of our own logs',
        ],
    },
} as const satisfies Record<string, MetricDefinition>;

/** Every metric key the pack may emit. */
export type MetricId = keyof typeof METRIC_DEFINITIONS;

/** All ids, sorted — a stable order for a rendered appendix. */
export const METRIC_IDS: readonly MetricId[] = Object.keys(METRIC_DEFINITIONS).sort() as MetricId[];

/**
 * Resolve the definitions for the metric keys a report emitted.
 *
 * Best-effort ON PURPOSE: an unknown key is DROPPED rather than throwing, so a
 * metric that ships without a definition degrades to a visible coverage gap in
 * the payload instead of taking the whole report down. The gap is what
 * `tests/integration/agentic-reports.test.ts` asserts against — a report whose
 * `definitions` do not cover its `metrics` is the failure this registry exists
 * to make detectable.
 */
export function definitionsFor(ids: readonly string[]): MetricDefinition[] {
    const seen = new Set<string>();
    const out: MetricDefinition[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const def: MetricDefinition | undefined = (
            METRIC_DEFINITIONS as Record<string, MetricDefinition>
        )[id];
        if (def) out.push(def);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}
