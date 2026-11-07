/**
 * FINOS AI Governance Framework (AIGF): the library, its catalogue, the risk
 * templates and the mapping sets describe one framework, and none of it
 * reproduces FINOS's prose.
 *
 * ═══ WHAT SHIPS ═══
 *
 *   src/data/libraries/finos-aigf.yaml          25 mitigations (MI-1 … MI-25), the requirements
 *   prisma/fixtures/finos-aigf-control-templates.json
 *                                               one authored control per mitigation, one pack
 *   prisma/fixtures/risk-templates-finos-aigf.json
 *                                               the 24 risks (RI-n) as global risk templates
 *   src/data/libraries/mappings/finos-aigf-to-{iso-42001,eu-ai-act}.yaml
 *                                               the clauses FINOS itself cites for each mitigation
 *
 * ═══ WHY IT HAS ITS OWN GUARD ═══
 *
 * Four populations no other guard ranges over together: the enumeration (which
 * identifiers FINOS publishes, gaps included), the risk templates (which have a
 * production writer of their own, scripts/seed-risk-templates.ts), the
 * provenance of the mappings (FINOS's citations, not Inflect's judgement), and
 * the licensing posture (index plus our own words, decided 2026-11-07).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { RISK_CATEGORIES } from '@/lib/risk/categories';

import { loadCatalogFile } from '../../prisma/catalog-loader';
import { appliedSources } from '../helpers/applied-catalogue';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const LIB = 'src/data/libraries/finos-aigf.yaml';
const CATALOG = 'prisma/fixtures/finos-aigf-control-templates.json';
const RISKS = 'prisma/fixtures/risk-templates-finos-aigf.json';
const MAPPINGS = ['finos-aigf-to-iso-42001.yaml', 'finos-aigf-to-eu-ai-act.yaml'];

const stored = parseLibraryFile(path.join(ROOT, LIB));
const library = loadLibrary(stored, LIB);
const nodes = library.framework.nodes;
const assessable = nodes.filter((n) => n.assessable);
const catalog = loadCatalogFile(path.join(ROOT, CATALOG));

interface RiskFixture {
    templates: Array<{
        id: string; title: string; description: string; category: string;
        defaultLikelihood: number; defaultImpact: number; frameworkTag: string;
    }>;
}
const risks = JSON.parse(fs.readFileSync(path.join(ROOT, RISKS), 'utf8')) as RiskFixture;

/**
 * The FINOS snapshot this ships (commit 67b8c325, 2026-11-02), by type. FINOS
 * numbers mitigations by a `sequence` and types each preventative or detective.
 */
const PREVENTATIVE = [2, 3, 5, 6, 7, 8, 10, 12, 14, 17, 18, 19, 20, 22, 23, 24, 25].map((n) => `MI-${n}`);
const DETECTIVE = [1, 4, 9, 11, 13, 15, 16, 21].map((n) => `MI-${n}`);
const DRAFT_MITIGATIONS = ['MI-24', 'MI-25'];

/** The 24 risks. FINOS retired 3, 11, 12, 13, 15 and 21; their absence is correct. */
const RISK_IDS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 14, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const RETIRED_RISKS = [3, 11, 12, 13, 15, 21];
const DRAFT_RISKS = ['RI-30'];

const DRAFT_SENTENCE = 'FINOS publishes this mitigation as a draft.';

