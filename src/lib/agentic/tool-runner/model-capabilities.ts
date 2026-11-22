/**
 * WHICH REQUEST PARAMETERS EACH MODEL ACCEPTS (owner decision, 2026-11-15).
 *
 * The Tool Runner used to send every model the same request: adaptive
 * thinking, `output_config.effort`, `fallbacks: 'default'` and the
 * server-side-fallback beta. Not every model accepts them. Inspect run
 * 43715891271 set both tiers to `claude-haiku-4-5`, which takes only a
 * `budget_tokens` thinking configuration and no `effort`, and every Tool Runner
 * run settled FAILED on the provider's 400 before a model step was recorded.
 * The engine now adapts: `lockedParams` reads the model's row here and sends
 * each of those parameters only to a model whose row says it accepts it.
 *
 * ── THE TABLE IS DATA, `lockedParams` IS THE SHAPE ─────────────────────────
 *
 * Nothing here builds a request. A row says what a model accepts, and
 * `lockedParams` (`params.ts`) stays the one function that shapes a request:
 * from the definition and the row of the model it chose. The parameters this
 * table does NOT govern are sent to every model, and are pinned by
 * `tests/unit/agentic/tool-runner-locked-params.test.ts` whatever the row
 * says: `thread: false`, the tool choice and its parallelism rule, the
 * per-tier `max_tokens`, and no sampling parameter (API version `2026-10-21`
 * refuses `temperature`, `top_p` and `top_k` on every model).
 *
 * ── WHERE THE ROWS COME FROM ────────────────────────────────────────────────
 *
 * The Claude API reference's model and migration notes, read on 2026-11-15:
 *
 *   thinking 'adaptive'  `thinking: { type: 'adaptive' }` is accepted. Every
 *                        model from the 4.6 generation on.
 *   thinking 'budget'    only `{ type: 'enabled', budget_tokens: N }`: Haiku
 *                        4.5, Sonnet 4.5, Opus 4.5. The engine sends such a
 *                        model NO thinking configuration. A budget is a token
 *                        count the engine would have to invent from an effort
 *                        level, and interleaved thinking on those models needs
 *                        a further beta; neither is a decision to take here.
 *   effort               `output_config.effort` is accepted at every level a
 *                        profile can name (`low`, `medium`, `high`). Opus 4.5
 *                        takes those three; it errors on Sonnet 4.5 and Haiku
 *                        4.5.
 *   fallbacks            `fallbacks: 'default'` under
 *                        `server-side-fallback-2026-07-01` is accepted and
 *                        means something: the Fable 5 family, Opus 5 and 5.5,
 *                        Sonnet 5.5. Haiku 5.5 has no server-side fallback (the
 *                        reference says not to send the parameter); for the
 *                        others the reference does not say the scalar form is
 *                        accepted, so it is not sent. The beta header travels
 *                        with the parameter and never without it.
 *
 * ── AN UNKNOWN MODEL FAILS CLOSED ───────────────────────────────────────────
 *
 * A model id with no row gets `CONSERVATIVE_CAPABILITIES`: no thinking
 * configuration, no effort, no fallbacks, no beta. That is the set every
 * current model accepts, because each of the three is refused by at least one
 * of them (`budget_tokens` by every 4.7-and-later model, adaptive thinking and
 * effort by Haiku 4.5, a fallback list by Haiku 5.5). Fail closed here means
 * "send the request every model takes", not "refuse the run": the deployment
 * chose the model id, and a request the provider refuses is the failure this
 * table exists to prevent. Omitting `thinking` is never a 400: a model that
 * thinks by default thinks, and one that does not, does not.
 *
 * A row is matched by its family id, alone or followed by a dated snapshot
 * suffix (`claude-haiku-4-5-20251001`). Nothing else: `claude-opus-5` is not a
 * prefix match for `claude-opus-5-5`, and a new model is unknown until a row
 * names it.
 */

/** How a model accepts a thinking configuration. */
export type ThinkingSupport = 'adaptive' | 'budget' | 'none';

export interface ModelCapabilities {
    /** The thinking configuration the model accepts. Only 'adaptive' is ever sent. */
    readonly thinking: ThinkingSupport;
    /** `output_config.effort` at `low`, `medium` and `high`. */
    readonly effort: boolean;
    /** `fallbacks: 'default'` with the server-side-fallback beta. */
    readonly fallbacks: boolean;
}

/** The model families this engine has a row for. A closed list: a new family is a reviewed row. */
export const MODEL_FAMILIES = [
    'claude-fable-5-2',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

const FULL: ModelCapabilities = { thinking: 'adaptive', effort: true, fallbacks: true };
const ADAPTIVE_NO_FALLBACKS: ModelCapabilities = { thinking: 'adaptive', effort: true, fallbacks: false };

/** One row per family. A `Record`, so a family added to the list without a row fails `tsc`. */
export const MODEL_CAPABILITIES: Readonly<Record<ModelFamily, ModelCapabilities>> = {
    'claude-fable-5-2': FULL,
    'claude-fable-5-1': FULL,
    'claude-fable-5': FULL,
    'claude-opus-5-5': FULL,
    'claude-opus-5': FULL,
    'claude-opus-4-8': ADAPTIVE_NO_FALLBACKS,
    'claude-opus-4-7': ADAPTIVE_NO_FALLBACKS,
    'claude-opus-4-6': ADAPTIVE_NO_FALLBACKS,
    'claude-opus-4-5': { thinking: 'budget', effort: true, fallbacks: false },
    'claude-sonnet-5-5': FULL,
    'claude-sonnet-5': ADAPTIVE_NO_FALLBACKS,
    'claude-sonnet-4-6': ADAPTIVE_NO_FALLBACKS,
    'claude-sonnet-4-5': { thinking: 'budget', effort: false, fallbacks: false },
    'claude-haiku-5-5': ADAPTIVE_NO_FALLBACKS,
    'claude-haiku-4-5': { thinking: 'budget', effort: false, fallbacks: false },
};

/** What a model with no row is sent: only what every current model accepts. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = { thinking: 'none', effort: false, fallbacks: false };

/** A dated snapshot of a family: `-` and eight digits, nothing else. */
const SNAPSHOT_SUFFIX = /^-\d{8}$/;

/** The family a model id belongs to, or null when no row names it. */
export function modelFamilyOf(modelId: string): ModelFamily | null {
    const id = modelId.trim();
    for (const family of MODEL_FAMILIES) {
        if (id === family) return family;
        if (id.startsWith(family) && SNAPSHOT_SUFFIX.test(id.slice(family.length))) return family;
    }
    return null;
}

/** The parameters `modelId` accepts: its family's row, or the conservative set. */
export function modelCapabilitiesFor(modelId: string): ModelCapabilities {
    const family = modelFamilyOf(modelId);
    return family === null ? CONSERVATIVE_CAPABILITIES : MODEL_CAPABILITIES[family];
}
