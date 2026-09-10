/**
 * `overrides` governance — an override must be EFFECTIVE and EXPLAINED.
 *
 * ─── The failure mode ───────────────────────────────────────────────
 *
 * `package.json`'s `overrides` block is this repo's mechanism for
 * forcing a patched transitive dependency when an advisory lands
 * against a version pulled in by a package we don't control (see
 * `docs/dependency-policy.md`). It is load-bearing: the CI `Security`
 * job blocks merges on MODERATE+ advisories in production deps.
 *
 * It has two silent-decay modes, and we hit BOTH in one day
 * (2026-07-21):
 *
 *  1. **The override stops meaning "patched".** `hono` was pinned
 *     `^4.12.23`. The caret range *permitted* the patched 4.12.31 —
 *     but `package-lock.json` was never refreshed, so the tree sat on
 *     vulnerable 4.12.25. The block LOOKED remediated. Nothing in the
 *     repo recorded which version was actually the fixed one, so the
 *     only signal was the audit gate going red weeks later.
 *
 *  2. **The override never applied at all.** An override that doesn't
 *     match how the package is actually reached (or that targets a
 *     version range the tree has moved past) resolves to nothing. The
 *     entry sits there reading like protection while protecting
 *     nothing.
 *
 * ─── What this guard does ───────────────────────────────────────────
 *
 * Offline, from `package.json` + `package-lock.json` only:
 *
 *  A. **Explained** — every version-forcing override carries a
 *     registry entry below with a written reason (and, for security
 *     overrides, the advisory). Bidirectional: an unregistered
 *     override fails, and a registry entry whose override is gone
 *     fails (so the list can't accumulate ghosts).
 *
 *  B. **Effective** — every resolved instance in the lockfile
 *     actually honours the override. For a plain override that means
 *     "every instance satisfies the replacement range"; for a
 *     range-keyed override (`pkg@>=a <=b`) it means "no instance is
 *     left inside the targeted vulnerable range".
 *
 *  C. **The one carve-out stays inert** — npm's own bundled
 *     dependency tree (`node_modules/npm/node_modules/**`) is
 *     unreachable by overrides. That is only acceptable because `npm`
 *     is a DEV-only dependency (pulled by `@semantic-release/npm`), so
 *     it is outside `npm audit --omit=dev`. This guard asserts that
 *     precondition rather than assuming it — if `npm` ever becomes a
 *     production dependency, the carve-out starts hiding real CVEs and
 *     this test fails.
 *
 * ─── What this guard deliberately does NOT do ───────────────────────
 *
 * It cannot tell you a NEWER patched version exists upstream, and it
 * cannot tell you whether a recorded `advisory` id is even REAL. Both
 * need the registry / advisory database, i.e. the network, which a
 * Jest guard must not touch. That half is
 * `.github/workflows/override-freshness.yml` (scheduled, non-blocking),
 * driving `scripts/check-override-freshness.mjs`.
 *
 * The blind spot is not hypothetical either. Check A below asserts an
 * advisory id matches `/^(GHSA-|CVE-)/` — a SHAPE test. Four entries
 * once sat green with ids that were shape-valid and substantively
 * wrong: `picomatch` carried an `ip` SSRF advisory, `tmp` carried an
 * id that does not exist, and `protobufjs` / `@grpc/grpc-js` carried
 * real advisories patched in majors far below the floors they were
 * supposedly justifying (2026-07-25). Offline, all four are
 * indistinguishable from correct. The script now resolves every id
 * against the GitHub Advisory Database and compares its real
 * `first_patched_version` against `patchedFrom`.
 *
 * The two halves are complementary: this one proves the override
 * bites, the script proves the facts it bites on are true.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const readJson = (rel: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// ────────────────────────────────────────────────────────────────
//  Minimal semver — enough for the shapes `overrides` actually uses
//  (`^X.Y.Z` replacements, `>=A <=B` range keys).
//
//  `semver` is not a declared dependency here and guards in this repo
//  stay dependency-free. A hand-rolled comparator is only safe if it
//  is itself verified — see the "comparator sanity" block at the
//  bottom, which exists so a broken comparator cannot quietly make
//  every assertion above vacuously true.
// ────────────────────────────────────────────────────────────────

type Ver = [number, number, number];

/** Parse `1.2.3` / `1.2.3-beta.1` → [1,2,3]. Prerelease tags ignored. */
function parseVersion(v: string): Ver | null {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Ver, b: Ver): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

