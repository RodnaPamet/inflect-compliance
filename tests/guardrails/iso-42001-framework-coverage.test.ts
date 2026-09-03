/**
 * ISO/IEC 42001:2023 framework-content coverage ratchet.
 *
 * ISO 42001 (AI Management System) ships as framework CONTENT on IC's existing
 * data-driven library machinery (no new code paths). This guard locks:
 *   - iso-42001.yaml exists + validates against the library schema (ISO_STANDARD);
 *   - the management clauses (4-10) AND the Annex A objectives (A.2-A.10) are
 *     represented; assessable ref_ids follow the clause/control numbering;
 *   - LICENSE: ISO 42001 is COPYRIGHTED — the yaml stores clause/control numbers
 *     + SHORT PARAPHRASED titles only (no verbatim ISO text; a length ceiling +
 *     a "(Paraphrase" marker enforce it), and the copyright points at ISO;
 *   - the seed fixture codes match the library assessable ref_ids (in sync) and
 *     the seed upserts the framework + ISO42001_BASELINE pack;
 *   - ISO 42001 rides the GENERIC framework-install machinery (no special-casing).
 *
 * AISVS/EU-AI-Act crosswalks are locked separately by the bundle ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const LIB = 'src/data/libraries';

const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso-42001.yaml')), 'iso42001');

describe('ISO 42001 library — iso-42001.yaml', () => {
    it('validates against the library schema as an ISO_STANDARD', () => {
        expect(iso.refId).toBe('ISO42001-2023');
        expect(iso.kind).toBe('ISO_STANDARD');
        expect(iso.version).toBeGreaterThanOrEqual(1);
    });

    it('represents management clauses 4-10 as grouping nodes', () => {
        for (const c of ['4', '5', '6', '7', '8', '9', '10']) {
            const node = iso.framework.nodesByRefId.get(c);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('represents Annex A objectives A.2-A.10 as grouping nodes', () => {
        for (const o of ['A.2', 'A.3', 'A.4', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10']) {
            const node = iso.framework.nodesByRefId.get(o);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable ref_ids follow the clause / Annex-control numbering', () => {
        const assessable = iso.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(50);
        for (const n of assessable) {
            // Clause sub-requirements (e.g. 4.1, 6.2) OR Annex controls (A.6.2.4).
            expect(n.refId).toMatch(/^(\d+\.\d+|A\.\d+(\.\d+){1,2})$/);
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check anchors across the standard.
        for (const ref of ['4.1', '6.2', '8.2', '10.2', 'A.2.2', 'A.6.2.4', 'A.10.4']) {
            expect(iso.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });

    // ── LICENSE SAFETY: paraphrase, not verbatim ISO text ──
    it('stores SHORT paraphrased titles + (Paraphrase) markers, not ISO prose', () => {
        const offenders: string[] = [];
        for (const n of iso.framework.nodes.filter((x) => x.assessable)) {
            const title = n.name ?? '';
            if (title.trim().split(/\s+/).length > 14 || title.length > 100) {
                offenders.push(`${n.refId}: "${title}"`);
            }
            if (!/\(Paraphrase/i.test(n.description ?? '')) {
                offenders.push(`${n.refId}: description missing (Paraphrase) marker`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the copyright points at ISO and disclaims verbatim reproduction', () => {
        const yaml = readRaw(`${LIB}/iso-42001.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock.toLowerCase()).toContain('iso.org');
        expect(copyrightBlock).toMatch(/NOT a reproduction|structural outline/i);
    });
});

describe('ISO 42001 seed fixture', () => {
    const fixture = JSON.parse(readRaw('prisma/fixtures/iso_42001_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + clause/control key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(50);
        for (const r of fixture) {
            expect(r.key).toMatch(/^(\d+\.\d+|A\.\d+(\.\d+){1,2})$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            iso.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });
});

describe('ISO 42001 seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the ISO 42001 fixture + upserts the framework', () => {
        expect(seed).toContain('iso_42001_requirements.json');
        expect(seed).toMatch(/key:\s*'ISO42001',\s*version:\s*'2023'/);
        expect(seed).toMatch(/key:\s*'ISO42001'[\s\S]{0,200}kind:\s*'ISO_STANDARD'/);
    });

    it('persists ISO provider + copyright disclaimer in framework metadata', () => {
        expect(seed).toMatch(/provider:\s*'ISO\/IEC'/);
        expect(seed).toMatch(/NOT a reproduction/i);
    });

    it('seeds an ISO 42001 framework pack (idempotent upsert)', () => {
        expect(seed).toContain("'ISO42001_BASELINE'");
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });
});

describe('ISO 42001 rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no ISO42001-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            expect(read(rel)).not.toMatch(/42001/);
        }
    });
});
