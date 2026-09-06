/**
 * SAMPLING AN APPROVAL FOR RETROSPECTIVE REVIEW.
 *
 * Every other signal this subsystem produces measures the SHAPE of the review
 * behaviour — how many proposals, how fast, by whom, under which rung. None of
 * them measures whether the approvals were RIGHT. A queue that is rubber-
 * stamped under volume produces a flawless-looking record of consent nobody
 * actually gave, and it does so while every shape metric stays green. That is
 * the whole of OWASP ASI09, and the only instrument that sees it is a second
 * human looking at an already-approved proposal and saying whether they would
 * have approved it too.
 *
 * So: periodically re-draw a sample of APPROVED proposals, hand each to a
 * reviewer who is not the approver, and record whether they concur. The rate
 * at which they do not is the number.
 *
 * ── The tension this module exists to resolve ────────────────────────
 *
 * The sample must be REPRODUCIBLE — a selection nobody can re-derive cannot be
 * tested, and a sampler that cannot be tested is a sampler nobody can show is
 * fair. It must ALSO be UNPREDICTABLE — if a reviewer can tell at approval
 * time which proposals will be audited, the audit measures the reviewer's
 * ability to spot the audited ones and nothing else. `Math.random()` gives the
 * second and not the first; a public hash of the proposal id gives the first
 * and not the second.
 *
 * Three independent properties get both, and it is worth being precise about
 * which one does which work, because only the third survives an attacker who
 * has read this file:
 *
 *   1. KEYED. The score is an HMAC under a per-tenant secret derived from the
 *      master KEK (`deriveSubkey`). Knowing the algorithm is not enough;
 *      nothing renders the seed and nothing logs it. This alone defeats a
 *      reviewer who reads the source.
 *
 *   2. EPOCH-BOUND. The score mixes in the sampling run's epoch, so a
 *      proposal passed over in one run is a fresh draw in the next. A single
 *      "am I safe?" answer does not exist — it is one answer per run.
 *
 *   3. RANK-BASED OVER A POPULATION, which is the load-bearing one. A
 *      proposal is not selected by its score crossing a fixed threshold; it is
 *      selected by its score being among the lowest IN THE POPULATION THE RUN
 *      DRAWS FROM. That population includes approvals made AFTER this one. So
 *      even an adversary holding the seed cannot know at approval time whether
 *      this proposal will be sampled, because the answer depends on decisions
 *      nobody has made yet.
 *
 * Reproducibility is preserved intact: given the same seed, the same epoch and
 * the same candidate list, the selection is identical. That triple is exactly
 * what a test supplies, and exactly what a reviewer cannot assemble.
 *
 * A property this deliberately does NOT have: a minimum sample of one means a
 * tenant with a single approval has it audited with certainty. That is correct
 * — the alternative is a rate that silently reports "0 disagreements" over a
 * population of zero, which is the shape of a measurement that never ran.
 *
 * PURE, and no server imports: the seed arrives as an argument so this can be
 * exercised without a key, a database or a tenant.
 */
import { createHmac } from 'node:crypto';

/**
 * Why a retrospective reviewer did not concur, as stable codes.
 *
 * CODES AND NOT FREE TEXT, and that is not a convenience. The subject of the
 * review is an agent-authored payload; a note field would be the obvious place
 * to quote it, and a quote in a column the operator surfaces is the content
 * leaving the encrypted store it was put in. Codes also make the disagreement
 * rate decomposable — "which KIND of wrong" is the question that changes an
 * agent's policy card, and free text does not aggregate.
 *
 * Stable, because they are written into a hash-chained audit row and read back
 * as evidence later. Append to this list; never repurpose a member.
 */
export const SAMPLE_AUDIT_DISSENT_CODES = [
    /** The payload is not supported by the rationale the agent gave for it. */
    'RATIONALE_DOES_NOT_SUPPORT_PAYLOAD',
    /** Materially inaccurate about the tenant's actual posture. */
    'MATERIALLY_INACCURATE',
    /** A record like this already existed; the approval created a duplicate. */
    'DUPLICATE_OF_EXISTING_RECORD',
    /** Right content, wrong kind of record (a risk filed as a finding, ...). */
    'WRONG_ENTITY_KIND',
    /** Should have been edited before approval, not accepted as proposed. */
    'SHOULD_HAVE_BEEN_EDITED',
    /** Should not have been approved at all. */
    'SHOULD_HAVE_BEEN_REJECTED',
    /** Outside what this agent's policy card should ever have permitted. */
    'OUTSIDE_AGENT_REMIT',
] as const;

