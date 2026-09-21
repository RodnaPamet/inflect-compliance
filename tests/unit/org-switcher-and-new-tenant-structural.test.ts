/**
 * Epic O-4 — structural contract for the OrgSwitcher + new-tenant form.
 *
 * Locks:
 *   - OrgSwitcher renders a portfolio entry + tenant rows with the
 *     correct hrefs (/org/{slug} and /t/{slug}/dashboard) so links
 *     stay deep-linkable and middle-clickable.
 *   - The trigger and rows expose stable test-ids for E2E targeting.
 *   - Switcher is mounted inside the org sidebar header so first-paint
 *     of every org page surfaces the context-switch affordance.
 *   - New-tenant page exists, gates on canManageTenants, posts to
 *     /api/org/{slug}/tenants, and includes a framework picker.
 *   - Form validation tightens the slug to the API contract regex
 *     before sending — fast feedback without a round-trip.
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
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

// i18n-aware: the trigger aria-label now routes through next-intl.
const EN = JSON.parse(readRaw('messages/en.json'));
const enOrg = (key: string): unknown =>
    key.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.org,
    );

const SWITCHER = 'src/components/org-switcher.tsx';
const ORG_NAV = 'src/components/layout/OrgSidebarNav.tsx';
const NEW_TENANT_PAGE = 'src/app/org/[orgSlug]/(app)/tenants/new/page.tsx';
const NEW_TENANT_FORM = 'src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx';
const TENANTS_TABLE = 'src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx';

describe('Epic O-4 — OrgSwitcher structural contract', () => {
    it('component file exists at the canonical path', () => {
        expect(exists(SWITCHER)).toBe(true);
    });

    it('is a client component (renders Popover)', () => {
        const src = read(SWITCHER);
        expect(src).toMatch(/^['"]use client['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/popover['"]/);
    });

    it('exposes typed props for context kind + current tenant', () => {
        const src = read(SWITCHER);
        // Locks the surface so the same component can later mount in
        // the tenant shell without prop-shape drift.
        expect(src).toMatch(/currentKind:\s*['"]org['"]\s*\|\s*['"]tenant['"]/);
        expect(src).toMatch(/currentTenantSlug\?:\s*string\s*\|\s*null/);
    });

    it('builds the portfolio link as /org/{slug} and tenant links as /t/{slug}/dashboard', () => {
        const src = read(SWITCHER);
        expect(src).toMatch(/href=\{`\/org\/\$\{orgSlug\}`\}/);
        expect(src).toMatch(/href=\{`\/t\/\$\{t\.slug\}\/dashboard`\}/);
    });

    it('lazy-fetches the tenant list from /api/org/{slug}/tenants', () => {
        const src = read(SWITCHER);
        // Endpoint is the Epic O-2 list route. Locking the URL means
        // a refactor of the API path forces a switcher update.
        expect(src).toMatch(/`\/api\/org\/\$\{orgSlug\}\/tenants`/);
    });

    it('exposes stable test-ids (trigger + portfolio + per-tenant)', () => {
        const src = read(SWITCHER);
        for (const id of [
            'org-switcher-trigger',
            'org-switcher-portfolio',
            'org-switcher-tenant-',
        ]) {
            expect(src).toContain(id);
        }
    });

    it('renders an aria-label on the trigger and role="status" on the loading region', () => {
        const src = read(SWITCHER);
        // i18n-aware: aria-label now resolves `t('switcher.switchOrgContextAria')`.
        expect(src).toMatch(/aria-label=\{t\('switcher\.switchOrgContextAria'\)\}/);
        expect(enOrg('switcher.switchOrgContextAria')).toBe('Switch organization context');
        expect(src).toMatch(/role="status"/);
    });

    it('avatar pill derives initials from orgName via formatInitials (no hardcoded "IC")', () => {
        // The trigger MUST NOT bake the brand initials into the
        // avatar pill — the pill represents the active org's
        // identity. Locks both the import + the substitution so a
        // future "minimal cleanup" PR doesn't quietly reintroduce
        // "IC".
        const src = read(SWITCHER);
        expect(src).toMatch(
            /import\s+\{\s*formatInitials\s*\}\s+from\s+['"]@\/lib\/format-initials['"]/,
        );
        expect(src).toMatch(/formatInitials\(orgName\)/);
        // Negative: the literal "IC" pill must be gone. Match
        // ">IC<" between JSX tags so we don't false-positive on
        // unrelated occurrences of those letters in identifiers.
        expect(src).not.toMatch(/>\s*IC\s*</);
        // Stable test-id for the dynamic content lets E2E assert
        // the rendered initials.
        expect(src).toContain('org-switcher-avatar-initials');
    });
});

describe('Epic O-4 — OrgSidebarNav mounts OrgSwitcher in the header', () => {
    it('imports OrgSwitcher', () => {
        expect(read(ORG_NAV)).toMatch(/from\s+['"]@\/components\/org-switcher['"]/);
    });

    it('renders <OrgSwitcher currentKind="org" /> in the sidebar', () => {
        const src = read(ORG_NAV);
        expect(src).toMatch(/<OrgSwitcher\b/);
        expect(src).toMatch(/currentKind=['"]org['"]/);
    });

    it('does not also keep the old static "Portfolio" tagline (avoid duplicate header)', () => {
        // The switcher carries its own tagline. A leftover static
        // "Portfolio" block would visually conflict.
        const src = read(ORG_NAV);
        const matches = src.match(/Portfolio<\/p>/g) ?? [];
        expect(matches.length).toBe(0);
    });
});

describe('Epic O-4 — new-tenant page structural contract', () => {
    it('server page + client form both exist', () => {
        expect(exists(NEW_TENANT_PAGE)).toBe(true);
        expect(exists(NEW_TENANT_FORM)).toBe(true);
    });

    it('server page declares dynamic = "force-dynamic"', () => {
        expect(read(NEW_TENANT_PAGE)).toMatch(
            /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
        );
    });

    it('server page resolves OrgContext, gates on canManageTenants, and routes errors to notFound()', () => {
        const src = read(NEW_TENANT_PAGE);
        expect(src).toMatch(/getOrgCtx\s*\(\s*\{[^}]*orgSlug/);
        expect(src).toMatch(/}\s*catch\b[\s\S]*?notFound\s*\(\s*\)/);
        expect(src).toMatch(/ctx\.permissions\.canManageTenants/);
        expect(src).toMatch(/throw\s+forbidden\(/);
    });

    it('client form is a "use client" component using shared form primitives', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/^['"]use client['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/form-field['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/input['"]/);
        expect(src).toMatch(/from\s+['"]@\/components\/ui\/button['"]/);
    });

    it('renders all three spec fields (name, slug, framework)', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toContain('org-new-tenant-name');
        expect(src).toContain('org-new-tenant-slug');
        expect(src).toContain('org-new-tenant-framework-group');
    });

    it('POSTs to /api/org/{slug}/tenants with name + slug only (matches API contract)', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/`\/api\/org\/\$\{orgSlug\}\/tenants`/);
        // The request body uses the API's two fields. Framework lives
        // client-side and drives the post-creation redirect target only.
        expect(src).toMatch(
            /body:\s*JSON\.stringify\(\s*\{\s*name:[^,]+,\s*slug:[^}]+\}\s*\)/,
        );
    });

    it('redirects to the new tenant frameworks page when a framework is picked, otherwise dashboard', () => {
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/router\.push\(`\/t\/\$\{newSlug\}\/dashboard`\)/);
        expect(src).toMatch(
            /router\.push\(`\/t\/\$\{newSlug\}\/frameworks\?install=\$\{framework\}`\)/,
        );
    });

    it('validates the slug with the API contract regex before sending', () => {
        // Mirrors `SlugField` in `organization.schemas.ts` — fail fast
        // in the UI rather than waiting on a 400 round-trip.
        const src = read(NEW_TENANT_FORM);
        expect(src).toMatch(/SLUG_RE\s*=\s*\//);
        expect(src).toMatch(/SLUG_RE\.test\(trimmedSlug\)/);
    });

    it('renders submit/cancel/error/loading states with stable test-ids', () => {
        const src = read(NEW_TENANT_FORM);
        for (const id of [
            'org-new-tenant-submit',
            'org-new-tenant-cancel',
            'org-new-tenant-error',
            'org-new-tenant-back',
            'org-new-tenant-form',
        ]) {
            expect(src).toContain(id);
        }
    });
});

describe('Epic O-4 — Tenant list page exposes a "New tenant" CTA when permitted', () => {
    it('TenantsTable links to /org/{slug}/tenants/new and gates on canManageTenants', () => {
        const src = read(TENANTS_TABLE);
        expect(src).toMatch(/from\s+['"]@\/lib\/org-context-provider['"]/);
        expect(src).toMatch(/perms\.canManageTenants/);
        expect(src).toMatch(/`\/org\/\$\{orgSlug\}\/tenants\/new`/);
        expect(src).toContain('org-tenants-new-link');
    });
});
