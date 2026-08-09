/**
 * B2-4 — the FAIR maths moved to `@/lib/fair-math`.
 *
 * `FairAnalysisPanel.tsx` is a `'use client'` component and value-imported
 * six functions from here, putting a usecase module in the browser bundle.
 * The module is pure arithmetic with no imports at all — but it sat beside
 * `risk-dashboard.ts`, which imports `listRisks` and reaches repositories,
 * so nothing structural stopped a future edit from dragging server code
 * into a page bundle. See `tests/guards/no-usecase-imports-in-client.test.ts`.
 *
 * Re-exported so the ~30 server call sites are unchanged. `resolveALE` and
 * `computeLegacyALE` live here too — one pure-maths module, not two.
 */
export * from '@/lib/fair-math';
