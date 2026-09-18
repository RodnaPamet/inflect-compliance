/**
 * "Coverage by Section" must break a framework down by its STRUCTURE.
 *
 * #2619 — OWASP ASVS and CIS v8 shipped assessable requirements with no
 * `section`, so `r.section || r.category || 'Other'` fell through to
 * `category`, which for those two holds the VERIFICATION TIER (`L1`/`L2`/`L3`)
 * and the IMPLEMENTATION GROUP (`IG1`/`IG2`/`IG3`). The breakdown rendered
 * three rows named after tiers on all three surfaces that show it — framework
 * detail, readiness hub, and the audit-readiness PDF.
 *
 * (The issue said it collapsed to ONE row duplicating the headline total. It
 * did not: ASVS split L1:128 / L2:119 / L3:12 and CIS split IG2:74 / IG1:56 /
 * IG3:23. Three rows on the wrong axis, not one row on none.)
 *
 * The chapter axis was present the whole time, as the non-assessable parent
 * nodes — 14 ASVS chapters and 18 CIS controls, reachable from 100% of
 * assessable nodes. The fix is in the library data: those nodes now carry an
 * explicit `section`, and `category` still carries the tier, so nothing is
 * lost. No importer or coverage code changed, so no other framework moved.
 *
 * This guard asserts the axis is structural, per framework, for all of them —
 * a new library whose only grouping is a tier fails here.
 */
import fs from 'fs';
import path from 'path';
import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries/library-loader';

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
});
