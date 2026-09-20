import fs from 'node:fs';
import path from 'node:path';
import { parseLibraryFile } from '../../src/app-layer/libraries/library-loader';

/**
 * Every obligation a grounding library declares must reach the catalogue that
 * ships it, or be declared out of scope here with a reason.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * ISO 27701 shipped for its whole life without 18 of the 43 obligations its own
 * library declares — the whole of 7.3.1, 7.3.7, 7.3.10, 7.4.2, 7.4.3, 7.4.9,
 * 7.5.3, 7.5.4 and ten clause-8 controls. A tenant installing ISO27701_CORE
 * received no obligation for any of them.
 *
 * It was a REGRESSION, not an omission, and that is the part worth keeping.
 * `prisma/fixtures/iso27701_requirements.json` holds all 55 library keys and
 * was loaded by `prisma/seed.ts` until #2363 replaced that path with the
 * fixture. That PR proved parity on what it thought to count — "PIMS- templates
 * 10 / 10, authored tasks 357 / 357" — and the requirement-row delta, 55 down to
 * 26, was measured by nobody. Every per-framework coverage guard in this repo
 * asserts counts against THE FIXTURE, so the fixture agreeing with itself is
 * all any of them ever checked.
 *
 * ═══ WHY THE JOIN IS DECLARED PER PAIR AND NOT INFERRED ═══
 *
 * The obvious form of this check — compare library ref_ids to fixture
 * requirement codes — is wrong, and its wrongness is invisible. For NIS2 the
 * library is keyed `NIS2-RM` and the fixture `Art.21(2)(a)`, so a spelling join
 * resolves ZERO of 20 and reports twelve missing obligations. Every one is a
 * false positive: the fixture rows are the library nodes re-keyed, and ten of
 * the twelve descriptions are byte-identical on both sides.
 *
 * A spelling join CANNOT TELL "genuinely absent" FROM "present under another
 * name". Both come back as "no match". So each pair declares how its two sides
 * join, and `assertJoinResolves` below refuses a declaration under which almost
 * nothing matches — because that is what a wrong declaration looks like, and
 * silently reading it as "everything is missing" or "nothing is comparable" is
 * the same defect one level up.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(REPO_ROOT, 'src/data/libraries');
const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

type Join =
    /** ref_id and requirement code are the same string. */
    | { kind: 'exact' }
    /** The library prefixes what the fixture does not, e.g. `A.5.1` vs `5.1`. */
    | { kind: 'normalised'; strip: RegExp; why: string }
    /** The fixture deliberately ships one tier, named by the library's own `category`. */
    | { kind: 'tier'; category: string; why: string }
    /** The two sides are re-keyed; a map file in the repo IS the join. */
    | { kind: 'mapped'; mapFile: string; why: string };

interface Pair {
    library: string;
    join: Join;
    /** Library obligations deliberately not shipped, each with a reason. */
    excluded?: Record<string, string>;
}

