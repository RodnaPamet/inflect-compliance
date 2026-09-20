/**
 * COSO ICF 2013 control content — the taxonomy, and the quality bar it is held to.
 *
 * ── WHAT IS ALREADY COVERED ELSEWHERE, AND IS NOT REPEATED HERE ─────────────
 *
 * `control-task-actionability` (imperative titles, 3-8 steps, >= 25 chars each,
 * >= 3 tasks over >= 3 phases), `control-task-conformance` (phase/object titles,
 * unfinishable openers), `no-generic-task-strings` and
 * `every-shipped-fixture-parses` all discover fixtures by directory and picked
 * COSO up with no change. COSO is in NO allowlist in any of them, and must never
 * be: `LEGACY_GENERIC_ALLOWLIST` is an empty downward ratchet at its stated end
 * state, so an entry there would be a visible regression rather than a waiver.
 *
 * Repeating those assertions here would be a second copy of a working guard,
 * and the copy is the one that rots. What this file holds is the part they
 * cannot know.
 *
 * ── THE TAXONOMY IS A SET, NOT A COUNT ──────────────────────────────────────
 *
 * The code set is asserted by EQUALITY, so a typo'd, invented, renamed or
 * silently dropped control fails naming itself. A count would pass all four.
 * The later content PRs extend this same set to 57, 75 and 96 — which is what
 * makes a control quietly lost in PR 2B fail in PR 2C rather than shipping.
 *
 * ── THE QUALITY BANDS ARE MEASURED, NOT CHOSEN ──────────────────────────────
 *
 * COSO is this product's first business-control framework with authored content
 * — the three that previously occupied that space (ISO 9001 / 28000 / 39001)
 * shipped with ZERO tasks and were retired on 2026-09-19 because no library
 * grounded them. So there is no weaker sibling to be measured against, and the
 * comparison that matters is against the 414 templates already shipped:
 *
 *     objective           existing 134-192, median 165
 *     successCriteria     existing 326-602, median 459
 *     testingMethodology  existing 936-1847, median 1267
 *     tasks carrying steps          existing 32% (610/1917)
 *     OPERATE with evidenceHint     existing 100% (433/433)
 *
 * The bands below sit at or above those, and the steps assertion is deliberately
 * 100% rather than the incumbent 32%: content carrying steps is held by BOTH the
 * actionability and conformance guards, content without them by only one. A
 * floor here is not a target — it is the line below which COSO would be thinner
 * than the frameworks beside it, which is the specific thing this file exists to
 * prevent.
 */
import path from 'node:path';

import { loadCatalogFile } from '../../prisma/catalog-loader';
import { appliedSources } from '../helpers/applied-catalogue';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'prisma/fixtures/coso-icf-2013-control-templates.json');

const catalog = loadCatalogFile(FIXTURE);

/** 75 controls: 33 entity-level (2A) + 24 process CA (2B) + 18 ITGC (2C). 96 follows. */
const TAXONOMY = [
    'COSO-CE-01.01', 'COSO-CE-01.02', 'COSO-CE-01.03',
    'COSO-CE-02.01', 'COSO-CE-02.02', 'COSO-CE-02.03',
    'COSO-CE-03.01', 'COSO-CE-03.02', 'COSO-CE-03.03',
    'COSO-CE-04.01', 'COSO-CE-04.02', 'COSO-CE-04.03',
    'COSO-CE-05.01', 'COSO-CE-05.02', 'COSO-CE-05.03', 'COSO-CE-05.04',
    'COSO-CE-06.01', 'COSO-CE-06.02', 'COSO-CE-06.03',
    'COSO-RA-01.01', 'COSO-RA-01.02', 'COSO-RA-01.03',
    'COSO-RA-02.01', 'COSO-RA-02.02', 'COSO-RA-02.03', 'COSO-RA-02.04',
    'COSO-RA-03.01', 'COSO-RA-03.02', 'COSO-RA-03.03', 'COSO-RA-03.04',
    'COSO-RA-04.01', 'COSO-RA-04.02', 'COSO-RA-04.03',
    // ── Control Activities: process-level (2B) + ITGC (2C) ─────────────
    'COSO-CA-01.01', 'COSO-CA-01.02', 'COSO-CA-01.03',
    'COSO-CA-01.04', 'COSO-CA-02.01', 'COSO-CA-02.02',
    'COSO-CA-02.03', 'COSO-CA-02.04', 'COSO-CA-03.01',
    'COSO-CA-03.02', 'COSO-CA-03.03', 'COSO-CA-04.01',
    'COSO-CA-04.02', 'COSO-CA-04.03', 'COSO-CA-04.04',
    'COSO-CA-04.05', 'COSO-CA-04.06', 'COSO-CA-05.01',
    'COSO-CA-05.02', 'COSO-CA-05.03', 'COSO-CA-05.04',
    'COSO-CA-05.05', 'COSO-CA-05.06', 'COSO-CA-06.01',
    'COSO-CA-06.02', 'COSO-CA-06.03', 'COSO-CA-06.04',
    'COSO-CA-06.05', 'COSO-CA-07.01', 'COSO-CA-07.02',
    'COSO-CA-07.03', 'COSO-CA-07.04', 'COSO-CA-08.01',
    'COSO-CA-08.02', 'COSO-CA-08.03', 'COSO-CA-09.01',
    'COSO-CA-09.02', 'COSO-CA-09.03', 'COSO-CA-10.01',
    'COSO-CA-10.02', 'COSO-CA-10.03', 'COSO-CA-10.04',
];

