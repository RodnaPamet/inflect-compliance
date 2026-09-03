/**
 * DORA framework-content coverage ratchet.
 *
 * DORA (Regulation (EU) 2022/2554 — Digital Operational Resilience Act) is
 * shipped as framework CONTENT on top of Inflect's existing data-driven
 * framework-library machinery (no new code paths). This guard locks:
 *   - the dora-2022.yaml library exists + validates against the library schema;
 *   - all five DORA pillars are represented, and assessable requirement
 *     ref_ids follow the official article structure (DORA.Art.N);
 *   - the seed-fixture requirement codes match the library assessable ref_ids
 *     (the two representations stay in sync);
 *   - the seed upserts the DORA framework (key DORA, kind REGULATION) + its
 *     requirements + a DORA pack, idempotently;
 *   - the dora-to-nis2 + dora-to-iso27001 mapping sets exist and every mapped
 *     requirement resolves against the YAML libraries (no dangling refs);
 *   - DORA rides the GENERIC framework-install machinery — no DORA-specific
 *     branching in the install/catalog usecases.
 *
 * Source: the official EU regulation 2022/2554 (five-pillar structure), NOT a
 * third-party interpretation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const LIB = 'src/data/libraries';

const dora = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'dora-2022.yaml')), 'dora');

// The five DORA pillars (grouping nodes, non-assessable).
const PILLAR_REFS = ['DORA.P1', 'DORA.P2', 'DORA.P3', 'DORA.P4', 'DORA.P5'];

describe('DORA library — dora-2022.yaml', () => {
    it('validates against the library schema with REGULATION kind', () => {
        expect(dora.refId).toBe('DORA-2022');
        expect(dora.kind).toBe('REGULATION');
        expect(dora.version).toBeGreaterThanOrEqual(1);
    });

    it('represents all five DORA pillars as grouping nodes', () => {
        const pillarNodes = dora.framework.nodes.filter((n) => !n.assessable);
        const refs = pillarNodes.map((n) => n.refId).sort();
        expect(refs).toEqual([...PILLAR_REFS].sort());
        // Each pillar has at least one assessable child article.
        for (const p of PILLAR_REFS) {
            const node = dora.framework.nodesByRefId.get(p);
            expect(node).toBeDefined();
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable requirement ref_ids follow the official article structure (DORA.Art.N)', () => {
        const assessable = dora.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(20);
        for (const n of assessable) {
            expect(n.refId).toMatch(/^DORA\.Art\.\d+$/);
            // Every assessable node hangs off a pillar.
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check one anchor article per pillar exists.
        for (const ref of ['DORA.Art.6', 'DORA.Art.19', 'DORA.Art.24', 'DORA.Art.28', 'DORA.Art.45']) {
            expect(dora.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });
});

describe('DORA seed fixture', () => {
    const fixture = JSON.parse(read('prisma/fixtures/dora_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + article-structured key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(20);
        for (const r of fixture) {
            expect(r.key).toMatch(/^DORA\.Art\.\d+$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
            expect(typeof r.sortOrder).toBe('number');
        }
        // Unique keys + unique sortOrders.
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
        expect(new Set(fixture.map((r) => r.sortOrder)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            dora.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });

    it('all five pillars appear as fixture sections', () => {
        const sections = new Set(fixture.map((r) => r.section));
        expect(sections.size).toBe(5);
    });
});

describe('DORA seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the DORA requirements fixture', () => {
        expect(seed).toContain('dora_requirements.json');
    });

    it('upserts the DORA framework (key DORA, version 2022/2554, kind REGULATION)', () => {
        expect(seed).toMatch(/key:\s*'DORA',\s*version:\s*'2022\/2554'/);
        expect(seed).toMatch(/key:\s*'DORA'[\s\S]{0,160}kind:\s*'REGULATION'/);
    });

    it('seeds a DORA framework pack (idempotent upsert)', () => {
        expect(seed).toContain("'DORA_BASELINE'");
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });
});

describe('DORA cross-framework mappings', () => {
    // Resolve mapping refs against the YAML libraries (the library-importer
    // writes these ref_ids as FrameworkRequirement.code).
    const nis2 = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'nis2-2022.yaml')), 'nis2');
    const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso27001-2022.yaml')), 'iso');

    const doraRefs = new Set(dora.framework.nodes.map((n) => n.refId));

    const cases: Array<{ file: string; targetLib: Set<string>; targetRef: string }> = [
        { file: 'dora-to-nis2.yaml', targetLib: new Set(nis2.framework.nodes.map((n) => n.refId)), targetRef: 'NIS2-2022' },
        { file: 'dora-to-iso27001.yaml', targetLib: new Set(iso.framework.nodes.map((n) => n.refId)), targetRef: 'ISO27001-2022' },
    ];

    for (const c of cases) {
        describe(c.file, () => {
            const set = parseMappingSetFile(path.join(ROOT, LIB, 'mappings', c.file));

            it('declares DORA as source and the expected target framework', () => {
                expect(set.source_framework_ref).toBe('DORA-2022');
                expect(set.target_framework_ref).toBe(c.targetRef);
                expect(set.mapping_entries.length).toBeGreaterThanOrEqual(10);
            });

            it('every mapped requirement resolves against the libraries (no dangling refs)', () => {
                const dangling: string[] = [];
                for (const e of set.mapping_entries) {
                    if (!doraRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
                    if (!c.targetLib.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
                }
                expect(dangling).toEqual([]);
            });

            it('marks provenance (official-overlap vs curated) on every entry', () => {
                for (const e of set.mapping_entries) {
                    expect(e.rationale ?? '').toMatch(/\[(official-overlap|curated)\]/);
                }
            });
        });
    }
});

describe('DORA rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no DORA-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            expect(read(rel)).not.toMatch(/\bDORA\b/);
        }
    });
});
