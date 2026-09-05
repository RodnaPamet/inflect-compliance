/**
 * OWASP AISVS framework-content coverage ratchet.
 *
 * AISVS v1.0 ships as framework CONTENT on Inflect's existing data-driven
 * framework-library machinery (no new code paths). This guard locks:
 *   - owasp-aisvs-1.0.yaml exists + validates against the library schema;
 *   - all 12 chapters are represented; assessable requirement ref_ids follow
 *     the AISVS C<ch>.<sec>.<req> format and carry a verification level;
 *   - the copyright/attribution field carries CC-BY-SA-4.0 + OWASP + source
 *     URL + the pinned version;
 *   - LICENSE SAFETY: the yaml stores IDs + SHORT PARAPHRASED titles + a
 *     canonical link, NOT verbatim OWASP requirement prose (a length/word
 *     ceiling catches accidental verbatim pasting);
 *   - the seed fixture codes match the library assessable ref_ids (the two
 *     representations stay in sync) and the seed upserts the framework + pack;
 *   - the aisvs-to-nist-csf + aisvs-to-iso27001 mapping sets exist and every
 *     mapped requirement resolves against the YAML libraries (no dangling
 *     refs), marked [curated] (our judgement, not OWASP);
 *   - AISVS rides the GENERIC framework-install machinery — no AISVS-specific
 *     branching in the install/catalog usecases;
 *   - the framework picker renders the OWASP attribution + license.
 *
 * Source: the OWASP AISVS v1.0 standard (github.com/OWASP/AISVS), CC-BY-SA-4.0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Code reads are comment-masked at the seam so a COMMENT mentioning a thing
// cannot satisfy an assertion meant to be about CODE. YAML/JSON reads keep
// readRaw — codeOf() would mask `//` inside a URL and break JSON.parse.
const read = (rel: string) => codeOf(readRaw(rel));
const LIB = 'src/data/libraries';

const aisvs = loadLibrary(
    parseLibraryFile(path.join(ROOT, LIB, 'owasp-aisvs-1.0.yaml')),
    'aisvs',
);

const CHAPTER_REFS = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);

describe('AISVS library — owasp-aisvs-1.0.yaml', () => {
    it('validates against the library schema as an INDUSTRY_STANDARD', () => {
        expect(aisvs.refId).toBe('AISVS-1.0');
        expect(aisvs.kind).toBe('INDUSTRY_STANDARD');
        expect(aisvs.version).toBeGreaterThanOrEqual(1);
    });

    it('represents all 12 AISVS chapters as grouping nodes', () => {
        const chapterNodes = aisvs.framework.nodes.filter(
            (n) => /^C\d+$/.test(n.refId),
        );
        expect(chapterNodes.map((n) => n.refId).sort((a, b) =>
            Number(a.slice(1)) - Number(b.slice(1)),
        )).toEqual(CHAPTER_REFS);
        for (const ref of CHAPTER_REFS) {
            const node = aisvs.framework.nodesByRefId.get(ref);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable requirement ref_ids follow the AISVS C<ch>.<sec>.<req> format', () => {
        const assessable = aisvs.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(150);
        for (const n of assessable) {
            expect(n.refId).toMatch(/^C\d+\.\d+\.\d+$/);
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check one anchor requirement per chapter exists.
        for (const ref of [
            'C1.1.1', 'C2.1.1', 'C3.1.1', 'C4.1.1', 'C5.1.1', 'C6.1.1',
            'C7.1.1', 'C8.1.1', 'C9.1.1', 'C10.1.1', 'C11.1.1', 'C12.1.1',
        ]) {
            expect(aisvs.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });

    it('every requirement carries its AISVS level (L1/L2/L3) + a canonical link', () => {
        for (const n of aisvs.framework.nodes.filter((x) => x.assessable)) {
            expect(n.annotation ?? '').toMatch(/AISVS Level:\s*L[123]/);
            expect(n.annotation ?? '').toContain('github.com/OWASP/AISVS');
        }
    });

    it('models the three AISVS levels as the assessment scale', () => {
        const scores = (aisvs.framework.scoring?.definitions ?? []).map((s) => s.score);
        expect(scores).toEqual([1, 2, 3]);
        expect(aisvs.framework.scoring?.min).toBe(1);
        expect(aisvs.framework.scoring?.max).toBe(3);
    });

    it('the copyright field carries CC-BY-SA-4.0 + OWASP + source URL + pinned version', () => {
        const yaml = readRaw(`${LIB}/owasp-aisvs-1.0.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock).toMatch(/CC-BY-SA-4\.0/);
        expect(copyrightBlock).toMatch(/OWASP/);
        expect(copyrightBlock).toContain('github.com/OWASP/AISVS');
        // Pinned version present in the file metadata.
        expect(yaml).toMatch(/ref_id:\s*AISVS-1\.0/);
    });

    // ── LICENSE SAFETY: index, not verbatim prose ──
    it('stores SHORT paraphrased titles, not verbatim requirement prose', () => {
        const offenders: string[] = [];
        for (const n of aisvs.framework.nodes.filter((x) => x.assessable)) {
            const title = n.name ?? '';
            const words = title.trim().split(/\s+/).length;
            // A paraphrased title is short; verbatim AISVS requirements are
            // full sentences (typically 20-40+ words). Ceiling catches a paste.
            if (words > 12 || title.length > 90) {
                offenders.push(`${n.refId}: "${title}"`);
            }
            // Description is "title (AISVS <id>, Level Lx)." — also bounded.
            if ((n.description ?? '').length > 160) {
                offenders.push(`${n.refId} desc too long`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('AISVS seed fixture', () => {
    const fixture = JSON.parse(
        readRaw('prisma/fixtures/owasp_aisvs_requirements.json'),
    ) as Array<{ key: string; section: string; level: string; sortOrder: number; title: string }>;

    it('every fixture entry has the required shape + AISVS-structured key + level', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(150);
        for (const r of fixture) {
            expect(r.key).toMatch(/^C\d+\.\d+\.\d+$/);
            expect(r.section).toBeTruthy();
            expect(r.level).toMatch(/^L[123]$/);
            expect(r.title).toBeTruthy();
            expect(typeof r.sortOrder).toBe('number');
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
        expect(new Set(fixture.map((r) => r.sortOrder)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            aisvs.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });

    it('all 12 chapters appear as fixture sections', () => {
        const sections = new Set(fixture.map((r) => r.section));
        expect(sections.size).toBe(12);
    });
});

describe('AISVS seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the AISVS requirements fixture', () => {
        expect(seed).toContain('owasp_aisvs_requirements.json');
    });

    it('upserts the AISVS framework (key OWASP-AISVS, version 1.0, kind INDUSTRY_STANDARD)', () => {
        expect(seed).toMatch(/key:\s*'OWASP-AISVS',\s*version:\s*'1\.0'/);
        expect(seed).toMatch(/key:\s*'OWASP-AISVS'[\s\S]{0,200}kind:\s*'INDUSTRY_STANDARD'/);
    });

    it('persists OWASP attribution + CC-BY-SA-4.0 in framework metadata', () => {
        // Bound to the declaration this test names. Against the whole of
        // seed.ts the needles stopped naming AISVS's metadata once a second
        // CC-BY-SA-4.0 OWASP framework was seeded — either could satisfy them,
        // so deleting aisvsMeta would have left both assertions green.
        const meta = declarationOf(seed, 'aisvsMeta');
        expect(meta).toMatch(/provider:\s*'OWASP'/);
        expect(meta).toContain('CC-BY-SA-4.0');
    });

    it('seeds an AISVS framework pack (idempotent upsert)', () => {
        expect(seed).toContain("'AISVS_BASELINE'");
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });
});

describe('AISVS cross-framework mappings', () => {
    const nist = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'nist-csf-2.0.yaml')), 'nist');
    const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso27001-2022.yaml')), 'iso');
    const aisvsRefs = new Set(aisvs.framework.nodes.map((n) => n.refId));

    const cases: Array<{ file: string; targetLib: Set<string>; targetRef: string }> = [
        { file: 'aisvs-to-nist-csf.yaml', targetLib: new Set(nist.framework.nodes.map((n) => n.refId)), targetRef: 'NIST-CSF-2.0' },
        { file: 'aisvs-to-iso27001.yaml', targetLib: new Set(iso.framework.nodes.map((n) => n.refId)), targetRef: 'ISO27001-2022' },
    ];

    for (const c of cases) {
        describe(c.file, () => {
            const set = parseMappingSetFile(path.join(ROOT, LIB, 'mappings', c.file));

            it('declares AISVS as source and the expected target framework', () => {
                expect(set.source_framework_ref).toBe('AISVS-1.0');
                expect(set.target_framework_ref).toBe(c.targetRef);
                expect(set.mapping_entries.length).toBeGreaterThanOrEqual(10);
            });

            it('every mapped requirement resolves against the libraries (no dangling refs)', () => {
                const dangling: string[] = [];
                for (const e of set.mapping_entries) {
                    if (!aisvsRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
                    if (!c.targetLib.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
                }
                expect(dangling).toEqual([]);
            });

            it('marks every mapping as [curated] provenance (our judgement, not OWASP)', () => {
                for (const e of set.mapping_entries) {
                    expect(e.rationale ?? '').toMatch(/\[curated\]/);
                }
            });
        });
    }
});

describe('AISVS rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no AISVS-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            expect(read(rel)).not.toMatch(/AISVS/i);
        }
    });
});

describe('AISVS provenance in the framework picker', () => {
    const client = read('src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx');

    it('parses framework metadata for provider + license provenance', () => {
        expect(client).toContain('parseProvenance');
        expect(client).toMatch(/metadataJson/);
    });

    it('renders the attribution, license, and canonical-text note', () => {
        expect(client).toMatch(/provenance\.provider/);
        expect(client).toMatch(/provenance\.license/);
        // The canonical-text note moved to next-intl — resolve against en.json.
        expect(client).toMatch(/list\.referenceIndexNote/);
        expect(JSON.parse(readRaw('messages/en.json')).frameworks.list.referenceIndexNote).toMatch(
            /links to canonical requirement text/,
        );
    });
});
