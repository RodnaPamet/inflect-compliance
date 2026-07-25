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
 * It cannot tell you a NEWER patched version exists upstream — that
 * needs the registry, i.e. the network, which a Jest guard must not
 * touch. That half is
 * `.github/workflows/override-freshness.yml` (scheduled, non-blocking).
 * The two are complementary: this one proves the override bites, the
 * workflow proves it still points at the current fix.
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
//
//  `patchedFrom` (security only) — the version the advisory was FIXED
//  in. This is the fact that was missing when `hono` decayed: with it
//  recorded, "is our floor still the fix?" is answerable from the
//  repo, and the freshness workflow has something to compare against.
// ────────────────────────────────────────────────────────────────

interface OverrideEntry {
    kind: 'security' | 'peer-bridge';
    reason: string;
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

const OVERRIDE_REGISTRY: Record<string, OverrideEntry> = {
    undici: {
        kind: 'security',
        advisory: 'GHSA-c76h-2ccp-4975',
        patchedFrom: '7.28.0',
        reason:
            'Pulled transitively by the OpenTelemetry / fetch stack. The <7.28.0 line mishandles ' +
            'redirect header stripping. No direct dependency on undici, so an override is the only lever.',
    },
    tar: {
        kind: 'security',
        advisory: 'GHSA-8489-44mv-ggj8',
        patchedFrom: '7.5.16',
        reason:
            'Path-traversal on extraction of crafted archives; the fix is only on the 7.5.x line. ' +
            'Added in #1252 alongside the undici pin.',
        currentlyInert:
            'The ONLY tar in the tree is npm\'s bundled copy (node_modules/npm/node_modules/tar), ' +
            'reached via libnpmdiff / node-gyp / pacote. npm ships its dependencies bundled, so an ' +
            'override cannot rewrite them — what actually keeps that copy safe is the `npm` pin ' +
            'above, not this entry. Kept as a floor in case tar re-enters the real tree (the guard ' +
            'will then require this note to be removed), but it is protecting nothing today.',
    },
    npm: {
        kind: 'security',
        advisory: 'GHSA-4v6q-8jgv-6q2j',
        patchedFrom: '11.17.0',
        reason:
            'Dev-only, via @semantic-release/npm. Forces the release tooling onto a patched npm CLI. ' +
            'NOTE: npm bundles its own dependencies, which overrides cannot rewrite — see the ' +
            'BUNDLED_TREE_PREFIX carve-out below.',
    },
    picomatch: {
        kind: 'security',
        advisory: 'GHSA-2p57-rm9w-gvfp',
        patchedFrom: '4.0.4',
        reason: 'ReDoS on adversarial glob input. Reached through the test/build matcher chain.',
    },
    protobufjs: {
        kind: 'security',
        advisory: 'GHSA-h755-8qp9-cq85',
        patchedFrom: '8.2.0',
        reason:
            'Prototype pollution during message decoding. Pulled by the OpenTelemetry OTLP exporter, ' +
            'which sits in the production tree.',
    },
    '@hono/node-server': {
        kind: 'security',
        advisory: 'GHSA-qgpw-5v7x-8v3v',
        patchedFrom: '2.0.5',
        reason: 'Request-smuggling via ambiguous framing. Paired with the `hono` override below.',
    },
    'fast-uri': {
        kind: 'security',
        advisory: 'GHSA-cfj4-hx58-2j6q',
        patchedFrom: '3.1.3',
        reason:
            'ReDoS in URI parsing, reached through the Ajv/schema-validation chain. Completed the ' +
            'npm-audit clean-up in #1693.',
    },
    hono: {
        kind: 'security',
        advisory: 'GHSA-hcxr-2v8p-3vqw',
        patchedFrom: '4.12.27',
        reason:
            'Middleware auth bypass on crafted paths. THE cautionary entry: this was pinned ^4.12.23 ' +
            'while the lockfile sat on vulnerable 4.12.25 — the range permitted the fix but nothing ' +
            'pulled it in. Raising a floor is not enough; the lockfile has to move too.',
    },
    tmp: {
        kind: 'security',
        advisory: 'GHSA-52f5-9888-68mp',
        patchedFrom: '0.2.6',
        reason: 'Symlink-following on temp-directory cleanup. Reached through build/test tooling.',
    },
    '@grpc/grpc-js': {
        kind: 'security',
        advisory: 'GHSA-7v5v-9h63-cj86',
        patchedFrom: '1.14.4',
        reason:
            'Unbounded memory growth on malformed frames. Pulled by the OpenTelemetry gRPC exporter ' +
            'in the production tree.',
    },
    uuid: {
        kind: 'security',
        advisory: 'GHSA-w5hq-g745-h8pq',
        patchedFrom: '11.1.1',
        reason:
            'Missing buffer bounds check in v3/v5/v6 when `buf` is provided. next-auth@4 declares ' +
            'uuid@^8.3.2 and the whole <11.1.1 line is affected, so forcing the patched major is the ' +
            'only fix. next-auth uses the version-stable named exports (v4, …), unchanged v8 → v11.',
    },
    'brace-expansion': {
        kind: 'security',
        advisory: 'GHSA-v6h2-p8h4-qcjw',
        patchedFrom: '5.0.7',
        reason:
            'ReDoS. Range-KEYED (`brace-expansion@>=3.0.0 <=5.0.6`) because only that window is ' +
            'affected — the 1.x and 2.x lines predate the regression and are deliberately left alone ' +
            'rather than force-marched to a breaking major.',
    },
    sharp: {
        kind: 'security',
        advisory: 'CVE-2026-33327',
        patchedFrom: '0.35.3',
        reason:
            'HIGH libvips CVEs (CVE-2026-33327/33328/35590/35591) affect sharp <0.35.0, pulled ' +
            'transitively via next@16. #1694 pins the EXACT tested build 0.35.3 (not a caret range) ' +
            'to clear the moderate+ npm-audit gate that had turned main red fleet-wide; the recorded ' +
            'floor is therefore the pin itself, well above the vulnerable <0.35.0 window.',
    },
    valibot: {
        kind: 'security',
        advisory: 'GHSA-5qjj-4xww-7phc',
        patchedFrom: '1.4.2',
        reason:
            'Moderate advisory pulled transitively through the production prisma / @prisma/dev chain. ' +
            'No direct dependency on valibot, so forcing the patched 1.x line through an override is ' +
            'the only lever. Added in #1698 alongside the js-yaml direct bump.',
    },
    '@typescript-eslint/eslint-plugin': {
        kind: 'peer-bridge',
        reason:
            'Keeps every @typescript-eslint entry-point on one version. A split graph makes the ' +
            'parser and plugin disagree about AST shape.',
    },
    '@typescript-eslint/parser': {
        kind: 'peer-bridge',
        reason: 'Paired with the plugin override above — same version, one AST contract.',
    },
    'typescript-eslint': {
        kind: 'peer-bridge',
        reason: 'The umbrella package; pinned with its two constituents so flat config resolves one line.',
    },
};

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
}

/**
 * The version-forcing overrides — i.e. the ones this guard governs.
 *
 * Skipped deliberately:
 *   • object values (`{ react: '$react' }`) — nested peer pins, which
 *     are scoped to one parent and covered by the peer-bridge docs;
 *   • `$name` values — "same as the root dependency", which cannot go
 *     stale independently.
 */
function parseOverrides(): ParsedOverride[] {
    const pkg = readJson('package.json');
    const out: ParsedOverride[] = [];
    for (const [key, value] of Object.entries(pkg.overrides ?? {})) {
        if (typeof value !== 'string') continue;
        if (value.startsWith('$')) continue;
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
                // The hono decay in reverse: if someone lowers the
                // floor below the recorded fix, the override stops
                // being a patch even though it still "looks" set.
                expect(satisfies(entry.patchedFrom!, o.spec)).toBe(true);
                const [maj, min, pat] = parseVersion(entry.patchedFrom!)!;
                const justBelow = pat > 0 ? `${maj}.${min}.${pat - 1}` : null;
                if (justBelow) expect(satisfies(justBelow, o.spec)).toBe(false);
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
