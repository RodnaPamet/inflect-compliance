import { env } from '@/env';

/**
 * WHICH MODEL A FLUE RUN MAY ASK FOR — and why this is a model specifier
 * rather than a provider.
 *
 * ── THE HAZARD THIS EXISTS TO AVOID ─────────────────────────────────────────
 *
 * `@flue/runtime/internal` exposes `setProvider(provider)`, and the obvious
 * shape is to call it per run with a provider built from that tenant's
 * settings. That is unsafe here, and measurably so: the runtime holds its
 * providers in a MODULE-SCOPED singleton —
 *
 *     let models = createModels();            // providers.ts, module scope
 *     function setProvider(p) { models.setProvider(p); }
 *
 * — so every call mutates one process-wide registry. Two concurrent runs in
 * one Node process would race, and the loser executes against the winner's
 * provider. In a product where `aiResidency: LOCAL_ONLY` is documented as a
 * HARD invariant, that race is a cross-tenant egress: a LOCAL_ONLY tenant's
 * reasoning could be streamed to an external endpoint another tenant
 * registered a millisecond earlier, with nothing in the audit trail to show
 * it.
 *
 * ── THE SAFE SHAPE, AND WHY IT IS AVAILABLE ─────────────────────────────────
 *
 * pi-ai's own contract is "providers own stream behaviour; `Models` resolves
 * auth and delegates each request TO THE PROVIDER THAT OWNS THE MODEL", and
 * `resolveModel` resolves a `"<provider-id>/<model-id>"` specifier against the
 * registered set. `useModel` takes exactly that string.
 *
 * So the per-run decision moves off the registry and onto the ASK: register
 * each provider ONCE under a stable id, then choose a specifier per run. The
 * registry never mutates after init, so there is no race to lose.
 *
 * This module owns that choice. It deliberately does NOT call `setProvider`;
 * `tests/guards/flue-provider-registration-is-not-per-run.test.ts` keeps it
 * that way, because a single stray per-run call anywhere reintroduces the
 * hazard in full.
 */

/**
 * The two provider ids the runtime is expected to carry, registered once at
 * init. Distinct ids are what make the specifier a routing decision.
 */
export const FLUE_PROVIDER_IDS = {
    /** Reachable only by an EXTERNAL-residency tenant. */
    external: 'inflect-external',
    /** The self-hosted OpenAI-compatible gateway. */
    local: 'inflect-local',
} as const;

/** The per-tenant terms, mirroring `ProviderSelection` in `ai/risk-assessment`. */
export interface FlueModelSelection {
    residency?: 'EXTERNAL' | 'LOCAL_ONLY' | null;
    /** Per-tenant gateway override; else `AI_LOCAL_BASE_URL`. */
    localBaseUrl?: string | null;
    /** Per-tenant model override; else `AI_LOCAL_MODEL`. */
    localModel?: string | null;
}

/** Why a run may not proceed. Each is an operator-actionable configuration gap. */
export type FlueModelRefusal =
    /** LOCAL_ONLY, and no gateway is configured to be local against. */
    | 'LOCAL_GATEWAY_NOT_CONFIGURED'
    /** LOCAL_ONLY with a gateway but no model named on it. */
    | 'LOCAL_MODEL_NOT_CONFIGURED'
    /** EXTERNAL residency, but no external credential exists. */
    | 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED';

export type FlueModelChoice =
    | { ok: true; specifier: string; residency: 'EXTERNAL' | 'LOCAL_ONLY' }
    | { ok: false; reason: FlueModelRefusal };

/**
 * Resolve the model a run may ask for, or refuse with a named reason.
 *
 * ── REFUSES RATHER THAN FALLS BACK, AND THAT IS THE DIFFERENCE FROM THE
 *    RISK-ASSESSMENT FACTORY ──────────────────────────────────────────────
 *
 * `ai/risk-assessment/index.ts` degrades an unconfigured tenant to a
 * deterministic stub — correct there, because a risk suggestion has a
 * knowledge-base template to fall back ON, and a template is a real answer.
 *
 * A reasoning loop has no such answer. There is no deterministic substitute
 * for a model call, so an unconfigured run must not start: a stub-backed
 * "agent run" would produce steps, charge tokens, and write proposals that
 * nothing reasoned about. Refusing names the gap and leaves the run
 * un-started, which is the same posture the driver gate already takes for an
 * unimplemented driver.
 *
 * The LOCAL_ONLY branch short-circuits FIRST, before any external
 * consideration — the placement `getProvider` uses and for the identical
 * reason: a residency invariant enforced after an external branch has already
 * been evaluated is an invariant that depends on the order of a switch.
 */
export function resolveFlueModel(sel?: FlueModelSelection): FlueModelChoice {
    // ── HARD residency invariant, checked before anything external ──────────
    if (sel?.residency === 'LOCAL_ONLY') {
        const baseUrl = sel.localBaseUrl || env.AI_LOCAL_BASE_URL;
        if (!baseUrl) return { ok: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' };
        const model = sel.localModel || env.AI_LOCAL_MODEL;
        if (!model) return { ok: false, reason: 'LOCAL_MODEL_NOT_CONFIGURED' };
        return {
            ok: true,
            residency: 'LOCAL_ONLY',
            specifier: `${FLUE_PROVIDER_IDS.local}/${model}`,
        };
    }

    // EXTERNAL. The credential is the same one the posture summary and the
    // risk assessor already use — a second key for the same vendor would be a
    // second thing to rotate.
    if (!env.ANTHROPIC_API_KEY) {
        return { ok: false, reason: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED' };
    }
    return {
        ok: true,
        residency: 'EXTERNAL',
        specifier: `${FLUE_PROVIDER_IDS.external}/${env.ANTHROPIC_MODEL}`,
    };
}
