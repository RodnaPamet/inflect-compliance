/**
 * AIUC-1 — the enumeration is exact, the two representations agree, and the
 * authored controls meet the bar the shipped frameworks set.
 *
 * ── WHAT IS ALREADY COVERED ELSEWHERE, AND IS NOT REPEATED HERE ─────────────
 *
 * `control-task-actionability` (imperative titles, 3-8 steps of >= 25 chars,
 * >= 3 tasks over >= 3 phases), `control-task-conformance`, `no-generic-task-
 * strings`, `authored-tasks-are-delivered`, `library-obligations-reach-the-
 * catalogue`, `framework-starter-pack-completeness`, `section-axis-is-
 * structural` and `catalog-requirement-prose` all discover fixtures and
 * libraries by directory and pick AIUC-1 up with a one-line registration each.
 * AIUC-1 is in NO allowlist in any of them. What this file holds is what they
 * cannot know.
 *
 * ── THE ENUMERATION IS A SET, AND THE GAPS ARE PART OF IT ───────────────────
 *
 * AIUC-1 retires a requirement rather than renumbering the rest, so the Q4-2026
 * identifiers have five holes: C011, C012 and D002 (folded into the broader
 * third-party testing requirements C010 and D004) and E007, E014 (retired
 * earlier). Asserted by SET EQUALITY, so an invented, typo'd, dropped or
 * "helpfully" restored identifier fails naming itself — a count would pass all
 * four, and restoring D002 to make the numbering look tidy would give a tenant
 * something to be compliant with that the standard no longer asks for.
 *
 * ── APPLICABILITY IS A CHECKED CLAIM, NOT A SENTENCE ────────────────────────
 *
 * AIUC-1 marks eight requirements optional and scopes fifteen to an agent
 * capability. The importer persists only a requirement's description, so those
 * facts are stated there. That makes them claims a tenant will act on when
 * marking requirements not applicable, so they are pinned here as data and the
 * descriptions are checked against the pin in BOTH directions: a requirement
 * that becomes optional upstream, or one that stops being, fails until the pin
 * and the prose move together.
 *
 * ── LICENSING ───────────────────────────────────────────────────────────────
 *
 * AIUC-1 is "© AIUC, all rights reserved" and its terms prohibit derivative
 * works. Identifiers and short titles are carried; everything else is ours. The
 * check below catches the crude failure — AIUC's control-activity identifiers
 * (A001.1 …) or its evidence-guidance phrasing pasted in. It cannot judge a
 * paraphrase that sits too close; that was measured once against the published
 * pages when this content was written (see the implementation note) and is what
 * a legal review is for.
 */
import path from 'node:path';

import { loadLibrary, parseLibraryFile } from '@/app-layer/libraries/library-loader';

import { loadCatalogFile } from '../../prisma/catalog-loader';
import { appliedSources } from '../helpers/applied-catalogue';

const ROOT = path.resolve(__dirname, '../..');
const LIB_FILE = path.join(ROOT, 'src/data/libraries/aiuc-1.yaml');
const FIXTURE_FILE = path.join(ROOT, 'prisma/fixtures/aiuc-1-control-templates.json');

const stored = parseLibraryFile(LIB_FILE);
const library = loadLibrary(stored, 'aiuc-1.yaml');
const nodes = library.framework.nodes;
const assessable = nodes.filter((n) => n.assessable);
const domains = nodes.filter((n) => !n.assessable);
const catalog = loadCatalogFile(FIXTURE_FILE);

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

/** Requirements AIUC-1 scopes to an agent capability, and the clause that says so. */
const CAPABILITY_CLAUSE = {
    code: 'applies to agents that generate code',
    text: 'applies to agents that generate text',
    actions: 'applies to agents that take actions',
    external: 'applies to externally facing agents',
} as const;
const CAPABILITY: Readonly<Record<string, keyof typeof CAPABILITY_CLAUSE>> = {
    A007: 'external', E002: 'external', E003: 'external',
    A008: 'code', B010: 'code', C006: 'code',
    B005: 'text', B009: 'text', C003: 'text', C004: 'text', D001: 'text', F001: 'text', F002: 'text',
    B006: 'actions', D003: 'actions',
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

    it('states the capability scope on the fifteen scoped requirements and nowhere else', () => {
        const stated: Record<string, string> = {};
        for (const c of ALL_CODES) {
            const hit = (Object.keys(CAPABILITY_CLAUSE) as Array<keyof typeof CAPABILITY_CLAUSE>).filter((k) =>
                desc.get(c)?.includes(CAPABILITY_CLAUSE[k]),
            );
            if (hit.length > 0) stated[c] = hit.join('+');
        }
        expect(stated).toEqual(CAPABILITY);
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
