/**
 * Agentic-framework content ratchet — OWASP Agentic AI Top 10, IMDA MGF and
 * AIUC-1 (the AIUC-1 section below carries its own reasoning).
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

import { loadCatalogFile } from '../../prisma/catalog-loader';
import { appliedSources } from '../helpers/applied-catalogue';

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

/*
 * ═══ AIUC-1 ═══
 *
 * The third agentic framework, and the only one a customer is CERTIFIED
 * against. Its identifiers (A001 … F002) are AIUC's own and the contract a
 * customer's auditor cites, so the same invariant holds as for ASI and MGF —
 * the key set — plus three AIUC-1 shapes the generic guards cannot know:
 *
 *   - THE GAPS ARE PART OF THE SET. AIUC-1 retires a requirement rather than
 *     renumbering, so the Q4-2026 identifiers have five holes (C011, C012,
 *     D002 folded into C010/D004; E007, E014 retired earlier). Set equality
 *     makes restoring one to tidy the numbering fail by name.
 *   - APPLICABILITY IS A CHECKED CLAIM. Eight requirements are optional and
 *     fifteen capability-scoped; the importer persists only the description,
 *     so that is where the facts live, pinned here in both directions.
 *   - ONE ROW, TWO WRITERS. The CatalogFile declares the library key and its
 *     requirements are generated from the library, so both writers converge
 *     on one Framework row; parity is asserted field for field here and by
 *     row id in tests/integration/aiuc-1-framework-import.test.ts.
 *
 * Licensing: AIUC-1 is (c) AIUC, all rights reserved, and its terms forbid
 * derivative works, so only identifiers and short titles are carried. The
 * last assertion catches AIUC's control-activity ids or evidence-guidance
 * phrasing pasted in; it cannot judge a paraphrase that sits too close, which
 * is what docs/implementation-notes/2026-10-24-aiuc-1-framework.md records as
 * measured once and left to legal review.
 */
