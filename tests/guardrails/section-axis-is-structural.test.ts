/**
 * "Coverage by Section" must break a framework down by its STRUCTURE — in the
 * data a tenant actually has, not only in the YAML libraries.
 *
 * #2619 — OWASP ASVS and CIS v8 shipped assessable requirements with no
 * `section`, so `r.section || r.category || 'Other'` fell through to
 * `category`, which for those two holds the VERIFICATION TIER (L1/L2/L3) and
 * the IMPLEMENTATION GROUP (IG1/IG2/IG3). The breakdown was named after tiers
 * on all three surfaces that show it — framework detail, readiness hub, and
 * the audit-readiness PDF.
 *
 * ═══ THE ISSUE WAS RIGHT AND THE FIRST FIX WAS MEASURED IN THE WRONG PLACE ═══
 *
 * The first version of this change said the issue was wrong to call it a
 * single row — that ASVS split L1:128 / L2:119 / L3:12. Those are the LIBRARY
 * YAML's 259 assessable nodes. What production applies is
 * `prisma/fixtures/asvs-l1-control-templates.json` via
 * `scripts/seed-framework-catalogs.ts`, which `scripts/entrypoint.sh:95` runs
 * on every container start, and that is 128 requirements in ONE bucket:
 *
 *     OWASP-ASVS   128 requirements, sections = {'L1'}
 *     CIS-V8        56 requirements, sections = {'IG1'}
 *
 * One row, duplicating the headline total. Exactly as reported. The "three
 * tier rows" correction described a file no tenant reads, and editing only
 * that file would have closed the issue while changing nothing anyone sees.
 *
 * BOTH representations are live, so both are fixed and both are asserted here.
 * `usecases/framework/coverage.ts:18-22` records why: one framework can exist
 * TWICE in `Framework` under different keys, and a tenant's links hang off
 * whichever its database got.
 *
 * The chapter axis was present all along as the non-assessable parent nodes,
 * so the section values are the chapters those nodes already name; `category`
 * still carries the tier, and nothing is lost.
 */
import fs from 'fs';
import path from 'path';
import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries/library-loader';
import { appliedCatalogFor } from '../helpers/applied-catalogue';

const LIB_DIR = path.join(process.cwd(), 'src/data/libraries');

interface Node {
    urn: string;
    parentUrn?: string;
    name?: string;
    refId: string;
    section?: string;
    category?: string;
    assessable?: boolean;
}

/** Exactly the importer's rule: `section: node.section ?? node.category`. */
function importedSection(n: Node): string {
    return n.section ?? n.category ?? 'Other';
}

function frameworks(): Array<{ key: string; assessable: Node[] }> {
    return fs
        .readdirSync(LIB_DIR)
        .filter((f) => /\.ya?ml$/.test(f) && !f.includes('-to-'))
        .map((f) => {
            const lib = loadLibrary(parseLibraryFile(path.join(LIB_DIR, f)), path.join(LIB_DIR, f)) as unknown as {
                refId: string;
                framework: { nodes: Node[] };
            };
            return {
                key: lib.refId,
                assessable: lib.framework.nodes.filter((n) => n.assessable !== false),
            };
        });
}

/**
 * A tier/level/group label rather than a subject area. These are the shapes
 * that actually shipped; the point is not to catch every possible one, but to
 * name the two that did and keep them named.
 */
const TIER_LABEL = /^(L[1-3]|IG[1-3]|Level\s*[1-3]|Tier\s*[1-3])$/i;

