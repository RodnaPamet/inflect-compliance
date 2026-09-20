/**
 * Override freshness — is anything WATCHING each override?
 *
 * ─── The failure mode ───────────────────────────────────────────────
 *
 * An `overrides` entry decays silently when its range keeps ADMITTING
 * a newer release while the lockfile sits on an older one that still
 * satisfies it. `hono` did exactly that: pinned `^4.12.23`, a range
 * that permitted the patched 4.12.31, lockfile never refreshed, tree
 * on vulnerable 4.12.25 for weeks while every offline signal read
 * "remediated".
 *
 * Deciding that question needs the registry — what versions EXIST
 * upstream — so it cannot be a Jest assertion. It is
 * `scripts/check-override-freshness.mjs`, run weekly by
 * `.github/workflows/override-freshness.yml`, which files the issue
 * this guard was written alongside (#2545).
 *
 * ─── What this guard adds, and why it is not redundant ──────────────
 *
 * `tests/guards/overrides-effective.test.ts` proves each override is
 * registered, forces its recorded patched floor, and rewrites every
 * resolved instance. What NEITHER it nor the script can tell you is
 * whether the script is LOOKING at a given override at all.
 *
 * That gap was live and it was load-bearing. `versionForcingOverrides`
 * enumerated only TOP-LEVEL string entries, so every nested pin —
 * `{ jsdom: { ws: '^8.21.0' } }` — fell outside the population. Two
 * survived deduplication against the top-level keys:
 *
 *   • `jsdom > ws` (`^8.21.0`) — no top-level `ws` override, `ws` is
 *     not a direct dependency, so Dependabot does not move it either.
 *     Watched by nothing at all.
 *   • `@istanbuljs/load-nyc-config > js-yaml` (`^3.15.2`) — whose own
 *     registry entry calls it a security floor, "the 3.x branch of the
 *     SAME advisory" as the top-level `js-yaml` key. A security floor
 *     whose freshness had never once been checked.
 *
 * Nothing was red. The script printed "All version-forcing overrides
 * are at the newest release their range permits" — true of the
 * population it selected, and the selection was the defect. That is
 * the shape this file refuses: a detector reporting full coverage of
 * the subset it happens to look at.
 *
 * ─── Why it shells out instead of re-implementing the rule ──────────
 *
 * The population is read by RUNNING the script with
 * `--print-population` and parsing what it prints. Re-deriving the
 * selection rule here would make the test grade its own copy — the
 * script could narrow to nothing and this file would still agree with
 * itself. Executing the shipped function is the only version of the
 * check with a causal path from the code that runs weekly to the
 * assertion that watches it.
 *
 * `--print-population` exits above every `await` in that script, so
 * this touches no network and takes milliseconds.
 *
 * ─── What is DELIBERATELY exempt ────────────────────────────────────
 *
 * A `$name` override forces whatever the matching DIRECT dependency
 * requests. Direct dependencies are Dependabot's job, and the override
 * cannot drift away from one it is defined as equal to. Those are
 * exempt — but the exemption is checked rather than assumed: a `$ref`
 * that resolves to nothing silently disables its override, so every
 * exempt entry must name a real direct dependency.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, unknown>;
}

const pkg = readJson('package.json') as PackageJson;
const directDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
};

/** `pkg@>=1 <2` → `pkg`; a scoped name with no range selector → itself. */
function targetName(key: string): string {
    const at = key.lastIndexOf('@');
    const scopedOnly = key.startsWith('@') && at === 0;
    return at > 0 && !scopedOnly ? key.slice(0, at) : key;
}

interface Entry {
    /** The literal path through `overrides`, e.g. `jsdom > ws`. */
    entry: string;
    /** The package the pin targets. */
    name: string;
    /** The replacement spec as written (`^8.21.0` or `$react`). */
    spec: string;
    nested: boolean;
}

/**
 * EVERY entry in the overrides block, top-level and nested, flattened.
 *
 * This is the denominator. It is derived from `package.json` here
 * rather than from the script, precisely so the two can disagree.
 */
