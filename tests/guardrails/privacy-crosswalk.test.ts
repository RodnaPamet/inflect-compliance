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
 *   - DELIVERY: a production seeder actually applies an ISO 27701 catalogue —
 *     framework, requirements, templates and pack — and the summaries it
 *     delivers keep the same clause-ref-only discipline as the yaml; GDPR is
 *     the documented regulatory-reference exemption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { appliedCatalogFor } from '../helpers/applied-catalogue';
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

/** Clause-ref only: a paraphrase fits, a pasted ISO passage does not. */
const MAX_REQ_SUMMARY = 200;

describe('Privacy crosswalk — ISO-copyright discipline (clause-ref only)', () => {
    it('every ISO 27701 requirement description is short (≤ 200 chars)', () => {
        const offenders = nodes(ISO27701).framework.nodes
            .map((n) => ({ ref: n.refId, len: (n.description ?? '').trim().length }))
            .filter((n) => n.len > MAX_REQ_SUMMARY);
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

describe('Privacy crosswalk — ISO 27701 delivery', () => {
    /**
     * This block used to ask `prisma/seed.ts` whether ISO 27701 shipped a pack.
     * `prisma/seed.ts` is not run on a production deploy, so that question could
     * not fail while the framework was undeliverable — and it named the wrong
     * pack besides: seed.ts builds `ISO27701_BASELINE`, while the row production
     * actually has is `ISO27701_CORE`, declared by the CatalogFile that
     * `scripts/seed-framework-catalogs.ts` applies on every container start.
     * The questions below are put to that catalogue instead.
     */
    const catalog = appliedCatalogFor('ISO27701');
    const completeness = read('tests/guardrails/framework-starter-pack-completeness.test.ts');

    it('a production seeder applies an ISO 27701 catalogue at all', () => {
        // DENOMINATOR. Every case below is vacuous when the lookup returns null.
        expect(catalog).not.toBeNull();
        expect(catalog?.requirements.length).toBeGreaterThanOrEqual(20);
        expect(catalog?.templates.length).toBeGreaterThanOrEqual(10);
    });

    it('declares the framework as ISO27701 2019, kind ISO_STANDARD', () => {
        expect(catalog?.framework.key).toBe('ISO27701');
        expect(catalog?.framework.version).toBe('2019');
        expect(catalog?.framework.kind).toBe('ISO_STANDARD');
        expect(catalog?.framework.sourceUrn).toBe('urn:inflect:library:iso27701-2019');
    });

    it('carries the ISO/IEC provider and the ISO-copyright notice in framework metadata', () => {
        const meta = (catalog?.framework.metadata ?? {}) as Record<string, unknown>;
        expect(meta.provider).toBe('ISO/IEC');
        expect(meta.license).toBe('iso-copyright');
        expect(String(meta.copyright ?? '')).toMatch(/ISO-copyrighted/);
    });

    it('delivers the pack production actually has', () => {
        // NOT seed.ts's ISO27701_BASELINE — no customer database holds that key.
        expect(catalog?.pack?.key).toBe('ISO27701_CORE');
        const codes = (catalog?.pack?.templateCodes ?? []) as string[];
        expect(codes.length).toBeGreaterThanOrEqual(10);
        const templateCodes = new Set(catalog?.templates.map((t) => t.code));
        expect(codes.filter((c) => !templateCodes.has(c))).toEqual([]);
    });

    it('delivers both the PII controller (7.x) and processor (8.x) clause families', () => {
        const codes = new Set((catalog?.requirements ?? []).map((r) => String(r.code)));
        for (const req of ['7.2.2', '7.2.5', '7.2.8', '7.3.6', '7.4.7', '7.5.1', '8.5.7']) {
            expect(codes.has(req)).toBe(true);
        }
    });

    it('keeps clause-ref-only discipline in the summaries it DELIVERS, not just the yaml', () => {
        const offenders = (catalog?.requirements ?? [])
            .map((r) => ({ code: String(r.code), len: String(r.summary ?? '').trim().length }))
            .filter((r) => r.len > MAX_REQ_SUMMARY);
        expect(offenders).toEqual([]);
    });

    it('the sibling starter-pack completeness ratchet knows about ISO 27701', () => {
        expect(completeness).toContain("'ISO27701-2019'");
    });

    it('GDPR is the documented regulatory-reference exemption (no starter pack)', () => {
        expect(completeness).toMatch(/'GDPR':\s*\n?\s*'Regulatory-reference framework/);
    });
});
