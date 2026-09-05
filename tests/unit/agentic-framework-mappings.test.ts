/**
 * Cross-framework mapping content — OWASP Agentic AI Top 10 + IMDA MGF.
 *
 * The commercial promise attached to these two frameworks is that a customer
 * who already holds ISO 42001 (or an ISO 27001 ISMS) sees PARTIAL agentic
 * coverage on day one instead of starting at zero. That promise is data, not
 * code: it is true exactly to the extent that the mapping YAML in
 * `src/data/libraries/mappings/` reaches every agentic requirement from a
 * framework the shipped control library is built on. So this suite holds the
 * DATA to account.
 *
 * Five invariants, each chosen because its failure mode is silent:
 *
 *  1. ZERO SILENT GAPS. Every assessable requirement in both agentic
 *     frameworks is reached from a control-library-backed framework, or is
 *     named in `UNMAPPED_WITH_REASON` with a written reason. A risk nobody
 *     mapped and nobody wrote down reads, in the product, exactly like a risk
 *     a customer has no controls for.
 *
 *     This is the INHERITED route specifically. The direct one — a
 *     `ControlTemplate` per agentic requirement, in the framework's own
 *     starter pack — is stage 1's, created by `prisma/seed.ts` rather than by
 *     data a unit test can read, and proved by running the seed against a
 *     real database.
 *
 *  2. SYMMETRY. Every pair with an agentic framework on either side ships in
 *     BOTH directions, and the reverse file is the EXACT transpose with each
 *     strength inverted. The reverse direction is derived data living beside
 *     its source, so the only thing that keeps it honest is a check: edit one
 *     side alone and this goes red.
 *
 *  3. NO DANGLING REFS. Every `source_ref` / `target_ref` resolves to an
 *     ASSESSABLE node in the referenced library. A non-assessable grouping
 *     node is never persisted by `library-importer.ts`, so a mapping onto one
 *     is not an error at import — it is an entry the importer records as
 *     unresolved and skips, and the mapping quietly does nothing forever.
 *
 *  4. NO EQUAL. No agentic mapping claims semantic equivalence. Nothing in
 *     ISO 42001 or ISO 27001 IS an agentic risk control; claiming otherwise
 *     would let `determineGapStatus` return COVERED off a curated judgement.
 *
 *  5. BOTH REPRESENTATIONS. Every ref also resolves against the SEED fixture,
 *     not just the library the mapping is authored against. `ISO27001-2022`
 *     shipped 39 edges that resolved perfectly and reached zero seeded
 *     tenants, because the seed numbers Annex A `5.15` where the library
 *     numbers it `A.5.15`. Each file was internally consistent, so nothing
 *     short of comparing the two representations could see it.
 *
 * Everything is asserted against PARSED data — the production
 * `scanMappingSetDirectory` scanner and the production library loader — never
 * by matching source text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { canonicalRequirementCode } from '@/app-layer/domain/framework-representation';
import {
    scanMappingSetDirectory,
    type StoredMappingSet,
} from '@/app-layer/services/mapping-set-importer';
import { MAPPING_STRENGTHS, type MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const MAPPINGS_DIR = path.join(LIB_DIR, 'mappings');

const load = (file: string) => loadLibrary(parseLibraryFile(path.join(LIB_DIR, file)), file);

/** Library ref_id → the assessable requirement codes that library persists. */
const ASSESSABLE_CODES: Record<string, Set<string>> = {
    'OWASP-ASI-TOP10': new Set(
        load('owasp-agentic-top10.yaml').framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
    ),
    'IMDA-MGF-2026': new Set(
        load('imda-mgf-2026.yaml').framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
    ),
    'ISO42001-2023': new Set(
        load('iso-42001.yaml').framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
    ),
    'ISO27001-2022': new Set(
        load('iso27001-2022.yaml').framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
    ),
};

const AGENTIC_FRAMEWORKS = ['OWASP-ASI-TOP10', 'IMDA-MGF-2026'] as const;