const PAIRS: Record<string, Pair> = {
    'iso27701-control-templates.json': { library: 'iso27701-2019.yaml', join: { kind: 'exact' } },
    'dora-control-templates.json': { library: 'dora-2022.yaml', join: { kind: 'exact' } },
    'eu-ai-act-control-templates.json': { library: 'eu-ai-act.yaml', join: { kind: 'exact' } },
    'imda-mgf-control-templates.json': { library: 'imda-mgf-2026.yaml', join: { kind: 'exact' } },
    'iso42001-control-templates.json': { library: 'iso-42001.yaml', join: { kind: 'exact' } },
    'nist-privacy-control-templates.json': { library: 'nist-privacy-framework-1.0.yaml', join: { kind: 'exact' } },
    'ssdf-control-templates.json': { library: 'nist-ssdf-800-218.yaml', join: { kind: 'exact' } },
    'owasp-aisvs-control-templates.json': { library: 'owasp-aisvs-1.0.yaml', join: { kind: 'exact' } },
    'owasp-asi-control-templates.json': { library: 'owasp-agentic-top10.yaml', join: { kind: 'exact' } },

    'iso27001-control-templates.json': {
        library: 'iso27001-2022.yaml',
        join: {
            kind: 'normalised',
            strip: /^A\./,
            why: 'The library spells Annex A controls `A.5.1`; the fixture spells them `5.1`. The strip is injective here and cannot collide: the library holds the seven ISMS clauses as bare `4`…`10` with no sub-clauses, so no library code already has the `<n>.<n>` shape the strip produces.',
        },
    },

    'asvs-l1-control-templates.json': {
        library: 'owasp-asvs-4.0.3.yaml',
        join: {
            kind: 'tier',
            category: 'L1',
            why: 'The shipped catalogue is ASVS Level 1 only. The library carries all three levels and states in its own header that a node\'s level lives in `category`.',
        },
    },

    'cis-v8-ig1-control-templates.json': {
        library: 'cis-controls-v8.yaml',
        join: {
            kind: 'tier',
            category: 'IG1',
            why: 'The shipped catalogue is Implementation Group 1 only; the library carries IG1/IG2/IG3 in `category`.',
        },
    },

    'nis2-control-templates.json': {
        library: 'nis2-2022.yaml',
        join: {
            kind: 'mapped',
            mapFile: 'nis2-library-map.json',
            why: 'The library is keyed thematically (`NIS2-RM`) and the fixture by Directive article (`Art.21(2)(a)`). Same obligations, different naming schemes — so the repo carries the join as data rather than leaving a scan to guess. Derived from the `(Paraphrase — Art. …)` citation each library node states in its own description.',
        },
    },

    'soc2-control-templates.json': {
        library: 'soc2-2017.yaml',
        join: { kind: 'exact' },
        excluded: {
            A1: 'Availability — an optional Trust Services category. The shipped catalogue is the Common Criteria (Security) only.',
            C1: 'Confidentiality — optional TSC category, as A1.',
            P1: 'Privacy — optional TSC category, as A1.',
            PI1: 'Processing Integrity — optional TSC category, as A1.',
        },
    },
};

interface Obligation {
    refId: string;
    category?: string;
}

function libraryObligations(file: string): Obligation[] {
    const lib = parseLibraryFile(path.join(LIB_DIR, file));
    return lib.objects.framework.requirement_nodes
        .filter((n) => n.assessable !== false && typeof n.ref_id === 'string')
        .map((n) => ({ refId: (n.ref_id as string).trim(), category: n.category }))
        .filter((o) => o.refId !== lib.ref_id.trim());
}

function fixtureCodes(file: string): Set<string> {
    const f = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8')) as {
        requirements?: Array<{ code: string }>;
    };
    return new Set((f.requirements ?? []).map((r) => r.code));
}

/** The obligations THIS fixture is supposed to ship, after the declared join. */
function inScope(pair: Pair): string[] {
    const all = libraryObligations(pair.library);
    const excluded = new Set(Object.keys(pair.excluded ?? {}));
    const kept = all.filter((o) => !excluded.has(o.refId));
    switch (pair.join.kind) {
        case 'exact':
            return kept.map((o) => o.refId);
        case 'normalised': {
            const { strip } = pair.join;
            return kept.map((o) => o.refId.replace(strip, ''));
        }
        case 'tier': {
            const { category } = pair.join;
            return kept.filter((o) => o.category === category).map((o) => o.refId);
        }
        case 'mapped':
            // The map file IS the join; membership is asserted separately below.
            return [];
    }
}

const entries = Object.entries(PAIRS);

