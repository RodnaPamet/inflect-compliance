/**
 * Structural ratchets for the Driver.js product tour.
 *
 * Two intents to lock:
 *
 *   1. The guided tour exists and is wired correctly:
 *      - <OnboardingTour> + <StartTourButton> are exported
 *      - mounted inside ClientProviders
 *      - sidebar carries the StartTourButton
 *      - tenant layout passes the userId to ClientProviders
 *
 *   2. The guided tour is SEPARATE from the existing tenant
 *      setup wizard at src/components/onboarding/OnboardingWizard.tsx.
 *      Conflating them in a future refactor would be a serious
 *      regression — the wizard is a DB-backed multi-step config
 *      flow; the tour is an in-page overlay. The two never share
 *      code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TOUR_COMPONENT = path.join(REPO_ROOT, 'src/components/ui/OnboardingTour.tsx');
const TOUR_STEPS = path.join(REPO_ROOT, 'src/lib/onboarding-steps.ts');
const CLIENT_PROVIDERS = path.join(REPO_ROOT, 'src/components/layout/ClientProviders.tsx');
const SIDEBAR = path.join(REPO_ROOT, 'src/components/layout/SidebarNav.tsx');
const TENANT_LAYOUT = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)/layout.tsx');
const WIZARD_DIR = path.join(REPO_ROOT, 'src/components/onboarding');

/**
 * MASKED AT THE READ SEAM — #2246 Class A. 27 whole-file assertions pinning
 * the tour wiring; four needles were measured matching fewer times through
 * the mask than raw (`driver.js`, `<OnboardingTour`, `onboarding-steps` and
 * `data-tour`), so a comment naming a mount could answer for the mount.
 * `codeOf` keeps string literals — the `data-tour` selector assertions are
 * unaffected.
 */
function read(p: string): string {
    return codeOf(fs.readFileSync(p, 'utf-8'));
}

// ─── Tour exists + correctly wired ────────────────────────────────────

describe('Driver.js product tour — exists + wired', () => {
    const tour = read(TOUR_COMPONENT);
    const steps = read(TOUR_STEPS);
    const providers = read(CLIENT_PROVIDERS);
    const sidebar = read(SIDEBAR);
    const layout = read(TENANT_LAYOUT);

    it('exports OnboardingTourProvider + useOnboardingTour + StartTourButton', () => {
        expect(tour).toMatch(/export function OnboardingTourProvider\b/);
        expect(tour).toMatch(/export function useOnboardingTour\b/);
        expect(tour).toMatch(/export function StartTourButton\b/);
    });

    it('lazy-loads driver.js + its stylesheet (chunk stays off the critical path)', () => {
        expect(tour).toMatch(/import\(['"]driver\.js['"]\)/);
        expect(tour).toMatch(/import\(['"]driver\.js\/dist\/driver\.css['"]\)/);
        // No top-level `from 'driver.js'` — the dep MUST stay
        // dynamic to keep the SSR bundle clean.
        expect(tour).not.toMatch(/^\s*import .* from ['"]driver\.js['"]/m);
    });

    it('persists completion via the project-standard useLocalStorage hook', () => {
        // Avoids reinventing SSR-safe storage; the hook handles
        // the one-tick hydration delay.
        // Match either bare `useLocalStorage(` or the typed-generic
        // form `useLocalStorage<…>(` — both are legitimate calls.
        expect(tour).toMatch(/useLocalStorage[<(]/);
    });

    it('auto-trigger fires once and is gated on userId + completion', () => {
        // Three gates documented in code; the structural ratchet
        // guards each one being present so a future refactor
        // can't accidentally make the tour fire on every render.
        expect(tour).toMatch(/autoTriggerOnFirstLogin/);
        expect(tour).toMatch(/autoTriggerFiredRef/);
        expect(tour).toMatch(/hasCompleted/);
    });

    it('records completion as either "finished" or "skipped" — never silent', () => {
        // A user who half-completes the tour MUST get
        // `skipped` persisted so the auto-trigger doesn't loop.
        expect(tour).toMatch(/makeCompletionRecord\('skipped'\)/);
        expect(tour).toMatch(/makeCompletionRecord\('finished'\)/);
    });

    it('step set imports from the centralised module (no inline anchors)', () => {
        // Edits go to one place — onboarding-steps.ts.
        expect(tour).toMatch(/from\s*['"]@\/lib\/onboarding-steps['"]/);
        expect(tour).toMatch(/DEFAULT_TOUR_STEPS\b/);
    });

    it('step module is the single source of truth for anchors + bodies', () => {
        expect(steps).toMatch(/export const DEFAULT_TOUR_STEPS\b/);
        expect(steps).toMatch(/export function filterStepsForCurrentPage\b/);
    });

    it('ClientProviders mounts <OnboardingTourProvider> with a userId prop', () => {
        expect(providers).toMatch(/OnboardingTourProvider\b/);
        expect(providers).toMatch(/userId/);
    });

    it('Tenant app layout threads session.user.id into ClientProviders', () => {
        expect(layout).toMatch(/userId=\{session\.user\.id/);
    });

    it('Sidebar renders <StartTourButton> in the footer', () => {
        expect(sidebar).toMatch(/<StartTourButton\b/);
        expect(sidebar).toMatch(/from\s*['"]@\/components\/ui\/OnboardingTour['"]/);
    });
});

// ─── Tour is conceptually separate from the setup wizard ──────────────

describe('Tour vs OnboardingWizard — separation of concerns', () => {
    const tour = read(TOUR_COMPONENT);
    const steps = read(TOUR_STEPS);

    it('tour does not import anything from src/components/onboarding/', () => {
        // The wizard lives at src/components/onboarding/. The tour
        // MUST NOT pull from it — they are different concepts
        // (DB-backed setup vs in-page overlay).
        expect(tour).not.toMatch(/from\s*['"]@\/components\/onboarding\//);
        expect(steps).not.toMatch(/from\s*['"]@\/components\/onboarding\//);
    });

    it('wizard module exists (sanity) and is unchanged by this refactor', () => {
        expect(fs.existsSync(WIZARD_DIR)).toBe(true);
        const wizard = read(path.join(WIZARD_DIR, 'OnboardingWizard.tsx'));
        // Wizard must NOT be re-exporting tour symbols — that would
        // be the most likely confusion path in a future cleanup PR.
        expect(wizard).not.toMatch(/OnboardingTour/);
        expect(wizard).not.toMatch(/StartTourButton/);
        expect(wizard).not.toMatch(/driver\.js/);
    });

    it('tour completion key is namespaced separately from any wizard/onboarding key', () => {
        // Wizard state lives in the DB (TenantOnboarding table);
        // the tour uses localStorage. Even if a future refactor
        // moves the wizard's "have you started" flag into
        // localStorage, it must not collide with the tour's key.
        // Match the prefix in either ' or ` quoted form (the
        // template-literal form is what the source uses).
        expect(steps).toMatch(/['`]inflect:onboarding-tour:completed:/);
    });
});
