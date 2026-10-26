/**
 * EU drone operations (Implementing Regulation (EU) 2019/947): the subcategory
 * packs install exactly what governs the subcategory, and nothing else.
 *
 * ═══ WHY THIS FRAMEWORK HAS ITS OWN GUARD ═══
 *
 * It is the first framework whose packs are a CHOICE rather than a single
 * baseline: one pack per operating subcategory (A1, A2, A3, STS-01, STS-02,
 * operational authorisation, LUC), sharing the controls every operation needs,
 * plus one per aircraft class an operator looks for by name (C2, which flies
 * in A2 or A3, so its pack is exactly those two together).
 * The install wizard and onboarding make a tenant choose at least one. That
 * choice is only worth requiring if each pack is honest about its scope, in
 * two directions no other guard checks:
 *
 *   - a pack's controls cite ONLY requirements that govern its subcategory —
 *     an A2-only tenant must not see LUC or STS requirements marked "mapped"
 *     by a control it installed;
 *   - every requirement that governs the subcategory is cited by at least one
 *     control IN THE PACK — install A2 and nothing that binds an A2 operator
 *     is left without a control.
 *
 * The table below is the decision record for "governs". It is held HERE, and
 * the fixture's `_meta.applicableRequirements` is asserted equal to it, so the
 * documentation copy cannot drift from the rule.
 *
 * Folded into no existing guard: nothing else ranges over this fixture's packs,
 * and the failure — a pack whose scope is wrong in either direction — has no
 * analogue in a single-pack framework.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = 'prisma/fixtures/eu-uas-ops-control-templates.json';
const LIBRARY = 'src/data/libraries/eu-uas-ops.yaml';

interface Template {
    code: string;
    category: string;
    requirementCodes: string[];
    objective: string;
    successCriteria: string;
    testingMethodology: string;
    tasks: Array<{ phase: string; steps?: unknown[]; evidenceHint?: unknown }>;
}
interface Fixture {
    _meta: { applicableRequirements: Record<string, string[]> };
    framework: { key: string; kind: string };
    requirements: Array<{ code: string; title: string; section: string; category: string; sortOrder: number; summary: string }>;
    templates: Template[];
    pack?: unknown;
    packs: Array<{ key: string; name: string; templateCodes: string[] }>;
}

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE), 'utf8')) as Fixture;

// ── The decision record: which requirements govern each subcategory ──

const EVERY_OPERATION = ['Art.3', 'Art.8', 'Art.9', 'Art.10', 'Art.14', 'Art.15', 'Art.19', 'U-space Art.6'];
const OPEN = [...EVERY_OPERATION, 'Art.4', 'UAS.OPEN.010', 'UAS.OPEN.050', 'UAS.OPEN.060', 'UAS.OPEN.070'];
const SPECIFIC = [...EVERY_OPERATION, 'Art.5', 'Art.13', 'UAS.SPEC.010', 'UAS.SPEC.050', 'UAS.SPEC.060', 'UAS.SPEC.100'];
// SPEC.090 (access) binds declared and authorised operations; an LUC holder's
// own-authorised work falls under UAS.LUC.090 instead.
const DECLARED = [...SPECIFIC, 'UAS.SPEC.090', 'UAS.SPEC.020', 'UAS.SPEC.085'];

const GOVERNS: Record<string, string[]> = {
    // Art.20 admits legacy aircraft to A1 (under 250 g) and A3 (under 25 kg), never A2.
    EU_UAS_OPEN_A1: [...OPEN, 'UAS.OPEN.020', 'Art.20'],
    EU_UAS_OPEN_A2: [...OPEN, 'UAS.OPEN.030'],
    EU_UAS_OPEN_A3: [...OPEN, 'UAS.OPEN.040', 'Art.20'],
    // A class, not a subcategory: a C2 aircraft flies in A2 or A3, so its pack
    // is those two packs together and governs what they govern.
    EU_UAS_CLASS_C2: [...new Set([...OPEN, 'UAS.OPEN.030', 'UAS.OPEN.040', 'Art.20'])],
    EU_UAS_STS_01: [...DECLARED, 'UAS.STS-01.010', 'UAS.STS-01.020', 'UAS.STS-01.030', 'UAS.STS-01.040'],
    EU_UAS_STS_02: [...DECLARED, 'UAS.STS-02.010', 'UAS.STS-02.020', 'UAS.STS-02.030', 'UAS.STS-02.040', 'UAS.STS-02.050'],
    EU_UAS_OPERATIONAL_AUTHORISATION: [
        ...SPECIFIC, 'UAS.SPEC.090', 'Art.11', 'Art.12', 'UAS.SPEC.030', 'UAS.SPEC.040', 'UAS.SPEC.070', 'UAS.SPEC.080',
    ],
    // An LUC holder risk-assesses its own operations under Art.11 (UAS.LUC.020(4)).
    EU_UAS_LUC: [
        ...SPECIFIC, 'Art.11',
        'UAS.LUC.010', 'UAS.LUC.020', 'UAS.LUC.030', 'UAS.LUC.040', 'UAS.LUC.050',
        'UAS.LUC.060', 'UAS.LUC.070', 'UAS.LUC.075', 'UAS.LUC.080', 'UAS.LUC.090',
    ],
};

const byCode = new Map(fixture.templates.map((t) => [t.code, t]));

describe('EU UAS — the enumeration', () => {
    it('ships under one key, as a regulation, with several packs and no single `pack`', () => {
        expect(fixture.framework.key).toBe('EU-UAS-OPS');
        expect(fixture.framework.kind).toBe('REGULATION');
        expect(fixture.pack).toBeUndefined();
        expect(fixture.packs.map((p) => p.key).sort()).toEqual(Object.keys(GOVERNS).sort());
    });

    it('carries the 51 requirements in 11 sections, and every one governs some subcategory', () => {
        expect(fixture.requirements).toHaveLength(51);
        expect(new Set(fixture.requirements.map((r) => r.section)).size).toBe(11);
        const governed = new Set(Object.values(GOVERNS).flat());
        expect(fixture.requirements.map((r) => r.code).filter((c) => !governed.has(c))).toEqual([]);
        expect([...governed].filter((c) => !fixture.requirements.some((r) => r.code === c))).toEqual([]);
    });

    it("generates its requirements from the library, field for field", () => {
        // The library import and this fixture must write identical rows; the
        // fixture is generated from the library, so any hand edit to one side
        // shows up here.
        const stored = parseLibraryFile(path.join(ROOT, LIBRARY));
        const lib = loadLibrary(stored, LIBRARY);
        expect(lib.refId).toBe(fixture.framework.key);
        const assessable = lib.framework.nodes.filter((n) => n.assessable);
        expect(
            assessable.map((n, i) => ({
                code: n.refId,
                title: n.name ?? n.refId,
                section: n.section ?? n.category,
                category: n.category,
                sortOrder: i,
                summary: n.description,
            })),
        ).toEqual(fixture.requirements);
    });
});

describe('EU UAS — each pack is honest about its subcategory', () => {
    it('the fixture documents the same table this guard enforces', () => {
        const norm = (t: Record<string, string[]>) =>
            Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v].sort()]));
        expect(norm(fixture._meta.applicableRequirements)).toEqual(norm(GOVERNS));
    });

    it.each(Object.keys(GOVERNS))('%s cites only requirements that govern it', (key) => {
        const pack = fixture.packs.find((p) => p.key === key)!;
        const governs = new Set(GOVERNS[key]);
        const strays = pack.templateCodes.flatMap((code) =>
            (byCode.get(code)?.requirementCodes ?? []).filter((r) => !governs.has(r)).map((r) => `${code} → ${r}`),
        );
        expect(strays).toEqual([]);
    });

    it.each(Object.keys(GOVERNS))('%s cites every requirement that governs it', (key) => {
        const pack = fixture.packs.find((p) => p.key === key)!;
        const cited = new Set(pack.templateCodes.flatMap((code) => byCode.get(code)?.requirementCodes ?? []));
        expect(GOVERNS[key].filter((r) => !cited.has(r))).toEqual([]);
    });

    it('every pack carries the controls every operation needs', () => {
        const core = fixture.templates
            .filter((t) => t.requirementCodes.every((r) => EVERY_OPERATION.includes(r)))
            .map((t) => t.code);
        expect(core.length).toBeGreaterThanOrEqual(10);
        const missing = fixture.packs.flatMap((p) =>
            core.filter((c) => !p.templateCodes.includes(c)).map((c) => `${p.key} lacks ${c}`),
        );
        expect(missing).toEqual([]);
    });

    it('the class C2 pack installs exactly what A2 and A3 install together', () => {
        // Ticking "Class C2" and ticking A2 + A3 must give a tenant the same
        // controls, or the two routes to the same aircraft would disagree.
        const codes = (key: string) => fixture.packs.find((p) => p.key === key)!.templateCodes;
        const union = new Set([...codes('EU_UAS_OPEN_A2'), ...codes('EU_UAS_OPEN_A3')]);
        expect([...codes('EU_UAS_CLASS_C2')].sort()).toEqual([...union].sort());
    });

    it('every subcategory pack names the aircraft classes it admits', () => {
        const name = (key: string) => fixture.packs.find((p) => p.key === key)!.name;
        expect(name('EU_UAS_OPEN_A1')).toMatch(/\(class C0, C1\)$/);
        expect(name('EU_UAS_OPEN_A2')).toMatch(/\(class C2\)$/);
        expect(name('EU_UAS_OPEN_A3')).toMatch(/\(class C2, C3, C4\)$/);
        expect(name('EU_UAS_STS_01')).toMatch(/\(class C5\)$/);
        expect(name('EU_UAS_STS_02')).toMatch(/\(class C6\)$/);
    });

    it('no template is left out of every pack', () => {
        const named = new Set(fixture.packs.flatMap((p) => p.templateCodes));
        expect(fixture.templates.map((t) => t.code).filter((c) => !named.has(c))).toEqual([]);
    });
});

describe('EU UAS — the content bar', () => {
    // The bands the COSO and AIUC-1 catalogues were held to.
    it.each(fixture.templates.map((t) => [t.code, t] as const))('%s carries a full control and its tasks', (_code, t) => {
        expect(t.objective.length).toBeGreaterThanOrEqual(130);
        expect(t.objective.length).toBeLessThanOrEqual(200);
        expect(t.successCriteria.split('\n').filter((l) => l.trim()).length).toBeGreaterThanOrEqual(4);
        expect(t.testingMethodology).toMatch(/^Evidence:\n/);
        expect(t.testingMethodology).toContain('\n\nAnalysis:\n');
        expect(t.testingMethodology).toContain('\n\nOutput:\n');
        expect(t.tasks.length).toBeGreaterThanOrEqual(4);
        expect(t.tasks.length).toBeLessThanOrEqual(6);
        expect(new Set(t.tasks.map((k) => k.phase)).size).toBeGreaterThanOrEqual(3);
        expect(t.tasks.every((k) => Array.isArray(k.steps) && k.steps.length >= 4 && k.evidenceHint)).toBe(true);
        expect(t.category.startsWith('EU UAS ')).toBe(true);
    });
});
