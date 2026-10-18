/**
 * THE OWNER-ORPHAN PASS — what "the owner has left" means, decided purely
 * (#3670, step 2b of the agentic IAM roadmap, UC2's second leaver direction).
 *
 * An agent's accountable owner is `RegisteredAgent.ownerUserId`: the person the
 * two-person rules compare against, the only person who can accept a harness
 * shortfall, the person a kill-switch bell is routed to. When that person
 * leaves, the agent keeps its credentials and its grants and nobody answers for
 * it. This module decides, from rows the pass has already read, whether that
 * has happened. It holds no prisma and no clock, so every rule here is asserted
 * directly by `tests/unit/agent-owner-orphan.test.ts`.
 *
 * ## The two signals, and the one rule that binds the second
 *
 *   1. MEMBERSHIP. The owner holds no ACTIVE membership in the tenant. The
 *      issue names DEACTIVATED and REMOVED; the pass also treats an ABSENT row
 *      and an INVITED one as departed. ABSENT is not a stretch of the rule, it
 *      is the rule as the product implements it: `removeTenantMember` DELETES
 *      the membership row, so the product's own Remove button leaves no
 *      REMOVED row behind for the pass to read. INVITED is included for the
 *      same fail-closed reason — accountability needs an active member, and an
 *      invitation nobody accepted is not one. Both are named on the row, never
 *      folded into DEACTIVATED.
 *   2. HR. The Employee row matched to the owner is TERMINATED. `Employee`
 *      carries no user link, only `workEmail`, so the match is EXACT
 *      NORMALISED EMAIL — `emailKey`, the JML chain's own rule — and only when
 *      exactly ONE employee holds that key. Two employees sharing a key is a
 *      data problem, not a match, and is recorded as `HR_MATCH_AMBIGUOUS`
 *      rather than guessed at. Never a name: a name match would stop an agent
 *      because somebody with the same name left, and nothing about that
 *      decision would look wrong on the row.
 *
 * Either signal alone orphans the agent. An owner still ACTIVE in the tenant
 * whose HR record says TERMINATED is the case the HR signal exists for — the
 * membership is often the last thing offboarding removes.
 *
 * ## Why the reason code is not the reason text
 *
 * `AgentKillSwitch.reason` is free text a person types at the engage route. An
 * `OWNER_DEPARTED` kill is counted apart from incidents and cannot be lifted
 * until an ownership transfer completes, so a person typing those words must not
 * be able to make a kill behave like one. The code lives in its own column,
 * `reasonCode`, which the database pins to `ORPHAN_PASS_ACTOR` with a CHECK
 * (migration 20261018090100), and `isOwnerDepartedKill` reads only that column.
 *
 * @module lib/agentic/owner-orphan
 */
import { emailKey } from '@/lib/identity/email-key';
import type { IdentityWriteMode } from '@/lib/identity/write-ladder';

/**
 * The actor recorded on an OWNER_DEPARTED kill row.
 *
 * Not a `User.id` and not pretending to be one, after the drill's
 * `system:agent-kill-switch-drill`. The CHECK in migration 20261018090100 spells
 * this literal; `tests/integration/agent-owner-orphan-pass.test.ts` proves the
 * two agree by writing a row through the usecase.
 */
export const ORPHAN_PASS_ACTOR = 'system:agent-owner-orphan-pass';

/** Every structured kill reason. One today; the CHECK admits exactly these. */
export const KILL_REASON_CODES = ['OWNER_DEPARTED'] as const;
export type KillReasonCode = (typeof KILL_REASON_CODES)[number];

/** `IntegrationExecution.provider` for the agentic passes' rows. */
export const AGENTIC_PASS_PROVIDER = 'agentic';

/**
 * `IntegrationExecution.automationKey` for an orphan-pass row.
 *
 * The dwell gate counts these rows, the admin route lists them, and the
 * tenant-wide control-check list EXCLUDES them by provider (`listAllControlChecks`):
 * a lifecycle action is not a control check, and the rows name agents and
 * owners behind a key the control-checks page does not require.
 */
export const ORPHAN_PASS_AUTOMATION_KEY = 'agentic.owner_orphan_pass';

