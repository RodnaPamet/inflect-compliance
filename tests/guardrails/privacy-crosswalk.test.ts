/**
 * Privacy regulatory crosswalk ratchet — ISO/IEC 27701 + GDPR + their mappings.
 *
 * Adds privacy coverage as DATA into IC's existing cross-framework mapping
 * engine (no new engine). This guard locks:
 *   - both new library frameworks parse under the library schema, with GDPR
 *     modelled as a regulatory-reference (REGULATION) framework;
 *   - MAPPING VALIDITY: every requirement id in the two new mapping yamls
 *     resolves to a real requirement on BOTH sides (no dangling refs);
 *   - ISO-COPYRIGHT DISCIPLINE: every ISO 27701 requirement description is
 *     short (≤ 200 chars) and clause-ref only — no verbatim ISO passages;
 *   - ATTRIBUTION: the ported crosswalk credits the Microsoft Data Protection
 *     Mapping Project (MIT); docs/attributions.md records it;
 *   - COMPLETENESS: ISO 27701 ships a starter pack (seed-wired); GDPR is the
 *     documented regulatory-reference exemption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'src/data/libraries');
const MAP = path.join(LIB, 'mappings');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Code reads are comment-masked at the seam. YAML/markdown reads keep
// readRaw — codeOf() would mask `//` inside a URL there.
const read = (rel: string) => codeOf(readRaw(rel));

function nodes(file: string) {
    const lib = loadLibrary(parseLibraryFile(path.join(LIB, file)), file);
    return lib;
}
function refIdSet(file: string): Set<string> {
    return new Set(nodes(file).framework.nodes.map((n) => n.refId));
}

const ISO27701 = 'iso27701-2019.yaml';
const GDPR = 'gdpr.yaml';
const ISO27001 = 'iso27001-2022.yaml';

describe('Privacy crosswalk — frameworks parse + register', () => {
    it('ISO 27701 parses and carries the PII controller (7.x) + processor (8.x) families', () => {
        const lib = nodes(ISO27701);
        expect(lib.refId).toBe('ISO27701-2019');
        expect(lib.kind).toBe('ISO_STANDARD');
        const ids = new Set(lib.framework.nodes.map((n) => n.refId));
        for (const req of ['7.2.2', '7.2.5', '7.2.8', '7.3.6', '7.4.7', '7.5.1', '8.2.1', '8.5.7']) {
            expect(ids.has(req)).toBe(true);
        }
    });

    it('GDPR parses as a regulatory-reference (REGULATION) framework', () => {
        const lib = nodes(GDPR);
        expect(lib.refId).toBe('GDPR');
        expect(lib.kind).toBe('REGULATION');
        const ids = new Set(lib.framework.nodes.map((n) => n.refId));
        for (const art of ['Art.5', 'Art.6', 'Art.28', 'Art.30', 'Art.32', 'Art.35', 'Art.46']) {
            expect(ids.has(art)).toBe(true);
        }
    });
});

describe('Privacy crosswalk — mapping validity (no dangling refs)', () => {
    const cases = [
        { file: 'iso27001-to-iso27701.yaml', src: ISO27001, tgt: ISO27701, srcRef: 'ISO27001-2022', tgtRef: 'ISO27701-2019' },
        { file: 'iso27701-to-gdpr.yaml', src: ISO27701, tgt: GDPR, srcRef: 'ISO27701-2019', tgtRef: 'GDPR' },
    ];

    it.each(cases)('$file — framework refs + every entry resolves on both sides', ({ file, src, tgt, srcRef, tgtRef }) => {
        const ms = parseMappingSetFile(path.join(MAP, file));
        expect(ms.source_framework_ref).toBe(srcRef);
        expect(ms.target_framework_ref).toBe(tgtRef);
        expect(ms.mapping_entries.length).toBeGreaterThan(0);

        const srcIds = refIdSet(src);
        const tgtIds = refIdSet(tgt);
        const dangling: string[] = [];
        for (const e of ms.mapping_entries) {
            if (!srcIds.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
            if (!tgtIds.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
        }
        expect(dangling).toEqual([]);
    });
});

describe('Privacy crosswalk — ISO-copyright discipline (clause-ref only)', () => {
    const MAX_DESC = 200;

    it('every ISO 27701 requirement description is short (≤ 200 chars)', () => {
        const offenders = nodes(ISO27701).framework.nodes
            .map((n) => ({ ref: n.refId, len: (n.description ?? '').trim().length }))
            .filter((n) => n.len > MAX_DESC);
        expect(offenders).toEqual([]);
    });

    it('the ISO 27701 yaml declares clause-ref-only discipline and no long verbatim block', () => {
        const src = readRaw(`src/data/libraries/${ISO27701}`);
        // States the discipline explicitly.
        expect(src).toMatch(/ISO-copyrighted|clause IDENTIFIERS|our own/i);
        // No absurdly long single line (a pasted ISO passage would blow past this).
        const longest = Math.max(...src.split('\n').map((l) => l.length));
        expect(longest).toBeLessThanOrEqual(320);
    });
});

describe('Privacy crosswalk — attribution', () => {
    it('the ported crosswalk credits the Microsoft Data Protection Mapping Project (MIT)', () => {
        const src = readRaw(`src/data/libraries/mappings/iso27701-to-gdpr.yaml`);
        expect(src).toMatch(/Microsoft Data Protection Mapping Project/);
        expect(src).toMatch(/MIT/);
    });

    it('docs/attributions.md records the MS project (MIT) source', () => {
        const doc = readRaw('docs/attributions.md');
        expect(doc).toMatch(/Microsoft Data Protection Mapping Project/);
        expect(doc).toMatch(/MIT/);
        expect(doc).toMatch(/iso27701-to-gdpr\.yaml/);
    });
});

describe('Privacy crosswalk — completeness', () => {
    const seed = read('prisma/seed.ts');
    const completeness = read('tests/guardrails/framework-starter-pack-completeness.test.ts');

    it('ISO 27701 ships a seed-wired starter pack', () => {
        expect(seed).toContain("'ISO27701'");
        expect(seed).toContain("'ISO27701_BASELINE'");
        expect(completeness).toContain("'ISO27701-2019'");
    });

    it('GDPR is the documented regulatory-reference exemption (no starter pack)', () => {
        expect(completeness).toMatch(/'GDPR':\s*\n?\s*'Regulatory-reference framework/);
    });
});