function allOverrideEntries(): Entry[] {
    const out: Entry[] = [];
    for (const [key, value] of Object.entries(pkg.overrides ?? {})) {
        if (typeof value === 'string') {
            out.push({ entry: key, name: targetName(key), spec: value, nested: false });
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        for (const [child, spec] of Object.entries(value as Record<string, unknown>)) {
            if (typeof spec !== 'string') continue;
            out.push({ entry: `${key} > ${child}`, name: targetName(child), spec, nested: true });
        }
    }
    return out;
}

/** Runs the shipped selection function and returns what it selected. */
function freshnessPopulation(): Array<{ name: string; key: string; spec: string }> {
    const out = execFileSync(
        process.execPath,
        ['scripts/check-override-freshness.mjs', '--print-population'],
        { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    return JSON.parse(out);
}

// ── minimal semver, for the lockfile-carries-two-versions check ─────

type Ver = [number, number, number];

function parseVersion(v: string): Ver | null {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Ver, b: Ver): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

/**
 * Does `version` satisfy `range`? Supports `^X.Y.Z` (with npm's 0.x
 * semantics) and a space-separated conjunction of comparators.
 *
 * Throws on an unrecognised shape. A silent `false` here would make
 * the split-instance check below vacuous for that override — the
 * whole population could go unanalysed and the suite stay green.
 */
function satisfies(version: string, range: string): boolean {
    const v = parseVersion(version);
    if (!v) throw new Error(`unparseable version: ${version}`);
    const r = range.trim();

    if (r.startsWith('^')) {
        const base = parseVersion(r.slice(1));
        if (!base) throw new Error(`unparseable caret range: ${range}`);
        if (compare(v, base) < 0) return false;
        const upper: Ver =
            base[0] !== 0
                ? [base[0] + 1, 0, 0]
                : base[1] !== 0
                  ? [0, base[1] + 1, 0]
                  : [0, 0, base[2] + 1];
        return compare(v, upper) < 0;
    }

    const parts = r.split(/\s+/).filter(Boolean);
    if (!parts.length) throw new Error(`empty range: ${range}`);
    return parts.every((part) => {
        const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
        if (!m) throw new Error(`unparseable comparator: ${part}`);
        const bound = parseVersion(m[2]);
        if (!bound) throw new Error(`unparseable comparator: ${part}`);
        const c = compare(v, bound);
        switch (m[1] ?? '=') {
            case '>=':
                return c >= 0;
            case '<=':
                return c <= 0;
            case '>':
                return c > 0;
            case '<':
                return c < 0;
            default:
                return c === 0;
        }
    });
}

/**
 * npm's own dependencies ship BUNDLED inside its tarball and no
 * override can rewrite them, so a version in there says nothing about
 * whether the override bites. Same carve-out as the effectiveness
 * guard, and safe for the same reason (`npm` is dev-only).
 */
const BUNDLED_TREE_PREFIX = 'node_modules/npm/node_modules/';

/** Every resolved instance of `name` outside npm's bundle. */
function resolvedVersions(name: string): string[] {
    const lock = readJson('package-lock.json');
    const suffix = `node_modules/${name}`;
    const found = new Set<string>();
    for (const [p, meta] of Object.entries<{ version?: string }>(lock.packages ?? {})) {
        if (p.startsWith(BUNDLED_TREE_PREFIX)) continue;
        if ((p === suffix || p.endsWith(`/${suffix}`)) && meta?.version) found.add(meta.version);
    }
    return [...found];
}

describe('override freshness — every override is inside the detector', () => {
    const entries = allOverrideEntries();
    const literal = entries.filter((e) => !e.spec.startsWith('$'));
    const dollarRefs = entries.filter((e) => e.spec.startsWith('$'));

    it('finds the overrides block (an empty denominator is not a pass)', () => {
        // Every `for` below iterates over `entries`. If the block moved
        // or was renamed, they would all iterate zero times and this
        // suite would pass while checking nothing.
        expect(entries.length).toBeGreaterThanOrEqual(40);
        expect(literal.length).toBeGreaterThanOrEqual(20);
    });

    describe('A. the freshness script examines every version-forcing override', () => {
        it('the script prints a population at all', () => {
            // A script that crashed, or a flag that stopped being
            // handled, would otherwise surface as an empty set — which
            // the residual check below would read as "nothing missing".
            expect(freshnessPopulation().length).toBeGreaterThanOrEqual(20);
        });

        it('no literal override is left unexamined', () => {
            const examined = new Set(freshnessPopulation().map((o) => `${o.name}|${o.spec}`));
            const unexamined = literal
                .filter((e) => !examined.has(`${e.name}|${e.spec}`))
                .map((e) => `${e.entry} -> ${e.spec}`);
            // Not a count — the NAMES, so a failure says which pin
            // nobody is watching rather than that the number moved.
            expect(unexamined).toEqual([]);
        });

        /**
         * The nested pins that survive deduplication against the
         * top-level keys — i.e. the entries that exist ONLY as nested
         * overrides and would go unwatched if the population narrowed
         * back to top-level.
         *
         * Pinned by exact equality rather than a `>=` count. The
         * residual check above compares two sets, so it passes
         * vacuously when both are empty; this is the assertion that
         * refuses that. Read these off the failure message.
         */
        const NESTED_ONLY_TODAY = ['@istanbuljs/load-nyc-config > js-yaml', 'jsdom > ws'];

        it('the nested-only pins are still in the population', () => {
            const topLevelIds = new Set(
                literal.filter((e) => !e.nested).map((e) => `${e.name}|${e.spec}`),
            );
            const nestedOnly = literal
                .filter((e) => e.nested && !topLevelIds.has(`${e.name}|${e.spec}`))
                .map((e) => e.entry)
                .sort();
            expect(nestedOnly).toEqual(NESTED_ONLY_TODAY);

            const examined = new Set(freshnessPopulation().map((o) => o.key));
            expect(NESTED_ONLY_TODAY.filter((k) => !examined.has(k))).toEqual([]);
        });

        it('a duplicated pin is examined once, under its top-level key', () => {
            // `brace-expansion ^5.0.9` is written three times. Reporting
            // it three times would train people to skim the weekly
            // report, and labelling it by whichever parent enumerated
            // first would make the report unstable under reordering.
            const population = freshnessPopulation();
            const ids = population.map((o) => `${o.name}|${o.spec}`);
            expect(ids).toEqual([...new Set(ids)]);
            expect(population.find((o) => o.name === 'brace-expansion')?.key).toBe(
                'brace-expansion@>=3.0.0 <=5.0.6',
            );
        });
    });

    describe('B. every exempt `$ref` really does track a direct dependency', () => {
        it('has `$ref` overrides to examine', () => {
            expect(dollarRefs.length).toBeGreaterThanOrEqual(3);
        });

        it('no `$ref` dangles', () => {
            // A `$ref` to a package that is not a direct dependency
            // resolves to nothing and silently disables the override —
            // the same class of failure as an override that never
            // matched, and the reason these may be skipped by the
            // freshness half at all.
            const dangling = dollarRefs
                .filter((e) => !directDeps[e.spec.slice(1)])
                .map((e) => `${e.entry} -> ${e.spec}`);
            expect(dangling).toEqual([]);
        });
    });

    describe('C. the lockfile does not already prove an override is behind', () => {
        // The offline half of #2545's question. Knowing that a NEWER
        // version exists upstream needs the registry — but when the
        // lockfile carries TWO versions of a package and the override
        // range admits both, the lockfile is its own witness: the newer
        // one demonstrably exists, demonstrably satisfies the range,
        // and an instance is still sitting below it. No network needed.
        //
        // This is also what a backwards-pinned lockfile entry looks
        // like, which is how the guard is mutation-proved.

        const analysed: string[] = [];
        const split: Array<{ override: string; spec: string; admitted: string[] }> = [];

        for (const e of literal) {
            const admitted = [...new Set(resolvedVersions(e.name))].filter(
                (v) => satisfies(v, e.spec),
            );
            analysed.push(e.entry);
            if (admitted.length > 1) {
                split.push({
                    override: e.entry,
                    spec: e.spec,
                    admitted: admitted.sort((a, b) => compare(parseVersion(a)!, parseVersion(b)!)),
                });
            }
        }

        it('analysed every literal override (the denominator is part of the result)', () => {
            // `satisfies` throws rather than returning false on a shape
            // it cannot read, so a range this check cannot analyse
            // fails the suite instead of quietly dropping out of it.
            expect(analysed).toHaveLength(literal.length);
        });

        it('no override range admits two different versions the lockfile carries', () => {
            expect(split).toEqual([]);
        });
    });

    describe('comparator sanity', () => {
        // Every assertion in C is only as trustworthy as `satisfies`.
        // One that returned `false` unconditionally would report an
        // empty `split` forever.
        it('handles caret ranges', () => {
            expect(satisfies('4.12.31', '^4.12.27')).toBe(true);
            expect(satisfies('4.12.25', '^4.12.27')).toBe(false);
            expect(satisfies('5.0.0', '^4.12.27')).toBe(false);
        });

        it('handles npm 0.x caret semantics', () => {
            expect(satisfies('0.2.7', '^0.2.6')).toBe(true);
            expect(satisfies('0.3.0', '^0.2.6')).toBe(false);
        });

        it('handles conjunction ranges', () => {
            expect(satisfies('2.2.24', '>=2.2.16 <2.2.25')).toBe(true);
            expect(satisfies('2.2.25', '>=2.2.16 <2.2.25')).toBe(false);
        });

        it('detects the split shape it exists to find', () => {
            // The positive control for check C: two versions, both
            // inside one caret range, is exactly what must be reported.
            const both = ['1.14.4', '1.14.5'].filter((v) => satisfies(v, '^1.14.4'));
            expect(both).toEqual(['1.14.4', '1.14.5']);
        });

        it('refuses ranges it does not understand instead of passing them', () => {
            expect(() => satisfies('1.0.0', '~1.0.0 || >=2')).toThrow();
        });
    });
});
