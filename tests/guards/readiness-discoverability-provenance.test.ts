/**
 * Audit-readiness discoverability + provenance ratchet.
 *
 * Locks the four gaps closed in the discoverability/provenance PR. Each
 * regression class is one a reviewer would plausibly reintroduce by
 * "simplifying" a surface:
 *
 *   1. The audits hub's cycle scope is reachable ONLY by hand-editing
 *      ?cycleId, and the active-filter banner is generic ("one cycle")
 *      rather than naming the cycle.
 *   2. A register-created finding cannot be attributed to the audit
 *      (and therefore the cycle) it was raised during, even though the
 *      schema + usecase accept auditId.
 *   3. The pack return-channel "create finding" affordance reads
 *      identically for a FINDING and an EVIDENCE_REQUEST, even though
 *      they materialise into different finding types; and the audit the
 *      finding attaches to looks arbitrary rather than documented.
 *   4. Raw status enums leak into cycle badges, custom-framework cycles
 *      render as a flat gray "unknown" chip, and the FindingRepository
 *      list-select comment contradicts the select it documents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
// `readDoc` is the DELIBERATE raw seam (#2246). Two tests below assert on the
// RATIONALE COMMENT beside a piece of code, not on the code — an undocumented
// `orderBy` is the defect they exist to catch. Over comment-masked source the
// prose they look for is blanked, so they could never pass again.
const readDoc = (rel: string) => readRaw(rel);
const HUB = 'src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx';
const CREATE_FINDING = 'src/app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx';
const PACK = 'src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx';
const SHARING = 'src/app-layer/usecases/audit-readiness/sharing.ts';
const CYCLES_LIST = 'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx';
const CYCLE_DETAIL = 'src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx';
const FINDING_REPO = 'src/app-layer/repositories/FindingRepository.ts';

const en = JSON.parse(readRaw('messages/en.json')) as Record<string, any>;
const bg = JSON.parse(readRaw('messages/bg.json')) as Record<string, any>;

describe('1 — the audits hub surfaces its cycle filter', () => {
    const src = read(HUB);

    it('renders a cycle picker that drives ?cycleId', () => {
        expect(src).toMatch(/id: 'audits-cycle-picker'/);
        // The picker navigates to ?cycleId (or clears it), not a local filter.
        expect(src).toMatch(/audits\$\{id \? `\?cycleId=\$\{id\}` : ''\}/);
        // Options come from the real cycle list, with an explicit "all" entry.
        expect(src).toMatch(/CACHE_KEYS\.audits\.cycles\(\)/);
        expect(src).toMatch(/hub\.cyclePickerAll/);
    });

    it('the active-filter banner NAMES the selected cycle', () => {
        expect(src).toMatch(/hub\.cycleFilterActiveNamed/);
        expect(src).toMatch(/\{ name: selectedCycle\.name \}/);
        for (const cat of [en, bg]) {
            expect(cat.audits.hub.cycleFilterActiveNamed).toMatch(/\{name\}/);
            expect(cat.audits.hub.cyclePickerLabel).toBeTruthy();
            expect(cat.audits.hub.cyclePickerAll).toBeTruthy();
        }
    });
});

describe('2 — a register-created finding can carry audit provenance', () => {
    const src = read(CREATE_FINDING);

    it('the modal offers an optional originating-audit picker', () => {
        expect(src).toMatch(/id="finding-audit"/);
        expect(src).toMatch(/name="auditId"/);
        expect(src).toMatch(/CACHE_KEYS\.audits\.list\(\)/);
    });

    it('the picked audit is actually submitted', () => {
        expect(src).toMatch(/auditId: form\.auditId \|\| undefined/);
    });

    it('the create schema accepts auditId and the usecase persists it', () => {
        expect(read('src/lib/schemas/index.ts')).toMatch(/auditId: z\.string\(\)\.optional\(\)\.nullable\(\)/);
        expect(read('src/app-layer/usecases/finding.ts')).toMatch(/auditId: data\.auditId \|\| null/);
    });

    it('both catalogs carry the picker copy', () => {
        for (const cat of [en, bg]) {
            expect(cat.findings.create.labelOriginatingAudit).toBeTruthy();
            expect(cat.findings.create.descOriginatingAudit).toBeTruthy();
        }
    });
});

describe('3 — the materialize affordance is precise', () => {
    it('the pack button label differs per return-channel kind', () => {
        const src = read(PACK);
        // FINDING → "create finding"; EVIDENCE_REQUEST → "create observation",
        // matching the finding TYPE each one materialises into.
        expect(src).toMatch(/c\.kind === 'FINDING'[\s\S]{0,160}auditorActivity\.createFinding[\s\S]{0,160}auditorActivity\.createObservation/);
        for (const cat of [en, bg]) {
            expect(cat.audits.packs.auditorActivity.createObservation).toBeTruthy();
        }
    });

    it('the kind → finding-type mapping the labels describe is real', () => {
        expect(read(SHARING)).toMatch(
            /findingType = loaded\.comment\.kind === 'FINDING' \? 'NONCONFORMITY' : 'OBSERVATION'/,
        );
    });

    it('the chosen fieldwork audit is documented as deterministic, not arbitrary', () => {
        // RAW: the window below IS the rationale comment, so it must not be masked.
        const src = readDoc(SHARING);
        // The oldest-audit choice must carry a written rationale next to it —
        // an undocumented orderBy is what made this look arbitrary.
        const window = src.slice(
            Math.max(0, src.indexOf('const audit = pack') - 1200),
            src.indexOf('const audit = pack'),
        );
        expect(window).toMatch(/Deterministic attachment point/i);
        expect(window).toMatch(/OLDEST/);
        expect(src).toMatch(/orderBy: \{ createdAt: 'asc' \}/);
    });
});

describe('4 — polish: localized statuses, branded fallback, honest comment', () => {
    it('the cycle-list card localizes its status instead of printing the enum', () => {
        const src = read(CYCLES_LIST);
        expect(src).toMatch(/cycleStatus\.\$\{c\.status\}/);
        // The raw-enum render is gone.
        expect(src).not.toMatch(/<StatusBadge[^>]*>\{c\.status\}<\/StatusBadge>/);
    });

    it('custom-framework cycles get a generic-but-branded chip, not flat gray', () => {
        const src = read(CYCLES_LIST);
        expect(src).toMatch(/const fwMeta = /);
        expect(src).toMatch(/FW_FALLBACK/);
        // The old gray fallback is gone.
        expect(src).not.toMatch(/from-gray-500 to-gray-600/);
    });

    it('the cycle-detail fieldwork badges localize the audit status enum', () => {
        const src = read(CYCLE_DETAIL);
        expect(src).toMatch(/auditStatusLabel\(a\.status\)/);
        expect(src).toMatch(/PLANNED: 'planned'/);
        expect(src).not.toMatch(/className="ml-2">\{a\.status\}</);
    });

    it('the FindingRepository list-select comment matches the select', () => {
        const src = read(FINDING_REPO);
        // `header` is the comment block above the select, so it reads RAW; `src`
        // stays masked because `audit: {` below is a CODE assertion.
        const header = readDoc(FINDING_REPO).slice(
            0,
            readDoc(FINDING_REPO).indexOf('const findingListSelect'),
        );
        // The select DOES carry the audit relation now — the comment must not
        // claim the page never reads it.
        expect(src).toMatch(/audit: \{/);
        expect(header).not.toMatch(/the page never reads on the list view/);
        expect(header).toMatch(/provenance/i);
    });
});
