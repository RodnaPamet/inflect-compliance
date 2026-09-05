/**
 * Agentic-framework content ratchet — OWASP Agentic AI Top 10 + IMDA MGF.
 *
 * These two frameworks exist because NIST AI RMF, ISO/IEC 42001 and the EU AI
 * Act govern AI as a content producer and carry no control set for AI that
 * ACTS. That makes their requirement identifiers a customer-facing contract:
 * an assessor citing ASI04 must resolve to the same FrameworkRequirement row
 * forever, whatever OWASP later calls that risk.
 *
 * So the invariant this guard holds is the KEY SET, not the prose:
 *
 *   - the OWASP library carries EXACTLY ten assessable requirements, keyed
 *     ASI01…ASI10 in order — an upstream revision that adds, drops or renumbers
 *     a risk turns this red and forces a deliberate update rather than a silent
 *     drift in what a customer's evidence is pinned to;
 *   - the IMDA library carries the four governance dimensions as grouping nodes
 *     with every assessable requirement hanging off one of them, and covers the
 *     three May-2026 additions (multi-agent systems, third-party agents,
 *     automation bias);
 *   - the seed fixtures and the YAML libraries — the two representations this
 *     repo keeps for every framework — hold the SAME key set, so seeding and
 *     library-import cannot disagree about what ASI04 is;
 *   - neither framework is special-cased in the install/catalog usecases: both
 *     ride the generic library-import machinery.
 *
 * Everything here is asserted against PARSED DATA (the loaded library, the
 * fixture JSON) or a computed value — never by grepping prose for names.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');

const load = (file: string) => loadLibrary(parseLibraryFile(path.join(LIB_DIR, file)), file);
const fixture = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'prisma/fixtures', file), 'utf8')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

const asi = load('owasp-agentic-top10.yaml');
const mgf = load('imda-mgf-2026.yaml');

const assessableCodes = (lib: typeof asi) =>
    lib.framework.nodes.filter((n) => n.assessable).map((n) => n.refId);

/** The ten canonical OWASP agentic risk identifiers, in publication order. */
const ASI_CODES = [
    'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
    'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
];

describe('OWASP Agentic AI Top 10 — owasp-agentic-top10.yaml', () => {
    it('is an INDUSTRY_STANDARD keyed on the edition-free ref_id', () => {
        // No edition suffix on purpose: a revised Top 10 must re-import OVER
        // this framework (content-hash update), not fork a second one and
        // strand every assessment pinned to the first.
        expect(asi.refId).toBe('OWASP-ASI-TOP10');
        expect(asi.kind).toBe('INDUSTRY_STANDARD');
        expect(asi.provider).toBe('OWASP');
    });

    it('carries exactly ten assessable risks keyed ASI01…ASI10, in order', () => {
        expect(assessableCodes(asi)).toEqual(ASI_CODES);
    });

    it('has no non-assessable filler — every node in the framework IS a risk', () => {
        expect(asi.framework.nodes.map((n) => n.refId)).toEqual(ASI_CODES);
    });

    it('every risk carries a title and a governance description', () => {
        for (const code of ASI_CODES) {
            const node = asi.framework.nodesByRefId.get(code);
            expect(node).toBeDefined();
            expect((node!.name ?? '').length).toBeGreaterThan(3);
            // Substantive enough to assess against, short enough not to be a
            // verbatim paste of the CC-BY-SA-4.0 source.
            expect((node!.description ?? '').length).toBeGreaterThan(60);
        }
    });

    it('attributes OWASP under CC-BY-SA-4.0 as a reference index', () => {
        const copyright = (asi.copyright ?? '').toLowerCase();
        const claims = {
            attributesOwasp: copyright.includes('owasp'),
            namesTheLicense: copyright.includes('cc-by-sa-4.0'),
            declaresIndexNotCopy: copyright.includes('index'),
        };
        expect(claims).toEqual({
            attributesOwasp: true,
            namesTheLicense: true,
            declaresIndexNotCopy: true,
        });
    });
});

