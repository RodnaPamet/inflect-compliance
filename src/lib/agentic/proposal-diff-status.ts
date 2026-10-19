/**
 * The proposal diff's SHAPE and its reviewability rule, with no hashing.
 *
 * Split out of `proposal-diff.ts` (#3726) because `ProposalDiffPanel` is a
 * client component and needs only these: the types it renders and the
 * predicate it gates the approve control on. `proposal-diff.ts` computes the
 * base digest with `crypto`, and a client importing it shipped the
 * crypto-browserify polyfill to the proposals page for a hash the browser
 * never takes. `proposal-diff.ts` re-exports everything here, so the server
 * and the tests import from either.
 *
 * Keep this module free of Node built-ins: a client reaches it.
 * `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * fails if it, or anything it imports, gains one.
 */

/** What the review UI is being asked to render. See the header. */
export type ProposalDiffStatus =
    | 'CREATE'
    | 'UPDATE'
    | 'NO_CHANGES'
    | 'TARGET_MISSING'
    | 'PAYLOAD_UNREADABLE';

/**
 * One field of the proposal, rendered.
 *
 * `before` is `null` for a CREATE and for an uncomputable base - those two are
 * distinguished by the diff's STATUS, never by squinting at a row. `after` is
 * the proposed value. Both are pre-rendered to strings here rather than in the
 * component, so the comparison that decides `changed` is the same comparison
 * the reviewer's eyes make: two rows that render identically are not "changed".
 */
export interface ProposalDiffField {
    field: string;
    before: string | null;
    after: string | null;
    changed: boolean;
    /**
     * Does the base RECORD carry this field at all?
     *
     * `before: null` answers two different questions with one word — "the record
     * holds null here" and "the record has no such field" — and `renderDiffValue`
     * maps `undefined` and `null` to the same `null`, so a payload key the base
     * does not have rendered as an ordinary null→value change. That is a diff
     * asserting the record HAS a field it does not, which is the one thing a
     * before/after column exists to be trusted about.
     *
     * Always `true` where there is no base to ask (CREATE, TARGET_MISSING) — the
     * status already carries that story, and a second `false` there would mean
     * something different from the one this flag is for.
     */
    baseHasField: boolean;
}

export interface ProposalDiff {
    status: ProposalDiffStatus;
    fields: ProposalDiffField[];
    /**
     * `sha256:<hex>` over the BASE the fields were computed against - the
     * fingerprint of what the reviewer was shown in the before-column.
     *
     * `null` for CREATE (there is no base) and for the two uncomputable
     * statuses (there is nothing to fingerprint). For an UPDATE it is the token
     * the approve path demands back: a reviewer consents to a specific delta
     * from a specific base, and an approval that cannot name the base it read
     * is an approval of whatever the row happens to say now.
     */
    baseDigest: string | null;
    /**
     * How many fields the payload carried that were actually COMPARED against a
     * base. Zero for a create (nothing to compare against) and zero for either
     * refusal (no comparison happened), so a caller can tell "compared and found
     * nothing" from "never compared" without re-deriving it from the status.
     */
    comparedFieldCount: number;
}

/** Statuses whose diff is a computed, trustworthy answer. */
const REVIEWABLE: readonly ProposalDiffStatus[] = ['CREATE', 'UPDATE', 'NO_CHANGES'];

/**
 * May a human approve this proposal?
 *
 * The predicate the review UI gates the approve control on, and the one the
 * approve usecase re-evaluates server-side. `NO_CHANGES` is deliberately TRUE:
 * the diff was computed and is being shown truthfully, and "the answer is
 * nothing" is an answer. The two refusals are FALSE because the reviewer would
 * be consenting to something nobody rendered - which is the entire failure this
 * module exists to prevent.
 */
export function isDiffReviewable(diff: Pick<ProposalDiff, 'status'>): boolean {
    return REVIEWABLE.includes(diff.status);
}
