/**
 * Centralised step definitions for the Driver.js-based product
 * tour.
 *
 * Each step pairs a STABLE anchor (sidebar `data-testid` slug or
 * a documented page-level `#id`) with a concise body. The tour
 * code (`<OnboardingTour>`) is a thin wrapper that hands these
 * to driver.js's API — adding/editing/removing a step is a
 * one-place change.
 *
 * Stability rules:
 *   - Only target IDs / data-testids that already exist in the
 *     codebase and have a documented purpose. The discovery
 *     pass for this file enumerated them; never invent new
 *     anchors here without adding them to the page first.
 *   - Every step MUST be safe to skip. If the target element is
 *     not on the current page (e.g. the user opens a tour from
 *     a route that doesn't contain the anchor), the runner
 *     filters the step out before driver.js sees it.
 *   - Order is intentional — the tour walks the sidebar
 *     top-to-bottom, then closes with two productivity-tip
 *     steps (palette + theme toggle).
 *
 * Tone: short, present-tense, action-oriented. The audience is
 * a tenant operator on their first login — they have ~15
 * seconds of patience, not 5 minutes.
 *
 * This system is INTENTIONALLY separate from the existing
 * `<OnboardingWizard>` (tenant initial-setup wizard at
 * `src/components/onboarding/OnboardingWizard.tsx`), which is a
 * different concept (DB-backed multi-step config flow). The
 * structural ratchet at
 * `tests/unit/onboarding-tour-structural.test.ts` locks the
 * separation so future refactors can't conflate them.
 */

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The catalogue entry a step reads its words from:
 * `onboardingTour.steps.<messageKey>.title` / `.body` in `messages/*.json`.
 * A closed union, so a step cannot name copy the catalogue does not have.
 */
export type TourStepMessageKey =
    | 'welcome'
    | 'dashboard'
    | 'controls'
    | 'risks'
    | 'policies'
    | 'commandPalette'
    | 'complete';

export interface OnboardingStep {
    /** Stable id — used for analytics + per-step skip tracing. */
    id: string;
    /**
     * CSS selector for the highlighted element. `null` means the
     * step is centred ("welcome" / "tour complete" cards).
     */
    selector: string | null;
    /**
     * Where the step's heading and body live in the message catalogue.
     * The words are never written here: the tour runs in the reader's
     * language, and this module has no locale (#5904).
     */
    messageKey: TourStepMessageKey;
    /**
     * Side of the target the popover should appear on. Must match
     * driver.js's `Side` union exactly — `"top" | "right" | "bottom"
     * | "left"`. (driver.js ≥1.6 tightened this type; it never
     * supported an "over" value, so steps that want a centred popover
     * simply omit `side` and rely on driver.js's default placement.)
     */
    side?: 'top' | 'bottom' | 'left' | 'right';
}

// ─── Default tour ──────────────────────────────────────────────────────

/**
 * Single global tour set today. Future expansions (e.g. a
 * per-page "show me how" tour on /controls) plug in as
 * additional named exports without changing the runner.
 */
export const DEFAULT_TOUR_STEPS: ReadonlyArray<OnboardingStep> = [
    // Step 1 — welcome card. Centred (no anchor) so the user
    // sees the explainer regardless of the route they happened
    // to land on first.
    {
        id: 'welcome',
        selector: null,
        messageKey: 'welcome',
    },

    // Step 2 — Dashboard. The sidebar's data-testid slug pattern
    // is `nav-<href-tail>`; this anchor exists on every layout
    // that mounts <SidebarNav>.
    {
        id: 'sidebar.dashboard',
        selector: '[data-testid="nav-dashboard"]',
        messageKey: 'dashboard',
        side: 'right',
    },

    // Step 3 — Controls.
    {
        id: 'sidebar.controls',
        selector: '[data-testid="nav-controls"]',
        messageKey: 'controls',
        side: 'right',
    },

    // Step 4 — Risks.
    {
        id: 'sidebar.risks',
        selector: '[data-testid="nav-risks"]',
        messageKey: 'risks',
        side: 'right',
    },

    // Step 5 — Policies.
    {
        id: 'sidebar.policies',
        selector: '[data-testid="nav-policies"]',
        messageKey: 'policies',
        side: 'right',
    },

    // (The previous sidebar.frameworks step was retired when the
    // Framework nav entry was dropped from the sidebar — the page
    // is reachable via the Frameworks pill on the Audits page
    // header and via the command palette.)

    // Step 6 — Command palette tip. No DOM anchor (the palette is
    // a portal that only mounts on Cmd+K). Centred card with the
    // shortcut spelled out.
    {
        id: 'tip.command-palette',
        selector: null,
        messageKey: 'commandPalette',
    },

    // (The previous sidebar.theme-toggle step was retired when the
    // theme toggle was dropped from the sidebar chrome — theme is
    // still toggleable from the command palette via the
    // `action:toggle-theme` command, which the `tip.command-palette`
    // step above already advertises.)

    // Step 8 — final tour-complete card. Tells the user how to
    // restart, which is the single most common follow-up
    // question.
    {
        id: 'tour-complete',
        selector: null,
        messageKey: 'complete',
    },
];

// ─── Persistence — completion / dismissal tracking ────────────────────

/**
 * localStorage key for the tour-completion flag. Per-user
 * persistence (the key includes the user id) so two operators
 * sharing a browser don't trigger the auto-tour for each other.
 */
export function tourCompletionKey(userId: string): string {
    return `inflect:onboarding-tour:completed:${userId}`;
}

/**
 * The completion blob is intentionally narrow — the only state
 * worth persisting is "the user has seen the tour at least once
 * and either finished or dismissed it." Anything richer (last
 * step viewed, total seconds spent) belongs in analytics, not
 * localStorage.
 */
export interface TourCompletionRecord {
    /** Schema version; lets us migrate without a hard reset. */
    version: 1;
    /** ms since epoch the user finished or dismissed. */
    at: number;
    /** Why the tour ended — `'finished'` (clicked Done) or `'skipped'`. */
    via: 'finished' | 'skipped';
}

export function makeCompletionRecord(via: TourCompletionRecord['via']): TourCompletionRecord {
    return { version: 1, at: Date.now(), via };
}

/**
 * Defensive load. Any non-conforming blob (older version,
 * tampered data, partial fields) reads as "not completed" so
 * the auto-trigger fires once and the user gets a clean run.
 */
export function isTourCompleted(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const v = raw as Partial<TourCompletionRecord>;
    if (v.version !== 1) return false;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false;
    if (v.via !== 'finished' && v.via !== 'skipped') return false;
    return true;
}

// ─── Filtering — drop steps whose anchor isn't on the page ────────────

/**
 * Returns the subset of steps whose `selector` exists in the
 * current document (or whose selector is null — "centred"
 * steps always run).
 *
 * Pure / DOM-aware — accepts a `findAnchor` resolver so the
 * helper unit-tests without a DOM. Production callers pass
 * `(s) => document.querySelector(s)`.
 */
export function filterStepsForCurrentPage(
    steps: ReadonlyArray<OnboardingStep>,
    findAnchor: (selector: string) => Element | null,
): OnboardingStep[] {
    return steps.filter((step) => {
        if (step.selector === null) return true;
        return findAnchor(step.selector) !== null;
    });
}
