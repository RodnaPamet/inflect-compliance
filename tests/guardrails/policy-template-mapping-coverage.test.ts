/**
 * Framework-aware policy-template mapping ratchet.
 *
 * Locks the load-bearing invariants of the policy-template → framework
 * link-suggestion feature:
 *
 *   1. The mapping fixture exists; every ISO 27001 / NIS2 requirement
 *      code in it resolves to a REAL seeded FrameworkRequirement (no
 *      dangling ids — a dangling id would silently drop a suggestion).
 *   2. Every mapping entry carries a provenance (from_toolkit | curated).
 *   3. getSuggestedControlLinks only suggests frameworks the tenant has
 *      INSTALLED (structural: the install gate is present).
 *   4. createPolicyFromTemplate does NOT auto-create PolicyControlLinks —
 *      the ONLY write path is the explicit linkPolicyControls confirm.
 *   5. The confirm UI pre-checks toolkit mappings, leaves curated ones
 *      unchecked (server marks preChecked = from_toolkit; UI seeds from it).
 *
 * Attribution: mappings derived in part from ciso-toolkit (MIT).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readJson = (rel: string) => JSON.parse(readRaw(rel));

const MAP_FIXTURE = 'prisma/fixtures/policy-template-framework-map.json';
const ISO_FIXTURE = 'prisma/fixtures/iso27001_2022_annexA.json';
const NIS2_FIXTURE = 'prisma/fixtures/nis2_requirements.json';

type Provenance = 'from_toolkit' | 'curated';
interface Entry { code: string; provenance: Provenance }
interface Mapping { iso27001?: Entry[]; nis2?: Entry[] }
const fixture = readJson(MAP_FIXTURE) as {
    _meta: Record<string, unknown>;
    mappings: Record<string, Mapping>;
};

const isoCodes = new Set((readJson(ISO_FIXTURE) as Array<{ key: string }>).map((r) => r.key));
const nis2Codes = new Set((readJson(NIS2_FIXTURE) as Array<{ key: string }>).map((r) => r.key));

describe('policy-template framework mapping — fixture integrity', () => {
    it('maps all 15 ciso-toolkit policies (POL-00…POL-14)', () => {
        const refs = new Set(Object.keys(fixture.mappings));
        for (let i = 0; i < 15; i++) expect(refs.has(`POL-${String(i).padStart(2, '0')}`)).toBe(true);
    });

    it('maps the canonical imported overlaps to the same frameworks as their ciso twin', () => {
        // The imported "Information Security Policy" / "Risk Management Policy"
        // supersede POL-01 / POL-02 by title in the seed, so their slug
        // externalRefs carry the same framework mappings.
        expect(fixture.mappings['information-security-policy']).toEqual(fixture.mappings['POL-01']);
        expect(fixture.mappings['risk-management-policy']).toEqual(fixture.mappings['POL-02']);
    });

    it('carries MIT attribution + the toolkit-vs-curated provenance legend', () => {
        const meta = JSON.stringify(fixture._meta);
        expect(meta).toContain('ciso-toolkit');
        expect(meta).toMatch(/MIT/);
        expect(meta).toMatch(/NIST-CSF|NIST CSF/i); // honest origin of the refs
        expect(fixture._meta.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
    });

    it('every ISO/NIS2 requirement code resolves to a real seeded requirement (no dangling ids)', () => {
        const dangling: string[] = [];
        for (const [ref, m] of Object.entries(fixture.mappings)) {
            for (const e of m.iso27001 ?? []) {
                if (!isoCodes.has(e.code)) dangling.push(`${ref} iso27001:${e.code}`);
            }
            for (const e of m.nis2 ?? []) {
                if (!nis2Codes.has(e.code)) dangling.push(`${ref} nis2:${e.code}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('every mapping entry carries a valid provenance', () => {
        const bad: string[] = [];
        let total = 0;
        for (const [ref, m] of Object.entries(fixture.mappings)) {
            for (const e of [...(m.iso27001 ?? []), ...(m.nis2 ?? [])]) {
                total++;
                if (e.provenance !== 'from_toolkit' && e.provenance !== 'curated') {
                    bad.push(`${ref}:${e.code}=${e.provenance}`);
                }
            }
        }
        expect(bad).toEqual([]);
        expect(total).toBeGreaterThan(30);
    });

    it('uses the real requirement-code format, not the prompt placeholders', () => {
        const allCodes = Object.values(fixture.mappings).flatMap((m) => [
            ...(m.iso27001 ?? []).map((e) => e.code),
            ...(m.nis2 ?? []).map((e) => e.code),
        ]);
        // No "A.5.1"-style ISO ids; no "nis2-gov-" placeholder keys.
        expect(allCodes.some((c) => /^A\.\d/.test(c))).toBe(false);
        expect(allCodes.some((c) => c.startsWith('nis2-'))).toBe(false);
    });

    it('every ciso (POL-xx) policy has at least one from_toolkit mapping (toolkit-grounded)', () => {
        // Only the ciso-toolkit set is toolkit-grounded. The imported policies
        // carry no toolkit provenance, so their mappings are wholly `curated`.
        for (const [ref, m] of Object.entries(fixture.mappings)) {
            if (!/^POL-\d\d$/.test(ref)) continue;
            const provs = [...(m.iso27001 ?? []), ...(m.nis2 ?? [])].map((e) => e.provenance);
            expect(provs.length).toBeGreaterThan(0);
            expect(provs).toContain('from_toolkit');
        }
    });

    it('every imported policy is mapped to at least one framework requirement', () => {
        const imported = JSON.parse(readRaw('prisma/fixtures/policy-templates-imported.json')) as {
            templates: Array<{ externalRef: string }>;
        };
        const unmapped: string[] = [];
        for (const t of imported.templates) {
            const m = fixture.mappings[t.externalRef];
            const n = (m?.iso27001?.length ?? 0) + (m?.nis2?.length ?? 0);
            if (n === 0) unmapped.push(t.externalRef);
        }
        expect(unmapped).toEqual([]);
    });
});

describe('policy-template framework mapping — code invariants', () => {
    const usecase = read('src/app-layer/usecases/policy-template-mapping.ts');
    const policyUsecase = read('src/app-layer/usecases/policy.ts');
    const modal = read('src/app/t/[tenantSlug]/(app)/policies/templates/TemplateControlSuggestModal.tsx');

    it('getSuggestedControlLinks gates on the tenant having the framework installed', () => {
        // The install gate: frameworks reachable via a tenant ControlRequirementLink.
        expect(usecase).toMatch(/requirements:\s*\{\s*some:\s*\{\s*controlLinks:\s*\{\s*some:\s*\{\s*tenantId/);
    });

    it('createPolicyFromTemplate does NOT auto-create PolicyControlLinks', () => {
        // Isolate the function body.
        const start = policyUsecase.indexOf('export async function createPolicyFromTemplate');
        expect(start).toBeGreaterThan(-1);
        const next = policyUsecase.indexOf('\nexport ', start + 1);
        const body = policyUsecase.slice(start, next === -1 ? undefined : next);
        expect(body).not.toMatch(/policyControlLink/i);
    });

    it('linkPolicyControls is the only PolicyControlLink write path', () => {
        // The create lives inside linkPolicyControls.
        expect(usecase).toMatch(/policyControlLink\.createMany/);
        const start = usecase.indexOf('export async function linkPolicyControls');
        expect(start).toBeGreaterThan(-1);
        const createIdx = usecase.indexOf('policyControlLink.createMany');
        expect(createIdx).toBeGreaterThan(start);
    });

    it('the server marks preChecked = from_toolkit and the modal seeds from it', () => {
        // Suggestions default to unchecked…
        expect(usecase).toMatch(/preChecked:\s*false/);
        // …and only flip checked under the from_toolkit branch.
        expect(usecase).toMatch(/provenance === 'from_toolkit'[\s\S]{0,80}preChecked = true/);
        // Modal initialises checkbox state from s.preChecked.
        expect(modal).toMatch(/init\[s\.controlId\]\s*=\s*s\.preChecked/);
    });
});
