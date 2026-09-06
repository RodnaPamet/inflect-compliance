/**
 * EU AI Act (Regulation (EU) 2024/1689) framework-content coverage ratchet.
 *
 * The EU AI Act ships as framework CONTENT on IC's data-driven library
 * machinery (no new code paths). This guard locks:
 *   - eu-ai-act.yaml exists + validates against the library schema (REGULATION);
 *   - the framework encodes the RISK-TIER structure (prohibited / high-risk /
 *     limited / GPAI / minimal) as grouping nodes;
 *   - the key obligation articles are present (Art.5; Art.9-15; Art.50; GPAI);
 *   - LICENSE: the AI Act is EU legislation (public domain) — the copyright
 *     field says so and points at EUR-Lex (article text is permitted here, unlike
 *     AISVS/ISO 42001);
 *   - the NOT-LEGAL-ADVICE boundary is carried (tier classification is a tenant
 *     decision);
 *   - the seed fixture codes match the library assessable ref_ids (in sync);
 *   - DELIVERY: which sources actually APPLY the framework. Today that is
 *     `prisma/seed.ts` alone, which no deploy runs — so production has no
 *     EU AI Act framework or pack. That is asserted as the current state,
 *     not papered over; see the docblock on the delivery describe;
 *   - the framework rides the GENERIC install machinery (no special-casing).
 *
 * Crosswalks are locked separately by the bundle ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import {
    appliedCatalogFor,
    appliedCatalogueStats,
    declaringSources,
    productionDeclaringSources,
} from '../helpers/applied-catalogue';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a comment naming a symbol
// cannot satisfy (nor a commented-out mention violate) an assertion about
// code. YAML / JSON stay raw — `//` there is content (URLs), not a comment.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};
const LIB = 'src/data/libraries';

const act = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'eu-ai-act.yaml')), 'euaiact');

const TIERS = ['Tier.Prohibited', 'Tier.HighRisk', 'Tier.Limited', 'Tier.GPAI', 'Tier.Minimal'];

describe('EU AI Act library — eu-ai-act.yaml', () => {
    it('validates against the library schema as a REGULATION', () => {
        expect(act.refId).toBe('EU-AI-ACT-2024');
        expect(act.kind).toBe('REGULATION');
        expect(act.version).toBeGreaterThanOrEqual(1);
    });

    it('encodes the five AI Act risk tiers as grouping nodes', () => {
        for (const t of TIERS) {
            const node = act.framework.nodesByRefId.get(t);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
        // Every assessable obligation hangs off a tier.
        for (const n of act.framework.nodes.filter((x) => x.assessable)) {
            expect(n.parentUrn).toBeDefined();
        }
    });

    it('includes the key obligation articles', () => {
        for (const ref of [
            'Art.5', 'Art.9', 'Art.10', 'Art.11', 'Art.12', 'Art.13', 'Art.14',
            'Art.15', 'Art.16', 'Art.26', 'Art.27', 'Art.50', 'Art.53', 'Art.55',
        ]) {
            expect(act.framework.nodesByRefId.get(ref)).toBeDefined();
        }
        expect(act.framework.nodes.filter((n) => n.assessable).length).toBeGreaterThanOrEqual(14);
    });

    it('marks the public-domain license + EUR-Lex source (article text permitted)', () => {
        const yaml = read(`${LIB}/eu-ai-act.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock).toMatch(/public domain/i);
        expect(copyrightBlock).toMatch(/eur-lex\.europa\.eu/i);
    });

    it('carries the not-legal-advice boundary', () => {
        const yaml = read(`${LIB}/eu-ai-act.yaml`);
        expect(yaml).toMatch(/not legal advice/i);
        expect(yaml).toMatch(/tenant.*(decision|counsel)|counsel/i);
    });
});

describe('EU AI Act seed fixture', () => {
    const fixture = JSON.parse(read('prisma/fixtures/eu_ai_act_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + article key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(14);
        for (const r of fixture) {
            expect(r.key).toMatch(/^Art\.\d+$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            act.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });

    it('all five risk tiers appear as fixture sections', () => {
        expect(new Set(fixture.map((r) => r.section)).size).toBe(5);
    });
});

describe('EU AI Act delivery', () => {
    /**
     * ═══ WHAT WAS WRONG ═══
     *
     * This block used to be headed "seed wiring (seed.ts)" and decided whether
     * the EU AI Act was AVAILABLE by grepping `prisma/seed.ts` for the string
     * `'EU_AI_ACT_BASELINE'`. `prisma/seed.ts` is not run on a production
     * deploy, so that assertion could not fail while the thing it named was
     * undeliverable — which is precisely the state the AI Act is in. No
     * production seeder applies an EU AI Act catalogue (`entrypoint.sh` runs
     * five seeders; the seven catalogue fixtures between them are soc2, ssdf,
     * cis-v8-ig1, asvs-l1, iso27701, dora and nis2), so a fresh production
     * database holds no EU-AI-ACT framework and no EU AI Act pack under any
     * key. The old assertions read as coverage of a shipped framework.
     *
     * So these cases say the true thing instead: the DEV seeder declares it,
     * production does not. The second half is a DELIVERY RATCHET — the PR that
     * gives the AI Act a CatalogFile turns it red, and the fix then is to
     * rewrite it as field reads off `appliedCatalogFor('EU-AI-ACT')`
     * (framework key / version / kind, plus the pack key PRODUCTION ships,
     * which for every framework converted so far has NOT been the `*_BASELINE`
     * name `seed.ts` builds).
     */
    const stats = appliedCatalogueStats();
    const seed = read('prisma/seed.ts');

    it('the applied-catalogue scan sees a real production corpus', () => {
        // DENOMINATOR. Every "production does not have it" case below is
        // vacuous if the scan reads nothing at all.
        expect(stats.seeders).toContain('scripts/seed-framework-catalogs.ts');
        expect(stats.fixtures.length).toBeGreaterThanOrEqual(7);
        expect(stats.bytes).toBeGreaterThan(10_000);
        // Control: a framework that IS delivered resolves through the very
        // same lookup, so the `null` asserted below means absent, not broken.
        expect(appliedCatalogFor('DORA')).not.toBeNull();
    });

    it('prisma/seed.ts — the dev-only path — declares the framework and its pack', () => {
        expect(declaringSources('EU-AI-ACT')).toContain('prisma/seed.ts');
        expect(declaringSources('EU_AI_ACT_BASELINE')).toContain('prisma/seed.ts');
    });

    it('DELIVERY RATCHET: no production seeder applies the EU AI Act (flip this on conversion)', () => {
        expect(appliedCatalogFor('EU-AI-ACT')).toBeNull();
        expect(productionDeclaringSources('EU-AI-ACT')).toEqual([]);
        expect(productionDeclaringSources('EU_AI_ACT_BASELINE')).toEqual([]);
    });

    it('the dev seeder upserts EU-AI-ACT 2024 / REGULATION off the AI Act fixture', () => {
        // Bound to the declarations, not to the whole 3,000-line file: a bare
        // `toMatch(/kind:\s*'REGULATION'/)` over all of seed.ts is satisfied by
        // DORA's block, and a span between two anchors re-forms across it.
        expect(declarationOf(seed, 'euAiActData')).toContain('fixtures/eu_ai_act_requirements');
        const upsert = declarationOf(seed, 'euAiAct');
        expect(upsert).toMatch(/key:\s*'EU-AI-ACT'/);
        expect(upsert).toMatch(/version:\s*'2024'/);
        expect(upsert).toMatch(/kind:\s*'REGULATION'/);
    });

    it('the dev seeder carries EU provider + public-domain + not-legal-advice metadata', () => {
        const meta = declarationOf(seed, 'euAiActMeta');
        expect(meta).toMatch(/provider:\s*'European Union'/);
        expect(meta).toMatch(/license:\s*'public-domain'/);
        expect(meta).toMatch(/notLegalAdvice:\s*true/);
        expect(meta).toMatch(/not legal advice/i);
    });
});

describe('EU AI Act rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no EU-AI-Act-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            const src = read(rel);
            expect(src).not.toMatch(/EU-AI-ACT|eu-ai-act/i);
        }
    });
});
