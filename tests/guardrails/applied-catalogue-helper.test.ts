/**
 * The applied-catalogue helper sees what it claims to see.
 *
 * ═══ WHY A GUARD FOR A TEST HELPER ═══
 *
 * `tests/helpers/applied-catalogue.ts` is about to become the denominator for
 * ~120 assertions that currently ask whether `prisma/seed.ts` CONTAINS a
 * string. Those assertions are wrong in a specific way — seed.ts is not run on
 * production deploys, so they cannot fail while the thing they name is
 * undeliverable — and the helper is what lets them ask the right question
 * instead.
 *
 * Which makes the helper a single point of silent failure for the whole sweep.
 * If its discovery stops matching, every caller falls back to the seed.ts arm,
 * every assertion still passes, and 120 guards quietly revert to the question
 * they were supposed to stop asking. Nothing in the callers would notice: they
 * assert on the RESULT, and a smaller corpus produces the same result for
 * anything seed.ts happens to declare.
 *
 * So the corpus is asserted here, once, in the terms the sweep depends on.
 * This is the same lesson the sweep itself is about, applied to the tool doing
 * the sweeping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';
import {
    appliedCatalogueStats,
    appliedSources,
    declaringSources,
    productionDeclaringSources,
    productionSeeders,
} from '../helpers/applied-catalogue';

describe('the applied-catalogue helper', () => {
    const stats = appliedCatalogueStats();

    it('discovers every seeder scripts/entrypoint.sh runs', () => {
        // Derived from the `node dist/<name>.mjs` lines, never listed here —
        // a list would be one more copy to rot. Five today; the floor moves
        // only when the entrypoint gains or loses a seeder.
        expect(stats.seeders.length).toBeGreaterThanOrEqual(5);
        for (const s of stats.seeders) {
            expect(fs.existsSync(path.join(REPO_ROOT, s))).toBe(true);
        }
    });

    it('discovers the fixtures those seeders name', () => {
        // 17 today across the five. The floor is what stops a regex that
        // stops matching from reading as "production applies nothing".
        expect(stats.fixtures.length).toBeGreaterThanOrEqual(15);
        expect(stats.bytes).toBeGreaterThan(1_000_000);
    });

    it('carries both arms, and distinguishes them', () => {
        // Merging the two would lose the only fact that matters: seed.ts
        // reaches dev and nothing else.
        const sources = appliedSources();
        const dev = sources.filter((s) => !s.reachesProduction);
        const prod = sources.filter((s) => s.reachesProduction);
        expect(dev.map((s) => s.file)).toEqual(['prisma/seed.ts']);
        expect(prod.length).toBeGreaterThanOrEqual(20);
    });

    it('throws rather than returning empty when a source cannot be read', () => {
        // The hole in both ad-hoc predecessors was `catch { return '' }`.
        // A silent empty arm makes every caller fall back to seed.ts and pass,
        // which is the entire failure mode this helper exists to close.
        // Bound to `read`, the one function that touches the filesystem,
        // rather than read against the whole module: a needle satisfied
        // anywhere in the file would keep this green while the throw it names
        // was gone. codeOf strips comments first, because the helper's own
        // docblock QUOTES the bad pattern in order to explain it — a guard
        // that cannot tell discussing a defect from shipping one is the same
        // distinction no-generic-task-strings makes.
        const body = functionBodyOf(
            codeOf(fs.readFileSync(path.join(REPO_ROOT, 'tests/helpers/applied-catalogue.ts'), 'utf8')),
            'read',
        );
        expect(body).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*return\s*''\s*;?\s*\}/);
        expect(body).toMatch(/throw new Error\(/);
    });

    it('finds a key that only a fixture declares', () => {
        // SSDF_CORE is the pack production actually has. It appears in
        // prisma/fixtures/ssdf-control-templates.json and NOT in seed.ts,
        // which spells its own packs SSDF_STARTER_PACK / NIST_SSDF_BASELINE.
        // If this returns [], the fixture arm is not being read — the exact
        // silent failure the sweep would inherit.
        expect(declaringSources('SSDF_CORE')).not.toEqual([]);
        expect(productionDeclaringSources('SSDF_CORE')).not.toEqual([]);
    });

    it('finds a key that only seed.ts declares, and does not call it production', () => {
        // The mirror case, and the one that makes the sweep worth doing:
        // SSDF_STARTER_PACK is declared by seed.ts alone, so it reaches dev
        // and no customer. The helper must say both halves of that.
        expect(declaringSources('SSDF_STARTER_PACK')).toEqual(['prisma/seed.ts']);
        expect(productionDeclaringSources('SSDF_STARTER_PACK')).toEqual([]);
    });

    it('returns nothing for a key nothing declares', () => {
        // Without this the two assertions above are satisfied by a helper that
        // returns every source for every input.
        expect(declaringSources('NO_SUCH_PACK_KEY_ANYWHERE')).toEqual([]);
    });

    it('the discovered seeders are exactly the ones entrypoint.sh runs', () => {
        // A set equality rather than a per-name substring search: it catches
        // a seeder the helper INVENTS as well as one it misses, and it states
        // the whole relationship in one assertion instead of N weaker ones.
        const entry = fs.readFileSync(path.join(REPO_ROOT, 'scripts/entrypoint.sh'), 'utf8');
        const fromEntrypoint = [
            ...new Set([...entry.matchAll(/node\s+dist\/([A-Za-z0-9._-]+)\.mjs/g)].map((m) => m[1])),
        ]
            .map((n) => `scripts/${n}.ts`)
            .filter((f) => fs.existsSync(path.join(REPO_ROOT, f)))
            .sort();
        expect(productionSeeders().slice().sort()).toEqual(fromEntrypoint);
    });
});
