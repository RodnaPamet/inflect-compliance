/**
 * Security-exemption tripwire — GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq.
 *
 * Both advisories are denial-of-service bugs in `image-size` parsers (ICNS,
 * JXL/HEIF) for which no patched release exists: the range is `<= 2.0.2` and
 * 2.0.2 is the newest published version. They are allowlisted in
 * `security/audit-allowlist.json` on the ground that the parsers are
 * unreachable. This test is what makes that ground checkable.
 *
 * The reachability argument is NOT "we never call addImage()". It is stronger
 * and does not depend on our call sites: pptxgenjs@4.0.1 declares `image-size`
 * as a dependency but never loads it. Its only sizing call site
 * (`getSizeFromImage`) ships inside a block comment marked "currently unused",
 * and even that dead code requires the string 'sizeof' — a different, uninstalled
 * package. The string `image-size` appears in none of the shipped bundles.
 *
 * Why this test and not the audit gate: `scripts/audit-gate.mjs` re-checks
 * whether the ADVISORY still applies, never whether the REACHABILITY claim
 * still holds. `pptxgenjs` is declared `^4.0.1`, so a minor bump could wire the
 * dependency up for real, and the gate would stay green while the written
 * justification silently became false. That is the regression this catches.
 *
 * If this fails: the exemption is void. Re-argue it or remove it — do NOT add
 * an `overrides` entry pinning image-size 2.x (futile, since 2.0.2 is itself in
 * range, and breaking, since v2 stopped exporting a callable).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Resolve the package ROOT from its main entry. `pptxgenjs` ships an
// `exports` map with no `./package.json` key, so it cannot be required
// directly — walk up from the resolved entry instead.
const pkgDir = dirname(dirname(require.resolve('pptxgenjs')));
const pkgPath = resolve(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    main?: string;
    module?: string;
    dependencies?: Record<string, string>;
};

/**
 * The entry points pptxgenjs actually ships, read from its own package.json
 * rather than hardcoded — a future version that renames or adds a bundle is
 * followed automatically instead of silently escaping the check.
 */
const entryPoints = [pkg.main, pkg.module].filter((p): p is string => typeof p === 'string');

/**
 * EVERY shipped `.js`, not just the two the `exports` map names.
 *
 * `main`/`module`/`exports` currently point only at dist/pptxgen.cjs.js and
 * dist/pptxgen.es.js, while the package also ships pptxgen.bundle.js and
 * pptxgen.min.js. Those two are browser builds outside the export map, so Node
 * cannot load them today — but a scan whose denominator is the export map
 * checks what upstream currently chooses to expose, and the claim being
 * guarded is about the package as a whole. Scanning the directory costs
 * nothing and does not depend on that choice staying the same.
 */
function shippedJsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return shippedJsFiles(full);
        return e.isFile() && e.name.endsWith('.js') ? [full] : [];
    });
}

const shipped = shippedJsFiles(pkgDir);

describe('image-size is unreachable through pptxgenjs (audit exemption basis)', () => {
    it('declares image-size as a dependency — the exemption is about a real edge', () => {
        // Sanity: if this ever fails, upstream dropped the dep and the
        // exemption in security/audit-allowlist.json should be deleted.
        expect(Object.keys(pkg.dependencies ?? {})).toContain('image-size');
    });

    it('never references image-size in any shipped JavaScript', () => {
        // Guards both denominators first: an empty list would make the
        // assertions below vacuously pass, which is the shape of the original
        // bug this whole exemption sits next to.
        expect(entryPoints.length).toBeGreaterThan(0);
        expect(shipped.length).toBeGreaterThanOrEqual(entryPoints.length);

        // Asserting on the computed offender list rather than on each file's
        // contents keeps the failure message specific (it names the offending
        // bundle) and keeps a whole-file read out of the assertion subject.
        const offenders = shipped
            .filter((file) => readFileSync(file, 'utf8').includes('image-size'))
            .map((file) => file.slice(pkgDir.length + 1));
        expect(offenders).toEqual([]);
    });
});
