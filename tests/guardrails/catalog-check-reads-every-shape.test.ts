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

/**
 * How many fixtures of each shape DECLARE template codes.
 *
 * Only code-declaring fixtures count. The directory also holds policy
 * templates, questionnaires and assessment banks, which legitimately carry no
 * template codes — counting those would let a shape look represented by a
 * fixture `catalog-check` has no reason to read.
 */
function shapeCensus(): Map<string, number> {
    const census = new Map<string, number>();
    for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
        } catch {
            continue;
        }
        const obj = (raw ?? {}) as { controls?: unknown[]; templates?: unknown[]; framework?: unknown };
        let shape: string | null = null;
        let list: unknown[] = [];
        if (Array.isArray(raw)) {
            shape = 'bare array';
            list = raw;
        } else if (obj.framework && Array.isArray(obj.templates)) {
            shape = 'CatalogFile';
            list = obj.templates;
        } else if (Array.isArray(obj.controls)) {
            shape = '{ _meta, controls }';
            list = obj.controls;
        }
        if (!shape) continue;
        const declares = list.some((t) => typeof (t as { code?: unknown })?.code === 'string');
        if (declares) census.set(shape, (census.get(shape) ?? 0) + 1);
    }
    return census;
}

describe('catalog-check sees the whole catalogue', () => {
    const expected = declaredCodes();

    it('the fixtures declare a substantial catalogue (not vacuous)', () => {
        // Every assertion below is satisfiable by an empty set, which is the
        // shape of the bug: a reader that finds nothing reports no divergence.
        expect(expected.size).toBeGreaterThan(300);
    });

    it('covers all three shipped fixture shapes', () => {
        // Asserts the SHAPES are still represented in the corpus, derived from
        // the fixtures themselves.
        //
        // This named one population per shape until 2026-09-06 — `ICN-`,
        // `TSC-`, and `AC-` for the bare array. Retiring the ten legacy
        // starter templates deleted the only `AC-` fixture and turned this
        // red, while the bare-array shape went on shipping in five others
        // (DORA, NIS2, and the three frozen ISO sets). The assertion was
        // pinned to a witness rather than to the property it was named for,
        // so a legitimate retirement read as a coverage regression.
        //
        // A hand-picked witness has that failure mode by construction: every
        // population is retirable, and the guard cannot know which. Deriving
        // the census removes the choice.
        const shapes = shapeCensus();
        expect(shapes.get('bare array') ?? 0).toBeGreaterThan(0);
        expect(shapes.get('CatalogFile') ?? 0).toBeGreaterThan(0);
        expect(shapes.get('{ _meta, controls }') ?? 0).toBeGreaterThan(0);
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
