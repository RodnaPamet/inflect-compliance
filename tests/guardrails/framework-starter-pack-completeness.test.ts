/**
 * Framework starter-pack completeness ratchet (generalized).
 *
 * A framework that ships as library CONTENT but has no starter pack installs to
 * a bare 0% coverage baseline — every requirement unmapped, no controls, no
 * tasks. That is a poor day-one experience and, worse, silent: nothing fails
 * when a new framework lands without controls.
 *
 * This guard enforces the invariant across EVERY production framework in the
 * library: each library framework is EITHER
 *   (a) backed by a seed starter/baseline pack — its seed Framework `key` and
 *       FrameworkPack key are wired in seed.ts (control templates linked to the
 *       framework's requirements); OR
 *   (b) explicitly listed in BARE_FRAMEWORKS with a written reason.
 *
 * A new framework library file that is neither wired nor allow-listed fails
 * CI — the author must add a starter pack or justify the bare framework. Both
 * maps carry a "no stale entries" check so a removed framework can't leave a
 * dangling registry entry.
 *
 * See ssdf-starter-pack-coverage.test.ts + the per-framework coverage ratchets
 * for the deep per-pack assertions (control counts, requirement links, etc.).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

import { codeOf } from '../helpers/source-blocks';
import { declaringSources, appliedCatalogueStats } from '../helpers/applied-catalogue';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const seed = read('prisma/seed.ts');

/**
 * Where a framework's keys may legitimately live.
 *
 * They used to have to be in `prisma/seed.ts`, and that was a question about
 * the IMPLEMENTATION rather than the outcome: seed.ts is not run on production
 * deploys, so a key appearing there proved a framework reached DEV and said
 * nothing about whether a customer ever sees it. DORA was the first framework
 * to move onto the shared `applyCatalogFile` writer, and this check read that
 * as a regression while the change was making DORA reach production for the
 * first time.
 *
 * So the question is now "is this framework declared somewhere a writer will
 * apply it?", and a CatalogFile wired into CATALOG_FIXTURES is the stronger
 * answer of the two — that list is what `scripts/entrypoint.sh` runs.
 */
// Both arms now come from tests/helpers/applied-catalogue.ts. This file and
// tests/integration/framework-coverage.test.ts each had their own copy of the
// discovery, and BOTH swallowed read errors with `catch { return '' }` — so a
// renamed fixture would have emptied the catalogue arm and left every
// assertion below passing against seed.ts alone. The helper throws instead.
/** Does any applied source declare this key? */
const declaredSomewhere = (key: string): boolean => declaringSources(key).length > 0;

/** Library framework ref_id → seed wiring proof (framework key + pack key). */
const STARTER_PACKS: Record<string, { frameworkKey: string; packKey: string }> = {
    'ISO27001-2022': { frameworkKey: 'ISO27001', packKey: 'ISO27001_2022_BASE' },
    'ISO42001-2023': { frameworkKey: 'ISO42001', packKey: 'ISO42001_BASELINE' },
    'NIS2-2022': { frameworkKey: 'NIS2', packKey: 'NIS2_BASELINE' },
    'DORA-2022': { frameworkKey: 'DORA', packKey: 'DORA_BASELINE' },
    'EU-AI-ACT-2024': { frameworkKey: 'EU-AI-ACT', packKey: 'EU_AI_ACT_BASELINE' },
    'NIST-PF-1.0': { frameworkKey: 'NIST-PRIVACY', packKey: 'NIST_PRIVACY_BASELINE' },
    'NIST-SSDF-800-218': { frameworkKey: 'NIST-SSDF', packKey: 'SSDF_CORE' },
    'AISVS-1.0': { frameworkKey: 'OWASP-AISVS', packKey: 'AISVS_BASELINE' },
    'ISO27701-2019': { frameworkKey: 'ISO27701', packKey: 'ISO27701_CORE' },
    'CIS-CONTROLS-V8': { frameworkKey: 'CIS-V8', packKey: 'CIS_V8_IG1' },
    'OWASP-ASVS-4.0.3': { frameworkKey: 'OWASP-ASVS', packKey: 'ASVS_L1' },
    'SOC2-2017': { frameworkKey: 'SOC2', packKey: 'SOC2_BASELINE' },
    'OWASP-ASI-TOP10': { frameworkKey: 'OWASP-ASI', packKey: 'OWASP_ASI_BASELINE' },
    'IMDA-MGF-2026': { frameworkKey: 'IMDA-MGF', packKey: 'IMDA_MGF_BASELINE' },
};