/**
 * Does `version` satisfy `range`?
 *
 * Supports the two forms the overrides block uses:
 *   • `^X.Y.Z`  — >= X.Y.Z and < (X+1).0.0, with npm's 0.x semantics
 *                 (`^0.2.6` → >=0.2.6 <0.3.0).
 *   • a space-separated conjunction of `>=` / `<=` / `>` / `<` / `=`
 *     comparators, e.g. `>=3.0.0 <=5.0.6`.
 * Throws on anything else so an unrecognised range can never be
 * silently treated as "satisfied".
 */
function satisfies(version: string, range: string): boolean {
    const v = parseVersion(version);
    if (!v) throw new Error(`unparseable version: ${version}`);
    const r = range.trim();

    if (r.startsWith('^')) {
        const base = parseVersion(r.slice(1));
        if (!base) throw new Error(`unparseable caret range: ${range}`);
        if (compare(v, base) < 0) return false;
        // npm caret: the leftmost NON-ZERO component is the one held.
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

// ────────────────────────────────────────────────────────────────
//  The registry — every version-forcing override, with its reason.
//
//  `kind`:
//    'security'     — forces a PATCHED version past an advisory. Keep
//                     until the upstream package depends on a patched
//                     range on its own.
//    'peer-bridge'  — reconciles a peer-dependency mismatch. Drop as
//                     soon as upstream's peer range includes what we
//                     run; a bridge, not a destination.
//    'upstream-defect'
//                   — holds us BELOW a released version that is
//                     broken. Drop when upstream ships the fix; the
//                     entry must name the first bad version so that
//                     question is answerable without archaeology.
//
//  `patchedFrom` (security only) — the version the advisory was FIXED
//  in. This is the fact that was missing when `hono` decayed: with it
//  recorded, "is our floor still the fix?" is answerable from the
//  repo, and the freshness workflow has something to compare against.
// ────────────────────────────────────────────────────────────────

interface OverrideEntry {
    /**
     * `bundle-vehicle` — the pin exists to move a package's BUNDLED
     * dependency tree, not because the pinned package itself has an
     * advisory. `npm` is the case: overrides cannot rewrite bundled
     * deps, so raising the `npm` pin is the only lever on the tar and
     * brace-expansion copies inside its bundle.
     *
     * It gets its own kind because forcing it into `security` means
     * inventing an advisory id and a `patchedFrom` for an advisory
     * that does not exist — a false fact recorded to satisfy a
     * schema, which is the failure this registry exists to prevent.
     * (The `npm` entry carried GHSA-4v6q-8jgv-6q2j for exactly that
     * reason; the id resolves to nothing.)
     *
     * `upstream-defect` — the pinned package shipped a BUG, not a
     * vulnerability, and the pin holds us below it until upstream
     * fixes it. Same argument as `bundle-vehicle`: forcing it into
     * `security` would mean inventing an advisory id for something no
     * advisory database has, and this registry exists to stop exactly
     * that. It is distinguished from `peer-bridge` because nothing is
     * mismatched — the graph is consistent, the code is simply wrong —
     * so the exit condition is "upstream ships a fix", not "upstream
     * widens a range".
     */
    kind: 'security' | 'peer-bridge' | 'bundle-vehicle' | 'upstream-defect';
    reason: string;
    /** `upstream-defect` only — the first released version carrying the bug. */
    brokenFrom?: string;
    advisory?: string;
    patchedFrom?: string;
    /**
     * Set when the override currently rewrites NOTHING — the package has
     * no resolved instance the override can reach.
     *
     * An inert override is not automatically wrong (it can be a floor
     * for a package that may return), but it must be a DECLARED state
     * rather than an accident: an entry that reads as protection while
     * protecting nothing is the exact trap this guard exists for. The
     * check is bidirectional — declaring `currentlyInert` on an override
     * that DOES bite fails too, so the note cannot go stale in either
     * direction.
     */
    currentlyInert?: string;
}

/**
 * The registry is DATA, held in `override-registry.json` rather than
 * inline here.
 *
 * That split is load-bearing, not tidiness: the network half
 * (`scripts/check-override-freshness.mjs`) verifies each recorded
 * `advisory` against the GitHub Advisory Database and checks that its
 * real fixed version still matches `patchedFrom`. A plain `.mjs`
 * script cannot import a TypeScript test module (the `describe` calls
 * would execute), so an inline registry would have forced the script
 * to either re-declare the same facts — two sources that drift — or
 * parse TypeScript with a regex that fails silently. One JSON file,
 * two readers.
 */
const OVERRIDE_REGISTRY: Record<string, OverrideEntry> = readJson(
    'tests/guards/override-registry.json',
);

/**
 * npm ships its dependencies BUNDLED — they live inside the published
 * tarball and `overrides` cannot rewrite them. Instances under this
 * prefix are therefore exempt from the effectiveness check.
 *
 * Safe ONLY while `npm` is dev-only (asserted below): the blocking
 * gate is `npm audit --omit=dev`, so a dev-tree bundle is outside the
 * shipped surface.
 */
const BUNDLED_TREE_PREFIX = 'node_modules/npm/node_modules/';

// ────────────────────────────────────────────────────────────────

interface ParsedOverride {
    /** The package the override targets. */
    name: string;
    /** The literal key in `overrides` (may carry a range selector). */
    key: string;
    /** Replacement spec, e.g. `^5.0.7`. */
    spec: string;
    /** For a range-keyed override, the targeted (vulnerable) range. */
    targetRange: string | null;
    /** `$name` pointing at a package that is not a direct dependency. */
    danglingRef?: boolean;
}

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, unknown>;
}

/**
 * Resolve a `$name` override to the spec of the direct dependency it
 * points at.
 *
 * `$name` means "whatever version I depend on directly". npm requires it
 * whenever a package is BOTH a direct dependency and an override target:
 * a duplicated literal range is legal only while the two happen to match
 * character-for-character, and the moment anything tries to bump one it
 * breaks. That is not hypothetical — it took Dependabot's whole
 * `npm_and_yarn` run down on 2026-08-10 with "Override for
 * undici@8.10.0 conflicts with direct dependency", which also blocked
 * every OTHER security update batched into that run.
 *
 * These used to be skipped here, on the reasoning that `$name` "cannot
 * go stale independently". True — but it can go stale TOGETHER with the
 * dependency it tracks. Downgrade `dependencies.undici` to `^6` and the
 * security floor this guard exists to protect is breached with nothing
 * to notice, because the override that recorded the floor had quietly
 * exempted itself. Resolving the reference keeps the floor checkable and
 * keeps the registry entry (with its advisory) alive.
 */
function resolveDollarRef(value: string, pkg: PackageJson): string | null {
    const target = value.slice(1);
    return (
        pkg.dependencies?.[target] ??
        pkg.devDependencies?.[target] ??
        null
    );
}

/**
 * The version-forcing overrides — i.e. the ones this guard governs.
 *
 * Skipped deliberately:
 *   • object values (`{ react: '$react' }`) — nested peer pins, which
 *     are scoped to one parent and covered by the peer-bridge docs.
 *
 * `$name` values are NOT skipped — see `resolveDollarRef`.
 */
function parseOverrides(): ParsedOverride[] {
    const pkg = readJson('package.json') as PackageJson;
    const out: ParsedOverride[] = [];
    for (const [key, rawValue] of Object.entries(pkg.overrides ?? {})) {
        if (typeof rawValue !== 'string') continue;
        let value = rawValue;
        if (value.startsWith('$')) {
            const resolved = resolveDollarRef(value, pkg);
            // A dangling `$ref` silently disables the override, which is
            // the same class of failure as an override that never
            // matched. Surface it as an unresolvable entry rather than
            // dropping it.
            if (!resolved) {
                out.push({ name: key, key, spec: rawValue, targetRange: null, danglingRef: true });
                continue;
            }
            value = resolved;
        }
        // `name@range` — split on the LAST `@` so scoped names survive.
        const at = key.lastIndexOf('@');
        const scopedOnly = key.startsWith('@') && at === 0;
        if (at > 0 && !scopedOnly) {
            out.push({
                name: key.slice(0, at),
                key,
                spec: value,
                targetRange: key.slice(at + 1),
            });
        } else {
            out.push({ name: key, key, spec: value, targetRange: null });
        }
    }
    return out;
}

/** Every resolved instance of `name`, as `[lockfilePath, version]`. */
function resolvedInstances(name: string): Array<[string, string]> {
    const lock = readJson('package-lock.json');
    const suffix = `node_modules/${name}`;
    const out: Array<[string, string]> = [];
    for (const [p, meta] of Object.entries<{ version?: string }>(lock.packages ?? {})) {
        if (p === suffix || p.endsWith(`/${suffix}`)) {
            if (meta?.version) out.push([p, meta.version]);
        }
    }
    return out;
}

describe('package.json overrides — effective and explained', () => {
    const overrides = parseOverrides();

    it('finds the overrides block (guard is not silently inert)', () => {
        // If the block moves or is renamed, every `for` below iterates
        // zero times and the suite passes green while checking nothing.
        expect(overrides.length).toBeGreaterThanOrEqual(10);
    });

    it('loads the registry file (a truncated JSON cannot go unnoticed)', () => {
        // The registry moved out to JSON so the freshness script can
        // read it too. That buys a new failure mode the inline literal
        // did not have: a file that fails to parse, or parses to `{}`,
        // would make check A fail loudly — but a file that lost only
        // SOME entries would not. Pin the floor.
        expect(Object.keys(OVERRIDE_REGISTRY).length).toBeGreaterThanOrEqual(15);
    });

    it('every registry entry is well-formed (including unused ones)', () => {
        // Check A only validates entries reachable from `overrides`.
        // This one validates the FILE, so a malformed entry is caught
        // even in the window before its override lands — and so the
        // freshness script can trust the shape of what it reads.
        const malformed = Object.entries(OVERRIDE_REGISTRY).filter(([, e]) => {
            if (!['security', 'peer-bridge', 'bundle-vehicle', 'upstream-defect'].includes(e.kind)) return true;
            // A vehicle pin must NOT carry advisory facts — that is the
            // whole point of the kind. Recording them here would put
            // the invented-id problem back, one indirection down.
            if (e.kind === 'bundle-vehicle' && (e.advisory || e.patchedFrom)) return true;
            // Same rule as bundle-vehicle: no invented advisory facts. But an
            // upstream-defect pin DOES owe the reader the version the defect
            // landed in — that is the fact that makes "can we drop this yet?"
            // answerable, and it is the analogue of `patchedFrom`.
            if (e.kind === 'upstream-defect') {
                if (e.advisory || e.patchedFrom) return true;
                if (!/^\d+\.\d+\.\d+$/.test(e.brokenFrom ?? '')) return true;
            }
            if (e.kind !== 'upstream-defect' && e.brokenFrom !== undefined) return true;
            if (typeof e.reason !== 'string' || e.reason.length <= 40) return true;
            if (e.kind === 'security') {
                if (!/^(GHSA-|CVE-)/.test(e.advisory ?? '')) return true;
                if (!/^\d+\.\d+\.\d+$/.test(e.patchedFrom ?? '')) return true;
            }
            if (e.currentlyInert !== undefined && typeof e.currentlyInert !== 'string') return true;
            return false;
        });
        expect(malformed.map(([name]) => name)).toEqual([]);
    });

    describe('A. every version-forcing override is registered', () => {
        for (const o of overrides) {
            it(`${o.key} has a registry entry`, () => {
                const entry = OVERRIDE_REGISTRY[o.name];
                expect(entry).toBeDefined();
                expect(entry.reason.length).toBeGreaterThan(40);
                if (entry.kind === 'security') {
                    // An advisory id and the version the fix landed in
                    // are what make "is this still the patch?"
                    // answerable without archaeology.
                    expect(entry.advisory).toMatch(/^(GHSA-|CVE-)/);
                    expect(entry.patchedFrom).toMatch(/^\d+\.\d+\.\d+$/);
                }
            });
        }

        it('has no ghost entries (registry ⊆ overrides)', () => {
            const live = new Set(overrides.map((o) => o.name));
            const ghosts = Object.keys(OVERRIDE_REGISTRY).filter((n) => !live.has(n));
            expect(ghosts).toEqual([]);
        });
    });

    describe('B. every security override still forces its patched floor', () => {
        for (const o of overrides) {
            const entry = OVERRIDE_REGISTRY[o.name];
            if (entry?.kind !== 'security' || !entry.patchedFrom) continue;
            it(`${o.name}: spec ${o.spec} admits nothing below ${entry.patchedFrom}`, () => {
                // The invariant is about the FLOOR, not about whether
                // the spec happens to admit `patchedFrom` itself.
                //
                // `patchedFrom` records the version the advisory was
                // fixed in — a fact about upstream. The spec records
                // what we admit, and pinning STRICTER than the fix is
                // legitimate (`sharp` is pinned to an exact 0.35.3
                // against a 0.35.0 fix). Asserting "spec admits
                // patchedFrom" would fail that entry and push someone
                // to record a false fix version to get green, which is
                // precisely the decay this file exists to prevent.
                //
                // What must hold: the lowest version the spec admits
                // is at or above the recorded fix.
                const floor = parseVersion(o.spec.replace(/^[\^~]/, ''));
                const fixedAt = parseVersion(entry.patchedFrom!);
                expect(floor).not.toBeNull();
                expect(fixedAt).not.toBeNull();
                expect({
                    override: o.key,
                    floor: o.spec,
                    admitsSomethingBelowTheFix: compare(floor!, fixedAt!) < 0,
                }).toEqual({ override: o.key, floor: o.spec, admitsSomethingBelowTheFix: false });
            });
        }
    });

    describe('C. every override actually applied in the lockfile', () => {
        for (const o of overrides) {
            it(`${o.key} bites on every resolved instance`, () => {
                const instances = resolvedInstances(o.name)
                    .filter(([p]) => !p.startsWith(BUNDLED_TREE_PREFIX));
                const entry = OVERRIDE_REGISTRY[o.name];

                if (instances.length === 0) {
                    // Reaches nothing. Allowed, but only as a declared
                    // state with a written reason — never silently.
                    expect({
                        override: o.key,
                        reachesNothing: true,
                        declaredInert: Boolean(entry?.currentlyInert),
                    }).toEqual({ override: o.key, reachesNothing: true, declaredInert: true });
                    return;
                }

                // The inverse: an override marked inert that HAS started
                // biting means the note is stale and the entry needs a
                // fresh look.
                expect({ override: o.key, staleInertNote: Boolean(entry?.currentlyInert) })
                    .toEqual({ override: o.key, staleInertNote: false });

                for (const [p, version] of instances) {
                    if (o.targetRange) {
                        // Range-keyed: the point is that NOTHING is
                        // left inside the vulnerable window.
                        expect({ path: p, version, insideVulnerableRange: satisfies(version, o.targetRange) })
                            .toEqual({ path: p, version, insideVulnerableRange: false });
                    } else {
                        expect({ path: p, version, satisfiesOverride: satisfies(version, o.spec) })
                            .toEqual({ path: p, version, satisfiesOverride: true });
                    }
                }
            });
        }
    });

    describe('D. the bundled-tree carve-out stays inert', () => {
        it('npm is a dev-only dependency, so its bundled tree is outside the audit gate', () => {
            // The whole justification for skipping
            // `node_modules/npm/node_modules/**` is that the blocking
            // gate runs `--omit=dev`. If npm ever lands in the
            // production tree, the carve-out would start concealing
            // real findings — fail loudly at that moment.
            const lock = readJson('package-lock.json');
            const npmPkg = lock.packages?.['node_modules/npm'];
            if (!npmPkg) return; // npm dropped out of the tree entirely — fine.
            expect(npmPkg.dev).toBe(true);
        });

        it('documents which packages the carve-out currently hides', () => {
            // Not an assertion about the count — a visibility check, so
            // a reviewer can see the carve-out's real blast radius
            // rather than trusting the comment above it.
            const lock = readJson('package-lock.json');
            const hidden = Object.keys(lock.packages ?? {}).filter((p) =>
                p.startsWith(BUNDLED_TREE_PREFIX),
            );
            expect(Array.isArray(hidden)).toBe(true);
        });
    });

    describe('E. an inert note names the floor the override ACTUALLY has', () => {
        // ─── The failure this catches, which has already happened ────
        //
        // `currentlyInert` exists so an override that rewrites nothing
        // is a DECLARED state rather than an accident. Check C keeps
        // the declaration honest in both directions — inert-but-biting
        // fails, biting-but-undeclared fails. What neither check reads
        // is the note's PROSE, and the prose carries a load-bearing
        // number: the floor that re-applies if the package returns.
        //
        // `hono`'s note said "the 4.12.27 floor" from the day it was
        // written (#1779, 2026-08-03). #1784 raised the spec to
        // ^4.12.34 the NEXT day and left the sentence behind, and it
        // stayed wrong for 38 days — through a scheduled freshness
        // report naming hono as floor-vulnerable, and through an issue
        // filed to delete the override on the strength of it. Nothing
        // was red, because every existing check reads the SPEC or the
        // registry FACTS, and the one field describing the spec in
        // words was outside all of them. That is the same
        // note-goes-stale decay `currentlyInert` was invented to
        // prevent, one level up, in the field that prevents it.
        //
        // ─── Why the check is scoped to floor SENTENCES ─────────────
        //
        // "Every version the note mentions must equal the floor" is
        // wrong, and `tar` is the counter-example that proves it: its
        // note correctly states that npm's bundle "carries tar
        // 7.5.19" — a true fact about a version BELOW the 7.5.21
        // floor, and the whole reason the override cannot bite. A rule
        // that reddened on it would push someone to delete a real
        // measurement to satisfy a schema, which is the failure this
        // registry exists to stop.
        //
        // So the unit is the sentence and the trigger word is `floor`.
        // A sentence that talks about the floor AND names versions is
        // making a claim about the spec; the note must then name the
        // spec's real floor in at least one such sentence. History
        // prose is unharmed — a note may narrate "4.12.27 -> 4.12.34
        // -> 4.13.5" as long as the number the override actually has
        // is among the ones it claims. What fails is the case that bit
        // us: the only floor the note names is one the override no
        // longer has.
        //
        // ─── Why "pin" is NOT a trigger word ────────────────────────
        //
        // Measured, not assumed: `tar`'s note says "bumping the `npm`
        // pin to ^11.18.0", a sentence naming two versions, neither of
        // them tar's floor. Adding `pin` to the trigger set would
        // redden a correct note. `floor` is the word this repo uses
        // for the thing being checked, so it is the only trigger.

        /**
         * The inert overrides today, pinned by EXACT equality rather
         * than a `>=` count. A count floor lets one entry go inert
         * while another stops being inert and reports green; and an
         * empty selection — `currentlyInert` renamed, or the last
         * inert override gone — would make every assertion below
         * iterate zero times. Both are the vacuous pass this list
         * refuses. Read these values off the failure message, never
         * compute them.
         */
        const INERT_OVERRIDES_TODAY = ['@hono/node-server', 'hono', 'tar'];

        /**
         * Of those, the ones whose note makes a VERSIONED floor claim
         * — i.e. the subjects the per-claim assertions below are
         * generated from. `tar` is deliberately absent: its note uses
         * the word `floor` with no version beside it.
         */
        const FLOOR_CLAIMING_NOTES_TODAY = ['@hono/node-server', 'hono'];

        /** Sentence boundary — `7.5.19.` splits, `7.5.19` does not. */
        const SENTENCES = /(?<=[.!?])\s+/;
        const VERSION = /\d+\.\d+\.\d+/g;

        const inertOverrides = overrides
            .map((o) => ({ o, entry: OVERRIDE_REGISTRY[o.name] }))
            .filter(({ entry }) => typeof entry?.currentlyInert === 'string');

        /** Specs whose floor cannot be read — reported, never skipped. */
        const unreadableSpec: string[] = [];
        /** One entry per inert note that makes a versioned floor claim. */
        const floorClaims: Array<{
            override: string;
            actualFloor: string;
            claimed: string[];
        }> = [];

        for (const { o, entry } of inertOverrides) {
            const floor = parseVersion(o.spec.replace(/^[\^~]/, ''));
            if (!floor) {
                // A conjunction range or a dangling `$ref` has no
                // single floor. Silently dropping it is how a detector
                // reports full coverage of the subset it happens to
                // understand — the defect one level up.
                unreadableSpec.push(`${o.key} -> ${o.spec}`);
                continue;
            }
            const claimed = new Set<string>();
            for (const sentence of entry!.currentlyInert!.split(SENTENCES)) {
                if (!/\bfloors?\b/i.test(sentence)) continue;
                for (const v of sentence.match(VERSION) ?? []) claimed.add(v);
            }
            if (claimed.size === 0) continue;
            floorClaims.push({
                override: o.key,
                actualFloor: floor.join('.'),
                claimed: [...claimed],
            });
        }

        it('has inert overrides to examine (an empty selection is not a pass)', () => {
            expect(inertOverrides.map(({ o }) => o.key).sort()).toEqual(
                INERT_OVERRIDES_TODAY,
            );
        });

        it('every inert override has a readable floor', () => {
            expect(unreadableSpec).toEqual([]);
        });

        it('the notes making a versioned floor claim are the expected ones', () => {
            // The per-claim assertions are generated from this list. If
            // it empties — the prose reworded to avoid the word
            // `floor`, or the versions dropped out of it — the `for`
            // below emits no `it` at all and the suite still passes.
            // This is the assertion that refuses that outcome.
            expect(floorClaims.map((c) => c.override).sort()).toEqual(
                FLOOR_CLAIMING_NOTES_TODAY,
            );
        });

        for (const claim of floorClaims) {
            it(`${claim.override}: currentlyInert names the ${claim.actualFloor} floor its spec actually has`, () => {
                expect({
                    override: claim.override,
                    claimed: claim.claimed,
                    namesTheActualFloor: claim.claimed.includes(claim.actualFloor),
                }).toEqual({
                    override: claim.override,
                    claimed: claim.claimed,
                    namesTheActualFloor: true,
                });
            });
        }
    });

    describe('comparator sanity', () => {
        // Every assertion above is only as trustworthy as `satisfies`.
        // A comparator that returned `true` unconditionally would make
        // the entire suite vacuous, so pin its behaviour explicitly.
        it('handles caret ranges', () => {
            expect(satisfies('4.12.31', '^4.12.27')).toBe(true);
            expect(satisfies('4.12.25', '^4.12.27')).toBe(false);
            expect(satisfies('5.0.0', '^4.12.27')).toBe(false);
            expect(satisfies('4.13.0', '^4.12.27')).toBe(true);
        });

        it('handles npm 0.x caret semantics', () => {
            expect(satisfies('0.2.7', '^0.2.6')).toBe(true);
            expect(satisfies('0.3.0', '^0.2.6')).toBe(false);
        });

        it('handles conjunction ranges', () => {
            expect(satisfies('5.0.6', '>=3.0.0 <=5.0.6')).toBe(true);
            expect(satisfies('5.0.7', '>=3.0.0 <=5.0.6')).toBe(false);
            expect(satisfies('2.1.2', '>=3.0.0 <=5.0.6')).toBe(false);
        });

        it('refuses ranges it does not understand instead of passing them', () => {
            // The dangerous failure is a silent `true`.
            expect(() => satisfies('1.0.0', '~1.0.0 || >=2')).toThrow();
        });
    });
});
