/**
 * B2-4 — the implementation moved to `@/lib/org-dashboard-widget-titles`.
 *
 * `widget-dispatcher.tsx` is a `'use client'` component and value-imported
 * `resolveWidgetTitle` from here, putting a usecase module in the browser
 * bundle. The module is dependency-free today, but its neighbours in this
 * directory reach repositories — see the reasoning in
 * `tests/guards/no-usecase-imports-in-client.test.ts`.
 *
 * Re-exported so server callers are unchanged.
 */
export * from '@/lib/org-dashboard-widget-titles';