/** Library frameworks intentionally shipped WITHOUT a starter pack. */
const BARE_FRAMEWORKS: Record<string, string> = {
    'NIST-CSF-2.0':
        'Reference/companion framework — cloned as the structural template for ' +
        'NIST-PF and NIST-SSDF. Ships as library content only (no seed FrameworkPack ' +
        'or control templates); adopters use the derived frameworks, not CSF directly.',
    'GDPR':
        'Regulatory-reference framework: mapping target, not a control catalogue. ' +
        'GDPR articles are the obligations that ISO 27701 and other controls map ' +
        'TO (via mappings/iso27701-to-gdpr.yaml); the framework carries no control ' +
        'templates by design, so it ships without a starter pack.',
};

/** Every framework ref_id discovered in the library directory. */
function libraryFrameworkRefIds(): string[] {
    const refIds: string[] = [];
    for (const file of fs.readdirSync(LIB_DIR)) {
        if (!file.endsWith('.yaml')) continue;
        const lib = loadLibrary(parseLibraryFile(path.join(LIB_DIR, file)), file);
        refIds.push(lib.refId);
    }
    return refIds;
}

describe('Framework starter-pack completeness', () => {
    const refIds = libraryFrameworkRefIds();

    it('discovers the known library frameworks', () => {
        // Sanity floor: if this drops, the discovery glob broke.
        expect(refIds.length).toBeGreaterThanOrEqual(10);
    });

    it('every library framework is EITHER wired to a starter pack OR allow-listed bare', () => {
        const unaccounted = refIds.filter(
            (r) => !(r in STARTER_PACKS) && !(r in BARE_FRAMEWORKS),
        );
        expect(unaccounted).toEqual([]);
    });

    it('no framework is in both registries', () => {
        const both = Object.keys(STARTER_PACKS).filter((r) => r in BARE_FRAMEWORKS);
        expect(both).toEqual([]);
    });

    it('the applied-catalogue scan found real sources (denominator)', () => {
        // declaredSomewhere falls back to the seed.ts arm, so a broken scan
        // would leave every assertion below passing on the weaker source —
        // silently reverting this check to the implementation question it used
        // to ask. applied-catalogue-helper.test.ts pins the corpus in detail;
        // this is the local restatement, so a caller cannot be read in
        // isolation and believed.
        expect(appliedCatalogueStats().bytes).toBeGreaterThan(1_000_000);
    });

    it('every starter-pack entry declares its framework + pack keys somewhere applied', () => {
        const missing: string[] = [];
        for (const [refId, { frameworkKey, packKey }] of Object.entries(STARTER_PACKS)) {
            if (!declaredSomewhere(frameworkKey)) missing.push(`${refId}: framework key ${frameworkKey}`);
            if (!declaredSomewhere(packKey)) missing.push(`${refId}: pack key ${packKey}`);
        }
        expect(missing).toEqual([]);
    });

    it('every BARE_FRAMEWORKS entry carries a substantive written reason', () => {
        for (const [refId, reason] of Object.entries(BARE_FRAMEWORKS)) {
            expect(refId).toBeTruthy();
            expect(reason.length).toBeGreaterThan(40);
        }
    });

    it('no stale registry entries — every registered ref_id still exists in the library', () => {
        const live = new Set(refIds);
        const stalePacks = Object.keys(STARTER_PACKS).filter((r) => !live.has(r));
        const staleBare = Object.keys(BARE_FRAMEWORKS).filter((r) => !live.has(r));
        expect({ stalePacks, staleBare }).toEqual({ stalePacks: [], staleBare: [] });
    });
});