/** Finance and governance weighted, deliberately NOT the security set. */
const ROLES = [
    'Audit Committee', 'Executive management', 'CFO/Controller', 'Internal Audit',
    'Process Owner', 'IT Operations', 'Engineering lead', 'HR', 'Legal/Compliance',
];

const BANDS = {
    objective: [130, 200],
    successCriteria: [420, 620],
    testingMethodology: [1000, 1800],
} as const;

describe('the COSO catalogue ships the taxonomy it declares', () => {
    it('carries exactly the 75 controls authored so far, by set equality', () => {
        expect(catalog.templates.map((t) => t.code).sort()).toEqual([...TAXONOMY].sort());
    });

    it('splits them CE 19 / RA 14 / CA 42 across the components', () => {
        const byCategory: Record<string, number> = {};
        for (const t of catalog.templates) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
        expect(byCategory).toEqual({ CE: 19, RA: 14, CA: 42 });
    });

    it('links every control to a principle the catalogue itself declares', () => {
        const declared = new Set(catalog.requirements.map((r) => r.code));
        const unresolved = catalog.templates.flatMap((t) =>
            (t.requirementCodes ?? []).filter((c) => !declared.has(c)).map((c) => `${t.code} -> ${c}`),
        );
        expect(unresolved).toEqual([]);
    });

    it('leaves no control without a principle', () => {
        const orphans = catalog.templates.filter((t) => (t.requirementCodes ?? []).length === 0);
        expect(orphans.map((t) => t.code)).toEqual([]);
    });

    it('names every one of its 75 templates in the pack', () => {
        // Without this the pack can shrink while the catalogue does not, and a
        // tenant installs fewer controls than the file declares.
        expect([...(catalog.pack?.templateCodes ?? [])].sort()).toEqual([...TAXONOMY].sort());
    });
});

describe('the content meets the bar the shipped frameworks set', () => {
    it.each(['objective', 'successCriteria', 'testingMethodology'] as const)(
        '%s sits inside the measured band for every control',
        (field) => {
            const [lo, hi] = BANDS[field];
            const outside = catalog.templates
                .map((t) => ({ code: t.code, len: (t[field] ?? '').length }))
                .filter((x) => x.len < lo || x.len > hi)
                .map((x) => `${x.code}=${x.len} (want ${lo}-${hi})`);
            expect(outside).toEqual([]);
        },
    );

    it('writes a real audit procedure, not a paragraph', () => {
        // The three headings are the house structure (149 of the 151
        // internal-controls templates use them). Their absence is the tell for
        // prose that describes the control again instead of testing it.
        const missing = catalog.templates
            .filter((t) => !['Evidence:', 'Analysis:', 'Output:'].every((h) => (t.testingMethodology ?? '').includes(h)))
            .map((t) => t.code);
        expect(missing).toEqual([]);
    });

    it('gives every control at least four separately testable success criteria', () => {
        const thin = catalog.templates
            .filter((t) => (t.successCriteria ?? '').split('\n').filter(Boolean).length < 4)
            .map((t) => t.code);
        expect(thin).toEqual([]);
    });

    it('carries steps on EVERY task, where the shipped norm is 32%', () => {
        const withoutSteps = catalog.templates.flatMap((t) =>
            (t.tasks ?? []).filter((k) => !k.steps || k.steps.length === 0).map((k) => `${t.code}: ${k.title.en}`),
        );
        expect(withoutSteps).toEqual([]);
    });

    it('names the artefact on every OPERATE task', () => {
        const noHint = catalog.templates.flatMap((t) =>
            (t.tasks ?? []).filter((k) => k.phase === 'OPERATE' && !k.evidenceHint).map((k) => `${t.code}: ${k.title.en}`),
        );
        expect(noHint).toEqual([]);
    });

    it('draws suggestedRole from the finance and governance set', () => {
        const strays = catalog.templates.flatMap((t) =>
            (t.tasks ?? [])
                .filter((k) => k.suggestedRole && !ROLES.includes(k.suggestedRole))
                .map((k) => `${t.code}: ${k.suggestedRole}`),
        );
        expect(strays).toEqual([]);
    });
});

