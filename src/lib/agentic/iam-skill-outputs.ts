/**
 * WHAT THE TWO IAM SKILLS MAY ANSWER (#3668, step 1d of the agentic IAM roadmap).
 *
 * `harness-level-assessment` and `nhi-ownership-attribution` are taught to an
 * agent as prose. Prose is what the model reads; it is not what anything
 * downstream may act on. This module is the other half: the closed shape each
 * skill's answer must parse into before the scanner ingest or the registration
 * intake (step 2a) may use it, with every rule the skill states as an
 * instruction re-stated here as a refusal.
 *
 * ── WHY A PARSER AND NOT A RUNTIME SEAM ─────────────────────────────────────
 *
 * The workflow engine has no per-workflow output schema today: a Flue run's
 * answer is the model's text, and the static engine's synthesis is the
 * definition's own function. Building that seam is not this step's to do. The
 * consumers of these contracts are 2a's intake (an owner suggestion becomes a
 * DRAFT register row only after a person confirms it) and any later reader of
 * an assessment, and each parses through here rather than trusting the text.
 *
 * ── THE ASSESSMENT: EVIDENCE OR "NOT EVIDENCED", NEVER A BARE YES ───────────
 *
 * Every verdict names a criterion by the ladder's own id (`HARNESS_CRITERIA`,
 * not a second list) and either cites an evidence reference or says it is not
 * evidenced. A verdict that says `met: true` with no reference is REFUSED, not
 * coerced: the ladder already reads it as not met, so accepting it would let an
 * answer claim a pass the level it produces does not contain — the cells and
 * the level would disagree. Refusing names the defect instead of hiding it.
 *
 * There is no `level` member, and an object carrying one is refused: the skill
 * says the ladder derives the level, and `toCriterionVerdicts` is how a reader
 * hands the verdicts to `scoreHarness` to get one.
 *
 * ── THE ATTRIBUTION: A SUGGESTION, AND NOTHING THAT COULD BE MISTAKEN FOR MORE
 *
 * `status` is a closed union of the reconcile engine's outcomes MINUS `LINKED`
 * (`src/lib/identity/reconcile/engine.ts`): only a strong deterministic signal
 * produces a link, and a model is not one. So `LINKED`, `CONFIRMED` or `OWNED`
 * is a parse failure, and at the type level `AttributionStatus` cannot hold
 * `LINKED` at all. No member records an owner either: an object carrying
 * `ownerUserId`, `confirmed` or `owned` is refused, because a person confirms in
 * the intake and nowhere else.
 *
 * The grade and the outcome are CHECKED against the signals rather than taken
 * from the answer, the rule the harness ingest applies to a scanner's report:
 * the claims are inputs, not facts. A naming pattern never decides, a group is
 * not an owner, a departed person is never proposed, and a tie is AMBIGUOUS.
 *
 * PURE: no clock, no I/O.
 */
import { z } from 'zod';

import type { Outcome } from '@/lib/identity/reconcile/engine';

import {
    ALL_HARNESS_CRITERIA,
    type CriterionVerdict,
    type HarnessCriterionId,
} from './harness-ladder';
import { MAX_EVIDENCE_CHARS, MAX_ID_CHARS, SOURCE_KINDS, looksLikeSecret } from './harness-contract';

/** A parse that either holds a value or names why it does not. */
export type SkillOutputParse<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly issues: readonly string[] };

const id = z.string().trim().min(1).max(MAX_ID_CHARS);

/**
 * A pointer to an observation: a source and an identifier, such as
 * `entra-sp:servicePrincipals/9f1c#owners`. Never a credential value — the
 * skill tells the model not to repeat one, and a reference that looks like a
 * secret is refused here whatever the model did.
 */
const evidenceRef = z
    .string()
    .trim()
    .min(1)
    .max(MAX_EVIDENCE_CHARS)
    .refine((v) => !looksLikeSecret(v), 'an evidence reference points at an observation and never carries a credential value');

function issuesOf(error: z.ZodError): string[] {
    return error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
}

