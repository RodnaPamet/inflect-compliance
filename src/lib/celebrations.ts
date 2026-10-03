/**
 * Epic 62 — milestone celebration registry.
 *
 * The single source of truth for which compliance milestones earn a
 * confetti moment, what preset fires, and what toast accompanies it.
 *
 * Adding a milestone:
 *   1. Add a literal to `MilestoneKey`.
 *   2. Add the matching record to `MILESTONES`.
 *   3. (Optionally) wire a trigger from the page that detects it. The page
 *      holds `useCelebration(celebrationDedupe)` from
 *      `@/components/ui/hooks` + this module, and hands `celebrate()` the
 *      definition — `scopedMilestone(key, scope)` for a per-resource
 *      milestone, or the `MILESTONES[key]` record itself for a tenant-wide
 *      one. The hook takes an object, never a key: it is shared UI and
 *      cannot know this registry.
 *
 * Why a single registry instead of inline configs at each call site:
 *   - Product / docs can audit "what triggers a celebration" in one
 *     place without grepping for confetti calls.
 *   - The `MilestoneKey` literal union prevents typos where a milestone is
 *     NAMED — `MILESTONES['framework_100']` and
 *     `scopedMilestone('framework_100', …)` both fail to compile. It no
 *     longer guards `celebrate()` itself, which takes a built object, so a
 *     trigger that hand-rolls `{ preset, key, message }` instead of going
 *     through this module is unchecked. Build the object here.
 *   - The `sessionStorage` dedupe key is derived from the milestone
 *     key, so two pages firing the same milestone in the same tab
 *     share dedupe state without coordinating.
 */

// ─── Shared-UI contract ─────────────────────────────────────────────
//
// `CelebrationPreset` and `CelebrateInput` are the HOOK's types and are
// defined with it, in `src/components/ui/hooks/use-celebration.ts`. They used
// to live here and be imported upward, which made a product module the owner
// of a shared-UI contract and made the hook import `@/lib` to read its own
// parameter type — an import no second product could satisfy. The dependency
// now runs one way: shared UI declares the shape, this layer fills it in.
//
// `import type` is erased at compile time, so this costs the server bundle
// nothing and cannot form a runtime cycle.
import type {
    CelebrateInput,
    CelebrationDedupe,
    CelebrationPreset,
} from '@/components/ui/hooks/use-celebration';

// ─── Milestone keys ─────────────────────────────────────────────────

/**
 * Stable identifiers for every supported milestone. Treat as PUBLIC
 * — these strings end up in `sessionStorage` keys and analytics
 * events, so renaming is a breaking change for in-flight sessions
 * and dashboards.
 */
export type MilestoneKey =
    | 'framework-100'
    | 'evidence-all-current'
    | 'audit-pack-complete'
    | 'first-control-mapped';

// ─── Definition shape ──────────────────────────────────────────────

export interface MilestoneDefinition {
    /** Stable identifier — also the dedupe key in sessionStorage. */
    key: MilestoneKey;
    /** Confetti preset chosen to match the milestone's emotional weight. */
    preset: CelebrationPreset;
    /** Toast title — short, present-tense ("Audit pack ready!"). */
    message: string;
    /** Optional toast description shown under `message`. */
    description?: string;
}

// ─── Registry ───────────────────────────────────────────────────────

export const MILESTONES: Record<MilestoneKey, MilestoneDefinition> = {
    'framework-100': {
        key: 'framework-100',
        preset: 'fireworks',
        message: '100% framework coverage 🎯',
        description: 'Every applicable control is implemented.',
    },
    'evidence-all-current': {
        key: 'evidence-all-current',
        preset: 'rain',
        message: 'All evidence is current ✨',
        description: 'No evidence is overdue or expiring this week.',
    },
    'audit-pack-complete': {
        key: 'audit-pack-complete',
        preset: 'fireworks',
        message: 'Audit pack ready 📦',
        description: 'Frozen and shareable with your auditor.',
    },
    'first-control-mapped': {
        key: 'first-control-mapped',
        preset: 'burst',
        message: 'First control mapped 🚀',
        description: "You're on your way — keep going.",
    },
};

// ─── Dedupe-key derivation ─────────────────────────────────────────

/**
 * Namespaced sessionStorage key for a given milestone. Centralised so
 * callers (and tests) never spell the prefix inline.
 */
export function celebrationDedupeKey(key: string): string {
    return `inflect.celebrate:${key}`;
}

/**
 * Read-only helper — true when the milestone has already been
 * celebrated in this tab. SSR-safe (returns false on the server).
 *
 * Exposed so consumers can suppress secondary UI (a reactive "we
 * haven't congratulated you yet!" banner, say) without having to
 * call `celebrate()` and rely on the dedupe being a no-op.
 */
export function hasCelebrated(key: string): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.sessionStorage.getItem(celebrationDedupeKey(key)) !== null;
    } catch {
        // Private mode / disabled storage — treat as "not yet" so the
        // first trigger still fires; the dedupe just won't persist
        // beyond the current call.
        return false;
    }
}

/**
 * Mark a milestone as celebrated in this tab. Idempotent. SSR-safe.
 * Exported separately so tests can prime the state without touching
 * sessionStorage internals directly.
 */
export function markCelebrated(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(
            celebrationDedupeKey(key),
            new Date().toISOString(),
        );
    } catch {
        // Same fallback rationale as `hasCelebrated`.
    }
}

/**
 * Clear the celebrated-state for a milestone. Used by tests and by
 * the (future) "reset onboarding" admin action so a returning user
 * can re-experience the burst.
 */
export function clearCelebrated(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.removeItem(celebrationDedupeKey(key));
    } catch {
        // Storage unavailable — nothing to clear.
    }
}

/**
 * The dedupe pair, packaged for `useCelebration(dedupe)`.
 *
 * The hook takes these as arguments rather than importing them, because
 * `celebrationDedupeKey` is brand-prefixed — a shared-UI file holding it would
 * carry this product's storage namespace into the package. One exported object
 * keeps the three call sites to a single argument and gives the
 * `CelebrationDedupe` contract exactly one place to be satisfied.
 */
export const celebrationDedupe: CelebrationDedupe = {
    hasCelebrated,
    markCelebrated,
};

// ─── Per-resource milestone builder ────────────────────────────────

/**
 * Combine a registered milestone with a per-resource scope so each
 * resource (framework, audit pack, …) earns its own celebration in
 * the same session.
 *
 * Example — framework detail page:
 *
 *   celebrate(scopedMilestone('framework-100', frameworkKey, {
 *     descriptionOverride: `${frameworkName} — ${MILESTONES['framework-100'].description}`,
 *   }));
 *
 * Without a scope, all frameworks share the `framework-100` dedupe
 * key and only the first one to reach 100% celebrates per session.
 *
 * The scope is appended to the dedupe key with a colon separator —
 * `framework-100:iso27001`. Pick a stable scope value (DB id, slug,
 * route param) so refreshes keep dedupe state consistent.
 *
 * For milestones that are intrinsically tenant-wide (no scope makes
 * sense — `evidence-all-current`, `first-control-mapped`), pass the
 * `MILESTONES[key]` record's fields to `celebrate()` instead of going through
 * this builder.
 */
export function scopedMilestone(
    key: MilestoneKey,
    scope: string,
    options: { descriptionOverride?: string } = {},
): CelebrateInput {
    const def = MILESTONES[key];
    return {
        preset: def.preset,
        key: `${key}:${scope}`,
        message: def.message,
        description: options.descriptionOverride ?? def.description,
    };
}
