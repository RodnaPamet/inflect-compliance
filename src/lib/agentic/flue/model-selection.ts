import { env } from '@/env';
import { resolveLocalGateway } from '@/lib/ai/local-gateway';

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
 * This module owns that choice. It deliberately does NOT call `setProvider`,
 * because a single stray per-run call anywhere reintroduces the hazard in
 * full.
 *
 * PINNED BY `tests/guards/flue-provider-is-never-set-per-run.test.ts`, which
 * scans every file under `src/` for a `setProvider(` CALL with comments
 * masked — this paragraph quotes the function three times, and a raw scan
 * would report the explanation as the breach. It also refuses to match
 * `setProviders(`, the React state setter two admin pages use.
 *
 * It cited `flue-provider-registration-is-not-per-run` before that, and that
 * file had never existed (#3650) — so the only thing keeping a per-run call
 * out of a CROSS-TENANT EGRESS path was this paragraph.
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

/**
 * The provider id a specifier routes to — the one definition (#3872).
 *
 * A specifier is `<providerId>/<model>`, built in `resolveFlueModel` below and
 * nowhere else. The external-residency gate has to know whether a run's model
 * calls leave the deployment, and `modelSpecifier.split('/')[0]` at its call
 * site would be a second opinion about the shape — which is the kind of
 * duplication the `RESIDENCY_SELECT` note below records as the one that
 * actually bites.
 *
 * A specifier with no `/` yields the whole string, which matches no registered
 * provider id, so an unparseable specifier is treated as "not the external
 * provider" by the gate and as unregistered by `flueModelIsRegistered` — the
 * run does not start at all, which is the right outcome and not this
 * function's to make.
 */
export function providerIdOf(specifier: string): string {
    const slash = specifier.indexOf('/');
    return slash === -1 ? specifier : specifier.slice(0, slash);
}

/** The per-tenant terms, mirroring `ProviderSelection` in `ai/risk-assessment`. */
export interface FlueModelSelection {
    residency?: 'EXTERNAL' | 'LOCAL_ONLY' | null;
    /** Per-tenant gateway override; else `AI_LOCAL_BASE_URL`. */
    localBaseUrl?: string | null;
    /** Per-tenant model override; else `AI_LOCAL_MODEL`. */
    localModel?: string | null;
}

/**
 * The `select` clause the posture is read with, and the mapping from that row
 * to the terms above. #3384 — three consumers read these same three columns
 * (`flue/driver.ts`, `usecases/risk-suggestions.ts`, `ai/intent/
 * chooser-for-tenant.ts`), and each used to write the three field renames out
 * by hand.
 *
 * The duplication that mattered was never the query — it was the RENAME.
 * A fourth column, or a rename, is a silent partial update: a site that keeps
 * compiling while passing `undefined` for the term it forgot gets the DEFAULT
 * posture, and `resolveFlueModel` reads an absent `residency` as EXTERNAL. So
 * the failure mode of a missed site is a LOCAL_ONLY tenant treated as
 * EXTERNAL, which is the one direction that matters.
 *
 * This is a MAPPER and not a reader on purpose. `risk-suggestions.ts` does its
 * read inside an existing `runInTenantContext(ctx, async (db) => …)`, so a
 * helper that opened its own context would nest one inside another. Each site
 * keeps its own read, with whatever `db` it already holds, and shares only the
 * part that was actually being repeated.
 *
 * The returned shape also satisfies `ProviderSelection` in
 * `ai/risk-assessment`, which mirrors `FlueModelSelection` field for field —
 * so the one mapper serves both `resolveFlueModel` and `getProvider`.
 */
export const RESIDENCY_SELECT = {
    aiResidency: true,
    aiLocalBaseUrl: true,
    aiLocalModel: true,
} as const;

export function residencyTermsFrom(
    row:
        | {
              readonly aiResidency?: 'EXTERNAL' | 'LOCAL_ONLY' | null;
              readonly aiLocalBaseUrl?: string | null;
              readonly aiLocalModel?: string | null;
          }
        | null
        | undefined,
): FlueModelSelection {
    // An absent row resolves to `undefined` throughout, which
    // `resolveFlueModel` and `getProvider` both read as EXTERNAL — the same
    // default `tenant-security-settings.ts` applies when the row is missing.
    return {
        residency: row?.aiResidency,
        localBaseUrl: row?.aiLocalBaseUrl,
        localModel: row?.aiLocalModel,
    };
}

/** Why a run may not proceed. Each is an operator-actionable configuration gap. */
export type FlueModelRefusal =
    /** LOCAL_ONLY, and no gateway is configured to be local against. */
    | 'LOCAL_GATEWAY_NOT_CONFIGURED'
    /** LOCAL_ONLY with a gateway but no model named on it. */
    | 'LOCAL_MODEL_NOT_CONFIGURED'
    /** EXTERNAL residency, but no external credential exists. */
    | 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED'
    /**
     * LOCAL_ONLY against a gateway this deployment does not serve.
     *
     * The tenant nominated its own `aiLocalBaseUrl`, and the `inflect-local`
     * provider is built ONCE AT BOOT from `AI_LOCAL_BASE_URL` alone. Honouring
     * the tenant value here while the traffic went to the deployment endpoint
     * would send that tenant's content somewhere it did not nominate — under a
     * residency setting whose whole point is that it does not.
     */
    | 'LOCAL_GATEWAY_NOT_SERVED';

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
        // The rule now lives in `@/lib/ai/local-gateway`, shared with the
        // risk-suggestion factory, which had no such rule and dialled the
        // tenant's URL with the deployment's key (#4545). The behaviour here is
        // unchanged — the refusals map one-to-one — and the point of moving it
        // is that the next reader of a tenant `aiLocalBaseUrl` inherits it
        // instead of having to remember it.
        const gateway = resolveLocalGateway(sel.localBaseUrl);
        if (!gateway.served) {
            return {
                ok: false,
                reason:
                    gateway.reason === 'NOT_SERVED'
                        ? 'LOCAL_GATEWAY_NOT_SERVED'
                        : 'LOCAL_GATEWAY_NOT_CONFIGURED',
            };
        }
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
    // second thing to rotate. The MODEL is not: the agent runtime names
    // AGENT_FLUE_MODEL, and ANTHROPIC_MODEL stays with those two features
    // (owner decision, 2026-10-18). `runtime-start.ts` registers the external
    // route under the same variable, so the specifier resolves.
    if (!env.ANTHROPIC_API_KEY) {
        return { ok: false, reason: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED' };
    }
    return {
        ok: true,
        residency: 'EXTERNAL',
        specifier: `${FLUE_PROVIDER_IDS.external}/${env.AGENT_FLUE_MODEL}`,
    };
}
