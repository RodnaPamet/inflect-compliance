/**
 * Epic O-4 — structural contract for the org shell.
 *
 * Static-file checks (no jsdom, no React render) that lock the
 * org-layer foundation:
 *
 *   1. The /org/[orgSlug] layout file exists and resolves session +
 *      org context server-side.
 *   2. Auth gate: redirects unauthenticated callers to /login.
 *   3. Membership gate: a thrown ForbiddenError/NotFoundError from
 *      `getOrgServerContext` collapses to `notFound()` (no slug echo).
 *   4. The layout wraps children in `OrgProvider` + the unified
 *      `<AppShell variant="org">` (Roadmap-2 PR-1; previously a
 *      separate `OrgAppShell` component).
 *   5. The org sidebar enumerates all 7 nav entries the spec calls for.
 *   6. Drill-down nav entries are gated by `canDrillDown`.
 *
 * Mirror of `keyboard-shortcut-provider-integration.test.ts` —
 * structural contract over an installed primitive.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
// `codeOf` lexes TypeScript, so the JSON message catalogue keeps its
// own RAW reader — it is parsed, never asserted on as text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// i18n-aware: nav labels now route through next-intl (`t('nav.*')`).
// Resolve the key against the real English catalog so the original
// intent (the visible English text) still holds.
const EN = JSON.parse(readRaw('messages/en.json'));
const enOrg = (key: string): unknown =>
    key.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.org,
    );

const LAYOUT_PATH = 'src/app/org/[orgSlug]/layout.tsx';
const SHELL_PATH = 'src/components/layout/AppShell.tsx';
const NAV_PATH = 'src/components/layout/OrgSidebarNav.tsx';
const PROVIDER_PATH = 'src/lib/org-context-provider.tsx';
const SERVER_CTX_PATH = 'src/lib/server/org-context.server.ts';

describe('Epic O-4 — org shell structural contract', () => {
    it('layout file exists at the canonical path', () => {
        expect(fs.existsSync(path.join(ROOT, LAYOUT_PATH))).toBe(true);
    });

    it('layout resolves session via auth() and redirects unauth callers to /login', () => {
        const src = read(LAYOUT_PATH);
        expect(src).toMatch(/from\s+['"]@\/auth['"]/);
        // Calls auth() and routes !session through redirect('/login').
        expect(src).toMatch(/await\s+auth\s*\(\s*\)/);
        expect(src).toMatch(/redirect\s*\(\s*['"]\/login['"]\s*\)/);
    });

    it('layout resolves OrgServerContext and routes errors to notFound()', () => {
        const src = read(LAYOUT_PATH);
        expect(src).toMatch(/getOrgServerContext\s*\(\s*\{/);
        expect(src).toMatch(/notFound\s*\(\s*\)/);
        // The membership-error path must NOT echo the slug — anti-
        // enumeration. The catch block routes to notFound() rather
        // than rendering a "you're not a member of <slug>" message.
        expect(src).toMatch(/}\s+catch\s*(\(\w+\))?\s*\{[\s\S]*?notFound\s*\(\s*\)/);
    });

    it('layout uses noStore() + dynamic = "force-dynamic" (per-request freshness)', () => {
        const src = read(LAYOUT_PATH);
        expect(src).toMatch(/noStore\s*\(\s*\)/);
        expect(src).toMatch(/dynamic\s*=\s*['"]force-dynamic['"]/);
    });

    it('layout wraps children in OrgProvider and the unified AppShell with variant="org"', () => {
        const src = read(LAYOUT_PATH);
        expect(src).toMatch(/<OrgProvider/);
        // Roadmap-2 PR-1 collapsed the separate OrgAppShell into the
        // canonical AppShell. The org route now mounts the same
        // primitive every authenticated surface uses, distinguished
        // only by `variant="org"`.
        expect(src).toMatch(/<AppShell[\s\S]*?variant=["']org["']/);
        expect(src).toMatch(/from\s+['"]@\/components\/layout\/AppShell['"]/);
    });

    // ── Sidebar nav structure ─────────────────────────────────────────

    it('OrgSidebarNav declares the spec nav entries', () => {
        const src = read(NAV_PATH);
        // Order matches the Epic O-4 spec. Settings was removed from the
        // sidebar (see the "Settings entry is not in the sidebar nav" test).
        //
        // #2246 Class A — this used to assert the seven ENGLISH labels
        // against the component text. The labels migrated to next-intl, so
        // the only surviving occurrence of 'Portfolio Overview' in that file
        // is the docblock at the top LISTING the spec: the assertion had
        // become a test of its own comment. It now pins the key in code and
        // resolves that key against the real English catalogue — the same
        // two-sided shape the drill-down test below already uses.
        for (const [key, english] of [
            ['portfolioOverview', 'Portfolio Overview'],
            ['allTenants', 'All Tenants'],
            ['nonPerformingControls', 'Non-Performing Controls'],
            ['criticalRisks', 'Critical Risks'],
            ['overdueEvidence', 'Overdue Evidence'],
            ['members', 'Members'],
            ['auditLog', 'Audit Log'],
        ] as const) {
            expect(src).toContain(`t('nav.${key}')`);
            expect(enOrg(`nav.${key}`)).toBe(english);
        }
    });

    it('drill-down nav entries are gated by canDrillDown', () => {
        const src = read(NAV_PATH);
        // The three drill-down items must carry `requiresDrillDown: true`.
        expect(src).toMatch(/label:\s*t\('nav\.nonPerformingControls'\)[\s\S]+?requiresDrillDown:\s*true/);
        expect(src).toMatch(/label:\s*t\('nav\.criticalRisks'\)[\s\S]+?requiresDrillDown:\s*true/);
        expect(src).toMatch(/label:\s*t\('nav\.overdueEvidence'\)[\s\S]+?requiresDrillDown:\s*true/);
        expect(enOrg('nav.nonPerformingControls')).toBe('Non-Performing Controls');
        expect(enOrg('nav.criticalRisks')).toBe('Critical Risks');
        expect(enOrg('nav.overdueEvidence')).toBe('Overdue Evidence');
        // And the filter must check `perms.canDrillDown` for those rows.
        expect(src).toMatch(/canDrillDown/);
    });

    it('Members nav entry is gated by canManageMembers', () => {
        const src = read(NAV_PATH);
        expect(src).toMatch(/label:\s*t\('nav\.members'\)[\s\S]+?requiresManageMembers:\s*true/);
        expect(enOrg('nav.members')).toBe('Members');
        expect(src).toMatch(/canManageMembers/);
    });

    it('Settings entry is not in the sidebar nav', () => {
        const src = read(NAV_PATH);
        // The Settings button was removed from the org sidebar. The nav must
        // not build a settings item — no nav.settings label and no /settings
        // nav href. (The /settings route itself is unchanged.)
        expect(src).not.toMatch(/label:\s*t\('nav\.settings'\)/);
        expect(src).not.toMatch(/orgHref\('\/settings'\)/);
    });

    it('the unified AppShell reuses MobileDrawer from SidebarNav', () => {
        const shellSrc = read(SHELL_PATH);
        // Post Roadmap-2 PR-1, the org shell no longer exists as a
        // separate file — the unified AppShell imports MobileDrawer
        // once and mounts it for both tenant and org variants.
        expect(shellSrc).toMatch(
            /MobileDrawer.*from\s+['"]@\/components\/layout\/SidebarNav['"]/,
        );
    });

    // ── Provider + server context ────────────────────────────────────

    it('OrgProvider exposes the four hooks the org pages need', () => {
        const src = read(PROVIDER_PATH);
        for (const hook of ['useOrgContext', 'useOrgPermissions', 'useOrgHref', 'useOrgApiUrl']) {
            expect(src).toMatch(new RegExp(`export function ${hook}`));
        }
    });

    it('useOrgContext throws when used outside OrgProvider (defensive guard)', () => {
        const src = read(PROVIDER_PATH);
        expect(src).toMatch(/throw new Error\([^)]*OrgProvider/);
    });

    it('getOrgServerContext collapses missing-org and non-membership to a single NotFoundError shape', () => {
        // Anti-enumeration: both paths throw the same NotFoundError
        // with a generic message that never echoes the slug. ForbiddenError
        // is no longer used here — its 403 response would have leaked
        // org existence to non-members.
        const src = read(SERVER_CTX_PATH);
        expect(src).toMatch(/throw\s+externalNotFound\(\)/);
        expect(src).not.toMatch(/throw new ForbiddenError/);
        expect(src).toMatch(
            /['"]Organization not found or access not permitted['"]/,
        );
    });

    it('getOrgServerContext logs an internal reason (org_not_found vs not_a_member)', () => {
        // Internal observability is preserved even though the external
        // response is collapsed. Operators reading logs can still
        // distinguish the two failure modes.
        const src = read(SERVER_CTX_PATH);
        expect(src).toMatch(/reason:\s*['"]org_not_found['"]/);
        expect(src).toMatch(/reason:\s*['"]not_a_member['"]/);
        expect(src).toMatch(/from\s+['"]@\/lib\/observability\/logger['"]/);
    });
});
