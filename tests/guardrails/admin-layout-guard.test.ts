/**
 * Guardrail test: Admin layout guard existence.
 *
 * Ensures the centralized admin layout guard exists and contains
 * the RequirePermission wrapper. If this file is deleted or the
 * guard is removed, admin pages lose their authorization boundary.
 */
import * as fs from 'fs';
import * as path from 'path';

const ADMIN_LAYOUT_PATH = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/admin/layout.tsx'
);

describe('Admin layout guard', () => {
    test('admin layout.tsx exists', () => {
        expect(fs.existsSync(ADMIN_LAYOUT_PATH)).toBe(true);
    });

    test('admin layout imports RequirePermission', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('RequirePermission');
    });

    test('admin layout imports ForbiddenPage', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('ForbiddenPage');
    });

    test('admin layout checks admin resource permission', () => {
        const content = fs.readFileSync(ADMIN_LAYOUT_PATH, 'utf-8');
        expect(content).toContain('resource="admin"');
    });
});

/**
 * Guardrail: No admin page should have its own redundant RequirePermission
 * for the "admin" resource. The layout handles this centrally.
 *
 * Pages that need finer-grained checks (e.g. admin.manage vs admin.view)
 * should be explicitly allowlisted below.
 *
 * The allowlist is keyed on the path RELATIVE TO the admin dir, not on the
 * basename. Keying on the basename could only ever hold `layout.tsx`, since
 * every page file in the tree is called `page.tsx` — so the "finer-grained
 * checks" carve-out the comment above promises was unreachable, and the first
 * page that legitimately needed a stricter gate would have had to choose
 * between failing CI and moving its guard somewhere the scan does not look.
 *
 * An entry is not a blanket pass. `STRICTER_GUARD_PAGES` is asserted to hold a
 * gate that is genuinely NARROWER than the layout's `admin.view` — an entry
 * that degrades to `action="view"` is redundant again and fails.
 */
