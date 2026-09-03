/**
 * AI-governance bundle ratchet — the three-layer AI-governance offering.
 *
 * IC's AI-governance bundle connects three layers so a tenant's technical
 * verification rolls up into a management system and regulatory obligations:
 *   - AISVS v1.0           (technical AI-security — #1328)
 *   - ISO/IEC 42001:2023   (AI management system — #1331)
 *   - EU AI Act 2024/1689  (regulation — #1332)
 *
 * This guard locks the INTEGRATION:
 *   - all three framework libraries exist + validate;
 *   - the per-source LICENSE handling is correct (AISVS CC-BY-SA index;
 *     ISO 42001 ISO-copyright paraphrase-only; EU AI Act public-domain text);
 *   - the EU AI Act encodes the risk-tier structure;
 *   - the three crosswalk mapping sets exist, are [curated], and every mapped
 *     node resolves against the libraries (no dangling refs);
 *   - all three frameworks ride the GENERIC install/catalog machinery;
 *   - the AI-governance posture REUSES the existing cross-framework
 *     traceability/coverage surfaces (no bespoke dashboard).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * Source read with COMMENTS MASKED — the seam for every .ts/.tsx assertion
 * below, so a comment naming a thing can never satisfy an assertion about
 * the code. Deliberately NOT applied to the YAML reads: `codeOf` blanks
 * `//` to end-of-line, which would eat the `https://www.iso.org/...` URL
 * the copyright assertion matches on.
 */
const readCode = (rel: string) => codeOf(read(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const LIB = 'src/data/libraries';

const aisvs = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'owasp-aisvs-1.0.yaml')), 'a');
const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso-42001.yaml')), 'i');
const eu = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'eu-ai-act.yaml')), 'e');

const refSet = (lib: typeof aisvs) => new Set(lib.framework.nodes.map((n) => n.refId));

describe('AI-governance bundle — three frameworks present + valid', () => {
    it('AISVS, ISO 42001 and EU AI Act libraries all validate', () => {
        expect(aisvs.refId).toBe('AISVS-1.0');
        expect(iso.refId).toBe('ISO42001-2023');
        expect(eu.refId).toBe('EU-AI-ACT-2024');
        expect(iso.kind).toBe('ISO_STANDARD');
        expect(eu.kind).toBe('REGULATION');
    });

    it('the EU AI Act encodes the risk-tier structure', () => {
        for (const t of ['Tier.Prohibited', 'Tier.HighRisk', 'Tier.Limited', 'Tier.GPAI', 'Tier.Minimal']) {
            const node = eu.framework.nodesByRefId.get(t);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
        }
    });
});

describe('AI-governance bundle — per-source license handling', () => {
    it('AISVS keeps the CC-BY-SA-4.0 attribution (index, not prose)', () => {
        const y = read(`${LIB}/owasp-aisvs-1.0.yaml`);
        expect(y).toMatch(/CC-BY-SA-4\.0/);
    });

    it('ISO 42001 is paraphrase-only (no verbatim ISO text), pointing at ISO', () => {
        const y = read(`${LIB}/iso-42001.yaml`);
        expect(y.slice(y.indexOf('copyright:')).toLowerCase()).toContain('iso.org');
        // Every assessable node carries a (Paraphrase) marker + a short title.
        for (const n of iso.framework.nodes.filter((x) => x.assessable)) {
            expect(n.description ?? '').toMatch(/\(Paraphrase/i);
            expect((n.name ?? '').length).toBeLessThanOrEqual(100);
        }
    });

    it('EU AI Act is public domain (article text permitted) + not-legal-advice', () => {
        const y = read(`${LIB}/eu-ai-act.yaml`);
        expect(y.slice(y.indexOf('copyright:'))).toMatch(/public domain/i);
        expect(y).toMatch(/not legal advice/i);
    });
});

describe('AI-governance bundle — three-way crosswalk', () => {
    const cases: Array<{ file: string; src: Set<string>; tgt: Set<string>; sf: string; tf: string }> = [
        { file: 'aisvs-to-iso-42001.yaml', src: refSet(aisvs), tgt: refSet(iso), sf: 'AISVS-1.0', tf: 'ISO42001-2023' },
        { file: 'aisvs-to-eu-ai-act.yaml', src: refSet(aisvs), tgt: refSet(eu), sf: 'AISVS-1.0', tf: 'EU-AI-ACT-2024' },
        { file: 'iso-42001-to-eu-ai-act.yaml', src: refSet(iso), tgt: refSet(eu), sf: 'ISO42001-2023', tf: 'EU-AI-ACT-2024' },
    ];

    for (const c of cases) {
        describe(c.file, () => {
            it('exists', () => {
                expect(exists(`${LIB}/mappings/${c.file}`)).toBe(true);
            });

            const set = parseMappingSetFile(path.join(ROOT, LIB, 'mappings', c.file));

            it('declares the expected source + target frameworks', () => {
                expect(set.source_framework_ref).toBe(c.sf);
                expect(set.target_framework_ref).toBe(c.tf);
                expect(set.mapping_entries.length).toBeGreaterThanOrEqual(10);
            });

            it('every mapped node resolves (no dangling refs)', () => {
                const dangling: string[] = [];
                for (const e of set.mapping_entries) {
                    if (!c.src.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
                    if (!c.tgt.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
                }
                expect(dangling).toEqual([]);
            });

            it('marks every entry [curated] (IC judgement, not the source standards)', () => {
                for (const e of set.mapping_entries) {
                    expect(e.rationale ?? '').toMatch(/\[curated\]/);
                }
            });
        });
    }
});

describe('AI-governance bundle — generic machinery + reused surfaces', () => {
    it('no framework in the bundle is special-cased in install/catalog', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            const src = readCode(rel);
            expect(src).not.toMatch(/AISVS|42001|EU-AI-ACT|eu-ai-act/i);
        }
    });

    it('reuses the EXISTING cross-framework traceability/mapping surfaces (no bespoke dashboard)', () => {
        // The crosswalks surface through the existing mapping/traceability
        // surface + the standard coverage flow — not a bespoke AI-governance page.
        expect(exists('src/app/t/[tenantSlug]/(app)/mapping/page.tsx')).toBe(true);
        expect(exists('src/app-layer/usecases/traceability.ts')).toBe(true);
        // Guard against accidentally introducing a one-off bespoke surface.
        expect(exists('src/app/t/[tenantSlug]/(app)/ai-governance')).toBe(false);
    });
});
