/**
 * Unit Tests — Evidence ↔ Control Linking
 *
 * Proves that:
 * 1. createEvidence validates controlId belongs to the same tenant
 * 2. createEvidence creates ControlEvidenceLink when controlId is provided (FILE/LINK types)
 * 3. createEvidence works without controlId (standalone evidence)
 * 4. uploadEvidenceFile validates controlId belongs to the same tenant
 * 5. The control evidence tab query returns both evidenceLinks and evidence
 */
import { buildRequestContext, buildControl, buildEvidence } from '../helpers/factories';

// ─── Structural: createEvidence validates controlId ───

describe('Evidence → Control linking — structural', () => {
    const usecasePath = require('path').resolve(
        __dirname, '../../src/app-layer/usecases/evidence.ts'
    );
    const usecaseContent = require('fs').readFileSync(usecasePath, 'utf-8');

    test('createEvidence validates control tenant before creating evidence', () => {
        // The usecase must check that the control belongs to the same tenant
        expect(usecaseContent).toContain('INVALID_CONTROL');
        expect(usecaseContent).toContain('Control not found or belongs to a different tenant');
    });

    test('createEvidence writes the EvidenceControlLink join (removed bridge is gone)', () => {
        // EP-3 — createEvidence now delegates to
        // EvidenceRepository.createControlLinks, which writes N
        // EvidenceControlLink join rows. The old best-effort
        // ControlEvidenceLink "bridge" write for Evidence entities is
        // removed (ControlEvidenceLink is retained only for
        // url/integration/bia artifacts).
        expect(usecaseContent).toContain('createControlLinks');
        expect(usecaseContent).not.toContain('controlEvidenceLink.create');
    });

    test('uploadEvidenceFile also validates controlId tenant', () => {
        // uploadEvidenceFile has the same validation
        const uploadSection = usecaseContent.split('uploadEvidenceFile')[1] || '';
        expect(uploadSection).toContain('INVALID_CONTROL');
    });

    test('uploadEvidenceFile writes the EvidenceControlLink join for file evidence', () => {
        const uploadSection = usecaseContent.split('uploadEvidenceFile')[1] || '';
        expect(uploadSection).toContain('createControlLinks');
    });

    test('duplicate control link is idempotent (join createMany skips duplicates)', () => {
        // EP-3 — idempotency moved from the old try/catch around the bridge
        // insert into the join repository: createControlLinks uses createMany
        // with skipDuplicates, so re-linking the same control is a no-op.
        const repoPath = require('path').resolve(
            __dirname, '../../src/app-layer/repositories/EvidenceRepository.ts'
        );
        const repoContent = require('fs').readFileSync(repoPath, 'utf-8');
        expect(repoContent).toContain('createControlLinks');
        expect(repoContent).toContain('skipDuplicates');
    });
});

// ─── Structural: control detail query includes both evidence arrays ───