/**
 * The frameworks the shipped ControlTemplate library is actually built on. A
 * mapping FROM one of these is what turns an existing control set into
 * inherited agentic coverage; a mapping from anywhere else is traceability
 * without a control behind it.
 */
const CONTROL_LIBRARY_BACKED = ['ISO42001-2023', 'ISO27001-2022'] as const;

/**
 * Agentic requirements deliberately left unreached from a control-library-backed
 * framework, each with a written reason.
 *
 * EMPTY, and that is the finding rather than an oversight: every one of the ten
 * OWASP risks and all nineteen MGF requirements has at least one honest route in
 * from ISO 42001 or ISO 27001, even where the honest strength is RELATED (which
 * the gap layer never counts as coverage). An entry here is a claim that a risk
 * has NO defensible route in — write the reason, do not delete the assertion.
 */
const UNMAPPED_WITH_REASON: Record<string, string> = {};

/**
 * The SEEDED representation of each framework an agentic mapping names: the
 * fixture `prisma/seed.ts` loads, and the family urn that decides how its
 * requirement codes reconcile with the library's.
 *
 * A framework in an agentic mapping set with no entry here fails the first
 * test below rather than being skipped — the point of invariant 5 is that a
 * new edge cannot be authored against the library alone.
 */
const SEEDED_REPRESENTATIONS: Record<string, { fixture: string; familyUrn: string }> = {
    'OWASP-ASI-TOP10': {
        fixture: 'owasp_asi_requirements.json',
        familyUrn: 'urn:inflect:library:owasp-agentic-top10',
    },
    'IMDA-MGF-2026': {
        fixture: 'imda_mgf_requirements.json',
        familyUrn: 'urn:inflect:library:imda-mgf-2026',
    },
    'ISO42001-2023': {
        fixture: 'iso_42001_requirements.json',
        familyUrn: 'urn:inflect:library:iso-42001',
    },
    'ISO27001-2022': {
        fixture: 'iso27001_2022_annexA.json',
        familyUrn: 'urn:inflect:library:iso27001-2022',
    },
};

const seededCodes = (frameworkRef: string): Set<string> => {
    const rep = SEEDED_REPRESENTATIONS[frameworkRef];
    const rows = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'prisma/fixtures', rep.fixture), 'utf8'),
    ) as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key));
};

const INVERSE: Record<MappingStrengthValue, MappingStrengthValue> = {
    EQUAL: 'EQUAL',
    INTERSECT: 'INTERSECT',
    RELATED: 'RELATED',
    SUBSET: 'SUPERSET',
    SUPERSET: 'SUBSET',
};

const scanned = scanMappingSetDirectory(MAPPINGS_DIR);
const setsByPair = new Map<string, StoredMappingSet>(
    scanned.map(({ stored }) => [
        `${stored.source_framework_ref}→${stored.target_framework_ref}`,
        stored,
    ]),
);

/** Every mapping set with an agentic framework on either side. */
const agenticSets = scanned
    .map(({ stored }) => stored)
    .filter(
        (s) =>
            (AGENTIC_FRAMEWORKS as readonly string[]).includes(s.source_framework_ref) ||
            (AGENTIC_FRAMEWORKS as readonly string[]).includes(s.target_framework_ref),
    );

const entryTriples = (s: StoredMappingSet) =>
    new Set(s.mapping_entries.map((e) => `${e.source_ref}|${e.target_ref}|${e.strength}`));

