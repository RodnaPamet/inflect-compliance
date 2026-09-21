/**
 * Roadmap-2 PR-1 — single AppShell discipline.
 *
 * Until this PR there were two near-identical shells:
 *   • `src/components/layout/AppShell.tsx`     (tenant /t/:slug/(app))
 *   • `src/components/layout/OrgAppShell.tsx`  (org /org/:slug)
 *
 * Plus a hand-rolled header on `t/[tenantSlug]/(app)/admin/page.tsx`
 * that bypassed `PageHeader` entirely. Three shells where there
 * should be one. The roadmap collapsed all three into a single
 * `<AppShell variant="…">` primitive — this ratchet locks it in.
 *
 * What this ratchet detects
 *   1. The deleted `OrgAppShell.tsx` MUST stay deleted. A future PR
 *      that resurrects it (or adds a third sibling shell) fails CI.
 *   2. Any `from '@/components/layout/OrgAppShell'` import is a
 *      compile-time + test-time error.
 *   3. The unified `AppShell` accepts a `variant` prop (the union
 *      type that gates the sidebar slot).
 *   4. Both consumer layouts (tenant + org) mount the unified
 *      `<AppShell>` — never their own bespoke chrome.
 *
 * What this ratchet does NOT police
 *   The `unauth` surfaces (login, error, no-tenant, not-found) and
 *   the `print` surfaces (SoAPrintView) are intentionally outside
 *   the shell — they have no sidebar and no app chrome. Adding
 *   shell variants for them is pretense, not unification, and is
 *   explicitly out of scope.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const SHELL_PATH = 'src/components/layout/AppShell.tsx';
const DELETED_SHELL_PATH = 'src/components/layout/OrgAppShell.tsx';
const TENANT_LAYOUT = 'src/app/t/[tenantSlug]/(app)/layout.tsx';
const ORG_LAYOUT = 'src/app/org/[orgSlug]/layout.tsx';

describe('Single AppShell discipline (Roadmap-2 PR-1)', () => {
    it('the unified AppShell file exists', () => {
        expect(fs.existsSync(path.join(ROOT, SHELL_PATH))).toBe(true);
    });

    it('the deprecated OrgAppShell.tsx stays deleted', () => {
        // A future PR that re-creates this file (or adds a third
        // sibling like AdminAppShell.tsx) is fragmenting the chrome.
        // Either fold the new variant into the unified primitive or
        // open an explicit RFC PR — never a silent re-fork.
        expect(fs.existsSync(path.join(ROOT, DELETED_SHELL_PATH))).toBe(false);
    });

    it('AppShell exports a `variant` discriminator union', () => {
        const src = read(SHELL_PATH);
        // The variant union must be exported as a named type so
        // consumers TypeCheck against it. Internal-only would let
        // the union drift silently.
        expect(src).toMatch(
            /export\s+type\s+AppShellVariant\s*=\s*['"]tenant['"]\s*\|\s*['"]org['"]/,
        );
    });

    it('tenant layout mounts the unified AppShell', () => {
        const src = read(TENANT_LAYOUT);
        expect(src).toMatch(/from\s+['"]@\/components\/layout\/AppShell['"]/);
        expect(src).toMatch(/<AppShell\b/);
        // The tenant variant is the default — no `variant=` is fine
        // here. Just assert the import + mount.
    });

    it('org layout mounts the unified AppShell with variant="org"', () => {
        const src = read(ORG_LAYOUT);
        expect(src).toMatch(/from\s+['"]@\/components\/layout\/AppShell['"]/);
        expect(src).toMatch(/<AppShell[\s\S]*?variant=["']org["']/);
        // No reference to the deleted shell can survive.
        expect(src).not.toMatch(/OrgAppShell/);
    });

    it('no source file imports from the deleted OrgAppShell path', () => {
        // Walk src/ + tests/ and assert nothing references
        // '@/components/layout/OrgAppShell'.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') continue;
                    walk(full);
                } else if (/\.(ts|tsx)$/.test(entry.name)) {
                    const content = codeOf(fs.readFileSync(full, 'utf-8'));
                    // Match the path only inside an `import … from`
                    // statement, not the test's own detection regex.
                    if (
                        /import[^;]*?from\s+['"]@\/components\/layout\/OrgAppShell['"]/m.test(
                            content,
                        )
                    ) {
                        offenders.push(path.relative(ROOT, full));
                    }
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        if (fs.existsSync(path.join(ROOT, 'tests'))) {
            walk(path.join(ROOT, 'tests'));
        }
        if (offenders.length > 0) {
            throw new Error(
                `Found ${offenders.length} file(s) still importing the deleted OrgAppShell. Migrate to '@/components/layout/AppShell' with variant="org":\n${offenders.join('\n')}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
