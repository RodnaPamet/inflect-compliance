/**
 * GAP O4-2 — org members page structural ratchet.
 *
 * Static-file checks (no jsdom, no React render) that lock the
 * load-bearing properties of the org members management surface so
 * a refactor can't quietly break them:
 *
 *   - The page exists at the canonical path the sidebar links to.
 *   - Server page resolves OrgContext via `getOrgCtx` and gates on
 *     `canManageMembers` (ORG_ADMIN only).
 *   - The list query routes through the `listOrgMembers` usecase
 *     (so the data shape is the load-bearing source of truth).
 *   - The client island wraps in the platform primitives
 *     (`ListPageShell` + `DataTable` + `TableEmptyState` + `Modal`)
 *     and never hand-rolls a `<table>` or `fixed-overlay` modal.
 *   - Add + remove flows POST/DELETE to the existing
 *     `/api/org/{slug}/members` endpoints (matches the API
 *     contract — no fictional endpoints).
 *   - Self-removal is disabled.
 *   - Stable test-ids for E2E targeting.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SERVER_PATH = 'src/app/org/[orgSlug]/(app)/members/page.tsx';
const CLIENT_PATH = 'src/app/org/[orgSlug]/(app)/members/MembersTable.tsx';
const SIDEBAR_PATH = 'src/components/layout/OrgSidebarNav.tsx';
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

// i18n-aware: nav labels + callout copy now route through next-intl.
// Resolve keys against the real English catalog so the original
// visible-text intent still holds.
const EN = JSON.parse(readRaw('messages/en.json'));
const enOrg = (key: string): unknown =>
    key.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.org,
    );

describe('GAP O4-2 — org members page structural contract', () => {
    it('server page exists at the canonical path the sidebar nav links to', () => {
        // The sidebar nav (`OrgSidebarNav.tsx`) emits an `orgHref('/members')`
        // entry. This file must satisfy that target — failing this is
        // the exact failure mode O4-2 was filed against (404 on click).
        expect(exists(SERVER_PATH)).toBe(true);
        expect(exists(CLIENT_PATH)).toBe(true);
    });

    it('sidebar nav still routes Members to /members (no drift)', () => {
        const src = read(SIDEBAR_PATH);
        expect(src).toMatch(/orgHref\(['"]\/members['"]\)/);
        // i18n-aware: label now resolves `t('nav.members')`.
        expect(src).toMatch(/label:\s*t\('nav\.members'\)/);
        expect(enOrg('nav.members')).toBe('Members');
    });

    it('server page declares dynamic = "force-dynamic"', () => {
        expect(read(SERVER_PATH)).toMatch(
            /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
        );
    });

    it('server page resolves OrgContext, gates on canManageMembers, collapses errors to notFound()', () => {
        const src = read(SERVER_PATH);
        expect(src).toMatch(/getOrgCtx\s*\(\s*\{[^}]*orgSlug/);
        expect(src).toMatch(/}\s*catch\b[\s\S]*?notFound\s*\(\s*\)/);
        expect(src).toMatch(/ctx\.permissions\.canManageMembers/);
        expect(src).toMatch(/throw\s+forbidden\(/);
    });

    it('server page reads the member list via the listOrgMembers usecase', () => {
        const src = read(SERVER_PATH);
        expect(src).toMatch(/from\s+['"]@\/app-layer\/usecases\/org-members['"]/);
        expect(src).toMatch(/\blistOrgMembers\b/);
    });

    it('client island is a "use client" component using shared primitives', () => {
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/^['"]use client['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/layout\/ListPageShell['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/table['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/modal['"]/);
        expect(src).toMatch(/<DataTable/);
        expect(src).toMatch(/<TableEmptyState/);
        expect(src).toMatch(/<Modal\b/);
    });

    it('add + remove + role-change flows hit /api/org/{slug}/members with the right HTTP verbs', () => {
        const src = read(CLIENT_PATH);
        // POST add
        expect(src).toMatch(/method:\s*['"]POST['"]/);
        expect(src).toMatch(/`\/api\/org\/\$\{orgSlug\}\/members`/);
        expect(src).toMatch(
            /JSON\.stringify\(\s*\{[^}]*\buserEmail\b[^}]*\brole\b[^}]*\}\s*\)/,
        );
        // PUT role-change (atomic — the legacy remove-and-readd
        // workaround would create a brief deprovisioning window).
        expect(src).toMatch(/method:\s*['"]PUT['"]/);
        expect(src).toMatch(
            /JSON\.stringify\(\s*\{[^}]*\buserId\b[^}]*\brole\b[^}]*\}\s*\)/,
        );
        // DELETE remove
        expect(src).toMatch(/method:\s*['"]DELETE['"]/);
        expect(src).toMatch(/\/members\?userId=\$\{encodeURIComponent\(target\.userId\)\}/);
    });

    it('role-change UI surfaces provisioning side effects to the operator BEFORE commit', () => {
        // Promotion to ORG_ADMIN fans ADMIN rows out into every
        // child tenant; demotion fans them in. The modal MUST tell
        // the operator that's what happens — no surprises.
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/org-change-role-promotion-callout/);
        expect(src).toMatch(/org-change-role-demotion-callout/);
        // Promotion callout names the ADMIN fan-out. i18n-aware: the
        // callout copy now lives in the catalog under
        // `members.promotionCallout` — assert the wiring + the copy.
        expect(src).toMatch(/t\('members\.promotionCallout'\)/);
        expect(enOrg('members.promotionCallout')).toMatch(
            /ADMIN\s+membership[\s\S]*?every[\s\S]*?child\s+tenant/i,
        );
    });

    it('role-change submit is disabled on no-op transitions', () => {
        // Same role chosen as current → submit disabled. Mirrors
        // the API's `transition: 'noop'` branch — the UI shouldn't
        // round-trip a no-op.
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/disabled=\{[^}]*isNoOp[^}]*\}/);
    });

    it('self-role-change is disabled (cannot change your own role from this UI)', () => {
        const src = read(CLIENT_PATH);
        // The change-role action button must disable when the row's
        // userId equals the current user's. Same posture as
        // self-removal — UX guard; the last-admin invariant is
        // also enforced server-side.
        expect(src).toMatch(
            /onClick=\{\(\)\s*=>\s*setRoleTarget[\s\S]*?disabled=\{isSelf\}/,
        );
    });

    it('self-removal is disabled (cannot remove your own membership from this UI)', () => {
        // The "remove" button MUST disable when the row's userId
        // matches the current user. Same intent as the last-OWNER
        // guard but at the UX layer — the API enforces last-admin
        // server-side; this prevents the easy footgun.
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/const\s+isSelf\s*=\s*row\.original\.userId\s*===\s*currentUserId/);
        expect(src).toMatch(/disabled=\{isSelf\}/);
    });

    it('does not hand-roll a <table> or a fixed-overlay modal', () => {
        const src = read(CLIENT_PATH);
        expect(src).not.toMatch(/<table\b/);
        // Anti-pattern from Epic 54: hand-rolled `fixed inset-0
        // bg-black/…` overlays. Modals must use the primitive.
        expect(src).not.toMatch(/fixed\s+inset-0[^"]*bg-black/);
    });

    it('exposes stable test-ids for E2E targeting', () => {
        const src = read(CLIENT_PATH);
        for (const id of [
            'org-members-table',
            'org-members-add-button',
            'org-add-member-form',
            'org-add-member-email',
            'org-add-member-submit',
            'org-add-member-cancel',
            'org-remove-member-confirm',
            'org-remove-member-cancel',
            'org-member-remove-',
            'org-member-role-',
            'org-member-name-',
            'org-change-role-form',
            'org-change-role-submit',
            'org-change-role-cancel',
        ]) {
            expect(src).toContain(id);
        }
        // Per-role radios — id is built from a template literal
        // `org-change-role-${opt}` then assigned via `data-testid={id}`.
        // The template-literal source covers both ORG_ADMIN and
        // ORG_READER option keys.
        expect(src).toMatch(/`org-change-role-\$\{opt\}`/);
    });

    it('after a successful mutation, the page refreshes (router.refresh)', () => {
        // Locks the read-after-write contract: the server page
        // re-fetches via the usecase on refresh, so the UI shows
        // the mutated state.
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/router\.refresh\(\)/);
    });
});
