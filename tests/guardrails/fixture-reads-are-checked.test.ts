/**
 * A fixture read asserts its shape instead of casting it.
 *
 * ═══ THE CLASS ═══
 *
 *     const rows = require('./fixtures/x.json') as Array<{ … }>;
 *
 * A cast is a claim the compiler stops checking. Change the fixture's
 * top-level shape and the cast still compiles; the failure arrives later,
 * elsewhere, as something else.
 *
 * It cost three diagnoses on 2026-09-05, and every one pointed away from the
 * cause. `soc2-control-templates.json` became a CatalogFile and `for...of`
 * threw forty lines into the seed — which died, reported success, and failed CI
 * on E2E specs for ISO 27001 and AI governance. Then the same for four more
 * fixtures. Then a too-broad rename made `title` undefined in twelve unrelated
 * loops, and the seed died again with the same misattribution.
 *
 * ═══ WHAT COUNTS AS CHECKED ═══
 *
 * `fixtureArray` / `fixtureObject` from prisma/fixture-io.ts, or a real schema
 * (`loadAndValidateCatalogFile`, `loadAuthoredControlTasks`). `as unknown` also
 * counts: it asserts NOTHING, so the value must be narrowed before use — which
 * is the safe form, not the bug.
 *
 * ═══ THE BASELINE IS EMPTY ═══
 *
 * It held `prisma/seed.ts: 38` — deliberately, while that file was under
 * concurrent change, because a 38-site edit across a moving target is exactly
 * how the third incident happened. Those landed once it settled, and every
 * fixture read in `prisma/` and `scripts/` now checks its shape.
 *
 * Kept as an empty record rather than deleted, because the assertions below are
 * what stop the next one. Adding an entry here to silence a failure is the one
 * move this file exists to prevent: `fixtureArray` and `fixtureObject` are a
 * single call and give a located error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/** `require('…fixtures/x.json') as T` where T is not `unknown`. */
const UNCHECKED = /require\(\s*['"][^'"]*fixtures\/[^'"]+\.json['"]\s*\)\s*as\s+(?!unknown\b)/g;

/**
 * Unconverted reads, by file. Shrink this; do not grow it.
 *
 * A NEW fixture read has no reason to be here — `fixtureArray` and
 * `fixtureObject` are one call and give a located error.
 */
const KNOWN_UNCHECKED: Record<string, number> = {};

/** Files the scan examined — the denominator, asserted below. */
const scanned: string[] = [];

function uncheckedReads(): Map<string, number> {
    const found = new Map<string, number>();
    for (const rel of repoRelativeFiles()) {
        if (!/^(prisma|scripts)\/.*\.(ts|mjs)$/.test(rel)) continue;
        let src: string;
        try {
            src = codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        } catch {
            continue;
        }
        scanned.push(rel);
        const n = [...src.matchAll(UNCHECKED)].length;
        if (n > 0) found.set(rel, n);
    }
    return found;
}

describe('fixture reads assert their shape', () => {
    const found = uncheckedReads();

    it('the scan actually reads the seeders (not vacuous)', () => {
        // Every assertion below passes on an empty scan, which is the shape of
        // the bug one level up: a check that examines nothing reports nothing
        // wrong.
        //
        // This used to assert that `prisma/seed.ts` APPEARED in the findings,
        // which worked only while it still carried casts. Now that it does not,
        // the denominator has to be pinned instead: the files the scan
        // examined, not the offences it found.
        expect(scanned).toContain('prisma/seed.ts');
        expect(scanned.length).toBeGreaterThanOrEqual(6);
    });

    it('no file outside the recorded baseline casts a fixture read', () => {
        const unexpected = [...found.entries()]
            .filter(([rel]) => !(rel in KNOWN_UNCHECKED))
            .map(([rel, n]) => `${rel} (${n})`);
        expect(unexpected).toEqual([]);
    });

    it('the recorded files have not grown', () => {
        const grown = [...found.entries()]
            .filter(([rel, n]) => rel in KNOWN_UNCHECKED && n > KNOWN_UNCHECKED[rel]!)
            .map(([rel, n]) => `${rel}: ${n} > ${KNOWN_UNCHECKED[rel]}`);
        expect(grown).toEqual([]);
    });

    it('no baseline entry is stale — a cleared file leaves the list', () => {
        // An entry for a file that no longer casts is a lie that makes the debt
        // look larger than it is, and hides the next regression inside slack.
        const stale = Object.keys(KNOWN_UNCHECKED).filter((rel) => (found.get(rel) ?? 0) === 0);
        expect(stale).toEqual([]);
    });
});
