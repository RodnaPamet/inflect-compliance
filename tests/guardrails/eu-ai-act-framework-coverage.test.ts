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
import { appliedCatalogFor, appliedCatalogueStats, declaringSources, productionDeclaringSources } from '../helpers/applied-catalogue';
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
     * This block asserted what `prisma/seed.ts` built, and was right to: the
     * framework was inline there and reached no production database. It carried
     * a case named "DELIVERY RATCHET ... flip this on conversion", written to
     * be true THEN and to fail the day a production seeder picked the framework
     * up. This is that flip.
     *
     * Same facts, asserted against the CatalogFile production applies — field
     * reads on structured data rather than regexes over a file production never
     * runs.
     */
    const catalog = appliedCatalogFor('EU-AI-ACT');

    it('a production seeder applies a EU AI Act catalogue at all', () => {
        // DENOMINATOR: every case below is vacuous on null.
        expect(catalog).not.toBeNull();
        expect(catalog?.requirements.length).toBeGreaterThanOrEqual(15);
        expect(catalog?.templates.length).toBeGreaterThanOrEqual(5);
    });

    it('declares the framework as EU-AI-ACT 2024, kind REGULATION', () => {
        expect(catalog?.framework.key).toBe('EU-AI-ACT');
        expect(catalog?.framework.version).toBe('2024');
        expect(catalog?.framework.kind).toBe('REGULATION');
    });

    it('carries the provenance the licensing depends on', () => {
        const meta = (catalog?.framework.metadata ?? {}) as Record<string, unknown>;
        expect(meta.provider).toBe('European Union');
        expect(String(meta.copyright).length).toBeGreaterThan(40);
        expect(catalog?.framework.sourceUrn).toBe('urn:inflect:library:eu-ai-act');
    });

    it('declares the EU_AI_ACT_BASELINE pack over its own templates', () => {
        expect(catalog?.pack?.key).toBe('EU_AI_ACT_BASELINE');
        const codes = new Set((catalog?.templates ?? []).map((t) => String(t.code)));
        const packCodes = (catalog?.pack?.templateCodes ?? []) as string[];
        expect(packCodes.length).toBeGreaterThan(0);
        expect(packCodes.filter((c) => !codes.has(c))).toEqual([]);
    });

    it('every template resolves its requirement codes', () => {
        const declared = new Set((catalog?.requirements ?? []).map((r) => String(r.code)));
        const dangling: string[] = [];
        for (const t of catalog?.templates ?? []) {
            const codes = (t.requirementCodes ?? []) as string[];
            if (!codes.length) dangling.push(`${String(t.code)}: no requirementCodes`);
            for (const c of codes) if (!declared.has(c)) dangling.push(`${String(t.code)} -> ${c}`);
        }
        expect(dangling).toEqual([]);
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