// ─── The assessment ─────────────────────────────────────────────────────────

const criterion = z.enum(ALL_HARNESS_CRITERIA as unknown as [HarnessCriterionId, ...HarnessCriterionId[]]);

/** One criterion, as the assessment may state it. */
export type AssessedCriterion =
    /** An observation shows the criterion met, or shows it not met. Either way it is cited. */
    | {
        readonly criterion: HarnessCriterionId;
        readonly met: boolean;
        readonly evidence: string;
    }
    /** Nothing observed shows it: not met, and said so. */
    | {
        readonly criterion: HarnessCriterionId;
        readonly met: false;
        readonly evidence: null;
        readonly notEvidenced: true;
        /** The incomplete source the criterion depends on, when that is why. */
        readonly incompleteSource?: (typeof SOURCE_KINDS)[number];
    };

const AssessedCriterionSchema = z
    .object({
        criterion,
        met: z.boolean(),
        evidence: evidenceRef.nullable(),
        notEvidenced: z.literal(true).optional(),
        incompleteSource: z.enum(SOURCE_KINDS).optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
        if (v.evidence === null) {
            if (v.met) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['evidence'],
                    message: 'a met verdict must cite an evidence reference: met with nothing behind it is not met',
                });
            }
            if (v.notEvidenced !== true) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['notEvidenced'],
                    message: 'a verdict with no evidence reference must say it is not evidenced',
                });
            }
        } else {
            if (v.notEvidenced !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['notEvidenced'],
                    message: 'a verdict that cites evidence cannot also say it is not evidenced',
                });
            }
            if (v.incompleteSource !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['incompleteSource'],
                    message: 'an incomplete source is a reason for a verdict that is not evidenced',
                });
            }
        }
    })
    .transform((v) => v as AssessedCriterion);

export interface HarnessAssessment {
    /** The `DiscoveredAgent` row the assessment is about. */
    readonly discoveredAgentId: string;
    readonly verdicts: readonly AssessedCriterion[];
}

const HarnessAssessmentSchema = z
    .object({
        discoveredAgentId: id,
        // Zero verdicts is never an assessment: an answer about no criterion
        // evidences nothing, and "every verdict cites evidence" is true of it.
        verdicts: z.array(AssessedCriterionSchema).min(1).max(ALL_HARNESS_CRITERIA.length),
    })
    // Strict: an answer stating its own `level` is refused. The ladder derives it.
    .strict();

/**
 * Parse a `harness-level-assessment` answer. `asked` is the criteria the run
 * asked about — every criterion by default, which is what assessing one
 * discovered agent means — and the answer must give exactly one verdict for
 * each of them and none for anything else.
 */
export function parseHarnessAssessment(
    raw: unknown,
    asked: readonly HarnessCriterionId[] = ALL_HARNESS_CRITERIA,
): SkillOutputParse<HarnessAssessment> {
    const parsed = HarnessAssessmentSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };

    const issues: string[] = [];
    const seen = new Set<HarnessCriterionId>();
    const wanted = new Set(asked);
    for (const v of parsed.data.verdicts) {
        if (seen.has(v.criterion)) issues.push(`${v.criterion}: answered more than once`);
        seen.add(v.criterion);
        if (!wanted.has(v.criterion)) issues.push(`${v.criterion}: not a criterion this assessment was asked about`);
    }
    for (const c of asked) if (!seen.has(c)) issues.push(`${c}: not answered — an unanswered criterion is not evidenced, and the answer must say so`);
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: parsed.data };
}

/** The verdicts in the ladder's own shape, for `scoreHarness` to derive a level from. */
export function toCriterionVerdicts(assessment: HarnessAssessment): CriterionVerdict[] {
    return assessment.verdicts.map((v) => ({ criterion: v.criterion, met: v.met, evidence: v.evidence }));
}

// ─── The attribution ────────────────────────────────────────────────────────