describe('agentic cross-framework mappings — the sets exist and are complete', () => {
    it('ships a mapping set for every agentic pair the product promises', () => {
        const pairs = agenticSets.map((s) => `${s.source_framework_ref}→${s.target_framework_ref}`).sort();
        expect(pairs).toEqual([
            'IMDA-MGF-2026→ISO42001-2023',
            'IMDA-MGF-2026→OWASP-ASI-TOP10',
            'ISO27001-2022→OWASP-ASI-TOP10',
            'ISO42001-2023→IMDA-MGF-2026',
            'ISO42001-2023→OWASP-ASI-TOP10',
            'OWASP-ASI-TOP10→IMDA-MGF-2026',
            'OWASP-ASI-TOP10→ISO27001-2022',
            'OWASP-ASI-TOP10→ISO42001-2023',
        ]);
    });

    it.each(AGENTIC_FRAMEWORKS)(
        'every %s requirement is reached from the control library, or is written down as unreached',
        (framework) => {
            const reached = new Set<string>();
            for (const set of agenticSets) {
                if (set.target_framework_ref !== framework) continue;
                if (!(CONTROL_LIBRARY_BACKED as readonly string[]).includes(set.source_framework_ref)) continue;
                for (const entry of set.mapping_entries) reached.add(entry.target_ref);
            }

            const silentGaps = [...ASSESSABLE_CODES[framework]]
                .filter((code) => !reached.has(code) && !(code in UNMAPPED_WITH_REASON))
                .sort();

            expect(silentGaps).toEqual([]);
        },
    );

    it('the unmapped list carries a real reason for every entry and no stale codes', () => {
        const allAgenticCodes = new Set(
            AGENTIC_FRAMEWORKS.flatMap((f) => [...ASSESSABLE_CODES[f]]),
        );
        for (const [code, reason] of Object.entries(UNMAPPED_WITH_REASON)) {
            expect(allAgenticCodes.has(code)).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });

    it('the ISO 42001 → OWASP ASI map is substantive, not a token', () => {
        const set = setsByPair.get('ISO42001-2023→OWASP-ASI-TOP10');
        expect(set).toBeDefined();
        // Every one of the ten risks has an ISO 42001 route of its own — this
        // is the specific map the "not starting at zero" claim rests on.
        const targets = new Set(set!.mapping_entries.map((e) => e.target_ref));
        expect([...targets].sort()).toEqual([...ASSESSABLE_CODES['OWASP-ASI-TOP10']].sort());
        expect(set!.mapping_entries.length).toBeGreaterThanOrEqual(30);
        // More than one strength: a file where every edge is RELATED would pass
        // the coverage check above while making no coverage claim at all.
        expect(new Set(set!.mapping_entries.map((e) => e.strength)).size).toBeGreaterThanOrEqual(3);
    });
});

describe('agentic cross-framework mappings — both representations, not just the library', () => {
    /**
     * INVARIANT 5. Every framework ships TWICE — the `prisma/seed.ts` row and
     * the `src/data/libraries/*.yaml` row — and a tenant's controls hang off
     * whichever one its database got. A mapping set is authored against the
     * LIBRARY (the importer resolves `source_framework_ref` against
     * `Framework.key`), so an edge whose code has no counterpart in the seeded
     * representation delivers nothing to a seeded tenant, and delivers it
     * silently: the readout is the same ten NOT_COVERED a tenant with no
     * controls sees.
     *
     * That is not hypothetical. `iso27001-to-owasp-agentic.yaml` shipped with
     * 39 resolving edges and reached zero seeded tenants, because the seed
     * numbers Annex A `5.15` where the library numbers it `A.5.15` — a break
     * every existing check was blind to, because each file is internally
     * consistent and the integration suite only ever built the ISO 42001
     * shape, where the two representations happen to agree.
     */
    it('names a seeded representation for every framework in an agentic mapping', () => {
        const referenced = new Set(
            agenticSets.flatMap((s) => [s.source_framework_ref, s.target_framework_ref]),
        );
        const undeclared = [...referenced].filter((f) => !(f in SEEDED_REPRESENTATIONS)).sort();
        expect(undeclared).toEqual([]);
    });

    it.each(agenticSets)(
        '$source_framework_ref → $target_framework_ref resolves against the SEED fixtures too',
        (set) => {
            const unreachable: string[] = [];
            for (const [frameworkRef, refs] of [
                [set.source_framework_ref, set.mapping_entries.map((e) => e.source_ref)],
                [set.target_framework_ref, set.mapping_entries.map((e) => e.target_ref)],
            ] as Array<[string, string[]]>) {
                const seeded = seededCodes(frameworkRef);
                const { familyUrn } = SEEDED_REPRESENTATIONS[frameworkRef];
                for (const ref of new Set(refs)) {
                    // The same reconciliation `computeAgentRiskCoverage` does:
                    // one join key both spellings of an obligation reduce to.
                    if (!seeded.has(canonicalRequirementCode(familyUrn, ref))) {
                        unreachable.push(`${frameworkRef}:${ref}`);
                    }
                }
            }
            expect(unreachable.sort()).toEqual([]);
        },
    );
});

describe('agentic cross-framework mappings — symmetry', () => {
    it.each(agenticSets)(
        '$source_framework_ref → $target_framework_ref ships its exact transpose with inverted strengths',
        (set) => {
            const reverse = setsByPair.get(`${set.target_framework_ref}→${set.source_framework_ref}`);
            expect(reverse).toBeDefined();

            const expected = new Set(
                set.mapping_entries.map(
                    (e) => `${e.target_ref}|${e.source_ref}|${INVERSE[e.strength as MappingStrengthValue]}`,
                ),
            );
            expect([...entryTriples(reverse!)].sort()).toEqual([...expected].sort());
        },
    );

    it('inverts SUBSET ⇄ SUPERSET rather than copying the strength across', () => {
        // A transpose that simply copied strengths would satisfy the check
        // above for every self-inverse strength, so the directional pair has to
        // be present and observed somewhere in the shipped data.
        const forward = setsByPair.get('ISO42001-2023→OWASP-ASI-TOP10')!;
        const reverse = setsByPair.get('OWASP-ASI-TOP10→ISO42001-2023')!;

        const subsets = forward.mapping_entries.filter((e) => e.strength === 'SUBSET');
        expect(subsets.length).toBeGreaterThan(0);

        for (const entry of subsets) {
            const mirrored = reverse.mapping_entries.find(
                (e) => e.source_ref === entry.target_ref && e.target_ref === entry.source_ref,
            );
            expect(mirrored?.strength).toBe('SUPERSET');
        }
    });
});

describe('agentic cross-framework mappings — refs and strengths', () => {
    it.each(agenticSets)(
        '$source_framework_ref → $target_framework_ref references only assessable requirements that exist in the libraries',
        (set) => {
            const dangling: string[] = [];
            for (const entry of set.mapping_entries) {
                if (!ASSESSABLE_CODES[set.source_framework_ref]?.has(entry.source_ref)) {
                    dangling.push(`source ${set.source_framework_ref}:${entry.source_ref}`);
                }
                if (!ASSESSABLE_CODES[set.target_framework_ref]?.has(entry.target_ref)) {
                    dangling.push(`target ${set.target_framework_ref}:${entry.target_ref}`);
                }
            }
            expect(dangling).toEqual([]);
        },
    );

    it.each(agenticSets)(
        '$source_framework_ref → $target_framework_ref uses valid, conservative strengths and explains every entry',
        (set) => {
            for (const entry of set.mapping_entries) {
                expect(MAPPING_STRENGTHS).toContain(entry.strength);
                expect(entry.strength).not.toBe('EQUAL');
                expect(entry.rationale ?? '').not.toHaveLength(0);
                expect((entry.rationale ?? '').length).toBeGreaterThan(20);
            }
        },
    );

    it('no mapping set maps a requirement onto itself', () => {
        const selfEdges = agenticSets.flatMap((s) =>
            s.mapping_entries
                .filter(
                    (e) =>
                        s.source_framework_ref === s.target_framework_ref &&
                        e.source_ref === e.target_ref,
                )
                .map((e) => `${s.urn}:${e.source_ref}`),
        );
        expect(selfEdges).toEqual([]);
    });
});