describe('frequency carries information rather than a default', () => {
    it('spans at least three distinct values across the 33', () => {
        // The lazy failure is ANNUALLY everywhere, which passes every structural
        // check and throws away the reason this content is authored at one
        // control per frequency in the first place.
        const spread = new Set(catalog.templates.map((t) => t.defaultFrequency));
        expect(spread.size).toBeGreaterThanOrEqual(3);
    });

    it('does not put the whole catalogue on one frequency', () => {
        const counts: Record<string, number> = {};
        for (const t of catalog.templates) counts[t.defaultFrequency] = (counts[t.defaultFrequency] ?? 0) + 1;
        const biggest = Math.max(...Object.values(counts));
        expect(biggest).toBeLessThan(catalog.templates.length);
    });
});

describe('the content is original, which is a licensing claim as well as a quality one', () => {
    it('repeats no objective between controls', () => {
        // Paste-and-swap is the failure mode when 33 controls are authored at
        // once, and a duplicated objective is its first symptom.
        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const t of catalog.templates) {
            const key = (t.objective ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
            const prior = seen.get(key);
            if (prior) dupes.push(`${prior} / ${t.code}`);
            else seen.set(key, t.code);
        }
        expect(dupes).toEqual([]);
    });

    it('repeats no task title anywhere in the catalogue', () => {
        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const t of catalog.templates) {
            for (const k of t.tasks ?? []) {
                const prior = seen.get(k.title.en);
                if (prior) dupes.push(`${prior} / ${t.code}: "${k.title.en}"`);
                else seen.set(k.title.en, t.code);
            }
        }
        expect(dupes).toEqual([]);
    });

    it('reproduces no COSO points-of-focus marker', () => {
        // Not a licensing PROOF — only a person can judge whether a paraphrase
        // sits too close to the source, which is why the implementation note
        // asks for legal review. This catches the cruder failure: the framework's
        // own phrasing pasted in verbatim.
        const forbidden = [/points? of focus/i, /©\s*COSO/i, /Committee of Sponsoring Organizations.*reserved/i];
        const hits: string[] = [];
        for (const t of catalog.templates) {
            const blob = [t.objective, t.successCriteria, t.testingMethodology, t.description].join(' ');
            for (const re of forbidden) if (re.test(blob)) hits.push(`${t.code} matches ${re}`);
        }
        expect(hits).toEqual([]);
    });
});

describe('the fixture reaches production', () => {
    it('is applied by a seeder that entrypoint.sh runs', () => {
        // The whole point of authoring under prisma/fixtures/ rather than
        // prisma/catalogs/: the latter is read by one integration test and one
        // doc, and reaches no tenant. Without this the 33 controls would be
        // installable by nobody.
        //
        // ASKED THROUGH `appliedSources()`, NOT BY READING THE SEEDER. The first
        // draft did `expect(readFileSync(seeder)).toContain('<path>')`, which is
        // two defects at once: it is a Class A raw-source assertion (the ratchet
        // caught it), and a COMMENTED-OUT registration would have satisfied it —
        // the precise failure that class exists to name. This helper follows the
        // real chain instead, entrypoint.sh -> seeder -> fixture, which is what
        // it was built for.
        const applied = appliedSources().filter((s) => s.reachesProduction);
        const named = applied.filter((s) =>
            s.text.includes('coso-icf-2013-control-templates.json'),
        );
        expect(named.length).toBeGreaterThan(0);
        // Positive control: the discovery found the production seeders at all.
        // An empty `applied` would make the line above pass by vacuity.
        expect(applied.length).toBeGreaterThan(0);
    });

    it('declares the same framework key as the library, so there is ONE row', () => {
        // Every other framework here exists twice under two keys, one per
        // authoring path, and a tenant's links hang off whichever its database
        // got. COSO does not, and this is what keeps it that way.
        expect(catalog.framework.key).toBe('COSO-ICF-2013');
    });
});
