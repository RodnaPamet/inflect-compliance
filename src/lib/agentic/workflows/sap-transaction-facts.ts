/**
 * THE `facts` INPUT of `sap-transaction-review` (#3864).
 *
 * What Joule hands over about SAP documents. Inflect judges these against the
 * tenant's controls and never calls SAP, so this structure is the ENTIRE factual
 * basis of an answer — which is why it is validated strictly and why the
 * workflow has to say what it was not given.
 *
 * ## It arrives as a JSON STRING, not an object, and that is forced
 *
 * `assertRequiredInputPresent` (`workflow-runs.ts`) refuses a run unless every
 * `requiredInput` key is a NON-EMPTY STRING, and `a2a-inbound.ts` refuses a data
 * part carrying any key the definition does not declare (`DATA_REFUSED`). So
 * there is no route by which a nested object could both be declared and be
 * accepted: `facts` is a JSON string, parsed and validated here.
 *
 * That shape is only safe because the scan normaliser decodes JSON escapes
 * first (`guard/normalize.ts` step 0, #3896). A newline inside a JSON string
 * value is the two characters `\` and `n`; before that fix the literal `n`
 * fused with the following token and an injection written on its own line
 * reached the model unflagged. Verified by positive control, not assumed.
 *
 * ## Strict, and unknown keys are REFUSED rather than stripped
 *
 * `.strict()` throughout. A host that sends a field we do not model is told so:
 * silently dropping it would mean answering about a document while ignoring part
 * of what we were told about it, and the answer would read as though the whole
 * document had been considered.
 *
 * ## Every collection and string is BOUNDED
 *
 * The A2A body is already capped at 64 KiB before parsing, so these caps are not
 * the only defence — they exist so a refusal is NAMED and attributable rather
 * than arriving as a parse failure, and so one enormous document cannot crowd
 * out the model's attention for the rest.
 */
import { z } from 'zod';

/** Caps. Source constants: raising one is a reviewed diff. */
export const SAP_FACTS_LIMITS = {
    MAX_DOCUMENTS: 25,
    MAX_LINE_ITEMS: 50,
    MAX_SHORT_TEXT: 120,
    MAX_IDENTIFIER: 60,
} as const;

const shortText = z.string().trim().min(1).max(SAP_FACTS_LIMITS.MAX_SHORT_TEXT);
const identifier = z.string().trim().min(1).max(SAP_FACTS_LIMITS.MAX_IDENTIFIER);

/**
 * An ISO-8601 date, as a STRING and not coerced to a Date.
 *
 * Deliberate: these are facts a third party asserted, and converting them would
 * both apply this process's timezone to someone else's calendar date and make
 * the value we judge differ from the value we were sent. The answer quotes what
 * it was given.
 */
const isoDate = z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/, 'must be an ISO-8601 date');

const lineItem = z
    .object({
        description: shortText,
        /** Signed: a credit line is negative, and forcing it positive would hide a reversal. */
        amount: z.number().finite(),
        quantity: z.number().finite().optional(),
        glAccount: identifier.optional(),
        costCentre: identifier.optional(),
    })
    .strict();

const sapDocument = z
    .object({
        /** e.g. "purchase order", "vendor invoice", "journal entry". Free text: SAP document types are tenant-configured. */
        documentType: shortText,
        documentNumber: identifier,
        /** Who created it in SAP. The SoD question is about this against `approvedBy`. */
        createdBy: identifier,
        /** Absent when the document is not approved — which is itself a fact worth stating. */
        approvedBy: identifier.optional(),
        customer: shortText.optional(),
        vendor: shortText.optional(),
        /** The document total. Signed, like a line item. */
        amount: z.number().finite(),
        /** ISO-4217, upper case. Three letters exactly: a missing currency makes an amount unjudgeable against a limit. */
        currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/, 'must be an ISO-4217 code'),
        documentDate: isoDate,
        postingDate: isoDate.optional(),
        /** The approver's limit, when the host knows it. Absent means we cannot judge the limit question. */
        approverLimit: z.number().finite().optional(),
        lineItems: z.array(lineItem).max(SAP_FACTS_LIMITS.MAX_LINE_ITEMS).optional(),
    })
    .strict();

export const sapTransactionFactsSchema = z
    .object({
        documents: z.array(sapDocument).min(1).max(SAP_FACTS_LIMITS.MAX_DOCUMENTS),
    })
    .strict();

export type SapTransactionFacts = z.infer<typeof sapTransactionFactsSchema>;
export type SapDocumentFacts = z.infer<typeof sapDocument>;

export type SapFactsRefusal =
    /** The string was not JSON at all. */
    | 'MALFORMED_JSON'
    /** Valid JSON, but carries a key this schema does not model. */
    | 'UNKNOWN_KEY'
    /** Valid JSON with known keys, but a value is the wrong shape or out of bounds. */
    | 'INVALID_VALUE';

export type SapFactsReading =
    | { readonly ok: true; readonly facts: SapTransactionFacts }
    | { readonly ok: false; readonly reason: SapFactsRefusal; readonly detail: string };

/**
 * Parse and validate the `facts` string.
 *
 * `UNKNOWN_KEY` is told apart from `INVALID_VALUE` on purpose. They mean
 * different things to whoever is integrating: an unknown key is usually a host
 * sending a field from a newer schema than we model, which someone must decide
 * to support; an invalid value is a bad payload to fix. One shared reason would
 * make those two indistinguishable in a support conversation.
 */
export function readSapTransactionFacts(raw: string): SapFactsReading {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { ok: false, reason: 'MALFORMED_JSON', detail: e instanceof Error ? e.message : 'unparseable' };
    }
    const result = sapTransactionFactsSchema.safeParse(parsed);
    if (result.success) return { ok: true, facts: result.data };

    const issues = result.error.issues;
    const unrecognised = issues.filter((i) => i.code === 'unrecognized_keys');
    if (unrecognised.length > 0) {
        // Name the keys: "unknown key" with no key is a refusal the integrator
        // cannot act on.
        const keys = unrecognised
            .flatMap((i) => ('keys' in i && Array.isArray(i.keys) ? (i.keys as string[]) : []))
            .join(', ');
        return { ok: false, reason: 'UNKNOWN_KEY', detail: keys || 'unrecognised key' };
    }
    const first = issues[0];
    return {
        ok: false,
        reason: 'INVALID_VALUE',
        detail: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid',
    };
}

/**
 * WHAT WE WERE NOT GIVEN, for one document.
 *
 * The skill must say this and the answer must carry it, because absence of a
 * conflict in the facts supplied is NOT evidence of compliance. A document with
 * no `approvedBy` cannot be tested for creator-equals-approver; one with no
 * `approverLimit` cannot be tested against a limit. Reporting "no issue found"
 * without naming these would overclaim, and this function makes the omission a
 * value rather than a thing the prose has to remember.
 */
export function unjudgeableAspects(doc: SapDocumentFacts): readonly string[] {
    const gaps: string[] = [];
    if (!doc.approvedBy) gaps.push('no approver was given, so creator-equals-approver could not be tested');
    if (doc.approverLimit === undefined) {
        gaps.push('no approval limit was given, so the amount could not be tested against one');
    }
    if (!doc.lineItems || doc.lineItems.length === 0) {
        gaps.push('no line items were given, so nothing below the document total was examined');
    }
    if (!doc.postingDate) gaps.push('no posting date was given, so period-based tests could not be applied');
    return gaps;
}
