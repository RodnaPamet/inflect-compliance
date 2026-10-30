/**
 * WHICH LOCAL AI GATEWAY THIS DEPLOYMENT WILL DIAL — one definition, two
 * callers.
 *
 * ── THE HAZARD ──────────────────────────────────────────────────────────────
 *
 * `TenantSecuritySettings.aiLocalBaseUrl` is written by any `admin.manage`
 * holder through `PUT /api/t/:slug/admin/security-settings`, whose schema is
 * `z.string().url()` and nothing more. So the value is a HOSTNAME A TENANT
 * ADMIN CHOSE, and anything that dials it dials wherever they pointed it: a
 * private address, the cloud-metadata endpoint, or any other internal host.
 *
 * Two things ride on that URL, and the second is worse than the first:
 *
 *   1. the request itself — textbook SSRF; and
 *   2. `AI_LOCAL_API_KEY`, which is the DEPLOYMENT's gateway credential and is
 *      sent as `Authorization: Bearer …`. A tenant admin who can choose the
 *      host can therefore collect that key.
 *
 * ── WHY `safeFetch` IS NOT THE ANSWER HERE ──────────────────────────────────
 *
 * Every other tenant-controlled sink in this repo routes through `safeFetch`
 * (`tests/guards/ssrf-egress-coverage.test.ts` holds that registry). This one
 * cannot: `assertPublicAddress` REFUSES private, loopback and link-local
 * addresses, and a local inference gateway is *supposed* to be on one —
 * `http://localhost:11434` for Ollama, an internal host for vLLM. Putting this
 * sink behind the public-address check would not harden the feature, it would
 * delete it.
 *
 * So the defence is upstream of the dial: the tenant does not get to choose
 * the host at all. A per-tenant value is honoured only when it NAMES THE
 * GATEWAY THIS DEPLOYMENT ALREADY SERVES, and is otherwise refused by name.
 * With that rule in place there is no tenant-controlled URL left to guard,
 * which is why this file is the fix rather than a new `SINKS` entry.
 *
 * ── WHY IT IS SHARED RATHER THAN WRITTEN TWICE ──────────────────────────────
 *
 * Flue had this rule (`LOCAL_GATEWAY_NOT_SERVED`, "what is decided here must
 * be what is dialled there") and the risk-suggestion factory did not (#4545) —
 * one subsystem defending an invariant the next one next door ignored. Two
 * copies of a rule eventually disagree, and the direction a drifted copy
 * disagrees in is the direction that grants access. One function, two callers,
 * and a guard that fails if a third reader of `env.AI_LOCAL_BASE_URL` appears
 * without going through it.
 *
 * This module reads `@/env` and nothing else, deliberately: both callers sit in
 * different layers (`src/lib/agentic/flue/`, `src/app-layer/ai/`), and a leaf
 * can be imported by either without dragging a module graph across the seam.
 */
import { env } from '@/env';

/** Why a nominated local gateway will not be dialled. */
export type LocalGatewayRefusal =
    /** Neither the deployment nor the tenant names a gateway. */
    | 'LOCAL_GATEWAY_NOT_CONFIGURED'
    /**
     * The tenant nominated a gateway this deployment does not serve.
     *
     * Refused rather than honoured, because honouring it dials a host a tenant
     * admin chose and hands it `AI_LOCAL_API_KEY`. Refused rather than silently
     * ignored, because ignoring it sends a LOCAL_ONLY workspace's content to a
     * gateway it did not nominate — the one outcome that setting exists to
     * prevent.
     */
    | 'LOCAL_GATEWAY_NOT_SERVED';

export type LocalGatewayResolution =
    | { readonly served: true; readonly baseUrl: string }
    | { readonly served: false; readonly reason: LocalGatewayRefusal };

/**
 * Resolve the gateway to dial for a tenant that nominated `tenantBaseUrl`.
 *
 * On success the URL is ALWAYS the deployment's `AI_LOCAL_BASE_URL` — never the
 * tenant's string, even when the two are equal. That is not pedantry: it means
 * no caller can accidentally come to depend on the tenant value flowing
 * through, so narrowing this rule later cannot silently change what is dialled.
 */
export function resolveLocalGateway(
    tenantBaseUrl: string | null | undefined,
): LocalGatewayResolution {
    const deployment = env.AI_LOCAL_BASE_URL;

    // Checked FIRST, before the configured-at-all question, so that a tenant
    // URL on a deployment with no gateway reports the specific refusal rather
    // than the generic one. An operator reading NOT_CONFIGURED would go and set
    // `AI_LOCAL_BASE_URL`; the honest answer is that the value they are looking
    // at is not one this deployment can serve.
    //
    // Compared RAW, exactly as `resolveFlueModel` compared it before this
    // module existed. No trailing-slash or case normalisation: a looser
    // comparison admits more strings, and every string it newly admits is one a
    // tenant admin typed.
    if (tenantBaseUrl && tenantBaseUrl !== deployment) {
        return { served: false, reason: 'LOCAL_GATEWAY_NOT_SERVED' };
    }
    if (!deployment) {
        return { served: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' };
    }
    return { served: true, baseUrl: deployment };
}

/** One sentence per refusal, for the operator reading a log line. */
/**
 * One sentence per refusal, for the operator reading a log line.
 *
 * The WORDING and the REASON CODES are #4556's, kept verbatim: that fix shipped
 * first and its sentences are what the logs, its own tests and any alert keyed
 * on `reason` already carry. A refactor that unifies two copies of a rule must
 * not also reword the output — that would make a behaviour-preserving change
 * look like a behavioural one, and quietly break whatever reads the old string.
 * The codes are Flue's vocabulary too, so `resolveFlueModel` now passes the
 * reason straight through instead of translating it.
 */
export const LOCAL_GATEWAY_REFUSAL_MESSAGE: Record<LocalGatewayRefusal, string> = {
    LOCAL_GATEWAY_NOT_CONFIGURED: 'Local AI gateway not configured (AI_LOCAL_BASE_URL)',
    LOCAL_GATEWAY_NOT_SERVED: 'Tenant local AI gateway is not one this deployment serves',
};