describe('the section axis is structural, not a tier (#2619)', () => {
    const all = frameworks();

    it('surveyed every shipped framework (positive control)', () => {
        expect(all.length).toBeGreaterThanOrEqual(16);
        expect(all.every((f) => f.assessable.length > 0)).toBe(true);
    });

    it('no framework groups its requirements by a tier label', () => {
        const offenders = all
            .map((f) => ({
                key: f.key,
                tierSections: [...new Set(f.assessable.map(importedSection))].filter((s) => TIER_LABEL.test(s)),
            }))
            .filter((f) => f.tierSections.length > 0);
        expect(offenders).toEqual([]);
    });

    it('ASVS and CIS break down by chapter, with the tier kept on category', () => {
        const asvs = all.find((f) => f.key === 'OWASP-ASVS-4.0.3')!;
        const cis = all.find((f) => f.key === 'CIS-CONTROLS-V8')!;

        expect(new Set(asvs.assessable.map(importedSection)).size).toBe(14);
        expect(new Set(cis.assessable.map(importedSection)).size).toBe(18);

        // The tier is not discarded — it stays queryable on `category`.
        expect(new Set(asvs.assessable.map((n) => n.category))).toEqual(new Set(['L1', 'L2', 'L3']));
        expect(new Set(cis.assessable.map((n) => n.category))).toEqual(new Set(['IG1', 'IG2', 'IG3']));
    });

    it('every assessable requirement has a section (no Other bucket)', () => {
        const missing = all.flatMap((f) =>
            f.assessable.filter((n) => importedSection(n) === 'Other').map((n) => `${f.key}:${n.refId}`),
        );
        expect(missing).toEqual([]);
    });

    it('a section breakdown says something the headline does not', () => {
        // One row per framework is a breakdown that cannot break anything down.
        // Pinned per framework so a regression names itself; these are the
        // shipped values, not a floor that a collapse could slip under.
        const counts = Object.fromEntries(
            all.map((f) => [f.key, new Set(f.assessable.map(importedSection)).size]),
        );
        expect(counts).toEqual({
            'AISVS-1.0': 44,
            'CIS-CONTROLS-V8': 18,
            'DORA-2022': 5,
            'EU-AI-ACT-2024': 5,
            GDPR: 4,
            'IMDA-MGF-2026': 4,
            'ISO27001-2022': 4,
            'ISO27701-2019': 2,
            'ISO42001-2023': 16,
            'NIS2-2022': 12,
            'NIST-CSF-2.0': 6,
            'NIST-PF-1.0': 5,
            'NIST-SSDF-800-218': 4,
            'OWASP-ASI-TOP10': 10,
            'OWASP-ASVS-4.0.3': 14,
            'SOC2-2017': 5,
        });
        expect(Object.values(counts).every((c) => c >= 2)).toBe(true);
    });

    // ─── The data production actually applies ───────────────────────────
    //
    // Everything above reads src/data/libraries. These read the CatalogFiles
    // that scripts/entrypoint.sh applies on every container start. The first
    // version of this guard had only the first half, and was green while the
    // two catalogues that ship violated its own tier assertion.

    it.each([
        ['OWASP-ASVS', 128, 13],
        ['CIS-V8', 56, 15],
    ])('%s, as production applies it, breaks down by chapter', (key, reqCount, sections) => {
        const applied = appliedCatalogFor(key as string);
        // Not a soft skip: if this framework stops being applied, that is a
        // fact this guard must report, not route around.
        expect(applied).not.toBeNull();
        const reqs = applied!.requirements;
        expect(reqs).toHaveLength(reqCount as number);

        const secs = new Set(reqs.map((r) => (r.section ?? r.category ?? 'Other') as string));
        expect(secs.size).toBe(sections as number);
        expect([...secs].filter((s) => TIER_LABEL.test(s))).toEqual([]);
    });

    it('no applied catalogue anywhere groups its requirements by a tier', () => {
        // The general form, over every framework production applies — so a
        // third catalogue with the same defect cannot ship unnoticed.
        const keys = [
            'OWASP-ASVS', 'CIS-V8', 'SOC2', 'NIST-SSDF', 'ISO27701', 'DORA', 'NIS2',
            'ISO27001', 'OWASP-ASI', 'IMDA-MGF', 'NIST-PRIVACY', 'ISO9001',
            'ISO28000', 'ISO39001', 'ISO42001', 'OWASP-AISVS', 'EU-AI-ACT',
        ];
        const offenders = keys
            .map((k) => ({ key: k, applied: appliedCatalogFor(k) }))
            .filter((x) => x.applied)
            .map((x) => ({
                key: x.key,
                tierSections: [
                    ...new Set(x.applied!.requirements.map((r) => (r.section ?? r.category ?? 'Other') as string)),
                ].filter((s) => TIER_LABEL.test(s)),
            }))
            .filter((x) => x.tierSections.length > 0);
        expect(offenders).toEqual([]);
    });

    it('surveyed the applied catalogues at all (positive control)', () => {
        // Without this, appliedCatalogFor returning null everywhere would make
        // both assertions above pass by filtering their population to empty.
        const found = ['OWASP-ASVS', 'CIS-V8', 'ISO27001'].filter((k) => appliedCatalogFor(k));
        expect(found).toEqual(['OWASP-ASVS', 'CIS-V8', 'ISO27001']);
    });
});