describe('No duplicate admin guards on pages', () => {
    const ADMIN_PAGES_DIR = path.resolve(
        __dirname,
        '../../src/app/t/[tenantSlug]/(app)/admin'
    );

    /**
     * Pages whose own `RequirePermission` is STRICTER than the layout's, with
     * the reason. Path is relative to ADMIN_PAGES_DIR, POSIX separators.
     *
     * Two shapes qualify, and both are narrower than `admin.view`: a whole page
     * behind a stricter key, and a page that keeps `admin.view` but gates ONE
     * affordance leading somewhere stricter.
     */
    const STRICTER_GUARD_PAGES: Record<string, string> = {
        'identity-leaver-passes/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — the report names which of a customer’s people a leaver pass would have disabled; without the page gate a non-OWNER admin sees the API 403 as a load failure',
        'identity-write-policy/page.tsx':
            'OWNER-only (admin.tenant_lifecycle) — the page decides whether this product may disable accounts in the customer’s own directory, which is authority of the same class as tenant deletion; the layout’s admin.view would let a non-OWNER admin reach it and read the API 403 as a broken backend',
        'integrations/page.tsx':
            'gates ONE link (admin.tenant_lifecycle) to the OWNER-only leaver-pass report; the page itself stays admin.view, so an ADMIN is never offered a door that closes on them',
        'agents/[agentId]/page.tsx':
            'gated on admin.agent_registry, checked SERVER-side before the agent is read — the header alone carries the autonomy rung, data scope, reversibility and both risk tiers, so a holder of admin.view without the register key would otherwise read the whole governing profile off a rendered MetaStrip while every tab underneath 403s',
    };

    function findPageFiles(dir: string): string[] {
        const files: string[] = [];
        if (!fs.existsSync(dir)) return files;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...findPageFiles(fullPath));
            } else if (entry.name === 'page.tsx') {
                files.push(fullPath);
            }
        }
        return files;
    }

    const rel = (p: string) =>
        path.relative(ADMIN_PAGES_DIR, p).split(path.sep).join('/');

    test('no admin page.tsx files import RequirePermission for admin resource', () => {
        const pages = findPageFiles(ADMIN_PAGES_DIR);
        const violations: string[] = [];

        for (const pagePath of pages) {
            const relPath = rel(pagePath);
            if (relPath in STRICTER_GUARD_PAGES) continue;

            const content = fs.readFileSync(pagePath, 'utf-8');
            // Check for RequirePermission import (not just any mention in comments)
            if (
                content.includes("from '@/components/require-permission'") ||
                content.includes('from "@/components/require-permission"')
            ) {
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    test('no admin page.tsx files import ServerForbiddenPage', () => {
        const pages = findPageFiles(ADMIN_PAGES_DIR);
        const violations: string[] = [];

        for (const pagePath of pages) {
            const relPath = rel(pagePath);
            // A page carrying a stricter gate needs a fallback to render when
            // that gate refuses; ForbiddenPage IS that fallback, so the same
            // carve-out applies here.
            if (relPath in STRICTER_GUARD_PAGES) continue;

            const content = fs.readFileSync(pagePath, 'utf-8');
            if (
                content.includes("from '@/components/ForbiddenPage'") ||
                content.includes('from "@/components/ForbiddenPage"')
            ) {
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    test('every allowlisted page exists AND guards something stricter than admin.view', () => {
        // Positive half: the carve-out has to describe a real file that really
        // does carry the guard. Without this an entry outlives its page and
        // silently exempts nothing (or, worse, a future file at that path).
        const entries = Object.keys(STRICTER_GUARD_PAGES);
        expect(entries.length).toBeGreaterThan(0);

        for (const relPath of entries) {
            const full = path.join(ADMIN_PAGES_DIR, relPath);
            expect(fs.existsSync(full)).toBe(true);

            const content = fs.readFileSync(full, 'utf-8');

            // Two idioms express the same thing, and the assertion has to see
            // both. A CLIENT page wraps itself in `RequirePermission`; a SERVER
            // page reads `ctx.appPermissions.admin.<key>` and returns the
            // fallback before it fetches anything. Asserting only the client
            // shape did not make server pages safe, it made them unable to be
            // allowlisted — the first one to need a stricter gate would have
            // had to move its check somewhere the scan cannot see, or drop it.
            //
            // Deliberately NOT relaxed to "mentions a permission somewhere":
            // each branch still has to name a key, and the key still has to be
            // narrower than the layout's own `admin.view`.
            const clientGate =
                content.includes('RequirePermission') && content.includes('resource="admin"');
            // Anchored on the REFUSAL — `if (!ctx.appPermissions.admin.x)` —
            // and not on a mention of the key. A bare
            // /appPermissions\.admin\.(\w+)/ sweep reads the props a page
            // threads DOWN to its client (`canGrantTools:
            // ctx.appPermissions.admin.agent_tool_exposure`) as evidence of a
            // gate, so it passed unchanged when the gate was degraded to
            // `admin.view` and again when it was deleted outright. It was
            // measuring that the file talks about permissions, which every
            // such page does by construction.
            const serverGateKeys = [
                ...content.matchAll(/if\s*\(\s*!\s*ctx\.appPermissions\.admin\.([a-z_]+)\s*\)/g),
            ].map((m) => m[1]);
            const serverGate = serverGateKeys.some((k) => k !== 'view');

            expect(clientGate || serverGate).toBe(true);

            // Negative half, paired with the positives above: the exemption is
            // for a NARROWER gate. Re-declaring the layout's own `admin.view`
            // is the redundancy this describe block exists to refuse — in
            // whichever idiom it is written.
            if (clientGate) expect(content).not.toContain('action="view"');
            if (!clientGate) expect(serverGateKeys).not.toEqual(['view']);
            expect(STRICTER_GUARD_PAGES[relPath].length).toBeGreaterThan(20);
        }
    });
});