export type SampleAuditDissentCode = (typeof SAMPLE_AUDIT_DISSENT_CODES)[number];

/** Runtime narrowing for codes read back out of a database column. */
export function narrowDissentCodes(stored: readonly string[]): SampleAuditDissentCode[] {
    return stored.filter((c): c is SampleAuditDissentCode =>
        (SAMPLE_AUDIT_DISSENT_CODES as readonly string[]).includes(c),
    );
}

/**
 * What share of the eligible population one run draws.
 *
 * 10% is a starting calibration, not a derived constant: it is high enough
 * that a tenant approving a handful of proposals a week gets a real sample and
 * low enough that the retrospective review is not itself a queue. The floor
 * and ceiling matter more than the rate — see `sampleSizeFor`.
 */
export const SAMPLE_AUDIT_RATE = 0.1;

/**
 * At least one, whenever there is anything at all to draw from.
 *
 * Without this a small tenant samples zero and the disagreement rate reports
 * "no disagreements" — which is what a tenant with a perfect record and a
 * tenant nobody ever measured both look like. An absence is ambiguous; the
 * floor removes one of the two readings.
 */
export const SAMPLE_AUDIT_MIN = 1;

/**
 * And at most this many per run. The retrospective review is done by a human,
 * so a sampler that can hand somebody 400 items has reinvented the queue whose
 * depth it exists to measure.
 */
export const SAMPLE_AUDIT_MAX = 25;

/** How many to draw from a population of `n`. */
export function sampleSizeFor(n: number): number {
    if (n <= 0) return 0;
    return Math.min(
        SAMPLE_AUDIT_MAX,
        Math.max(SAMPLE_AUDIT_MIN, Math.ceil(n * SAMPLE_AUDIT_RATE)),
    );
}

/**
 * The separator between the epoch and the id inside the HMAC message.
 *
 * A NUL, because it cannot occur in either operand, so no two distinct
 * (epoch, id) pairs can produce the same message. Concatenating two strings
 * with a separator that could appear inside one of them is the ordinary way a
 * keyed identifier stops identifying.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * The keyed score for one candidate, as fixed-width lowercase hex.
 *
 * Hex of fixed width so a plain string comparison sorts numerically; there is
 * no BigInt in the ordering path and no truncation to a machine float.
 */
export function sampleScore(seed: string, epoch: string, id: string): string {
    return createHmac('sha256', seed)
        .update(`${epoch}${FIELD_SEPARATOR}${id}`)
        .digest('hex');
}

export interface SampleCandidate {
    id: string;
}

export interface SampleSelectionOptions {
    /** The per-tenant HMAC key. Never rendered, never logged. */
    seed: string;
    /** The run's epoch — the UTC date of the sweep, or a test-supplied value. */
    epoch: string;
    /** How many to take. Defaults to `sampleSizeFor(candidates.length)`. */
    count?: number;
}

/**
 * Draw the sample: the `count` candidates with the lowest keyed score.
 *
 * Rank, not threshold — see property 3 in the header. The tie-break on `id`
 * is unreachable in practice (a SHA-256 collision) and is there so the
 * function is a total order rather than "whatever the sort happened to do",
 * which is the kind of thing that makes a test pass on one Node version.
 */
export function selectSample<T extends SampleCandidate>(
    candidates: readonly T[],
    options: SampleSelectionOptions,
): T[] {
    const count = options.count ?? sampleSizeFor(candidates.length);
    if (count <= 0 || candidates.length === 0) return [];
    return [...candidates]
        .map((candidate) => ({
            candidate,
            score: sampleScore(options.seed, options.epoch, candidate.id),
        }))
        .sort((a, b) =>
            a.score === b.score
                ? a.candidate.id.localeCompare(b.candidate.id)
                : a.score.localeCompare(b.score),
        )
        .slice(0, count)
        .map((scored) => scored.candidate);
}

/** The epoch string for a run anchored at `now` — the UTC calendar day. */
export function samplingEpochFor(now: Date): string {
    return now.toISOString().slice(0, 10);
}