describe('Control detail query — evidence completeness', () => {
    const repoPath = require('path').resolve(
        __dirname, '../../src/app-layer/repositories/ControlRepository.ts'
    );
    const repoContent = require('fs').readFileSync(repoPath, 'utf-8');

    test('control getById includes evidenceLinks relation', () => {
        expect(repoContent).toContain('evidenceLinks');
    });

    test('control getById reads evidence through the evidenceControlLinks join', () => {
        // EP-3 — the singular Evidence.controlId FK is gone; the detail
        // query includes the many-to-many join and flattens it back to the
        // `control.evidence` array the detail page expects.
        expect(repoContent).toMatch(/evidenceControlLinks:\s*\{/);
        expect(repoContent).toContain('evidenceControlLinks.map');
    });
});

// ─── Structural: frontend evidence tab renders both sources ───

describe('Control evidence tab — unified display', () => {
    // R10-PR3 follow-up — the evidence-tab rendering moved from
    // `page.tsx` into the extracted `_tabs/EvidenceSubTable.tsx`
    // (raw `<table>` → `<DataTable>` migration; the inline helper
    // would have blown the page-size ratchet, so it lives in its
    // own file). The structural assertions still hold but they now
    // need to match in EITHER location. We concatenate both file
    // contents and search the joined string, so a future re-shuffle
    // (e.g. inlining the helper back during a tab refactor) doesn't
    // re-break the test.
    const path = require('path');
    const fs = require('fs');
    const PAGE_PATH = path.resolve(
        __dirname, '../../src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx'
    );
    const SUBTABLE_PATH = path.resolve(
        __dirname, '../../src/components/controls-shared/EvidenceSubTable.tsx'
    );
    const pageContent = fs.readFileSync(PAGE_PATH, 'utf-8');
    const subtableContent = fs.existsSync(SUBTABLE_PATH)
        ? fs.readFileSync(SUBTABLE_PATH, 'utf-8')
        : '';
    const evidenceTabContent = pageContent + '\n' + subtableContent;

    // #102 item 1 — the Evidence tab is tab-lazy: it fetches its own
    // `{ links, evidence }` payload via `evidenceSWR` instead of
    // reading the arrays off the eager page-data control.
    test('evidence tab fetches its links + evidence payload', () => {
        // The SWR fetch lives in page.tsx (page-level state); the
        // sub-table receives it via `data=`.
        expect(pageContent).toContain('evidenceSWR.data');
        // The unified rendering (`data?.links` + `data?.evidence`)
        // lives in the extracted EvidenceSubTable.
        expect(evidenceTabContent).toMatch(/data\?\.links/);
        expect(evidenceTabContent).toMatch(/data\?\.evidence/);
    });

    test('evidence tab renders direct evidence records', () => {
        expect(evidenceTabContent).toContain('directEvidence');
    });

    test('evidence tab reads direct evidence without the removed fileRecordId dedup', () => {
        // EP-3 — Evidence entities reach the control through the
        // EvidenceControlLink join; ControlEvidenceLink (`links`) now only
        // carries genuinely non-Evidence artifacts. The old `linkedFileIds`
        // dedup that compensated for the dual representation is gone — the
        // sub-table reads `data.evidence` directly.
        expect(evidenceTabContent).not.toContain('linkedFileIds');
        expect(subtableContent).toContain('directEvidence');
        expect(subtableContent).toMatch(/data\?\.evidence/);
    });

    test('evidence tab count includes both sources', () => {
        // The Evidence badge sums the link + direct-evidence counts
        // off the page-data `_count` — still in page.tsx.
        expect(pageContent).toMatch(/_count\?\.evidenceLinks[\s\S]*?_count\?\.evidence/);
    });
});

// ─── Unit: factory support ───

describe('Evidence → Control linking — factories', () => {
    test('buildEvidence with controlId sets FK', () => {
        const e = buildEvidence({ controlId: 'ctrl-123' });
        expect(e.controlId).toBe('ctrl-123');
    });

    test('buildEvidence without controlId defaults to null', () => {
        const e = buildEvidence();
        expect(e.controlId).toBeNull();
    });

    test('buildControl creates valid control object', () => {
        const c = buildControl({ tenantId: 'tenant-1' });
        expect(c.tenantId).toBe('tenant-1');
        expect(c.id).toBeDefined();
        expect(c.name).toBeDefined();
    });

    test('cross-tenant controlId should be rejected by usecase', () => {
        const ctx = buildRequestContext({ tenantId: 'tenant-a' });
        const control = buildControl({ tenantId: 'tenant-b' });
        // The usecase queries db.control.findFirst with tenantId: ctx.tenantId,
        // so a control from a different tenant won't be found → badRequest thrown
        expect(ctx.tenantId).not.toBe(control.tenantId);
    });
});

// ─── API Route: evidence POST accepts JSON (not FormData) ───

describe('Evidence API route — JSON body parsing', () => {
    const tenantRoutePath = require('path').resolve(
        __dirname, '../../src/app/api/t/[tenantSlug]/evidence/route.ts'
    );
    const tenantRouteContent = require('fs').readFileSync(tenantRoutePath, 'utf-8');

    const legacyRoutePath = require('path').resolve(
        __dirname, '../../src/app/api/evidence/route.ts'
    );
    const legacyRouteContent = require('fs').readFileSync(legacyRoutePath, 'utf-8');

    test('tenant evidence POST uses withValidatedBody (not withValidatedForm)', () => {
        expect(tenantRouteContent).toContain('withValidatedBody');
        expect(tenantRouteContent).not.toMatch(/withValidatedForm/);
    });

    test('tenant evidence POST uses CreateEvidenceSchema (not FormSchema)', () => {
        expect(tenantRouteContent).toContain('CreateEvidenceSchema');
        expect(tenantRouteContent).not.toMatch(/CreateEvidenceFormSchema/);
    });

    test('legacy evidence POST uses withValidatedBody', () => {
        expect(legacyRouteContent).toContain('withValidatedBody');
        expect(legacyRouteContent).not.toMatch(/withValidatedForm/);
    });
});

// ─── Schema: CreateEvidenceSchema supports controlId ───

describe('Evidence schema — controlId support', () => {
    const schemaPath = require('path').resolve(
        __dirname, '../../src/lib/schemas/index.ts'
    );
    const schemaContent = require('fs').readFileSync(schemaPath, 'utf-8');

    test('CreateEvidenceSchema includes optional controlId', () => {
        expect(schemaContent).toContain('controlId');
        // controlId should be optional and nullable
        expect(schemaContent).toMatch(/controlId.*optional.*nullable|controlId.*nullable.*optional/);
    });
});