/**
 * The highest rung the pass acts at. A SOURCE CONSTANT, not configuration,
 * after `LEAVER_MAX_MODE`.
 *
 * At the TOP rung, so `isAboveClamp` can never be true and `MODE_ABOVE_CLAMP`
 * is unreachable — the leaver's state since #2187. The branch that reads it is
 * kept as the brake: narrowing this to `DRY_RUN` is a reviewed one-line diff
 * that stops every automatic kill on the next pass, which is the change an
 * incident would want to ship in a hurry.
 */
export const ORPHAN_PASS_MAX_MODE: IdentityWriteMode = 'AUTOMATIC';

/** Decisions one execution row carries before it says it was truncated. */
export const MAX_REPORTED_ORPHANS = 200;

/**
 * The roster the HR signal reads, read ONE PAST this cap. More rows than this
 * and the HR signal is not evaluated for anybody on that run — recorded as
 * `HR_ROSTER_TRUNCATED` and the row is PARTIAL — because a match against the
 * first ten thousand employees cannot tell "no record" from "a record past the
 * cut", and the second is the leaver this pass exists to find.
 */
export const MAX_ROSTER_READ = 10_000;

/** What the pass observed about the owner's membership. */
export type MembershipObservation = 'ACTIVE' | 'INVITED' | 'DEACTIVATED' | 'REMOVED' | 'ABSENT';

/** One reason the pass considers the owner gone. */
export type DepartureSignal =
    | { kind: 'MEMBERSHIP_NOT_ACTIVE'; membership: Exclude<MembershipObservation, 'ACTIVE'> }
    | { kind: 'HR_TERMINATED'; employeeId: string };

/** How the owner matched the HR roster. */
export type HrMatch =
    | { kind: 'NOT_READ' }
    | { kind: 'NO_EMAIL' }
    | { kind: 'NONE' }
    | { kind: 'AMBIGUOUS'; employeeIds: string[] }
    | { kind: 'ONE'; employeeId: string; status: string; managerEmployeeId: string | null };

/** A note the row carries about an agent the pass could not fully judge. */
export type OrphanNote = 'HR_MATCH_AMBIGUOUS' | 'HR_ROSTER_NOT_READ';

export interface RosterEmployee {
    id: string;
    workEmail: string;
    status: string;
    managerEmployeeId: string | null;
}

/**
 * The roster keyed by `emailKey`, with every employee kept under its key.
 *
 * A LIST per key rather than the last writer, so two employees sharing a key are
 * seen as two. An employee whose address normalises to nothing is under no key:
 * `emailKey` maps empty to null precisely so absences cannot match each other.
 */
export function indexRosterByEmailKey(
    roster: readonly RosterEmployee[],
): ReadonlyMap<string, readonly RosterEmployee[]> {
    const out = new Map<string, RosterEmployee[]>();
    for (const e of roster) {
        const key = emailKey(e.workEmail);
        if (!key) continue;
        const bucket = out.get(key);
        if (bucket) bucket.push(e);
        else out.set(key, [e]);
    }
    return out;
}

/**
 * Match an owner to the roster by EXACT normalised email — and by nothing else.
 *
 * `rosterRead: false` is the truncated roster: no match is attempted, because a
 * NONE read off a partial roster would claim an absence nobody observed.
 */
export function matchOwnerToRoster(
    ownerEmail: string | null | undefined,
    index: ReadonlyMap<string, readonly RosterEmployee[]>,
    rosterRead: boolean,
): HrMatch {
    if (!rosterRead) return { kind: 'NOT_READ' };
    const key = emailKey(ownerEmail);
    if (!key) return { kind: 'NO_EMAIL' };
    const hits = index.get(key) ?? [];
    if (hits.length === 0) return { kind: 'NONE' };
    if (hits.length > 1) return { kind: 'AMBIGUOUS', employeeIds: hits.map((e) => e.id).sort() };
    const [one] = hits;
    return {
        kind: 'ONE',
        employeeId: one.id,
        status: one.status,
        managerEmployeeId: one.managerEmployeeId,
    };
}

/** The verdict on one owner. */
export interface DepartureVerdict {
    orphaned: boolean;
    signals: DepartureSignal[];
    note: OrphanNote | null;
}

/**
 * Has this agent's owner left?
 *
 * ORDER IS NOT PRECEDENCE. Both signals are evaluated and both are recorded when
 * both fire, because an operator reading the row asks "how do we know", and the
 * answer "HR and the membership agree" is stronger evidence than either alone.
 */
