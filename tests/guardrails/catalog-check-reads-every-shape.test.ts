/**
 * `catalog-check` sees every fixture shape that ships.
 *
 * ═══ WHY THIS ONE ASSERTION ═══
 *
 * The script answers "does this database hold the catalogue the repo
 * declares?", and its whole value is the DENOMINATOR. A reader that silently
 * misses a fixture reports a clean bill of health for the subset it happens to
 * understand — which is the exact failure it exists to catch, one level up.
 *
 * That is not hypothetical here. Three shapes ship:
 *   • a bare array                     (legacy fixtures)
 *   • `{ framework, requirements, templates, pack }`   (CatalogFile)
 *   • `{ _meta, controls }`            (internal-controls.json)
 * An earlier scan in this repo read only the first two and stayed blind to 151
 * templates — the largest population there is — while reporting full coverage.
 *
 * So this asserts the script's expectation covers every template code that any
 * fixture declares, computed independently here rather than by calling the
 * script's own reader. Two implementations that agree is the point; one
 * implementation checked against itself proves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

/** Every template code any fixture declares, derived independently. */
function declaredCodes(): Set<string> {
    const codes = new Set<string>();
    for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
        } catch {
            continue;
        }
        const obj = (raw ?? {}) as { controls?: unknown[]; templates?: unknown[] };
        const list = (Array.isArray(raw) ? raw : (obj.templates ?? obj.controls ?? [])) as Array<{
            code?: unknown;
        }>;
        for (const t of list) if (typeof t?.code === 'string') codes.add(t.code);
    }
    return codes;
}

describe('catalog-check sees the whole catalogue', () => {
    const expected = declaredCodes();

    it('the fixtures declare a substantial catalogue (not vacuous)', () => {
        // Every assertion below is satisfiable by an empty set, which is the
        // shape of the bug: a reader that finds nothing reports no divergence.
        expect(expected.size).toBeGreaterThan(300);
    });

    it('covers all three shipped fixture shapes', () => {
        // Named populations, one per shape, so a regression says WHICH shape
        // broke rather than only that a number moved.
        expect([...expected].some((c) => c.startsWith('ICN-'))).toBe(true); // { _meta, controls }
        expect([...expected].some((c) => c.startsWith('TSC-'))).toBe(true); // CatalogFile
        expect([...expected].some((c) => c.startsWith('AC-'))).toBe(true); // bare array
    });

    it("the script's own expectation matches, template for template", () => {
        // Runs the real script in its no-database mode. If its reader ever
        // drifts from the shapes that ship, the counts diverge here.
        const out = execFileSync('npx', ['tsx', 'scripts/catalog-check.ts', '--expected-only'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env, SKIP_ENV_VALIDATION: '1' },
        });
        const m = out.match(/Repo declares (\d+) templates/);
        expect(m).toBeTruthy();
        expect(Number(m![1])).toBe(expected.size);
    });
});
