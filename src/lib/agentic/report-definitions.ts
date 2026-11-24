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
 *   • `population` — which RECORDS, in words a reader can check: not "12
 *     agents" but "the agents in this workspace’s register that are active".
 *     It is written for the person reading the report, so it names things,
 *     states and other figures in words, never a table, a column, an enum
 *     value or a metric id (owner decision, #5924). The query that counts
 *     the figure is where the table is named.
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
    'deleted agents',
    'the placeholder entry that holds proposals made before the register existed, which is never a real agent',
] as const;

function agentPopulation(qualifier: string): string {
    return `the agents in this workspace’s register${qualifier ? ` ${qualifier}` : ''}`;
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
            'every lifecycle state — draft, active, suspended and retired',
            'agents currently stopped by a kill switch (the agent is still in the register)',
        ],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'inventory.active_agents': {
        id: 'inventory.active_agents',
        label: 'Active agents',
        population: agentPopulation('that are active'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents a kill switch is stopping right now — being active is the register’s ' +
                'state, and a kill is a separate fact, reported for each agent',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'draft agents, which have never been admitted',
            'suspended and retired agents',
        ],
    },
    'inventory.retired_agents': {
        id: 'inventory.retired_agents',
        label: 'Retired agents',
        population: agentPopulation('that are retired'),
        moment: 'AS_OF_GENERATION',
        includes: ['agents retired at any time, however long ago'],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'deleted agents, which are a different end state from retirement',
        ],
    },
    'inventory.unscored_agents': {
        id: 'inventory.unscored_agents',
        label: 'Agents with no risk tier',
        population: agentPopulation('that have no risk tier'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents registered but never assessed — the state between registration and the ' +
                'first completed risk assessment',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents whose completed assessment has since gone out of date — those carry a ' +
                'tier and are counted under “Agents whose assessment is stale”',
        ],
    },
    'inventory.stale_assessments': {
        id: 'inventory.stale_assessments',
        label: 'Agents whose assessment is stale',
        population: agentPopulation('whose completed risk assessment is out of date'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents whose autonomy, tool grants, data scope, reversibility or declared ' +
                'model changed after the tier was scored',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'never-assessed agents — an absent judgement is not a stale one',
        ],
    },
    'inventory.unattended_agents': {
        id: 'inventory.unattended_agents',
        label: 'Agents at unattended autonomy',
        population: agentPopulation('registered at autonomy level 5 or above, where nobody watches each step'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'the registered autonomy level, which is what the operator declared, not an ' +
                'observation of what the agent did',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'any narrowing a policy card’s autonomy ceiling imposes when the agent calls a ' +
                'tool — the ceiling is what is enforced, the registered level is the claim',
        ],
    },
    'inventory.third_party_agents': {
        id: 'inventory.third_party_agents',
        label: 'Third-party agents',
        population: agentPopulation('that a third party supplies'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents supplied by a named vendor (the register requires one)',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents built in-house',
        ],
    },
    'inventory.agents_without_policy_card': {
        id: 'inventory.agents_without_policy_card',
        label: 'Agents with no policy card',
        population: agentPopulation('that have no policy card'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents registered before policy cards existed, whose tool calls no card ' +
                'constrains',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents holding a card whose current version grants nothing — that is a card, ' +
                'and a restrictive one',
        ],
    },

    'inventory.agents_with_spending_authority': {
        id: 'inventory.agents_with_spending_authority',
        label: 'Agents with declared spending authority',
        population: agentPopulation('with at least one spending limit that has not been withdrawn'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'limits awaiting review, reviewed limits, and those a kill asked to be ' +
                'suspended — a suspension is a request to the token provider, not proof the ' +
                'token stopped',
            'retired agents whose limit was never withdrawn',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'withdrawn limits',
            'agents whose code can pay but for which nobody declared a limit — the scanner ' +
                'reports those as an undeclared spending agent, and a count of the register ' +
                'cannot see them',
        ],
    },
    'inventory.agents_with_unreviewed_spending_authority': {
        id: 'inventory.agents_with_unreviewed_spending_authority',
        label: 'Agents with spending authority nobody else has reviewed',
        population: agentPopulation('with a spending limit that is declared and not yet reviewed, or that a kill asked to suspend before anybody reviewed it'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'a limit a kill asked to suspend before anybody reviewed it — the same rule ' +
                'that holds the agent back from activation',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'withdrawn limits, and limits a second person reviewed',
        ],
    },

    // ── ASI01–ASI10 coverage ────────────────────────────────────────
    'asi.agents_in_scope': {
        id: 'asi.agents_in_scope',
        label: 'Agents the coverage matrix covers',
        population: agentPopulation(''),
        moment: 'AS_OF_GENERATION',
        includes: ['every registered agent, whatever its state'],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'asi.risks_in_framework': {
        id: 'asi.risks_in_framework',
        label: 'Distinct agentic risks in the installed framework',
        population:
            'the distinct risk codes across every installed copy of the OWASP Agentic Top 10 ' +
            '(the seeded framework and the one synced from the library are one family)',
        moment: 'AS_OF_GENERATION',
        includes: ['codes present in either copy'],
        excludes: ['requirements the framework has withdrawn'],
    },
    'asi.agents_fully_covered': {
        id: 'asi.agents_fully_covered',
        label: 'Agents with no uncovered agentic risk',
        population: agentPopulation('scored against the installed framework'),
        moment: 'AS_OF_GENERATION',
        includes: [
            'agents for which every risk is covered or partly covered by a direct or ' +
                'inherited control',
        ],
        excludes: [
            ...AGENT_ROW_EXCLUSIONS,
            'agents with any risk that needs review — a route that needs a human decision ' +
                'is not coverage',
            'risks the register shows do not apply to that agent (no tool grants for ' +
                'ASI02, autonomy 0 for ASI08) — they are neither covered nor a gap, so they ' +
                'cannot keep an agent out of this count',
        ],
    },
    'asi.risks_covered_by_no_agent': {
        id: 'asi.risks_covered_by_no_agent',
        label: 'Agentic risks no agent covers',
        population:
            'the distinct risk codes counted under “Distinct agentic risks in the installed ' +
            'framework”',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a risk that is uncovered or needs review for every agent it applies to, and ' +
                'applies to at least one of them',
        ],
        excludes: [
            'risks covered for at least one agent, however many others leave them open — ' +
                'this is a floor, not an average',
            'risks that apply to no agent — nobody covering a risk nobody is exposed to is ' +
                'not a gap',
        ],
    },

    // ── Approval statistics ──────────────────────────────────────────
    'approvals.decided': {
        id: 'approvals.decided',
        label: 'Proposals a human decided',
        population:
            'agent proposals a person accepted, accepted with edits, or rejected, with the ' +
            'decision made inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'decisions on proposals from any agent, including proposals no agent is named ' +
                'on',
        ],
        excludes: [
            'pending proposals, which nobody has decided',
            'expired proposals, which closed without a decision',
            'decisions beyond the report’s row limit, which the report marks as cut short',
        ],
    },
    'approvals.approved': {
        id: 'approvals.approved',
        label: 'Proposals approved',
        population:
            'the decided proposals above that a person accepted, with or without edits',
        moment: 'OVER_WINDOW',
        includes: ['proposals the person edited before accepting them'],
        excludes: ['rejected proposals'],
    },
    'approvals.rejected': {
        id: 'approvals.rejected',
        label: 'Proposals rejected',
        population: 'the decided proposals above that a person rejected',
        moment: 'OVER_WINDOW',
        includes: ['every rejection, whatever the reason'],
        excludes: ['proposals that expired unreviewed'],
    },
    'approvals.approval_rate': {
        id: 'approvals.approval_rate',
        label: 'Share of decisions that approved',
        population: 'proposals approved, divided by proposals a human decided',
        moment: 'OVER_WINDOW',
        includes: ['a value between 0 and 1'],
        excludes: [
            'any figure at all when nothing was decided — an empty denominator is reported ' +
                'as having no population rather than as 0, which would read as “everything was ' +
                'rejected”',
        ],
    },
    'approvals.fastest_decision_seconds': {
        id: 'approvals.fastest_decision_seconds',
        label: 'Fastest decision in the window',
        population: 'the shortest time any reviewer took to decide a proposal in the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a single observation, reported at any sample size — unlike the per-reviewer ' +
                'estimates, which are withheld below a minimum number of decisions',
        ],
        excludes: ['reviewers with no decision in the window'],
    },
    'approvals.reviewers': {
        id: 'approvals.reviewers',
        label: 'Distinct humans who decided something',
        population:
            'the different people who decided at least one agent proposal in the window',
        moment: 'OVER_WINDOW',
        includes: ['anyone who decided at least one proposal'],
        excludes: [
            'people with permission to review who did not — the queue records decisions, ' +
                'not eligibility',
        ],
    },
    'approvals.reviewers_below_reportable_sample': {
        id: 'approvals.reviewers_below_reportable_sample',
        label: 'Reviewers with too few decisions to estimate',
        population: 'reviewers whose number of decisions is under the minimum sample',
        moment: 'OVER_WINDOW',
        includes: [
            'reviewers for whom the approval rate and the median time are shown as ' +
                'withheld rather than computed from a handful of decisions',
        ],
        excludes: ['reviewers at or above the minimum'],
    },
    'approvals.bias_signals': {
        id: 'approvals.bias_signals',
        label: 'Automation-bias patterns that fired',
        population: 'the signs of automation bias detected in the window',
        moment: 'OVER_WINDOW',
        includes: [
            'bursts of bulk approvals, implausibly fast decisions, fast medians, reviewers ' +
                'who never reject, and second approvers that were required but not recorded',
        ],
        excludes: [
            'whether the proposal was ever actually read — the queue records decisions, ' +
                'never attention, and the report names that question as unobservable rather ' +
                'than guessing at it',
        ],
    },
    'approvals.pending_now': {
        id: 'approvals.pending_now',
        label: 'Proposals awaiting a decision',
        population: 'agent proposals waiting for a decision now',
        moment: 'AS_OF_GENERATION',
        includes: [
            'every waiting proposal regardless of age — this is a snapshot, not limited to ' +
                'the report window, because the length of the queue now is what drives ' +
                'rubber-stamping now',
        ],
        excludes: ['proposals already closed as expired'],
    },
    'approvals.sample_audits_answered': {
        id: 'approvals.sample_audits_answered',
        label: 'Retrospective sample audits answered',
        population:
            'decided proposals drawn for a second look inside the window whose second look has ' +
            'been answered',
        moment: 'OVER_WINDOW',
        includes: ['answers that agreed, disagreed or could not conclude'],
        excludes: [
            'drawn but unanswered audits — counting them would improve the disagreement ' +
                'rate every time the sample was drawn and nobody did the work',
        ],
    },
    'approvals.sample_audit_disagreement_rate': {
        id: 'approvals.sample_audit_disagreement_rate',
        label: 'Share of answered sample audits that dissented',
        population:
            'answered sample audits that disagreed, divided by all answered sample audits, ' +
            'inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a value between 0 and 1 — the number the approval queue is judged on',
        ],
        excludes: [
            'any figure when nothing was answered — a workspace with a perfect record and ' +
                'one nobody reviewed both produce zero disagreements',
        ],
    },

    // The content guard's three states. `guardVerdict` alone cannot tell a
    // clean scan from no scan — see `lib/agentic/proposal-guard-state.ts`.
    'approvals.guard_flagged': {
        id: 'approvals.guard_flagged',
        label: 'Proposals the content guard refused',
        population: 'agent proposals the content guard objected to',
        moment: 'AS_OF_GENERATION',
        includes: [
            'both kinds of objection — flagged (shown to a reviewer with the rules that ' +
                'matched) and quarantined (held out of the review queue entirely). Both mean ' +
                'the guard looked and objected',
            'proposals since decided by a human — the guard’s verdict is a record of what ' +
                'it saw, not of what happened next',
        ],
        excludes: [
            'proposals written before the guard existed, which read as passed but were ' +
                'never scanned — those are counted under “Proposals no content guard ever ' +
                'scanned”',
        ],
    },
    'approvals.guard_unscanned': {
        id: 'approvals.guard_unscanned',
        label: 'Proposals no content guard ever scanned',
        population:
            'agent proposals that read as passed by the content guard but carry no record of a ' +
            'scan',
        moment: 'AS_OF_GENERATION',
        includes: [
            'every proposal that entered the queue before the guard shipped — such a ' +
                'proposal reads as passed because that was the default, and no earlier record ' +
                'was filled in, so “passed” on it means “not refused”, never “scanned and ' +
                'found clean”',
        ],
        excludes: [
            'scanned proposals, whichever way the scan went — the record of the scan is ' +
                'what tells them apart, and it is written on every proposal the guard decides',
        ],
    },
    'approvals.guard_clean': {
        id: 'approvals.guard_clean',
        label: 'Proposals the content guard scanned and passed',
        population: 'agent proposals the content guard scanned and let through',
        moment: 'AS_OF_GENERATION',
        includes: [
            'the remainder: all proposals minus those refused minus those never scanned, ' +
                'so the three guard figures always add up to the whole rather than being three ' +
                'counts that can disagree when proposals arrive at the same time',
        ],
        excludes: [
            'proposals from before the guard, which look the same as passed ones and are ' +
                'counted under “Proposals no content guard ever scanned”',
        ],
    },

    // ── Incident and kill-switch history ─────────────────────────────
    'incidents.guard_blocks': {
        id: 'incidents.guard_blocks',
        label: 'Guard blocks',
        population:
            'times inside the window the content guard quarantined something, in both places ' +
            'that can happen: an agent proposal it quarantined, and a step of a run it stopped',
        moment: 'OVER_WINDOW',
        includes: [
            'blocks that produced a proposal, and blocks on a reasoning run that produced ' +
                'no proposal at all — the second is the only trace a block on a Flue run leaves',
            'blocks on a run that began before the window; each step carries its own time, ' +
                'and a run blocked inside the window was blocked inside it',
        ],
        excludes: [
            'flagged proposals, which pause for review rather than stop — those are ' +
                'counted under “Proposals the content guard refused”',
            'runs the circuit breaker then stopped; the trip is counted separately under ' +
                '“Circuit breakers that tripped”, and one cause can produce both',
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
        population: 'agent runs started inside the window that completed',
        moment: 'OVER_WINDOW',
        includes: [
            'runs started by a person and runs started by an automation rule',
        ],
        excludes: [
            'runs still in progress, which are counted by the three “now” measures below',
            'runs started before the window, however they ended — the window is on the ' +
                'start time, so a quarter reports the runs it began',
        ],
    },
    'runs.failed': {
        id: 'runs.failed',
        label: 'Runs failed',
        population: 'agent runs started inside the window that failed',
        moment: 'OVER_WINDOW',
        includes: [
            'runs closed as failed because nothing was left to execute them — a deploy ' +
                'that stranded a run looks like a failure here, which is honest: it did not ' +
                'complete',
        ],
        excludes: [
            'runs stopped by a guard block or a kill, counted separately as aborted — the ' +
                'cause is different and so is what an operator does about it',
        ],
    },
    'runs.aborted': {
        id: 'runs.aborted',
        label: 'Runs aborted',
        population: 'agent runs started inside the window that were aborted',
        moment: 'OVER_WINDOW',
        includes: [
            'runs a guard blocked, runs a kill switch stopped, and runs an operator ' +
                'aborted by hand',
        ],
        excludes: [
            'runs that failed, which nothing stopped deliberately',
            'the reason for each abort; this is a count, and the trail carries the cause ' +
                'for each run',
        ],
    },
    'runs.in_flight': {
        id: 'runs.in_flight',
        label: 'Runs in flight now',
        population: 'agent runs executing at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: [
            'runs this deployment is executing and runs stranded by a deploy',
        ],
        excludes: [
            'runs awaiting approval or paused, which count against the limit on runs at ' +
                'once but are waiting on a person rather than executing — those are their own ' +
                'measures',
        ],
    },
    'runs.awaiting_approval': {
        id: 'runs.awaiting_approval',
        label: 'Runs awaiting approval',
        population:
            'agent runs waiting for a person’s approval at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: [
            'runs stopped at a human checkpoint, and runs the guard flagged for review',
        ],
        excludes: [
            'runs whose approval window has expired but which have not moved on; this ' +
                'counts where the run stands, and expiry is a separate question the ' +
                'approval-window measures answer',
        ],
    },
    'runs.paused': {
        id: 'runs.paused',
        label: 'Runs paused',
        population: 'agent runs paused at the moment the pack was generated',
        moment: 'AS_OF_GENERATION',
        includes: [
            'runs paused as a deploy shut the worker down, which is what makes them ' +
                'resumable rather than closed as failed',
        ],
        excludes: ['runs awaiting a person, which are their own measure above'],
    },
    'incidents.kill_engagements': {
        id: 'incidents.kill_engagements',
        label: 'Kill switches engaged',
        population: 'kill switches engaged inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'both scopes — a kill for the whole workspace and one for a single agent',
            'kills that have since been lifted; the engagement is the record of the window',
        ],
        excludes: [
            'the scheduled drill’s practice kills, which are exercises against an agent no ' +
                'credential belongs to and are counted separately',
            'kills engaged because an agent’s accountable owner left, which the owner ' +
                'check engages — a lifecycle containment, not an incident, counted separately ' +
                'under “Kills engaged because an agent’s owner left”',
            'the platform-wide kill, which is global and belongs to no workspace',
        ],
    },
    'incidents.owner_departed_engagements': {
        id: 'incidents.owner_departed_engagements',
        label: 'Kills engaged because an agent’s owner left',
        population:
            'kill switches engaged inside the window because an agent’s accountable owner left',
        moment: 'OVER_WINDOW',
        includes: [
            'every such kill the scheduled owner check engaged, whether or not it has ' +
                'since been lifted after a completed ownership transfer',
        ],
        excludes: [
            'kills a person engaged, whatever their stated reason says — only the system ' +
                'records this cause, never the free-text reason',
            'agents the check found while it was running as a dry run, which it recorded ' +
                'and did not stop',
            'the drill’s practice kills',
        ],
    },
    'incidents.owner_departed_in_force_now': {
        id: 'incidents.owner_departed_in_force_now',
        label: 'Kills for a departed owner currently in force',
        population:
            'kill switches engaged because an agent’s accountable owner left that have not ' +
            'been lifted',
        moment: 'AS_OF_GENERATION',
        includes: [
            'kills engaged before the report window and still in force — each is an agent ' +
                'waiting for an ownership transfer to complete',
        ],
        excludes: [
            'kills a person engaged',
            'the drill’s practice kills',
            'the global platform kill',
        ],
    },
    'incidents.drill_canary_engagements': {
        id: 'incidents.drill_canary_engagements',
        label: 'Drill canary kills',
        population:
            'kill switches engaged inside the window against the drill’s practice agent',
        moment: 'OVER_WINDOW',
        includes: ['exercises the scheduled drill engaged and lifted itself'],
        excludes: ['kills a human engaged against a real agent'],
    },
    'incidents.kills_in_force_now': {
        id: 'incidents.kills_in_force_now',
        label: 'Kill switches currently in force',
        population: 'kill switches that have not been lifted',
        moment: 'AS_OF_GENERATION',
        includes: [
            'kills engaged before the report window — a stop still in force is a fact ' +
                'about now, not about the window',
        ],
        excludes: [
            'the drill’s practice kills',
            'kills for a departed owner, counted under “Kills for a departed owner ' +
                'currently in force”',
            'the global platform kill',
        ],
    },
    'incidents.longest_kill_minutes': {
        id: 'incidents.longest_kill_minutes',
        label: 'Longest kill window in the report window',
        population: 'how long each kill counted above lasted, from engaged to lifted',
        moment: 'OVER_WINDOW',
        includes: [
            'a kill still in force, measured to the moment the report was generated and ' +
                'marked as not lifted',
        ],
        excludes: [
            'the drill’s practice kills',
            'kills for a departed owner, which last as long as an ownership transfer takes ' +
                'and are not an incident’s duration',
        ],
    },
    'incidents.drills_run': {
        id: 'incidents.drills_run',
        label: 'Kill-switch drills run',
        population: 'kill-switch drills started inside the window',
        moment: 'OVER_WINDOW',
        includes: ['every outcome — passed, failed and could not run'],
        excludes: ['drills started before the window'],
    },
    'incidents.drills_failed': {
        id: 'incidents.drills_failed',
        label: 'Drills that failed',
        population: 'the drills above that failed',
        moment: 'OVER_WINDOW',
        includes: ['drills where the stop control did not stop something'],
        excludes: [
            'drills that could not run, which proved nothing rather than proving the ' +
                'control broken — counting the two together would raise a finding about the ' +
                'wrong thing',
        ],
    },
    'incidents.drills_errored': {
        id: 'incidents.drills_errored',
        label: 'Drills that could not run',
        population: 'the drills above that could not run',
        moment: 'OVER_WINDOW',
        includes: [
            'drills that could not complete, and so are evidence of nothing',
        ],
        excludes: ['drills that failed'],
    },
    'incidents.tool_calls_after_kill': {
        id: 'incidents.tool_calls_after_kill',
        label: 'Tool calls that got through after a kill',
        population:
            'the tool calls that got through after the kill, added up over the drills above ' +
            'that actually measured something — a drill that could not run measured nothing',
        moment: 'OVER_WINDOW',
        includes: [
            'every call let through while a kill was in force; anything other than zero is ' +
                'the control failing',
        ],
        excludes: [
            'any figure at all when no drill ran — adding up an empty list to zero would ' +
                'make a workspace that never tested its stop control look the same as one ' +
                'whose control is proven',
            'drills that could not run. Such a drill is recorded but measured nothing: it ' +
                'could not run, so it proves nothing either way, and its count of calls is ' +
                'left at zero. Counting it added that zero to the strongest claim this product ' +
                'makes, so a workspace whose only drill broke read exactly like one whose stop ' +
                'control is proven. “Never drilled” and “drilled and the drill broke” demand ' +
                'different actions and are reported differently',
        ],
    },
    'incidents.breaker_trips': {
        id: 'incidents.breaker_trips',
        label: 'Circuit breakers that tripped',
        population: 'circuit breakers that tripped inside the window',
        moment: 'OVER_WINDOW',
        includes: ['a breaker that tripped and has since been closed'],
        excludes: [
            'breakers that have never tripped, and agents that have no breaker',
        ],
    },
    'incidents.breakers_open_now': {
        id: 'incidents.breakers_open_now',
        label: 'Circuit breakers currently open',
        population: 'circuit breakers that are open now',
        moment: 'AS_OF_GENERATION',
        includes: [
            'breakers tripped before the window — nothing closes itself, so an open ' +
                'breaker is open until a human closes it',
        ],
        excludes: ['closed breakers, whatever the reason they were closed'],
    },

    // The monthly token budget — the third stop control, alongside the kill
    // switch and the circuit breaker. It refuses a run AT THE DOOR rather than
    // truncating one mid-flight, so its figures are about admission, not damage.
    'incidents.monthly_token_budget': {
        id: 'incidents.monthly_token_budget',
        label: 'Monthly agent token budget',
        population:
            'the monthly token budget set for this workspace’s agents, the ceiling every run ' +
            'start is checked against',
        moment: 'AS_OF_GENERATION',
        includes: [
            'the configured number, whatever this month has actually spent',
        ],
        excludes: [
            'a budget nobody has set, reported as not configured rather than as 0 — no ' +
                'budget means unlimited here, and a 0 would read as a ceiling that refuses ' +
                'every run',
        ],
    },
    'incidents.tokens_spent_this_month': {
        id: 'incidents.tokens_spent_this_month',
        label: 'Agent tokens spent this month',
        population:
            'the tokens spent by agent runs started since the first moment of the current ' +
            'calendar month (UTC)',
        moment: 'AS_OF_GENERATION',
        includes: [
            'the calendar month (UTC) rather than the report window — the budget this is ' +
                'measured against resets monthly, and a 90-day total would not be comparable ' +
                'to it',
            'runs however they ended, and runs still executing: the tokens are spent ' +
                'whether or not the run finished',
        ],
        excludes: [
            'runs started before this month, however recently — the budget is a monthly ' +
                'allowance and last month’s spend does not consume it',
        ],
    },
    'incidents.monthly_budget_remaining_tokens': {
        id: 'incidents.monthly_budget_remaining_tokens',
        label: 'Monthly token budget remaining',
        population:
            'the configured budget minus this month’s spend, in tokens, for this workspace',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a negative value when spend has passed the ceiling. The check is made before ' +
                'a run starts and bounds a run by its own token cap, so an admitted run can ' +
                'still finish above the line — rounding up to 0 would hide exactly that ' +
                'overshoot',
        ],
        excludes: [
            'any figure at all when no budget is configured, because subtracting from ' +
                'unlimited has no answer',
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
            'the auditor agent’s workpapers drawn for review by internal audit inside the ' +
            'window — one for each workpaper the scheduled sweep drew at this workspace’s ' +
            'sampling rate',
        moment: 'OVER_WINDOW',
        includes: [
            'every state: waiting for a reviewer to be assigned, waiting for an answer, ' +
                'and answered',
            'workpapers of every procedure, period and auditor agent',
        ],
        excludes: [
            'workpapers the draw passed over at a rate below 100% (at the pilot’s 100% ' +
                'there are none)',
            'workpapers written since the last daily sweep (09:40 UTC), which are not ' +
                'drawn yet',
        ],
    },
    'assurance.workpaper_reviews_unassigned': {
        id: 'assurance.workpaper_reviews_unassigned',
        label: 'Drawn workpapers nobody in internal audit can be asked to review',
        population:
            'the drawn workpapers above that are still unassigned, with the reason: no active ' +
            'third-line member, the only third-line member owns the auditor agent, or the ' +
            'auditor agent is no longer in the register',
        moment: 'OVER_WINDOW',
        includes: [
            'workpapers a later sweep may still assign, once somebody is eligible',
        ],
        excludes: [
            'workpapers with an assigned reviewer, awaiting an answer — counted under ' +
                '“Drawn workpapers awaiting their assigned reviewer”',
            'answered workpapers',
        ],
    },
    'assurance.workpaper_reviews_awaiting': {
        id: 'assurance.workpaper_reviews_awaiting',
        label: 'Drawn workpapers awaiting their assigned reviewer',
        population:
            'the drawn workpapers with an assigned third-line reviewer that are still waiting ' +
            'for an answer',
        moment: 'OVER_WINDOW',
        includes: [
            'workpapers however long they have waited — an unanswered review is the ' +
                'failure this counts',
        ],
        excludes: [
            'unassigned workpapers',
            'answered workpapers',
        ],
    },
    'assurance.workpaper_reviews_indeterminate': {
        id: 'assurance.workpaper_reviews_indeterminate',
        label: 'Reviews that could not conclude',
        population:
            'the drawn workpapers whose reviewer answered that they could not conclude',
        moment: 'OVER_WINDOW',
        includes: [
            'answers where the reviewer could not judge the workpaper from the record — a ' +
                'finding about the record, not a vote either way',
        ],
        excludes: [
            'every other answer — an indeterminate answer is neither agreement nor ' +
                'disagreement',
        ],
    },
    'assurance.workpaper_reviews_concluded': {
        id: 'assurance.workpaper_reviews_concluded',
        label: 'Reviews that concluded',
        population:
            'the drawn workpapers whose reviewer agreed or disagreed with the auditor agent — ' +
            'the denominator of both re-performance rates',
        moment: 'OVER_WINDOW',
        includes: [
            'agreeing and disagreeing answers, each recorded once by the assigned reviewer',
        ],
        excludes: [
            'indeterminate answers',
            'unassigned workpapers, which nobody could be asked to answer',
            'drawn but unreviewed workpapers',
        ],
    },
    'assurance.workpaper_reperformance_agreement_rate': {
        id: 'assurance.workpaper_reperformance_agreement_rate',
        label: 'Share of concluded reviews that concurred with the auditor agent',
        population:
            'reviews that agreed, divided by reviews that agreed or disagreed, among the ' +
            'workpapers drawn inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a value between 0 and 1 — how often internal audit’s re-performance reached ' +
                'the auditor agent’s result',
        ],
        excludes: [
            'drawn but unreviewed workpapers, in neither the numerator nor the denominator ' +
                '— counting them as agreement would improve the rate every time the sweep ran ' +
                'and nobody did the work',
            'indeterminate answers, which are neither agreement nor disagreement',
            'unassigned workpapers, which nobody could be asked to review',
            'any figure at all when no review concluded — zero concluded reviews is not ' +
                '“100% agreement”',
        ],
    },
    'assurance.workpaper_reperformance_disagreement_rate': {
        id: 'assurance.workpaper_reperformance_disagreement_rate',
        label: 'Share of concluded reviews that dissented from the auditor agent',
        population:
            'reviews that disagreed, divided by reviews that agreed or disagreed, among the ' +
            'workpapers drawn inside the window',
        moment: 'OVER_WINDOW',
        includes: [
            'a value between 0 and 1, the complement of the agreement rate over the same ' +
                'denominator; each disagreement queued one finding proposal for a person to ' +
                'decide',
        ],
        excludes: [
            'drawn but unreviewed workpapers',
            'indeterminate answers',
            'unassigned workpapers',
            'any figure at all when no review concluded — a workspace whose internal audit ' +
                'concluded nothing and one that never disagreed both have zero disagreements',
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
        label: 'Share of concluded reviews, of the workpapers relied on, that concurred with the ' +
            'auditor agent',
        population:
            'reviews that agreed, divided by reviews that agreed or disagreed, among the ' +
            'reviews of the workpapers in the reliance pack: workpapers of a library v1 ' +
            'procedure whose period lies wholly inside the audit cycle’s period',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a value between 0 and 1, for each control and once for the pack, computed ' +
                'when the pack was assembled',
        ],
        excludes: [
            'workpapers internal audit did not draw, listed beside the rate as not drawn',
            'drawn but unreviewed workpapers, in neither the numerator nor the denominator',
            'indeterminate answers, which are neither agreement nor disagreement',
            'unassigned workpapers, which nobody could be asked to review',
            'any figure at all when no review concluded — zero concluded reviews is not ' +
                '“100% agreement”',
        ],
    },
    'assurance.reliance_reperformance_disagreement_rate': {
        id: 'assurance.reliance_reperformance_disagreement_rate',
        label: 'Share of concluded reviews, of the workpapers relied on, that dissented from the ' +
            'auditor agent',
        population:
            'reviews that disagreed, divided by reviews that agreed or disagreed, over the ' +
            'same reviews as the agreement rate for the workpapers relied on',
        moment: 'AS_OF_GENERATION',
        includes: [
            'a value between 0 and 1, the complement of the agreement rate over the same ' +
                'denominator',
        ],
        excludes: [
            'workpapers not drawn, drawn but unreviewed, indeterminate and unassigned, as ' +
                'for the agreement rate',
            'any figure at all when no review concluded',
        ],
    },

    // ── Third-party agent assessments ────────────────────────────────
    'thirdparty.agents': {
        id: 'thirdparty.agents',
        label: 'Third-party agents',
        population: agentPopulation('that a third party supplies'),
        moment: 'AS_OF_GENERATION',
        includes: ['every lifecycle state'],
        excludes: AGENT_ROW_EXCLUSIONS,
    },
    'thirdparty.supplying_vendors': {
        id: 'thirdparty.supplying_vendors',
        label: 'Vendors supplying an agent',
        population: 'the different vendors named as the supplier of a third-party agent',
        moment: 'AS_OF_GENERATION',
        includes: ['a vendor supplying several agents, counted once'],
        excludes: [
            'vendors in the register that supply no agent — this is the agents’ supply ' +
                'chain, not the whole vendor book',
            'deleted vendors, which are reported per agent as an unresolved supplier',
        ],
    },
    'thirdparty.vendors_without_completed_assessment': {
        id: 'thirdparty.vendors_without_completed_assessment',
        label: 'Supplying vendors with no completed assessment',
        population:
            'the supplying vendors above with no vendor assessment that reached a reviewed end ' +
            '(approved, reviewed or closed)',
        moment: 'AS_OF_GENERATION',
        includes: [
            'vendors with an assessment still in progress — drafted, sent, being answered, ' +
                'submitted or in review: started is not finished',
            'vendors whose only assessment was rejected, which is a completed process with ' +
                'an adverse result and is reported per vendor',
        ],
        excludes: [
            'vendors holding at least one assessment that reached a reviewed end',
        ],
    },
    'thirdparty.tools_pinned': {
        id: 'thirdparty.tools_pinned',
        label: 'Agent tools with a pinned definition',
        population: 'the tool definitions pinned for this workspace’s agents',
        moment: 'AS_OF_GENERATION',
        includes: [
            'definitions pinned when first seen, with no human involved',
            'definitions a named human accepted after they changed',
        ],
        excludes: [
            'tools this build offers that no agent has ever called here, which therefore ' +
                'have no pin',
        ],
    },
    'thirdparty.tools_human_approved': {
        id: 'thirdparty.tools_human_approved',
        label: 'Tool definitions a human accepted after a change',
        population:
            'the pinned definitions above that a named human accepted after a change',
        moment: 'AS_OF_GENERATION',
        includes: [
            'pins whose definition changed and a named human approved it again',
        ],
        excludes: [
            'definitions pinned when first seen — trusting what was seen first is not a ' +
                'human decision, and an auditor asking “did a person accept this description” ' +
                'must not have the two told apart by a timestamp',
        ],
    },
    'thirdparty.supplier_side_agent_changes': {
        id: 'thirdparty.supplier_side_agent_changes',
        label: 'Changes a supplier made to its own agent',
        population: 'nothing this platform can observe',
        moment: 'AS_OF_GENERATION',
        includes: [],
        excludes: [
            'everything — a third-party agent’s model, prompt and tool implementation live ' +
                'on the supplier’s side of the boundary. The register records what the ' +
                'operator declares (the model, autonomy and scope) and the tool boundary ' +
                'records what the agent did here. Neither is a view of the supplier’s build, ' +
                'and a figure derived from either would be a claim about the supplier made out ' +
                'of our own logs',
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