export function classifyOwnerDeparture(input: {
    membership: MembershipObservation;
    hr: HrMatch;
}): DepartureVerdict {
    const signals: DepartureSignal[] = [];
    if (input.membership !== 'ACTIVE') {
        signals.push({ kind: 'MEMBERSHIP_NOT_ACTIVE', membership: input.membership });
    }
    if (input.hr.kind === 'ONE' && input.hr.status === 'TERMINATED') {
        signals.push({ kind: 'HR_TERMINATED', employeeId: input.hr.employeeId });
    }
    const note: OrphanNote | null =
        input.hr.kind === 'AMBIGUOUS'
            ? 'HR_MATCH_AMBIGUOUS'
            : input.hr.kind === 'NOT_READ'
              ? 'HR_ROSTER_NOT_READ'
              : null;
    return { orphaned: signals.length > 0, signals, note };
}

/** Is this kill row an OWNER_DEPARTED kill? Reads the CODE, never the text. */
export function isOwnerDepartedKill(row: { reasonCode?: string | null }): boolean {
    return row.reasonCode === 'OWNER_DEPARTED';
}

/**
 * The reason TEXT written beside the code, naming the signals and no person.
 *
 * The row's `reason` column is read by the kill-switch surface and the incident
 * pack, so it says what happened in words. It carries signal codes only: no
 * name, no address, no user id — the departed owner is identified by the agent,
 * which is the row's subject.
 */
export function ownerDepartedReasonText(signals: readonly DepartureSignal[]): string {
    const parts = signals.map((s) =>
        s.kind === 'MEMBERSHIP_NOT_ACTIVE'
            ? `membership ${s.membership}`
            : 'HR record TERMINATED (matched by exact normalised email)',
    );
    return (
        `OWNER_DEPARTED — the agent's accountable owner has left (${parts.join('; ')}). ` +
        'Stopped by the owner-orphan pass. It lifts only after a two-step ownership ' +
        'transfer completes, by the new owner, with a reason.'
    );
}

/** What the pass did, or would do, about one orphan. */
export type OrphanOutcome =
    /** DRY_RUN: nothing was written. */
    | 'WOULD_SUSPEND_AND_KILL'
    /** AUTOMATIC: the kill was engaged and the agent suspended. */
    | 'SUSPENDED_AND_KILLED'
    /**
     * AUTOMATIC: an agent-scope kill was already in force (a person's, or an
     * earlier pass's) and was left standing — the partial unique index admits
     * one per agent — and the agent was suspended.
     */
    | 'SUSPENDED_KILL_ALREADY_IN_FORCE'
    /** AUTOMATIC: an effect could not be applied; `failedStep` names it. */
    | 'FAILED';

/** Why a pass did not evaluate its population. Every one records a row. */
export type OrphanPassRefusal = 'MODE_DISABLED' | 'MODE_ABOVE_CLAMP' | 'NO_ACTIVE_AGENTS';

/** The `IntegrationExecution.status` a pass that ran persists. ERROR has its own seam. */
export type OrphanPassRanStatus = 'PASSED' | 'PARTIAL' | 'NOT_APPLICABLE';

/**
 * One rule for the row's status, so the row and the job result cannot disagree
 * (the leaver's `leaverPassStatus` lesson).
 *
 *   - a refusal, and every DRY_RUN pass → NOT_APPLICABLE: nothing was applied,
 *     by design or because nothing was in scope;
 *   - anything the pass could not complete — an effect that FAILED, a decision
 *     list over the cap, a roster it could not read in full → PARTIAL;
 *   - otherwise PASSED: a non-empty population was read in full and every
 *     orphan in it was contained (or there were none).
 *
 * PARTIAL wins over DRY_RUN's NOT_APPLICABLE when the roster was truncated: a
 * dry run whose HR half did not run produced an incomplete report, and the
 * seven-day window is read off these reports.
 */
export function orphanPassStatus(input: {
    refusal: OrphanPassRefusal | null;
    mode: IdentityWriteMode;
    failed: number;
    decisionsTruncated: boolean;
    rosterRead: boolean;
}): OrphanPassRanStatus {
    if (input.refusal) return 'NOT_APPLICABLE';
    if (input.failed > 0 || input.decisionsTruncated || !input.rosterRead) return 'PARTIAL';
    if (input.mode !== 'AUTOMATIC') return 'NOT_APPLICABLE';
    return 'PASSED';
}