/**
 * The owner signals the skill grades, STRONGEST FIRST — index is rank, as in
 * the skill's own numbered list. Only the first three name a person who could
 * own the agent; a team tag names a group, and a naming pattern decides nothing.
 */
export const OWNER_SIGNAL_KINDS = [
    'IDENTITY_OWNER',
    'CREDENTIAL_ACTOR',
    'DEPLOYMENT_OWNER',
    'TEAM_TAG',
    'NAMING_PATTERN',
] as const;
export type OwnerSignalKind = (typeof OWNER_SIGNAL_KINDS)[number];

/** Signals that can make a person the proposal. */
const DECIDING_KINDS: readonly OwnerSignalKind[] = ['IDENTITY_OWNER', 'CREDENTIAL_ACTOR', 'DEPLOYMENT_OWNER'];
/** Signals that can make a proposal STRONG: "signal 1 or 2 names exactly one active person". */
const STRONG_KINDS: readonly OwnerSignalKind[] = ['IDENTITY_OWNER', 'CREDENTIAL_ACTOR'];

const rankOf = (kind: OwnerSignalKind): number => OWNER_SIGNAL_KINDS.indexOf(kind);

/**
 * The only statuses a model's attribution can carry: the reconcile engine's
 * outcomes, minus `LINKED` — the one that acts without a reviewer — and minus
 * `NON_PERSON`, which a non-human identity is by definition. `CONFIRMED` was
 * never a member of either.
 */
export type AttributionStatus = Exclude<Outcome, 'LINKED' | 'NON_PERSON'>;
export const ATTRIBUTION_STATUSES = ['SUGGESTED', 'AMBIGUOUS', 'UNMATCHED'] as const satisfies readonly AttributionStatus[];

export interface OwnerSignal {
    readonly kind: OwnerSignalKind;
    /** Where it was observed: a source and an identifier. */
    readonly evidence: string;
    /** The person it names, in the source's own namespace, or null. */
    readonly personRef: string | null;
    /** Whether that person's membership is active, as the input said; null when it did not. */
    readonly personActive: boolean | null;
}

export type OwnershipAttribution =
    | {
        readonly discoveredAgentId: string;
        readonly status: 'SUGGESTED';
        /** Proposed for a person to confirm in the intake. Never recorded here. */
        readonly proposedOwnerRef: string;
        readonly grade: 'STRONG' | 'WEAK';
        readonly signals: readonly OwnerSignal[];
    }
    | {
        readonly discoveredAgentId: string;
        /** Two people with equal signals: both reported, nobody proposed. */
        readonly status: 'AMBIGUOUS';
        readonly signals: readonly OwnerSignal[];
    }
    | {
        readonly discoveredAgentId: string;
        readonly status: 'UNMATCHED';
        /** No owner signal, or the strongest names somebody who has left (an orphan). */
        readonly reason: 'NO_OWNER_SIGNAL' | 'OWNER_DEPARTED';
        readonly signals: readonly OwnerSignal[];
    };

const OwnerSignalSchema = z
    .object({
        kind: z.enum(OWNER_SIGNAL_KINDS),
        evidence: evidenceRef,
        personRef: id.nullable(),
        personActive: z.boolean().nullable(),
    })
    .strict()
    .superRefine((s, ctx) => {
        if (s.kind === 'TEAM_TAG' && s.personRef !== null) {
            ctx.addIssue({ code: 'custom', path: ['personRef'], message: 'a team tag names a group, and a group is not an owner' });
        }
        if (s.personRef === null && s.personActive !== null) {
            ctx.addIssue({ code: 'custom', path: ['personActive'], message: 'only a signal that names a person can say whether they are active' });
        }
    });

const signals = z.array(OwnerSignalSchema).max(50);

