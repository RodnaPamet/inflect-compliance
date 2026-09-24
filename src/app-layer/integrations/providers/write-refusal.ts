/**
 * The one sentence two writer factories classify a constructor refusal by.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THIS IS A LEAF MODULE AND NOT A CONSTANT IN A PROVIDER
 * ═══════════════════════════════════════════════════════════════════
 *
 * It began inside `providers/entra-id/write-direction.ts`, which was right
 * while Entra was the only directory with a per-connection write opt-in.
 * Active Directory now has one too (#2841), and its refusal has to be
 * classified by the same `WRITES_NOT_ENABLED` code — a deliberate operator
 * state must not reach an operator as an unexplained `WRITER_REFUSED`.
 *
 * That left two options: have the AD module import the phrase from the Entra
 * module, or move it below both. Importing sideways would say that AD's
 * consent model is a detail of Entra's, which is false — they are two
 * independent statements that happen to be reported through one code — and it
 * would drag `entra-id/write-direction` into the AD import graph for a string.
 * This file has NO imports, by the same argument
 * `identity-writable-providers.ts` makes for itself one directory up.
 *
 * `entra-id/write-direction` re-exports both names, so its public surface and
 * every existing importer are unchanged.
 *
 * @module integrations/providers/write-refusal
 */

/**
 * The substring both factories classify on, spelled ONCE.
 *
 * It used to be an inline regex in `identity-writer-factory` matched against a
 * literal sentence in a provider module — two spellings of one string, in
 * different files, with nothing holding them together. Every provider refusal
 * that means "the operator deliberately did not opt in" must contain this
 * phrase, and each provider's tests assert that it does.
 */
export const WRITES_NOT_ENABLED_PHRASE = 'not enabled for directory writes';

/** Is this constructor failure the deliberate opt-out rather than a misconfiguration? */
export function isWritesNotEnabledRefusal(detail: string): boolean {
    return detail.toLowerCase().includes(WRITES_NOT_ENABLED_PHRASE);
}
