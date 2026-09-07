/**
 * The two seeding paths do not declare different pack keys for one framework.
 *
 * ═══ WHAT THIS FOUND ═══
 *
 * Five frameworks ship a pack under one key in development and a different key
 * in production. Verified against the live database on 2026-09-06:
 *
 *   framework    prisma/seed.ts (dev)                production
 *   SOC 2        SOC2_STARTER_PACK                   SOC2_BASELINE
 *   NIST SSDF    SSDF_STARTER_PACK                   SSDF_CORE
 *   CIS v8       CIS_V8_IG1_PACK                     CIS_V8_IG1
 *   OWASP ASVS   ASVS_L1_PACK                        ASVS_L1
 *   ISO 27701    ISO27701_BASELINE                   ISO27701_CORE
 *
 * These are different ROWS, not different labels — same templates, two keys.
 * A developer installs `SOC2_STARTER_PACK`; no customer has one.
 *
 * It matters beyond tidiness because guards elsewhere assert that
 * `prisma/seed.ts` contains a pack key as a proxy for the pack existing. Those
 * assertions name packs production does not have, so repointing them at what
 * is actually applied would make them FALSE rather than merely weak — the
 * divergence has to be visible before that sweep can be honest.
 *
 * ═══ WHICH KEY IS RIGHT ═══
 *
 * The CatalogFile's. Production holds those rows and customers have installed
 * from them; `prisma/seed.ts` is not run on deploys, so its spelling has never
 * reached anybody. Each framework's conversion deletes the dev-only key, which
 * is why this is a ratchet and not a fix-it-now list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { appliedSources } from '../helpers/applied-catalogue';

const SEED = 'prisma/seed.ts';

/**
 * Frameworks whose two writers disagree, and the key production actually has.
 *
 * A DOWNWARD RATCHET whose end state is empty. An entry leaves when that
 * framework moves onto `applyCatalogFile` and its seed.ts block goes with it.
 * Do not add one to make a test pass: a NEW divergence means a fresh database
 * and a customer database now disagree about what a pack is called.
 */
const PACK_KEY_DIVERGENCES: Record<string, { dev: string; production: string }> = {
    SOC2: { dev: 'SOC2_STARTER_PACK', production: 'SOC2_BASELINE' },
    'CIS-V8': { dev: 'CIS_V8_IG1_PACK', production: 'CIS_V8_IG1' },
    'OWASP-ASVS': { dev: 'ASVS_L1_PACK', production: 'ASVS_L1' },
    ISO27701: { dev: 'ISO27701_BASELINE', production: 'ISO27701_CORE' },
};

/** framework key -> pack key, for every CatalogFile a production seeder applies. */
function productionPacks(): Map<string, string> {
    const packs = new Map<string, string>();
    for (const s of appliedSources()) {
        if (!s.reachesProduction || !s.file.endsWith('.json')) continue;
        let doc: unknown;
        try {
            doc = JSON.parse(s.text);
        } catch {
            continue;
        }
        const obj = (doc ?? {}) as { pack?: { key?: unknown }; framework?: { key?: unknown } };
        if (typeof obj.pack?.key === 'string' && typeof obj.framework?.key === 'string') {
            packs.set(obj.framework.key, obj.pack.key);
        }
    }
    return packs;
}

describe('the two seeding paths agree on pack keys', () => {
    const seed = codeOf(fs.readFileSync(path.join(REPO_ROOT, SEED), 'utf8'));
    const prodPacks = productionPacks();

    it('the scan finds pack keys on both sides (denominator)', () => {
        // Every assertion below is satisfied by an empty scan, which would
        // report perfect agreement between two things it never read.
        expect(prodPacks.size).toBeGreaterThanOrEqual(5);
        expect([...seed.matchAll(/key: '[A-Z0-9_]*(?:PACK|BASELINE|CORE)'/g)].length).toBeGreaterThanOrEqual(8);
    });

    it('every recorded divergence is real on both sides', () => {
        // An entry naming a key nothing declares makes the list longer than
        // the debt and hides a live one behind it.
        const stale: string[] = [];
        for (const [fw, { dev, production }] of Object.entries(PACK_KEY_DIVERGENCES)) {
            if (!seed.includes(`'${dev}'`)) stale.push(`${fw}: seed.ts no longer declares ${dev}`);
            if (prodPacks.get(fw) !== production) {
                stale.push(`${fw}: no applied CatalogFile declares ${production}`);
            }
        }
        expect(stale).toEqual([]);
    });

    it('a framework seed.ts still builds knows its CatalogFile pack key', () => {
        // The forward guard, and the rule is exact: if seed.ts still creates a
        // framework that a CatalogFile also declares, then seed.ts builds that
        // framework's pack too — so it must spell the pack the same way. If it
        // does not name the CatalogFile's key at all, it is creating a SECOND
        // pack under a name of its own, which is the divergence.
        //
        // A framework seed.ts no longer creates is silent here by
        // construction: DORA and NIS2 converted, their blocks went with them,
        // and there is no second writer left to disagree.
        const unexplained: string[] = [];
        for (const [fwKey, packKey] of prodPacks) {
            // BUILDS, not mentions. A converted framework can still be NAMED
            // in seed.ts — ISO 27001's coverage-link block re-fetches it with
            // `framework.findUniqueOrThrow({ where: { key: 'ISO27001' } })`
            // now that its upsert has moved into applyCatalogFile. Reading a
            // row is not writing one, and a mention-based rule reported that
            // re-fetch as a second writer inventing a pack.
            // Split rather than span: an interior `[\s\S]{0,400}` here would
            // be Class C debt, and hiding it inside `new RegExp` would put it
            // where the span analyser cannot see it — worse than the problem.
            const seedBuildsFramework = seed
                .split('framework.upsert')
                .slice(1)
                .some((block) => block.slice(0, 400).includes(`key: '${fwKey}'`));
            if (!seedBuildsFramework) continue;
            if (seed.includes(`'${packKey}'`)) continue;
            if (PACK_KEY_DIVERGENCES[fwKey]) continue;
            unexplained.push(
                `${fwKey}: seed.ts builds the framework but never names its pack ${packKey}`,
            );
        }
        expect(unexplained).toEqual([]);
    });

    it('the divergence list is not growing', () => {
        // Four. Was five until NIST SSDF converted — its two dev-only pack
        // keys went with the seed.ts block that built them, which is what a
        // conversion is supposed to do to this list.
        expect(Object.keys(PACK_KEY_DIVERGENCES).length).toBeLessThanOrEqual(4);
    });

    it('DORA and NIS2 agree, because they have already converted', () => {
        // The end state, demonstrated rather than described: both frameworks
        // moved onto applyCatalogFile, their seed.ts blocks went with them,
        // and one key now serves both paths.
        for (const [fw, pack] of [['DORA', 'DORA_BASELINE'], ['NIS2', 'NIS2_BASELINE']]) {
            expect(prodPacks.get(fw)).toBe(pack);
            expect(PACK_KEY_DIVERGENCES[fw]).toBeUndefined();
        }
    });
});
