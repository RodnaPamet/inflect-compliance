/**
 * Epic 59 — kept as an internal surface for legacy imports. The
 * canonical home for chart math helpers is `./layout.ts`, which
 * collects margin / padding / scale / tick-density utilities in one
 * place. This file re-exports the single helper that historically
 * lived here so any external code that still imports it keeps
 * working — new code should target `./layout` directly.
 */

export { getFactors } from './layout';