// Each arm strict: `ownerUserId`, `confirmed`, `owned` or a `LINKED` status is
// not a shape this union has, so an answer that recorded an owner fails here.
const OwnershipAttributionSchema = z.discriminatedUnion('status', [
    z
        .object({
            discoveredAgentId: id,
            status: z.literal('SUGGESTED'),
            proposedOwnerRef: id,
            grade: z.enum(['STRONG', 'WEAK']),
            signals: signals.min(1),
        })
        .strict(),
    z.object({ discoveredAgentId: id, status: z.literal('AMBIGUOUS'), signals }).strict(),
    z
        .object({
            discoveredAgentId: id,
            status: z.literal('UNMATCHED'),
            reason: z.enum(['NO_OWNER_SIGNAL', 'OWNER_DEPARTED']),
            signals,
        })
        .strict(),
]);

/** The strongest rank at which each person is named by a deciding signal. */
function strongestByPerson(all: readonly OwnerSignal[]): Map<string, { rank: number; active: boolean | null }> {
    const by = new Map<string, { rank: number; active: boolean | null }>();
    for (const s of all) {
        if (s.personRef === null || !DECIDING_KINDS.includes(s.kind)) continue;
        const prior = by.get(s.personRef);
        const rank = rankOf(s.kind);
        // A person is departed if ANY signal says so: an active claim elsewhere
        // does not undo a deactivated membership.
        const active: boolean | null =
            prior?.active === false || s.personActive === false
                ? false
                : prior?.active === true || s.personActive === true
                    ? true
                    : null;
        by.set(s.personRef, { rank: Math.min(prior?.rank ?? rank, rank), active });
    }
    return by;
}

/**
 * The grade the skill's rule gives a proposal of this person: STRONG when an
 * identity-owner or credential signal names exactly one active person and it is
 * this one, WEAK otherwise. Activity the input did not state is not "active".
 */
export function gradeFor(personRef: string, all: readonly OwnerSignal[]): 'STRONG' | 'WEAK' {
    const named = all.some(
        (s) => s.personRef === personRef && STRONG_KINDS.includes(s.kind) && s.personActive === true,
    );
    const others = all.some(
        (s) => s.personRef !== null && s.personRef !== personRef && STRONG_KINDS.includes(s.kind) && s.personActive !== false,
    );
    return named && !others ? 'STRONG' : 'WEAK';
}

/** Parse a `nhi-ownership-attribution` answer, and check its outcome against its own signals. */
export function parseOwnershipAttribution(raw: unknown): SkillOutputParse<OwnershipAttribution> {
    const parsed = OwnershipAttributionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
    const a = parsed.data as OwnershipAttribution;
    const people = strongestByPerson(a.signals);
    const issues: string[] = [];

    if (a.status === 'SUGGESTED') {
        const owner = people.get(a.proposedOwnerRef);
        if (!owner) {
            issues.push('a suggested owner must be named by an identity-owner, credential or deployment signal; a naming pattern or a team tag never decides');
        } else {
            if (owner.active === false) issues.push('a person whose membership is not active is never proposed: that is an orphan, UNMATCHED');
            for (const [ref, other] of people) {
                if (ref === a.proposedOwnerRef) continue;
                if (other.active === false) {
                    if (other.rank <= owner.rank) {
                        issues.push(`${ref}, named at least as strongly, has left: an orphan is UNMATCHED, not a proposal`);
                    }
                } else if (other.rank < owner.rank) {
                    issues.push(`${ref} is named by a stronger signal than the suggested owner`);
                } else if (other.rank === owner.rank) {
                    issues.push(`${ref} has a signal equal to the suggested owner's: a tie is AMBIGUOUS, never broken`);
                }
            }
            const derived = gradeFor(a.proposedOwnerRef, a.signals);
            if (a.grade !== derived) issues.push(`the signals grade this proposal ${derived}, not ${a.grade}`);
        }
    } else if (a.status === 'AMBIGUOUS') {
        if (people.size < 2) issues.push('a tie reports at least two people, each named by a deciding signal');
    } else if (a.reason === 'NO_OWNER_SIGNAL') {
        if (people.size > 0) issues.push('a signal names a person, so there is an owner signal');
    } else if (![...people.values()].some((p) => p.active === false)) {
        issues.push('an orphan needs a signal naming a person whose membership is not active');
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: a };
}
