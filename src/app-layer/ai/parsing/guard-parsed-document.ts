/**
 * PARSER OUTPUT REACHES A MODEL ONLY THROUGH HERE (G4).
 *
 * A parsed document is more untrusted than the upload it came from: it is
 * text a model will read that no human wrote, assembled by a service from
 * whatever the file contained — hidden text layers, OCR of an image, a table
 * cell nobody looks at. So it crosses into model context the way every other
 * untrusted text does, through `guardUntrustedInput`, and this module turns
 * the answer into a type.
 *
 * {@link GuardedParsedDocument} is NOMINAL: a class with a private field, so an
 * object literal cannot satisfy it, and a constructor keyed on a symbol this
 * file does not export, so nothing outside it can construct one. A model-facing consumer (the
 * knowledge-index job, a retrieval tool) accepts `GuardedParsedDocument`, never
 * `ParsedDocument`, and the compiler holds the rule — no convention, no cast.
 *
 * The admission rule is the auto-draft one (`assertNoReviewRequired`, H2):
 * ANY review-required verdict withholds the document, `flag` as well as
 * `block`. Under the default `balanced` mode a malicious input resolves to
 * `flag`, and a document is not reviewed by a person between the parse and
 * the index, so a flag that let it through would reach every later prompt that
 * retrieves it. A withheld document is returned as a refusal carrying the
 * guard outcome (rule ids only), for the caller to record — never dropped.
 *
 * The scan text is the document's text AND every table cell: a table is
 * exactly where an instruction can sit unseen.
 *
 * This module logs nothing about the document. The guard audits a non-clean
 * verdict with rule ids only, which is its standing contract.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import type { ParsedDocument } from '@/lib/ai/parsing/types';
import { guardUntrustedInput, type GuardOutcome } from '@/app-layer/ai/guard';

/**
 * The constructor's key. Not exported, and a `unique symbol`, so no value
 * outside this module has its type: calling the constructor from anywhere else
 * does not compile without a cast.
 */
const ADMIT: unique symbol = Symbol('GuardedParsedDocument.admit');

export class GuardedParsedDocument {
    readonly #admitted = true;

    constructor(
        key: typeof ADMIT,
        readonly document: ParsedDocument,
        readonly guard: GuardOutcome,
    ) {
        if (key !== ADMIT) {
            throw new Error('GuardedParsedDocument is constructed by guardParsedDocument only');
        }
    }

    /** True by construction; present so the nominal private field is read. */
    get admitted(): boolean {
        return this.#admitted;
    }
}

export type ParsedDocumentAdmission =
    | { readonly admitted: true; readonly guarded: GuardedParsedDocument }
    | { readonly admitted: false; readonly outcome: GuardOutcome };

/** Everything in the document a model could be shown, as one string to scan. */
export function scanTextOf(document: ParsedDocument): string {
    const cells = document.tables.flatMap((t) => t.rows.flatMap((row) => row));
    return cells.length > 0 ? `${document.text}\n\n${cells.join('\n')}` : document.text;
}

export async function guardParsedDocument(
    ctx: RequestContext,
    document: ParsedDocument,
    opts: { readonly db?: PrismaTx } = {},
): Promise<ParsedDocumentAdmission> {
    const outcome = await guardUntrustedInput(ctx, scanTextOf(document), {
        source: `document-parser:${document.backend}`,
        db: opts.db,
    });
    if (outcome.reviewRequired) return { admitted: false, outcome };
    return { admitted: true, guarded: new GuardedParsedDocument(ADMIT, document, outcome) };
}
