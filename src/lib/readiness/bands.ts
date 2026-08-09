import type { StatusBadgeVariant } from '@/components/ui/status-badge';

/**
 * The readiness score's colour bands — ONE definition, three vocabularies.
 *
 * A readiness score is a percentage, and the product reads it in three bands:
 * ready to be audited, nearly there, at risk. The boundaries (80 and 50) had
 * been written out six times across four files, in three mutually-unaware
 * output vocabularies:
 *
 *   readiness/ReadinessOverviewClient.tsx:33    success | attention | critical
 *   readiness/ReadinessOverviewClient.tsx:125   success | warning   | error
 *   readiness/ReadinessOverviewClient.tsx:128   success | warning   | error
 *   readiness/ReadinessOverviewClient.tsx:131   success | warning   | error
 *   cycles/[cycleId]/readiness/page.tsx:236     success | warning   | error
 *   cycles/ReadinessScoreRing.tsx:15            #22c55e | #eab308   | #ef4444
 *
 * THIS HAS BEEN FIXED ONCE ALREADY. `<ReadinessScoreRing>` exists precisely
 * because the bands "were previously undocumented magic numbers duplicated in
 * two files" — and they regrew, including back into
 * `cycles/[cycleId]/readiness/page.tsx`, one of the two files the ring was
 * extracted from. The reason it regrew is that the extraction moved the
 * *rendering* but not the *rule*: a renderer that needs the band in a
 * different vocabulary had nowhere to ask, so it re-derived it.
 *
 * Resolution (the rule that stops a third regrowth): the band is a property of
 * the SCORE, not of any renderer. `readinessBand(score)` is the only place the
 * numbers appear; each surface maps the returned band into its own vocabulary
 * through the maps below. A new surface adds a map here — it never re-reads
 * the thresholds.
 *
 * Deliberately dependency-free apart from the `StatusBadgeVariant` type, so
 * both the server-side scoring engine (`usecases/audit-readiness/scoring.ts`,
 * which re-exports this) and client components can import it without dragging
 * Prisma into the browser bundle. The engine owns the bands; this is where it
 * keeps them.
 *
 * Enforced by `tests/guards/readiness-band-single-definition.test.ts`.
 */

/**
 * `ready` — 80+, presentable to an auditor.
 * `nearly` — 50–79, real progress with known gaps.
 * `atRisk` — below 50, not defensible yet.
 */
export type ReadinessBand = 'ready' | 'nearly' | 'atRisk';

/**
 * The two boundaries, and the ONLY place they are written.
 *
 * Inclusive lower bounds: a score of exactly 80 is `ready`, exactly 50 is
 * `nearly`. That matches every call site this replaced (all six used `>=`).
 */
export const READINESS_BAND_MIN = {
    ready: 80,
    nearly: 50,
} as const;

/** The band a score falls in. Scores are 0-100; out-of-range clamps sensibly. */
export function readinessBand(score: number): ReadinessBand {
    if (score >= READINESS_BAND_MIN.ready) return 'ready';
    if (score >= READINESS_BAND_MIN.nearly) return 'nearly';
    return 'atRisk';
}

/** Vocabulary 1 — `<StatusBadge variant>` / `<ProgressBar variant>`. */
export const READINESS_BAND_VARIANT: Record<ReadinessBand, StatusBadgeVariant> = {
    ready: 'success',
    nearly: 'warning',
    atRisk: 'error',
};

/**
 * Vocabulary 2 — the KPI `tone` scale, which names the same three states
 * differently (`attention`/`critical` rather than `warning`/`error`).
 */
export const READINESS_BAND_TONE: Record<ReadinessBand, 'success' | 'attention' | 'critical'> = {
    ready: 'success',
    nearly: 'attention',
    atRisk: 'critical',
};

/**
 * Vocabulary 3 — a CSS custom property, for SVG `stroke` / `fill` and inline
 * `backgroundColor`, which cannot take a Tailwind class.
 *
 * Tokens rather than the hex literals they replace: `--bg-*-emphasis` resolves
 * per theme, so the ring re-tones on a light/dark flip instead of staying at
 * one hardcoded emerald. Policed by `tests/guards/chart-token-discipline.test.ts`.
 */
export const READINESS_BAND_COLOR_VAR: Record<ReadinessBand, string> = {
    ready: 'var(--bg-success-emphasis)',
    nearly: 'var(--bg-warning-emphasis)',
    atRisk: 'var(--bg-error-emphasis)',
};

/** Convenience for the common `score → badge variant` hop. */
export function readinessVariant(score: number): StatusBadgeVariant {
    return READINESS_BAND_VARIANT[readinessBand(score)];
}

/** Convenience for the common `score → KPI tone` hop. */
export function readinessTone(score: number): 'success' | 'attention' | 'critical' {
    return READINESS_BAND_TONE[readinessBand(score)];
}