describe('IMDA Model AI Governance Framework — imda-mgf-2026.yaml', () => {
    const DIMENSIONS = ['MGF-D1', 'MGF-D2', 'MGF-D3', 'MGF-D4'];

    it('is an INDUSTRY_STANDARD attributed to IMDA', () => {
        expect(mgf.refId).toBe('IMDA-MGF-2026');
        expect(mgf.kind).toBe('INDUSTRY_STANDARD');
        expect(mgf.provider).toBe('IMDA Singapore');
    });

    it('models the four governance dimensions as grouping nodes with children', () => {
        const shape = DIMENSIONS.map((d) => {
            const node = mgf.framework.nodesByRefId.get(d);
            return {
                dimension: d,
                present: node !== undefined,
                grouping: node?.assessable === false,
                hasChildren: (node?.childUrns.length ?? 0) > 0,
            };
        });
        expect(shape).toEqual(
            DIMENSIONS.map((d) => ({ dimension: d, present: true, grouping: true, hasChildren: true })),
        );
    });

    it('every assessable requirement hangs off exactly one dimension', () => {
        const dimensionUrns = new Set(
            DIMENSIONS.map((d) => mgf.framework.nodesByRefId.get(d)!.urn),
        );
        const orphans = mgf.framework.nodes
            .filter((n) => n.assessable)
            .filter((n) => !n.parentUrn || !dimensionUrns.has(n.parentUrn))
            .map((n) => n.refId);
        expect(orphans).toEqual([]);
    });

    it('requirement keys are the stable MGF-<dimension>.<n> shape and unique', () => {
        const codes = assessableCodes(mgf);
        expect(codes.length).toBeGreaterThanOrEqual(16);
        expect(new Set(codes).size).toBe(codes.length);
        expect(codes.filter((c) => !/^MGF-[1-4]\.\d+$/.test(c))).toEqual([]);
    });

    it('covers the three May-2026 agentic additions', () => {
        // Multi-agent systems, third-party agents, and automation bias are what
        // the May 2026 revision adds; a future revision that drops one of these
        // requirements should be a deliberate edit, not an accident.
        const covered = ['MGF-1.4', 'MGF-1.5', 'MGF-2.4', 'MGF-3.6'].map((code) => ({
            code,
            present: mgf.framework.nodesByRefId.get(code)?.assessable === true,
        }));
        expect(covered.every((c) => c.present)).toBe(true);
    });

    it('declares that its requirement identifiers are packager-assigned, not IMDA clause numbers', () => {
        // The MGF publishes narrative guidance, so there is no upstream clause
        // number to mirror. Saying so in the library is what stops a later
        // reader citing MGF-3.4 to IMDA as if it were their numbering.
        const copyright = (mgf.copyright ?? '').toLowerCase();
        expect({
            attributesImda: copyright.includes('imda') || copyright.includes('infocomm'),
            disclaimsClauseNumbering: copyright.includes('not imda clause numbers'),
        }).toEqual({ attributesImda: true, disclaimsClauseNumbering: true });
    });
});

describe('Seed fixtures agree with the libraries (two representations in sync)', () => {
    const cases = [
        { name: 'OWASP Agentic AI Top 10', lib: asi, file: 'owasp_asi_requirements.json' },
        { name: 'IMDA MGF', lib: mgf, file: 'imda_mgf_requirements.json' },
    ];

    for (const c of cases) {
        describe(c.name, () => {
            const rows = fixture(c.file);

            it('holds exactly the library assessable key set', () => {
                expect(rows.map((r) => r.key)).toEqual(assessableCodes(c.lib));
            });

            it('every row carries the library title, a section and a unique sort order', () => {
                const drift = rows.filter(
                    (r) => r.title !== c.lib.framework.nodesByRefId.get(r.key)?.name,
                ).map((r) => r.key);
                expect(drift).toEqual([]);
                expect(rows.filter((r) => !r.section).map((r) => r.key)).toEqual([]);
                expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(rows.length);
            });
        });
    }

    it('the OWASP fixture is the ten canonical risks — the seed cannot disagree with the library', () => {
        expect(fixture('owasp_asi_requirements.json').map((r) => r.key)).toEqual(ASI_CODES);
    });
});

describe('Both frameworks ride the generic framework machinery', () => {
    it('neither is special-cased in the install or catalog usecases', () => {
        // Computed value, not a source-text matcher: the assertion is "no
        // usecase names either framework", and the failure prints which does.
        const NEEDLES = ['OWASP-ASI', 'IMDA-MGF', 'owasp-agentic-top10', 'imda-mgf'];
        const offenders: string[] = [];
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const needle of NEEDLES) {
                if (src.includes(needle)) offenders.push(`${rel}: ${needle}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
