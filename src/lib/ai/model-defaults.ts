/**
 * The model the Flue agent runtime and the in-product assistant name when the
 * deployment does not set `AGENT_FLUE_MODEL` — the schema default in
 * `src/env.ts`, written once so the one other reader that needs it can read
 * the same value rather than a copy.
 *
 * That reader is `agentFlueModel()` (`src/lib/agentic/flue/model-selection.ts`),
 * which every route to the external model resolves through. Under
 * `SKIP_ENV_VALIDATION` (CI, and the Ragas nightly's answer stage, which asks
 * the assistant in process) `@t3-oss/env-nextjs` hands back the raw
 * environment with no defaults applied, so without this the assistant there
 * would name the model `undefined`. A deployment's own setting still wins.
 *
 * The Ragas nightly's cost meter lists this model in the ragas share
 * (`evals/cost-meter/shares.json`; owner decision 2026-11-17: the product's
 * answers are written by the assistant's production model), and a guardrail
 * holds the two equal.
 */
export const AGENT_FLUE_MODEL_DEFAULT = 'claude-sonnet-5-5';
