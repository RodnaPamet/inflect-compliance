/**
 * Pure helpers behind the Driver.js product tour.
 *
 * The React surface (provider + hook + sidebar button) needs a
 * DOM to test end-to-end and the project doesn't ship
 * `jest-environment-jsdom`. The pure helpers here cover the
 * load-bearing logic: completion-blob defence, completion-record
 * shape, and the page-anchored step filter.
 */

import {
    DEFAULT_TOUR_STEPS,
    filterStepsForCurrentPage,
    isTourCompleted,
    makeCompletionRecord,
    tourCompletionKey,
    type OnboardingStep,
    type TourCompletionRecord,
} from '@/lib/onboarding-steps';

// ─── tourCompletionKey ─────────────────────────────────────────────────

describe('tourCompletionKey', () => {
    it('includes the user id so two operators sharing a browser do not auto-trigger each other', () => {
        const a = tourCompletionKey('user-a');
        const b = tourCompletionKey('user-b');
        expect(a).not.toBe(b);
        expect(a).toContain('user-a');
        expect(b).toContain('user-b');
    });

    it('uses a documented prefix so callers can grep + invalidate as a group', () => {
        expect(tourCompletionKey('u1').startsWith('inflect:onboarding-tour:completed:')).toBe(true);
    });
});

// ─── makeCompletionRecord ──────────────────────────────────────────────

describe('makeCompletionRecord', () => {
    it('emits a versioned record with the via reason', () => {
        const r = makeCompletionRecord('finished');
        expect(r.version).toBe(1);
        expect(r.via).toBe('finished');
        expect(typeof r.at).toBe('number');
        expect(Number.isFinite(r.at)).toBe(true);
    });

    it('captures both finished + skipped reasons', () => {
        expect(makeCompletionRecord('finished').via).toBe('finished');
        expect(makeCompletionRecord('skipped').via).toBe('skipped');
    });
});

// ─── isTourCompleted (defensive) ───────────────────────────────────────

describe('isTourCompleted — defensive load', () => {
    it('returns false for null/undefined/non-objects', () => {
        expect(isTourCompleted(null)).toBe(false);
        expect(isTourCompleted(undefined)).toBe(false);
        expect(isTourCompleted('oops')).toBe(false);
        expect(isTourCompleted(42)).toBe(false);
    });

    it('returns false when version is missing or not 1', () => {
        expect(isTourCompleted({ at: Date.now(), via: 'finished' })).toBe(false);
        expect(isTourCompleted({ version: 2, at: Date.now(), via: 'finished' })).toBe(false);
    });

    it('returns false when at is missing, non-numeric, or NaN', () => {
        expect(isTourCompleted({ version: 1, via: 'finished' })).toBe(false);
        expect(isTourCompleted({ version: 1, at: 'oops', via: 'finished' })).toBe(false);
        expect(isTourCompleted({ version: 1, at: NaN, via: 'finished' })).toBe(false);
    });

    it('returns false when via is missing or not in the documented enum', () => {
        expect(isTourCompleted({ version: 1, at: 0 })).toBe(false);
        expect(isTourCompleted({ version: 1, at: 0, via: 'aborted' })).toBe(false);
    });

    it('returns true for a well-formed record (finished or skipped)', () => {
        expect(isTourCompleted(makeCompletionRecord('finished'))).toBe(true);
        expect(isTourCompleted(makeCompletionRecord('skipped'))).toBe(true);
    });

    it('round-trips through a JSON serialise/deserialise cycle', () => {
        const r = makeCompletionRecord('finished');
        const restored = JSON.parse(JSON.stringify(r)) as unknown;
        expect(isTourCompleted(restored)).toBe(true);
    });
});

// ─── filterStepsForCurrentPage ─────────────────────────────────────────

describe('filterStepsForCurrentPage', () => {
    function step(id: string, selector: string | null): OnboardingStep {
        return {
            id,
            selector,
            messageKey: 'welcome',
        };
    }

    it('keeps centred steps (selector === null) regardless of page', () => {
        const steps = [step('welcome', null), step('done', null)];
        const out = filterStepsForCurrentPage(steps, () => null);
        expect(out.map((s) => s.id)).toEqual(['welcome', 'done']);
    });

    it('drops anchored steps whose selector is not on the current page', () => {
        const steps = [
            step('welcome', null),
            step('present', '#here'),
            step('absent', '#nope'),
        ];
        const present = new Set(['#here']);
        const out = filterStepsForCurrentPage(
            steps,
            (s) => (present.has(s) ? ({} as Element) : null),
        );
        expect(out.map((s) => s.id)).toEqual(['welcome', 'present']);
    });

    it('returns an empty array when nothing matches', () => {
        const steps = [step('a', '#x'), step('b', '#y')];
        expect(filterStepsForCurrentPage(steps, () => null)).toEqual([]);
    });
});

// ─── DEFAULT_TOUR_STEPS — invariants ───────────────────────────────────

describe('DEFAULT_TOUR_STEPS — shape invariants', () => {
    it('has at least 5 steps (welcome + 3+ landmarks + complete)', () => {
        expect(DEFAULT_TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
    });

    it('starts with a welcome step (centred, no selector)', () => {
        expect(DEFAULT_TOUR_STEPS[0].id).toBe('welcome');
        expect(DEFAULT_TOUR_STEPS[0].selector).toBeNull();
    });

    it('ends with a tour-complete step (centred, no selector)', () => {
        const last = DEFAULT_TOUR_STEPS[DEFAULT_TOUR_STEPS.length - 1];
        expect(last.id).toBe('tour-complete');
        expect(last.selector).toBeNull();
    });

    it('every step names a heading and a body that exist in both catalogues', () => {
        for (const locale of ['en', 'bg']) {
            const catalogue = require(`../../messages/${locale}.json`) as {
                onboardingTour: { steps: Record<string, { title?: unknown; body?: unknown }> };
            };
            for (const s of DEFAULT_TOUR_STEPS) {
                const entry = catalogue.onboardingTour.steps[s.messageKey];
                expect([locale, s.id, typeof entry?.title, typeof entry?.body]).toEqual([locale, s.id, 'string', 'string']);
            }
        }
    });

    it('every step id is unique (analytics + per-step skip tracing)', () => {
        const ids = DEFAULT_TOUR_STEPS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('uses sidebar nav-* data-testid anchors for sidebar steps (stable selector contract)', () => {
        // The sidebar's NavItem renders `data-testid="nav-<slug>"`
        // for every entry. If a sidebar step ever points at a
        // brittle anchor (raw className, hash on a heading inside
        // a re-flowable card), the tour breaks the next time the
        // page is restyled.
        const sidebarSteps = DEFAULT_TOUR_STEPS.filter((s) => s.id.startsWith('sidebar.'));
        expect(sidebarSteps.length).toBeGreaterThan(0);
        for (const s of sidebarSteps) {
            expect(s.selector).toMatch(/data-testid="nav-/);
        }
    });
});

// ─── Type-only sanity ─────────────────────────────────────────────────

describe('TourCompletionRecord type', () => {
    it('compiles with both `via` literals (catches accidental enum widening)', () => {
        const a: TourCompletionRecord = { version: 1, at: 0, via: 'finished' };
        const b: TourCompletionRecord = { version: 1, at: 0, via: 'skipped' };
        expect(a.via).toBe('finished');
        expect(b.via).toBe('skipped');
    });
});
