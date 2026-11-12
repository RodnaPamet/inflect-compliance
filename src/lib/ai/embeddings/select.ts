/**
 * WHICH EMBEDDING AND RERANK PROVIDER A TENANT'S TEXT MAY REACH — routed by
 * residency, copied from `flue/model-selection.ts`.
 *
 * ── THE ROUTES THAT EXIST ───────────────────────────────────────────────────
 *
 * One: `inflect-local/<model>`, a TEI service inside the deployment's
 * perimeter, named by operator configuration (`AI_EMBED_LOCAL_*`,
 * `AI_RERANK_LOCAL_*`). There is NO external embedding or rerank route. Adding
 * one is a sub-processor receiving business content — the four-step process
 * (G2) and a notice window before the first vector — so it is a reviewed diff
 * here, never a configuration value.
 *
 * ── REFUSES RATHER THAN FALLS BACK ──────────────────────────────────────────
 *
 * An unconfigured route is REFUSED with a named reason, for every residency.
 * Not routed elsewhere (there is nowhere else), and not handed the stub: a stub
 * vector written into an index is a passage no real model can find again, and
 * nothing about the row would say so. The stub is constructed by name, by tests
 * and evaluation harnesses, and never here.
 *
 * ── RESIDENCY IS STRUCTURAL ─────────────────────────────────────────────────
 *
 * The `LOCAL_ONLY` branch RETURNS first, before anything else is considered —
 * the `identity-match/index.ts` shape. Today both branches reach the same local
 * route, and that is exactly when the structure matters: the day an external
 * provider is added, it is added BELOW a return a `LOCAL_ONLY` tenant has
 * already taken. `tests/guards/ai-residency-enforcement.test.ts` reads this
 * file and pins the constructor set, so a new provider fails CI until somebody
 * classifies it as local or external.
 *
 * ── HOSTS ARE CONFIG, AND THEY MUST BE INSIDE ───────────────────────────────
 *
 * The base URL is operator configuration; no tenant column reaches it, and
 * there is no per-tenant override. (If one is ever added it follows
 * `aiLocalBaseUrl`'s rule, #4545: honoured only when it names the deployment's
 * own address.)
 *
 * `inflect-local` is a residency claim, so the URL must name an address
 * INSIDE the deployment's perimeter — the Compose network, the VPC, loopback
 * (`perimeter.ts`). Not `safeFetch`'s public-address policy: that admits only
 * the addresses that make the claim false, and a `LOCAL_ONLY` tenant's text
 * would leave under a local id. The structural half is asked here, when the
 * route is chosen, so a public literal, a metadata host or a URL carrying
 * credentials is refused once, by name, before any text is queued for it. A
 * NAME is judged at use time by what it resolves to (`http.ts`), every
 * address, pinned.
 *
 * @module lib/ai/embeddings/select
 */
import { env } from '@/env';

import { checkPerimeterUrl } from './perimeter';
import { TeiEmbeddingProvider, TeiRerankProvider, type TeiEmbeddingRoute, type TeiRerankRoute } from './tei-provider';
import { EMBEDDING_PROVIDER_IDS, type EmbeddingProvider, type RerankProvider } from './types';

/** The per-tenant term: the tenant's `aiResidency`. Absent reads as EXTERNAL. */
export interface EmbeddingSelection {
    readonly residency?: 'EXTERNAL' | 'LOCAL_ONLY' | null;
}

/** The largest dimension a configured model may declare. */
export const MAX_EMBEDDING_DIMENSIONS = 8192;

export type EmbeddingRouteRefusal =
    /** LOCAL_ONLY, and no in-deployment embedding service is configured. */
    | 'LOCAL_EMBED_ROUTE_NOT_CONFIGURED'
    /** EXTERNAL, and no in-deployment service is configured; no external route exists. */
    | 'EMBED_ROUTE_NOT_CONFIGURED'
    /** A service is configured but no model is named on it. */
    | 'EMBED_MODEL_NOT_CONFIGURED'
    /** No dimension, or one that is not an integer in 1..MAX_EMBEDDING_DIMENSIONS. */
    | 'EMBED_DIMENSIONS_NOT_CONFIGURED'
    /** The configured endpoint is not inside the deployment's perimeter (`perimeter.ts`). */
    | 'EMBED_ENDPOINT_OUTSIDE_PERIMETER';

export type RerankRouteRefusal =
    | 'LOCAL_RERANK_ROUTE_NOT_CONFIGURED'
    | 'RERANK_ROUTE_NOT_CONFIGURED'
    | 'RERANK_MODEL_NOT_CONFIGURED'
    | 'RERANK_ENDPOINT_OUTSIDE_PERIMETER';

export type EmbeddingRouteChoice =
    | ({ readonly ok: true } & TeiEmbeddingRoute)
    | { readonly ok: false; readonly reason: EmbeddingRouteRefusal; readonly detail?: string };