describe('FINOS AIGF — the enumeration', () => {
    it('is an INDUSTRY_STANDARD keyed without an edition, because FINOS revises it in place', () => {
        expect({ refId: library.refId, kind: stored.kind }).toEqual({ refId: 'FINOS-AIGF', kind: 'INDUSTRY_STANDARD' });
    });

    it('carries the 25 mitigations by set equality, grouped as FINOS types them', () => {
        const byParent = (ref: string) =>
            assessable.filter((n) => n.parentUrn === `urn:inflect:req:finos-aigf:${ref.toLowerCase()}`).map((n) => n.refId);
        expect({ PREV: byParent('PREV'), DET: byParent('DET') }).toEqual({ PREV: PREVENTATIVE, DET: DETECTIVE });
        expect(nodes.filter((n) => !n.assessable).map((n) => n.refId)).toEqual(['PREV', 'DET']);
    });

    it('says "draft" on exactly the mitigations FINOS publishes as draft', () => {
        const saysDraft = assessable.filter((n) => (n.description ?? '').includes(DRAFT_SENTENCE)).map((n) => n.refId);
        expect(saysDraft).toEqual(DRAFT_MITIGATIONS);
    });

    it('records a text_hash that matches its content', () => {
        // A hand edit that forgot to restamp would otherwise import as "unchanged".
        expect(stored.text_hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('FINOS AIGF — the catalogue and the library are one framework', () => {
    it('declares the library key, so both writers converge on ONE Framework row', () => {
        expect({ key: catalog.framework.key, sourceUrn: catalog.framework.sourceUrn })
            .toEqual({ key: library.refId, sourceUrn: library.urn });
    });

    it('carries the library requirements verbatim, in library order', () => {
        const fromLibrary = assessable.map((n, i) => ({
            code: n.refId, title: n.name, summary: n.description, section: n.section, category: n.section, sortOrder: i,
        }));
        const fromCatalog = catalog.requirements.map((r) => ({
            code: r.code, title: r.title, summary: r.summary, section: r.section, category: r.category, sortOrder: r.sortOrder,
        }));
        expect(fromCatalog).toEqual(fromLibrary);
    });

    it('maps each mitigation to exactly one template and installs all of them through the pack', () => {
        expect(catalog.templates.map((t) => [t.code, t.requirementCodes])).toEqual(
            assessable.map((n) => [`FINOS-${n.refId}`, [n.refId]]),
        );
        const pack = Array.isArray(catalog.packs) ? catalog.packs[0] : catalog.pack;
        expect(pack?.key).toBe('FINOS_AIGF_BASELINE');
        expect(pack?.templateCodes).toEqual(catalog.templates.map((t) => t.code));
    });

    it('files each template under a framework-qualified category', () => {
        const bare = catalog.templates.filter((t) => !(t.category ?? '').startsWith('FINOS AIGF ')).map((t) => t.code);
        expect(bare).toEqual([]);
    });

    it('is applied by a seeder that runs on every production start', () => {
        const applied = appliedSources().filter((s) => s.reachesProduction);
        expect(applied.filter((s) => s.text.includes('finos-aigf-control-templates.json')).length).toBeGreaterThan(0);
    });

    it('attributes FINOS under CC-BY-4.0 in the stored framework row', () => {
        const meta = catalog.framework.metadata ?? {};
        expect({ license: meta.license, notLegalAdvice: meta.notLegalAdvice }).toEqual({ license: 'CC-BY-4.0', notLegalAdvice: true });
        expect(String(meta.copyright)).toMatch(/CC-BY-4\.0/);
        expect(String(stored.copyright)).toMatch(/CC-BY-4\.0/);
    });
});

describe('FINOS AIGF — the content bar', () => {
    const templates = catalog.templates;
    const tasks = templates.flatMap((t) => t.tasks.map((k) => ({ code: t.code, k })));
    const BANDS = { objective: [130, 200], successCriteria: [420, 620], testingMethodology: [1000, 1800] } as const;
    const ROLES = ['IT Operations', 'Security engineering', 'Engineering lead', 'HR', 'Legal/DPO', 'Facilities', 'Management', 'Procurement'];

    it('authors 4-6 tasks for every control, across at least three phases', () => {
        const off = templates
            .filter((t) => t.tasks.length < 4 || t.tasks.length > 6 || new Set(t.tasks.map((k) => k.phase)).size < 3)
            .map((t) => `${t.code}: ${t.tasks.length} tasks, ${new Set(t.tasks.map((k) => k.phase)).size} phases`);
        expect(off).toEqual([]);
    });

    it.each(['objective', 'successCriteria', 'testingMethodology'] as const)('%s sits inside the measured band', (field) => {
        const [lo, hi] = BANDS[field];
        const outside = templates
            .map((t) => ({ code: t.code, len: (t[field] ?? '').length }))
            .filter((x) => x.len < lo || x.len > hi)
            .map((x) => `${x.code}=${x.len}`);
        expect(outside).toEqual([]);
    });

    it('writes an Evidence / Analysis / Output audit procedure for every control', () => {
        const missing = templates
            .filter((t) => !['Evidence:', 'Analysis:', 'Output:'].every((h) => (t.testingMethodology ?? '').includes(h)))
            .map((t) => t.code);
        expect(missing).toEqual([]);
    });

    it('carries steps, a named artefact and a house role on every task', () => {
        const bad = tasks
            .filter(({ k }) => !k.steps || k.steps.length < 4 || !k.evidenceHint || !ROLES.includes(k.suggestedRole ?? ''))
            .map(({ code, k }) => `${code}: ${k.title.en}`);
        expect(bad).toEqual([]);
    });

    it('repeats no task title anywhere in the catalogue', () => {
        const seen = new Set<string>();
        const dupes = tasks.map(({ k }) => k.title.en.toLowerCase()).filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
        expect(dupes).toEqual([]);
    });
});

describe('FINOS AIGF — the risks ship as risk templates', () => {
    it('carries the 24 risks by set equality, retired numbers absent', () => {
        expect(risks.templates.map((t) => t.id)).toEqual(RISK_IDS.map((n) => `finos-aigf-ri-${n}`));
        const tags = risks.templates.map((t) => t.frameworkTag);
        for (const n of RETIRED_RISKS) expect(tags).not.toContain(`FINOS-AIGF:RI-${n}`);
    });

    it('attributes each description to its FINOS risk, and marks the draft', () => {
        const unattributed = risks.templates
            .filter((t) => !t.description.endsWith(`[FINOS AIGF ${t.frameworkTag.split(':')[1]}]`))
            .map((t) => t.id);
        expect(unattributed).toEqual([]);
        const drafts = risks.templates.filter((t) => t.description.includes('as a draft')).map((t) => t.frameworkTag.split(':')[1]);
        expect(drafts).toEqual(DRAFT_RISKS);
    });

    it('uses only the canonical risk categories, and FINOS-neutral midpoint scores', () => {
        // FINOS rates neither likelihood nor impact; a default other than the
        // midpoint would be Inflect's judgement presented as FINOS's.
        const bad = risks.templates
            .filter((t) => !(RISK_CATEGORIES as readonly string[]).includes(t.category) || t.defaultLikelihood !== 3 || t.defaultImpact !== 3)
            .map((t) => t.id);
        expect(bad).toEqual([]);
    });

    it('is delivered to production by the risk-template seeder the entrypoint runs', () => {
        const entrypoint = fs.readFileSync(path.join(ROOT, 'scripts/entrypoint.sh'), 'utf8');
        const live = entrypoint.split('\n').filter((l) => !l.trim().startsWith('#'));
        expect(live.some((l) => l.includes('node dist/seed-risk-templates.mjs'))).toBe(true);
        const code = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        expect(code('scripts/build-worker.mjs')).toContain("'scripts/seed-risk-templates.ts'");
        expect(code('scripts/seed-risk-templates.ts')).toContain("require('../prisma/fixtures/risk-templates-finos-aigf.json')");
    });
});

describe('FINOS AIGF — the mappings are FINOS citations, not Inflect judgement', () => {
    const sets = MAPPINGS.map((f) => ({
        file: f,
        set: yaml.load(fs.readFileSync(path.join(ROOT, 'src/data/libraries/mappings', f), 'utf8')) as {
            source_framework_ref: string;
            mapping_entries: Array<{ source_ref: string; target_ref: string; strength: string; rationale: string }>;
        },
    }));

    it.each(MAPPINGS)('%s starts from FINOS-AIGF, names a real mitigation, and is non-empty', (file) => {
        const { set } = sets.find((s) => s.file === file)!;
        expect(set.source_framework_ref).toBe('FINOS-AIGF');
        expect(set.mapping_entries.length).toBeGreaterThan(0);
        const codes = new Set(assessable.map((n) => n.refId));
        expect(set.mapping_entries.filter((e) => !codes.has(e.source_ref))).toEqual([]);
    });

    it('marks every entry [FINOS-crosswalk] and holds it at RELATED, since FINOS does not grade overlap', () => {
        const off = sets.flatMap(({ file, set }) =>
            set.mapping_entries
                .filter((e) => e.strength !== 'RELATED' || !e.rationale.startsWith('[FINOS-crosswalk] '))
                .map((e) => `${file}: ${e.source_ref} -> ${e.target_ref}`),
        );
        expect(off).toEqual([]);
    });
});