describe('AIUC-1 — aiuc-1.yaml and its catalogue', () => {
    const library = load('aiuc-1.yaml');
    const stored = parseLibraryFile(path.join(LIB_DIR, 'aiuc-1.yaml'));
    const nodes = library.framework.nodes;
    const assessable = nodes.filter((n) => n.assessable);
    const domains = nodes.filter((n) => !n.assessable);
    const catalog = loadCatalogFile(path.join(ROOT, 'prisma/fixtures/aiuc-1-control-templates.json'));

    /** The six domains, as the standard names them. */
    const DOMAINS: Readonly<Record<string, string>> = {
        A: 'Data & Privacy',
        B: 'Security',
        C: 'Safety',
        D: 'Reliability',
        E: 'Accountability',
        F: 'Society',
    };

    /** The Q4-2026 (15 October 2026) requirements in force. */
    const IN_FORCE: Readonly<Record<string, readonly string[]>> = {
        A: ['A001', 'A002', 'A003', 'A004', 'A005', 'A006', 'A007', 'A008', 'A009'],
        B: ['B001', 'B002', 'B003', 'B004', 'B005', 'B006', 'B007', 'B008', 'B009', 'B010'],
        C: ['C001', 'C002', 'C003', 'C004', 'C005', 'C006', 'C007', 'C008', 'C009', 'C010'],
        D: ['D001', 'D003', 'D004'],
        E: [
            'E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E008', 'E009',
            'E010', 'E011', 'E012', 'E013', 'E015', 'E016', 'E017', 'E018',
        ],
        F: ['F001', 'F002'],
    };
    const ALL_CODES = Object.values(IN_FORCE).flat();

    /** Retired upstream. Absent on purpose — see the docblock. */
    const RETIRED = ['C011', 'C012', 'D002', 'E007', 'E014'];

    /** Requirements AIUC-1 classes as optional rather than mandatory. */
    const OPTIONAL = ['B002', 'B003', 'B005', 'C007', 'C008', 'C009', 'E013', 'E017'];

    /**
     * Requirements AIUC-1 scopes to agent capabilities, and the exact scope clause
     * each description must carry ("… Applies to <scope>.").
     *
     * AIUC tags a requirement with one or more of Text-, Voice-, Image- and
     * Code-generation, Automation and External-facing; a requirement with several
     * tags applies to an agent holding ANY of them, so the clause lists them all.
     * Compared whole, not by substring: the first version of this content said
     * "agents that generate text" for C003 where AIUC tags text, voice AND image
     * generation, and a substring check would have passed it.
     */
    const CAPABILITY_SCOPE: Readonly<Record<string, string>> = {
        A007: 'externally facing agents',
        E002: 'externally facing agents',
        E003: 'externally facing agents',
        A008: 'agents that generate code',
        B010: 'agents that generate code',
        B006: 'agents that take actions',
        D003: 'agents that take actions',
        B005: 'agents that generate text, speech or images',
        B009: 'agents that generate text, speech or images',
        C003: 'agents that generate text, speech or images',
        F002: 'agents that generate text, speech or images',
        C004: 'agents that generate text or speech',
        C006: 'agents that generate code, text or speech',
        D001: 'agents that generate text, speech or code',
        F001: 'agents that generate text, speech or code, or that take actions',
    };

    /**
     * AIUC-1's evidence cadence. Every three months for these; E012 is every six,
     * and QUARTERLY is the tightest value the frequency enum has that still meets it
     * (there is no semi-annual value). Everything else is every twelve months.
     */
    const QUARTERLY = ['A009', 'B001', 'B002', 'B007', 'C006', 'C009', 'C010', 'D004', 'E012', 'E018'];

    /** The house role set (docs/control-task-authoring.md). */
    const ROLES = [
        'IT Operations', 'Security engineering', 'Engineering lead', 'HR', 'Legal/DPO',
        'Facilities', 'Management', 'Procurement',
    ];

    /** The bands COSO was held to — the measured distribution of the shipped catalogue. */
    const BANDS = {
        objective: [130, 200],
        successCriteria: [420, 620],
        testingMethodology: [1000, 1800],
    } as const;

    const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const domainOf = (code: string) => code.charAt(0);
    const domainLabel = (letter: string) => `${letter}. ${DOMAINS[letter]}`;

    describe('the AIUC-1 library carries exactly the requirements in force', () => {
        it('is 56 nodes: 6 domains and 50 requirements', () => {
            expect({ total: nodes.length, domains: domains.length, requirements: assessable.length })
                .toEqual({ total: 56, domains: 6, requirements: 50 });
        });

        it('carries the Q4-2026 identifiers by set equality, gaps included', () => {
            expect(assessable.map((n) => n.refId).sort()).toEqual([...ALL_CODES].sort());
        });

        it('carries none of the retired identifiers', () => {
            const codes = new Set(nodes.map((n) => n.refId));
            expect(RETIRED.filter((c) => codes.has(c))).toEqual([]);
        });

        it('splits them A 9 / B 10 / C 10 / D 3 / E 16 / F 2', () => {
            const per: Record<string, number> = {};
            for (const n of assessable) per[domainOf(n.refId)] = (per[domainOf(n.refId)] ?? 0) + 1;
            expect(per).toEqual({ A: 9, B: 10, C: 10, D: 3, E: 16, F: 2 });
        });

        it('hangs every requirement under the domain its identifier names, with that domain as its section', () => {
            const byUrn = new Map(nodes.map((n) => [n.urn, n]));
            const misplaced = assessable
                .filter((n) => {
                    const parent = n.parentUrn ? byUrn.get(n.parentUrn) : undefined;
                    return parent?.refId !== domainOf(n.refId) || n.section !== domainLabel(domainOf(n.refId));
                })
                .map((n) => n.refId);
            expect(misplaced).toEqual([]);
        });

        it('names the six domains as the standard does', () => {
            expect(Object.fromEntries(domains.map((d) => [d.refId, d.name]))).toEqual(DOMAINS);
        });

        it('carries no edition in its key, because AIUC-1 is revised in place every quarter', () => {
            // With the edition in the key, each quarterly release would import as a
            // second framework and strand every link pinned to the first.
            expect(library.refId).toBe('AIUC-1');
        });

        it('describes every requirement in distinct prose of real length', () => {
            const short = assessable.filter((n) => flat(n.description).length < 150).map((n) => n.refId);
            const seen = new Map<string, string>();
            const dupes: string[] = [];
            for (const n of assessable) {
                const key = flat(n.description).toLowerCase();
                const prior = seen.get(key);
                if (prior) dupes.push(`${prior} / ${n.refId}`);
                else seen.set(key, n.refId);
            }
            expect({ short, dupes }).toEqual({ short: [], dupes: [] });
        });
    });

    describe('applicability is stated exactly where AIUC-1 states it', () => {
        const desc = new Map(assessable.map((n) => [n.refId, flat(n.description).toLowerCase()]));

        it('says "optional under AIUC-1" on the eight optional requirements and nowhere else', () => {
            const saysOptional = ALL_CODES.filter((c) => desc.get(c)?.includes('optional under aiuc-1'));
            expect(saysOptional.sort()).toEqual([...OPTIONAL].sort());
        });

        it('states the exact capability scope on the fifteen scoped requirements and nowhere else', () => {
            const stated: Record<string, string> = {};
            for (const c of ALL_CODES) {
                const scopes = [...(desc.get(c) ?? '').matchAll(/\bapplies to ([^.]+)\./g)].map((m) => m[1]);
                if (scopes.length > 0) stated[c] = scopes.join(' | ');
            }
            expect(stated).toEqual(CAPABILITY_SCOPE);
        });
    });

    describe('the catalogue and the library describe one framework', () => {
        it('declares the library key, so both writers converge on ONE Framework row', () => {
            expect({ key: catalog.framework.key, sourceUrn: catalog.framework.sourceUrn })
                .toEqual({ key: library.refId, sourceUrn: library.urn });
        });

        it('carries the library requirements verbatim, in library order', () => {
            // Field for field, because both writers upsert the same row: a title or
            // description that differed would flip on every alternate write.
            const fromLibrary = assessable.map((n, i) => ({
                code: n.refId,
                title: n.name,
                summary: n.description,
                section: n.section,
                category: n.section,
                sortOrder: i,
            }));
            const fromCatalog = catalog.requirements.map((r) => ({
                code: r.code,
                title: r.title,
                summary: r.summary,
                section: r.section,
                category: r.category,
                sortOrder: r.sortOrder,
            }));
            expect(fromCatalog).toEqual(fromLibrary);
        });

        it('carries its provenance into the database row', () => {
            const meta = catalog.framework.metadata ?? {};
            expect({
                provider: meta.provider,
                publicationDate: meta.publicationDate,
                notLegalAdvice: meta.notLegalAdvice,
                identifiersAssignedByPackager: meta.identifiersAssignedByPackager,
            }).toEqual({
                provider: stored.provider,
                publicationDate: stored.publication_date,
                notLegalAdvice: true,
                // AIUC assigns these identifiers — unlike IMDA MGF, whose are ours.
                identifiersAssignedByPackager: false,
            });
        });

        it('is applied by a seeder that runs on every production start', () => {
            // Asked through appliedSources(), which follows entrypoint.sh -> seeder
            // -> fixture, so a commented-out registration cannot satisfy it.
            const applied = appliedSources().filter((s) => s.reachesProduction);
            expect(applied.length).toBeGreaterThan(0);
            expect(applied.filter((s) => s.text.includes('aiuc-1-control-templates.json')).length).toBeGreaterThan(0);
        });
    });

    describe('one authored control per requirement', () => {
        const templates = catalog.templates;
        const reqTitle = new Map(assessable.map((n) => [n.refId, n.name]));

        it('maps every requirement to exactly one template, keyed on its identifier', () => {
            const pairs = templates.map((t) => `${t.code}->${(t.requirementCodes ?? []).join(',')}`).sort();
            expect(pairs).toEqual(ALL_CODES.map((c) => `AIUC-${c}->${c}`).sort());
        });

        it('installs all fifty through the baseline pack', () => {
            expect({ key: catalog.pack?.key, codes: [...(catalog.pack?.templateCodes ?? [])].sort() })
                .toEqual({ key: 'AIUC_1_BASELINE', codes: ALL_CODES.map((c) => `AIUC-${c}`).sort() });
        });

        it('files each template under its framework-qualified domain', () => {
            // Qualified because the Controls category filter keys on the bare
            // string: a plain "Security" would merge with any other framework's.
            const wrong = templates
                .filter((t) => t.category !== `AIUC-1 ${DOMAINS[domainOf(t.requirementCodes[0])]}`)
                .map((t) => `${t.code}: ${t.category}`);
            expect(wrong).toEqual([]);
        });

        it('runs each control on the cadence AIUC-1 evidences it', () => {
            const actual = Object.fromEntries(templates.map((t) => [t.requirementCodes[0], t.defaultFrequency]));
            const expected = Object.fromEntries(
                ALL_CODES.map((c) => [c, QUARTERLY.includes(c) ? 'QUARTERLY' : 'ANNUALLY']),
            );
            expect(actual).toEqual(expected);
        });

        it('titles each control by its outcome, not by the AIUC requirement title', () => {
            const echoes = templates
                .filter((t) => flat(t.title).toLowerCase() === flat(reqTitle.get(t.requirementCodes[0])).toLowerCase())
                .map((t) => t.code);
            expect(echoes).toEqual([]);
        });
    });

    describe('the content meets the bar the shipped frameworks set', () => {
        const templates = catalog.templates;
        const tasks = templates.flatMap((t) => t.tasks.map((k) => ({ code: t.code, k })));

        it('authors a real task set for every control — never the generic five', () => {
            // applyCatalogFile writes the generic five for a template with no
            // tasks, so an empty array here would ship placeholder work silently.
            // 4-6 here, inside conformance's 3-6: every AIUC-1 requirement carries
            // at least one core activity plus something to scope and something to
            // check, so a three-task set would be leaving one of them out.
            const offRange = templates
                .filter((t) => t.tasks.length < 4 || t.tasks.length > 6)
                .map((t) => `${t.code}: ${t.tasks.length}`);
            expect(offRange).toEqual([]);
        });

        it.each(['objective', 'successCriteria', 'testingMethodology'] as const)(
            '%s sits inside the measured band for every control',
            (field) => {
                const [lo, hi] = BANDS[field];
                const outside = templates
                    .map((t) => ({ code: t.code, len: (t[field] ?? '').length }))
                    .filter((x) => x.len < lo || x.len > hi)
                    .map((x) => `${x.code}=${x.len} (want ${lo}-${hi})`);
                expect(outside).toEqual([]);
            },
        );

        it('writes a real audit procedure, not a paragraph', () => {
            const missing = templates
                .filter((t) => !['Evidence:', 'Analysis:', 'Output:'].every((h) => (t.testingMethodology ?? '').includes(h)))
                .map((t) => t.code);
            expect(missing).toEqual([]);
        });

        it('gives every control at least four separately testable success criteria', () => {
            const thin = templates
                .filter((t) => (t.successCriteria ?? '').split('\n').filter((l) => l.trim()).length < 4)
                .map((t) => t.code);
            expect(thin).toEqual([]);
        });

        it('carries steps and a named artefact on EVERY task', () => {
            // Above the incumbent norm on purpose: content carrying steps is held by
            // both the actionability and conformance guards, content without by one.
            const bare = tasks
                .filter(({ k }) => !k.steps || k.steps.length < 4 || !k.evidenceHint)
                .map(({ code, k }) => `${code}: ${k.title.en}`);
            expect(bare).toEqual([]);
        });

        it('draws suggestedRole from the house role set', () => {
            const strays = tasks
                .filter(({ k }) => !k.suggestedRole || !ROLES.includes(k.suggestedRole))
                .map(({ code, k }) => `${code}: ${k.suggestedRole}`);
            expect(strays).toEqual([]);
        });

        it('repeats no objective and no task title anywhere in the catalogue', () => {
            const dupes = (values: Array<[string, string]>) => {
                const seen = new Map<string, string>();
                const out: string[] = [];
                for (const [owner, v] of values) {
                    const key = flat(v).toLowerCase();
                    const prior = seen.get(key);
                    if (prior) out.push(`${prior} / ${owner}: "${v}"`);
                    else seen.set(key, owner);
                }
                return out;
            };
            expect({
                objectives: dupes(templates.map((t) => [t.code, t.objective ?? ''])),
                taskTitles: dupes(tasks.map(({ code, k }) => [code, k.title.en])),
            }).toEqual({ objectives: [], taskTitles: [] });
        });

        it("reproduces none of AIUC's control-activity identifiers or evidence-guidance phrasing", () => {
            const forbidden = [/\b[A-F]\d{3}\.\d+\b/, /typically demonstrated by/i, /\bmay include\b/i, /\bshould include\b/i, /©|all rights reserved/i];
            const hits: string[] = [];
            for (const t of templates) {
                const blob = JSON.stringify(t);
                for (const re of forbidden) if (re.test(blob)) hits.push(`${t.code} matches ${re}`);
            }
            expect(hits).toEqual([]);
        });
    });
});

describe('All three frameworks ride the generic framework machinery', () => {
    it('none is special-cased in the install or catalog usecases', () => {
        // Computed value, not a source-text matcher: the assertion is "no
        // usecase names any of the three", and the failure prints which does.
        const NEEDLES = ['OWASP-ASI', 'IMDA-MGF', 'AIUC-1', 'owasp-agentic-top10', 'imda-mgf', 'aiuc-1'];
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