describe('every library obligation reaches the catalogue that ships it', () => {
    it('is looking at something, and at every pair that exists', () => {
        // DENOMINATOR GUARD. A shrinking pair list would make every assertion
        // below pass over less, which is the failure this file exists to stop.
        expect(entries.length).toBeGreaterThanOrEqual(14);

        // A library that has a fixture must be declared. This is what makes a
        // NEW framework arrive checked rather than arrive unnoticed.
        const declaredLibs = new Set(entries.map(([, p]) => p.library));
        const undeclared = fs
            .readdirSync(LIB_DIR)
            .filter((f) => f.endsWith('.yaml'))
            .filter((f) => !declaredLibs.has(f))
            // gdpr and nist-csf ship no catalogue of their own; they are
            // crosswalk targets. If either gains a fixture, declare it here.
            //
            // coso-icf-2013 is a THIRD kind and is excluded for a different
            // reason: it will gain a fixture, in the content PRs that follow the
            // framework one. Its 17 principles exist so controls can link to
            // them; until those controls are authored there is no catalogue for
            // this guard to compare against. The moment the fixture lands, this
            // entry must be DELETED rather than left — leaving it would hide the
            // very comparison the fixture makes possible, which is the failure
            // mode of every "temporary" exclusion.
            .filter((f) => !['gdpr.yaml', 'nist-csf-2.0.yaml', 'coso-icf-2013.yaml'].includes(f));
        expect(undeclared).toEqual([]);
    });

    it.each(entries)('%s ships every obligation its library declares', (fixture, pair) => {
        if (pair.join.kind === 'mapped') return; // asserted by its own case below
        const codes = fixtureCodes(fixture);
        const missing = inScope(pair).filter((c) => !codes.has(c)).sort();
        expect(missing).toEqual([]);
    });

    it.each(entries)('%s — the declared join actually resolves', (fixture, pair) => {
        if (pair.join.kind === 'mapped') return;
        const codes = fixtureCodes(fixture);
        const scope = inScope(pair);
        const matched = scope.filter((c) => codes.has(c)).length;

        // THE NIS2 LESSON. A join that resolves almost nothing is a WRONG
        // DECLARATION, not a catalogue with everything missing — and the two
        // are indistinguishable from the miss count alone. Asserting the
        // resolution rate separately means a re-keying can never be read as a
        // gap, nor a gap as a re-keying.
        expect({ fixture, matched, of: scope.length }).toEqual({
            fixture,
            matched: scope.length,
            of: scope.length,
        });
    });

    it('the NIS2 map is the join, and it covers every obligation', () => {
        const pair = PAIRS['nis2-control-templates.json'];
        if (pair.join.kind !== 'mapped') throw new Error('nis2 join is no longer mapped');
        const map = JSON.parse(
            fs.readFileSync(path.join(FIXTURE_DIR, pair.join.mapFile), 'utf-8'),
        ) as { map?: Record<string, unknown>; unmapped?: Record<string, unknown> };

        const accounted = new Set([
            ...Object.values(map.map ?? {}).map((v) =>
                typeof v === 'string' ? v : (v as { libraryRefId?: string }).libraryRefId,
            ),
            ...Object.keys(map.unmapped ?? {}),
        ]);

        // Every assessable library node is either mapped to a template or
        // written down as deliberately unmapped. Neither list may go silent.
        const unaccounted = libraryObligations(pair.library)
            .map((o) => o.refId)
            .filter((r) => !accounted.has(r))
            .sort();
        expect(unaccounted).toEqual([]);
    });

    it('every exclusion names a real library obligation', () => {
        // An exclusion for a code the library no longer declares is a record
        // that has outlived its subject — it reads as a live carve-out and
        // guards nothing.
        const stale: string[] = [];
        for (const [fixture, pair] of entries) {
            const declared = new Set(libraryObligations(pair.library).map((o) => o.refId));
            for (const code of Object.keys(pair.excluded ?? {})) {
                if (!declared.has(code)) stale.push(`${fixture}: ${code}`);
            }
        }
        expect(stale).toEqual([]);
    });

    it('the check can actually fail', () => {
        // MUTATION PROOF. Every assertion above is a `toEqual([])` over a
        // filter, which a broken parse satisfies as happily as a complete
        // catalogue. Drop one shipped code and require the miss to be seen.
        const pair = PAIRS['iso27701-control-templates.json'];
        const codes = fixtureCodes('iso27701-control-templates.json');
        const scope = inScope(pair);
        const victim = scope.find((c) => codes.has(c));
        expect(victim).toBeDefined();

        // Baseline-relative on purpose. A proof written as
        // `expect(missing).toEqual([victim])` silently assumes the catalogue is
        // already complete, so it would fail for a reason that has nothing to do
        // with whether the detector works — and it did, while ISO 27701 was
        // still short its 18. The claim is that deleting a code adds EXACTLY
        // that code to the miss list, whatever the list held before.
        const before = scope.filter((c) => !codes.has(c));
        codes.delete(victim as string);
        const after = scope.filter((c) => !codes.has(c));
        expect(after.filter((c) => !before.includes(c))).toEqual([victim]);
    });
});
