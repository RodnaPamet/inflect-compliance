/**
 * R2-P3 — posture navigation spine + dead-surface cleanup (structural ratchet).
 *
 * The posture spine (per-framework coverage/readiness, all ~15 frameworks) was
 * unnavigable and several surfaces were dead/misleading. This locks the fixes:
 *   1. Frameworks + Coverage are in the sidebar (were ⌘K-only / URL-only).
 *   2. The controls dashboard is ungated from controls.create (read-only view).
 *   3. The dead BestValueControls leaderboard is mounted.
 *   4. SoA core mutations surface errors; the map picker is searchable +
 *      pre-filtered to unmapped controls.
 *   5. The frameworks page distinguishes a coverage error from a genuine 0%.
 *   6. SoA is scoped to ISO-family frameworks (non-ISO shows a redirect notice).
 *   7. The state-losing Clauses checkboxes are gone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const APP = 'src/app/t/[tenantSlug]/(app)';
const SIDEBAR = 'src/components/layout/SidebarNav.tsx';
const CONTROLS_CLIENT = `${APP}/controls/ControlsClient.tsx`;
const DASHBOARD = `${APP}/controls/dashboard/page.tsx`;
const SOA_CLIENT = `${APP}/reports/soa/SoAClient.tsx`;
const SOA_PAGE = `${APP}/reports/soa/page.tsx`;
const SOA_PRINT_PAGE = `${APP}/reports/soa/print/page.tsx`;
const FRAMEWORKS_PAGE = `${APP}/frameworks/page.tsx`;
const CLAUSES = `${APP}/clauses/ClausesBrowser.tsx`;
const SOA_USECASE = 'src/app-layer/usecases/soa.ts';

describe('R2-P3 (1) posture spine — Frameworks/Coverage removed from the sidebar', () => {
    // 2026-07-14 — reversed the R2-P3 decision at the user's request: the
    // Frameworks and Coverage-map sidebar entries are removed. Both pages stay
    // reachable via the command palette (⌘K) and the Frameworks pill on the
    // Audits header. This ratchet now locks their ABSENCE so a future edit
    // doesn't silently re-add them.
    const src = read(SIDEBAR);
    it('Frameworks and Coverage are not sidebar items', () => {
        expect(src).not.toMatch(/tenantHref\('\/frameworks'\)/);
        expect(src).not.toMatch(/tenantHref\('\/coverage'\)/);
    });
});

describe('R2-P3 (2) controls dashboard ungated', () => {
    it('the dashboard link is not wrapped in the controls.create gate', () => {
        const src = read(CONTROLS_CLIENT);
        const dashIdx = src.indexOf('controls-dashboard-btn');
        expect(dashIdx).toBeGreaterThan(-1);
        // The nearest create-gate before the dashboard link must be far away
        // (the gate now wraps only the install action, which comes AFTER).
        const gateIdx = src.lastIndexOf('appPermissions.controls.create && (', dashIdx);
        // No create gate opens in the ~200 chars immediately preceding the
        // dashboard link — i.e. it is not gated.
        expect(gateIdx === -1 || dashIdx - gateIdx > 200).toBe(true);
    });
});

describe('R2-P3 (3) best-value leaderboard mounted', () => {
    it('the controls dashboard mounts BestValueControls', () => {
        const src = read(DASHBOARD);
        expect(src).toMatch(/import \{ BestValueControls \}/);
        expect(src).toMatch(/<BestValueControls/);
    });
});

describe('R2-P3 (4) SoA errors surfaced + searchable picker', () => {
    const src = read(SOA_CLIENT);
    it('map + justification handlers catch failures and toast', () => {
        expect(src).toMatch(/toast\.error\(t\('soaView\.mapFailed'\)\)/);
        expect(src).toMatch(/toast\.error\(t\('soaView\.justificationFailed'\)\)/);
    });
    it('the control picker is searchable and pre-filtered to unmapped', () => {
        expect(src).toMatch(/mapSearch/);
        expect(src).toMatch(/alreadyMapped/);
        expect(src).toMatch(/soa-map-search/);
    });
});

describe('R2-P3 (5) coverage error vs genuine 0%', () => {
    it('the frameworks page tracks coverageErrors', () => {
        expect(read(FRAMEWORKS_PAGE)).toMatch(/coverageErrors/);
    });
});

describe('R2-P3 (6) SoA scoped to ISO-family', () => {
    it('soa.ts computes isIsoFamily and the PAGE redirects a non-ISO framework', () => {
        // This used to assert that SoAClient renders a non-ISO notice. That
        // notice was UNREACHABLE: `SoAClient` is mounted in exactly one place
        // (soa/page.tsx), and that page redirects on `!report.isIsoFamily`
        // BEFORE rendering it — so the guard was pinning dead code, and would
        // have kept pinning it indefinitely.
        //
        // The invariant worth protecting is the one that actually holds: a
        // non-ISO framework never reaches the SoA surface at all. Asserted at
        // the redirect, which is where the behaviour lives.
        expect(read(SOA_USECASE)).toMatch(/isIsoFamily/);
        for (const page of [SOA_PAGE, SOA_PRINT_PAGE]) {
            const src = read(page);
            expect(src).toMatch(/if\s*\(!report\.isIsoFamily\)/);
            expect(src).toMatch(/redirect\(/);
        }
        // And the client must NOT reintroduce an in-component branch for a case
        // it can never see.
        expect(read(SOA_CLIENT)).not.toMatch(/nonIsoNotice|nonIsoLink/);
    });
});

describe('R2-P3 (7) Clauses checklist is not a state-losing checkbox', () => {
    it('the clause checklist no longer renders bare input checkboxes', () => {
        const src = read(CLAUSES);
        expect(src).not.toMatch(/<input type="checkbox"/);
    });
});

describe('R2-P3 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new nav + soa keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.nav.compliance).toBeTruthy();
            expect(l.nav.frameworks).toBeTruthy();
            expect(l.nav.coverage).toBeTruthy();
            expect(l.reports.soaView.mapFailed).toBeTruthy();
            // `nonIsoNotice` / `nonIsoLink` were deleted from both catalogues
            // along with the unreachable branch that read them — asserted as
            // ABSENT so neither comes back without the redirect changing first.
            expect(l.reports.soaView.nonIsoNotice).toBeUndefined();
            expect(l.reports.soaView.nonIsoLink).toBeUndefined();
        }
    });
});
