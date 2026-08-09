/**
 * The one place `RiskSimulationRun.perRiskResultsJson` is read.
 *
 * B2-6 — this column is a Prisma `Json` field, so every consumer got
 * `JsonValue` and narrowed it independently. Six sites had done so, and they
 * did NOT agree:
 *
 *   - `monte-carlo.ts::getPerRiskPercentiles` — full runtime validation,
 *     per-field `typeof` checks, mean-fallback for pre-RQ3-1 rows.
 *   - `risk-report.ts` — a weaker re-implementation: `Array.isArray` then
 *     `as Array<Record<string, unknown>>`, riskId + aleP90 only.
 *   - `risks/board/page.tsx` — `as unknown as { riskId; aleP90? }[]`, i.e.
 *     no validation at all.
 *   - three client DTOs (`MonteCarloPanel`, `loss-events`, `dashboard`)
 *     which disagree on optionality: `aleMean` is REQUIRED in
 *     `MonteCarloPanel` and OPTIONAL in `loss-events`; `aleP50` exists only
 *     in `loss-events`.
 *
 * The client DTOs are fine — they describe an API response that is already
 * serialised, and their divergence is a separate (documented) question. The
 * three SERVER reads are what this module replaces: they all start from the
 * same untrusted `JsonValue` and two of them skip the validation the third
 * bothered to write.
 *
 * ## Why runtime validation, not a cast
 *
 * A JSON column has no schema the compiler can check. Rows written before
 * RQ3-1 genuinely lack `aleP50` / `aleP90` / `aleP95`, and a row written by
 * the >200-risk mean-only fallback carries no distribution at all. A cast
 * asserts those fields exist and hands `undefined` to arithmetic; the
 * validation below drops malformed entries and falls back to the mean, which
 * consumers read as "no tail data, re-run the simulation".
 */

/** One risk's contribution to a completed portfolio simulation. */
export interface RiskTailPercentiles {
    aleMean: number;
    aleP50: number;
    aleP90: number;
    aleP95: number;
    contribution: number;
}

/**
 * Validate and index a run's `perRiskResultsJson`.
 *
 * Returns an empty map for a null/non-array column rather than throwing — a
 * run that has not completed has no per-risk results, which is a normal
 * state, not an error. Entries that are not objects, or that lack a string
 * `riskId` or a numeric `aleMean`, are dropped: without those two there is
 * nothing to key on or fall back to.
 */
export function parsePerRiskResults(json: unknown): Record<string, RiskTailPercentiles> {
    const byRisk: Record<string, RiskTailPercentiles> = {};
    if (!Array.isArray(json)) return byRisk;
    for (const entry of json) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.riskId !== 'string' || typeof e.aleMean !== 'number') continue;
        byRisk[e.riskId] = {
            aleMean: e.aleMean,
            // Pre-RQ3-1 runs carry no percentiles. Falling back to the mean
            // keeps every consumer's arithmetic total and makes the
            // "no tail" case visible as p50 === p90 === mean, which
            // `tail-language.ts` already keys off.
            aleP50: typeof e.aleP50 === 'number' ? e.aleP50 : e.aleMean,
            aleP90: typeof e.aleP90 === 'number' ? e.aleP90 : e.aleMean,
            aleP95: typeof e.aleP95 === 'number' ? e.aleP95 : e.aleMean,
            contribution: typeof e.contribution === 'number' ? e.contribution : 0,
        };
    }
    return byRisk;
}

/**
 * The P90-only lookup, for surfaces that show a tail figure beside a risk.
 *
 * Deliberately built on `parsePerRiskResults` rather than its own scan: the
 * two previous P90 readers (`risk-report.ts`, `risks/board`) each accepted
 * rows this one rejects, so a malformed row showed a tail number on the
 * board and no number in the report from the same simulation.
 */
export function buildTailByRisk(json: unknown): Record<string, number> {
    const parsed = parsePerRiskResults(json);
    const out: Record<string, number> = {};
    for (const [riskId, v] of Object.entries(parsed)) out[riskId] = v.aleP90;
    return out;
}
