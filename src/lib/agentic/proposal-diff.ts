/**
 * The proposal DIFF - what a reviewer is actually consenting to.
 *
 * ## Why this module exists
 *
 * The propose-not-commit queue is the product's whole safety story for agentic
 * writes: an agent never mutates a record, it queues an `AgentProposal` and a
 * human approves it. That control is only worth what the human sees. Until now
 * the review UI printed `JSON.stringify(payloadJson)` into a `<pre>`, which is
 * an honest rendering of a CREATE and a lie about an UPDATE - the meaning of an
 * update is the difference between the payload and the row it targets, and a
 * payload alone cannot express a difference.
 *
 * Approving an opaque payload is not oversight. It is the exact mechanism by
 * which automation bias operates (OWASP ASI09): under volume, a reviewer
 * defaults to trusting the proposer, and the queue then manufactures an
 * auditable record of consent nobody actually gave.
 *
 * ## The five outcomes, and why they are five and not two
 *
 * The interesting failure is not "no diff" - it is a diff that RENDERS while
 * being empty or wrong. Three of these five statuses exist purely so that
 * "nothing would change" and "we could not work out what would change" can
 * never reach a reviewer looking alike:
 *
 *   CREATE             - no prior state exists; the full proposed content IS
 *                        the diff. Every field is an addition.
 *   UPDATE             - a base was read and at least one field differs.
 *   NO_CHANGES         - a base was read and NOTHING differs. A real, computed
 *                        answer: approving it is a no-op. Reviewable.
 *   TARGET_MISSING     - the row the update names is gone (deleted, or never
 *                        visible to this reviewer's tenant). NOT reviewable.
 *   PAYLOAD_UNREADABLE - the stored payload is not a JSON object, so there are
 *                        no fields to compare. NOT reviewable.
 *
 * `NO_CHANGES` and the two refusals are the pair that must not be confused.
 * They are different renderings, different tones, and - the load-bearing part -
 * different answers from `isDiffReviewable`, so the approve control is present
 * for one and absent for the others.
 *
 * ## Purity
 *
 * Nothing here reads a database, a clock, or a request context. The caller
 * supplies the base row; `src/app-layer/usecases/agent-proposal-diff.ts` is the
 * seam that fetches it. That split is what lets the whole decision table be
 * exercised as a unit test with no fixtures, including the branches a live DB
 * would make awkward to reach (a deleted target, a corrupt payload).
 */
import { createHash } from 'crypto';

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

/**
 * Render one proposed or stored value as the string a reviewer compares.
 *
 * `undefined` and `null` both collapse to `null` (rendered as an explicit
 * "empty" marker by the UI, never as the string "null"). Objects and arrays are
 * stringified with sorted keys so that two structurally equal values cannot
 * differ only by key order - an ordering difference presented as a change is a
 * diff that cries wolf, and a queue whose diffs cry wolf is a queue that gets
 * rubber-stamped.
 */
export function renderDiffValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    return stableStringify(value);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * The base fingerprint. Computed over the (field, before) pairs actually shown,
 * NOT over the whole row: the reviewer read a before-column, and that column is
 * what the approval is bound to. Including untouched columns would make an
 * unrelated edit elsewhere on the row invalidate a diff that is still exactly
 * true, which trains reviewers to retry past the warning.
 */
export function computeDiffBaseDigest(fields: readonly ProposalDiffField[]): string {
    const canonical = fields
        .map((f) => `${f.field}=${f.before ?? '∅'};`)
        .sort()
        .join('');
    return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface ComputeProposalDiffInput {
    operation: 'CREATE' | 'UPDATE';
    /** The stored `AgentProposal.payloadJson` - already decrypted by Epic B on read. */
    payloadJson: string;
    /**
     * The CURRENT state of the target, for an UPDATE.
     *   - a record  -> the base was read;
     *   - `null`    -> the target could not be found (deleted, or cross-tenant);
     *   - `undefined` for a CREATE, where there is nothing to read.
     */
    target?: Record<string, unknown> | null;
}

/**
 * Compute what the reviewer will be shown. Pure; see the module header for the
 * decision table.
 */
export function computeProposalDiff(input: ComputeProposalDiffInput): ProposalDiff {
    const payload = parsePayloadObject(input.payloadJson);
    if (!payload) {
        return {
            status: 'PAYLOAD_UNREADABLE',
            fields: [],
            baseDigest: null,
            comparedFieldCount: 0,
        };
    }

    const keys = Object.keys(payload).sort();

    if (input.operation === 'CREATE') {
        return {
            status: 'CREATE',
            fields: keys.map((field) => ({
                field,
                baseHasField: true,
                before: null,
                after: renderDiffValue(payload[field]),
                changed: true,
            })),
            baseDigest: null,
            comparedFieldCount: 0,
        };
    }

    // UPDATE from here. A missing base is NOT an empty base: rendering the
    // proposed values against a column of blanks would read as "this creates
    // all of these", which is the wrong story about a record that no longer
    // exists. The fields are still returned so an operator can triage WHAT was
    // proposed - the status is what stops it being approvable.
    if (!input.target) {
        return {
            status: 'TARGET_MISSING',
            fields: keys.map((field) => ({
                field,
                baseHasField: true,
                before: null,
                after: renderDiffValue(payload[field]),
                changed: false,
            })),
            baseDigest: null,
            comparedFieldCount: 0,
        };
    }

    const target = input.target;
    const fields: ProposalDiffField[] = keys.map((field) => {
        // OWN-PROPERTY, not a truthiness or an `undefined` test. A key the base
        // does not have and a key the base holds as null both read `undefined`
        // through `renderDiffValue`, and telling a reviewer "null → high" about
        // a field the record does not have is a false statement about the base
        // they are being asked to consent to a delta from.
        const baseHasField = Object.prototype.hasOwnProperty.call(target, field);
        const before = renderDiffValue(target[field]);
        const after = renderDiffValue(payload[field]);
        return { field, baseHasField, before, after, changed: before !== after };
    });

    return {
        status: fields.some((f) => f.changed) ? 'UPDATE' : 'NO_CHANGES',
        fields,
        baseDigest: computeDiffBaseDigest(fields),
        comparedFieldCount: fields.length,
    };
}

/** `payloadJson` -> a plain object, or null when it is anything else. */
function parsePayloadObject(payloadJson: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payloadJson);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}
