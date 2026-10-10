/**
 * Step 6c: whether a model may adjudicate the reconciliation residue, and
 * where it runs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A LEAF MODULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It imports nothing but types. That is deliberate: the settings usecase has to
 * answer "may this tenant use the external processor?", and the obvious place to
 * read the answer from is `jev-provider`, which imports the transport, which
 * imports the egress stack. Dragging that into a settings page is the hazard
 * `legacy-reconcile` already names about the leaver pass — a module that must
 * never make an outbound call should not have one in its import graph, even
 * with no call site.
 *
 * So the SUB-PROCESSOR FACT lives here, and the provider reads it from here.
 * That is also the right direction on the merits: whether TypeSafe is an active
 * sub-processor is a fact about the deployment's DPA, not about one provider
 * class that happens to call it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO GATES, NOT ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `updateTenantSecurityConfig` REFUSES the combinations that cannot be
 * honoured — LOCAL_ONLY with no local endpoint, EXTERNAL under LOCAL_ONLY
 * residency, EXTERNAL while the processor is inactive.
 *
 * {@link effectiveLegacyMatchAiMode} then re-applies residency at USE time. Both
 * are needed, and the second is the one that is easy to leave out:
 *
 *   - the refusals stop a tenant CHOOSING an unhonourable combination;
 *   - the effective mode stops a combination BECOMING unhonourable later.
 *
 * The second happens whenever residency is tightened after the fact. A tenant on
 * EXTERNAL who later sets `aiResidency = LOCAL_ONLY` has a stored
 * `legacyMatchAiMode` that nothing refused, because nothing was wrong when it
 * was written. Reading the column directly at that point sends their data to a
 * third party they have just told us not to use.
 *
 * @module lib/legacy-access/adjudication-mode
 */

import type { AiResidency, LegacyMatchAiMode } from '@prisma/client';

/**
 * Whether TypeSafe is an ACTIVE sub-processor.
 *
 * `false`, and it stays false until the Step 6a notice window has closed and
 * somebody decides. Flipping this is a sub-processor activation, not a
 * configuration change — see `docs/sub-processors.md`.
 *
 * Moved here from `jev-provider` in Step 6c so a settings usecase can read it
 * without importing the egress stack. The provider now reads it from here; there
 * is still exactly one definition.
 */
export const TYPESAFE_SUBPROCESSOR_ACTIVE = false;

/**
 * Who processes the payload under each mode, and where.
 *
 * Recorded with every mode change, because "somebody changed
 * legacyMatchAiMode" does not answer "when did our data start going to a third
 * party, and which one" — which is the question a DPO asks of an audit trail.
 *
 * OFF names no processor rather than an empty string: a row claiming the
 * processor is "" reads as a missing value, and this one is a positive fact.
 */
export const LEGACY_MATCH_PROCESSOR: Readonly<
    Record<LegacyMatchAiMode, { readonly processor: string; readonly region: string }>
> = {
    OFF: { processor: 'none — no model is called', region: 'n/a' },
    LOCAL_ONLY: { processor: 'Laya, in-deployment', region: 'the deployment’s own region' },
    EXTERNAL: { processor: 'TypeSafe (Jev / SystemOne)', region: 'EU' },
};

/**
 * The mode that actually applies: the stricter of the tenant's choice and their
 * AI residency.
 *
 * `LOCAL_ONLY` residency caps the mode at `LOCAL_ONLY`; it does not force it to
 * `OFF`. A tenant who wants adjudication and wants it in-deployment is asking
 * for something coherent, and answering `OFF` would deny them a feature their
 * settings permit.
 *
 * Read this; never read the column. The column is what was chosen, which is not
 * the same as what is allowed now.
 */
export function effectiveLegacyMatchAiMode(
    stored: LegacyMatchAiMode | null | undefined,
    residency: AiResidency | null | undefined
): LegacyMatchAiMode {
    const mode = stored ?? 'OFF';
    if (mode === 'OFF') return 'OFF';
    // The only narrowing residency performs. Written as an explicit branch
    // rather than a min() over an ordering, because an ordering would have to
    // assert that OFF < LOCAL_ONLY < EXTERNAL is a STRICTNESS ordering as well
    // as an enum order, and a fourth mode added between them would silently
    // inherit a strictness nobody chose.
    if ((residency ?? 'EXTERNAL') === 'LOCAL_ONLY' && mode === 'EXTERNAL') {
        return 'LOCAL_ONLY';
    }
    return mode;
}

/** Does any model get called at all? */
export function adjudicationEnabled(
    stored: LegacyMatchAiMode | null | undefined,
    residency: AiResidency | null | undefined
): boolean {
    return effectiveLegacyMatchAiMode(stored, residency) !== 'OFF';
}