export type RerankRouteChoice =
    | ({ readonly ok: true } & TeiRerankRoute)
    | { readonly ok: false; readonly reason: RerankRouteRefusal; readonly detail?: string };

function parseDimensions(raw: string | undefined): number | null {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= MAX_EMBEDDING_DIMENSIONS ? n : null;
}

/** The in-deployment embedding route, or the refusal named by `absent`. */
function localEmbeddingRoute(
    absent: 'LOCAL_EMBED_ROUTE_NOT_CONFIGURED' | 'EMBED_ROUTE_NOT_CONFIGURED',
): EmbeddingRouteChoice {
    const baseUrl = env.AI_EMBED_LOCAL_BASE_URL;
    if (!baseUrl) return { ok: false, reason: absent };
    const model = env.AI_EMBED_LOCAL_MODEL;
    if (!model) return { ok: false, reason: 'EMBED_MODEL_NOT_CONFIGURED' };
    const dimensions = parseDimensions(env.AI_EMBED_LOCAL_DIMENSIONS);
    if (dimensions === null) return { ok: false, reason: 'EMBED_DIMENSIONS_NOT_CONFIGURED' };
    const perimeter = checkPerimeterUrl(baseUrl);
    if (!perimeter.ok) {
        return { ok: false, reason: 'EMBED_ENDPOINT_OUTSIDE_PERIMETER', detail: perimeter.reason };
    }
    return {
        ok: true,
        specifier: `${EMBEDDING_PROVIDER_IDS.local}/${model}`,
        baseUrl,
        dimensions,
        queryPrefix: env.AI_EMBED_LOCAL_QUERY_PREFIX ?? '',
        passagePrefix: env.AI_EMBED_LOCAL_PASSAGE_PREFIX ?? '',
    };
}

/** The in-deployment rerank route, or the refusal named by `absent`. */
function localRerankRoute(
    absent: 'LOCAL_RERANK_ROUTE_NOT_CONFIGURED' | 'RERANK_ROUTE_NOT_CONFIGURED',
): RerankRouteChoice {
    const baseUrl = env.AI_RERANK_LOCAL_BASE_URL;
    if (!baseUrl) return { ok: false, reason: absent };
    const model = env.AI_RERANK_LOCAL_MODEL;
    if (!model) return { ok: false, reason: 'RERANK_MODEL_NOT_CONFIGURED' };
    const perimeter = checkPerimeterUrl(baseUrl);
    if (!perimeter.ok) {
        return { ok: false, reason: 'RERANK_ENDPOINT_OUTSIDE_PERIMETER', detail: perimeter.reason };
    }
    return { ok: true, specifier: `${EMBEDDING_PROVIDER_IDS.local}/${model}`, baseUrl };
}

/** Resolve the embedding route a tenant may use, or refuse with a named reason. */
export function resolveEmbeddingRoute(sel?: EmbeddingSelection): EmbeddingRouteChoice {
    // ── HARD residency invariant, decided before anything else ──────────────
    if (sel?.residency === 'LOCAL_ONLY') {
        return localEmbeddingRoute('LOCAL_EMBED_ROUTE_NOT_CONFIGURED');
    }
    // EXTERNAL. The in-deployment route serves this tenant too; an external
    // embedding provider would be a sub-processor (G2) and does not exist.
    return localEmbeddingRoute('EMBED_ROUTE_NOT_CONFIGURED');
}

/** Resolve the rerank route a tenant may use, or refuse with a named reason. */
export function resolveRerankRoute(sel?: EmbeddingSelection): RerankRouteChoice {
    if (sel?.residency === 'LOCAL_ONLY') {
        return localRerankRoute('LOCAL_RERANK_ROUTE_NOT_CONFIGURED');
    }
    return localRerankRoute('RERANK_ROUTE_NOT_CONFIGURED');
}

export type EmbeddingProviderChoice =
    | { readonly ok: true; readonly provider: EmbeddingProvider }
    | { readonly ok: false; readonly reason: EmbeddingRouteRefusal; readonly detail?: string };

export type RerankProviderChoice =
    | { readonly ok: true; readonly provider: RerankProvider }
    | { readonly ok: false; readonly reason: RerankRouteRefusal; readonly detail?: string };

/**
 * The factory: a provider for the route, or the route's refusal. A refusal
 * constructs NOTHING — not a provider, not a stub.
 */
export function getEmbeddingProvider(sel?: EmbeddingSelection): EmbeddingProviderChoice {
    const route = resolveEmbeddingRoute(sel);
    if (!route.ok) return route;
    return { ok: true, provider: new TeiEmbeddingProvider(route) };
}

export function getRerankProvider(sel?: EmbeddingSelection): RerankProviderChoice {
    const route = resolveRerankRoute(sel);
    if (!route.ok) return route;
    return { ok: true, provider: new TeiRerankProvider(route) };
}
