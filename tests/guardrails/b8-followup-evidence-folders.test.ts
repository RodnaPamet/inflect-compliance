/**
 * B8 follow-up — Evidence folders ratchet.
 *
 * Pairs with `b8-folders-frameworks.test.ts` (which locks the
 * VendorDocument folder pattern). This ratchet locks the same
 * shape on the bigger "documents" surface: Evidence.
 *
 *   1. `Evidence.folder String?` + `(tenantId, folder)` index in
 *      the Prisma schema.
 *   2. Migration `20260524190000_b8_evidence_folder` adds the
 *      column + the supporting index.
 *   3. `CreateEvidenceSchema` + `UpdateEvidenceSchema` accept the
 *      `folder` field with a 120-char cap.
 *   4. `createEvidence` + `updateEvidence` usecases trim +
 *      null-coerce the folder value (so empty input maps to
 *      "no folder" rather than the empty string).
 *   5. `uploadEvidenceFile` honours `folder` so file uploads land
 *      in the same folder as TEXT/LINK evidence.
 *   6. The `__none__` filter sentinel resolves to NULL/empty in
 *      `EvidenceRepository._buildWhere`.
 *   7. The evidence list page renders a Folder column, exposes
 *      the Folder filter via the toolbar, and mounts a shared
 *      `evidence-folder-suggestions` datalist for the create +
 *      upload modals.
 *   8. The Edit modal's `initial` shape carries `folder`, and the
 *      Edit modal renders a Folder input.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B8 follow-up — evidence folders', () => {
    describe('Schema + migration', () => {
        const compliance = readPrismaSchema();
        const migration = read(
            'prisma/migrations/20260524190000_b8_evidence_folder/migration.sql',
        );

        it('Evidence carries a nullable folder column', () => {
            // Anchor on the Evidence model so a `folder` field on
            // another model can't false-match.
            const evidenceBlock = compliance.slice(
                compliance.indexOf('model Evidence {'),
                compliance.indexOf('model FileRecord {'),
            );
            expect(evidenceBlock).toMatch(/^\s*folder\s+String\?/m);
        });

        it('Evidence indexes (tenantId, folder)', () => {
            const evidenceBlock = compliance.slice(
                compliance.indexOf('model Evidence {'),
                compliance.indexOf('model FileRecord {'),
            );
            expect(evidenceBlock).toMatch(
                /@@index\(\[tenantId,\s*folder\]\)/,
            );
        });

        it('migration adds the column + index', () => {
            expect(migration).toMatch(
                /ALTER TABLE "Evidence" ADD COLUMN "folder"/,
            );
            expect(migration).toMatch(
                /CREATE INDEX "Evidence_tenantId_folder_idx"/,
            );
        });
    });

    describe('Zod schema coverage', () => {
        const schema = read('src/lib/schemas/index.ts');

        it('CreateEvidence base schema accepts folder', () => {
            expect(
                /_CreateEvidenceBase[\s\S]{0,800}folder:\s*z\.string\(\)\.max\(120\)/.test(
                    schema,
                ),
            ).toBe(true);
        });

        it('UpdateEvidenceSchema accepts folder', () => {
            expect(
                /UpdateEvidenceSchema[\s\S]{0,800}folder:\s*z\.string\(\)\.max\(120\)/.test(
                    schema,
                ),
            ).toBe(true);
        });
    });

    describe('Usecase wiring', () => {
        const usecase = read('src/app-layer/usecases/evidence.ts');

        it('createEvidence trims + null-coerces folder', () => {
            expect(usecase).toMatch(/folder:\s*data\.folder\?\.trim\(\)\s*\|\|\s*null/);
        });

        it('updateEvidence honours the three-state contract', () => {
            // undefined = no change, null = clear, string = set.
            expect(usecase).toMatch(
                /folder:[\s\S]{0,200}data\.folder === undefined[\s\S]{0,200}data\.folder\?\.trim\(\)\s*\|\|\s*null/,
            );
        });

        it('uploadEvidenceFile threads folder onto the new row', () => {
            expect(usecase).toMatch(/folder:\s*metadata\.folder\?\.trim\(\)\s*\|\|\s*null/);
        });
    });

    describe('Repository filter (__none__ sentinel)', () => {
        const src = read('src/app-layer/repositories/EvidenceRepository.ts');

        it('declares folder on EvidenceListFilters', () => {
            expect(src).toMatch(
                /interface EvidenceListFilters[\s\S]{0,500}folder\?:\s*string/,
            );
        });

        it('selects the folder column for the list shape', () => {
            expect(src).toMatch(/^\s*folder:\s*true,/m);
        });

        it('resolves __none__ to a NULL-or-empty WHERE clause', () => {
            expect(src).toMatch(
                /filters\.folder === ['"]__none__['"][\s\S]{0,200}folder:\s*null/,
            );
        });
    });

    describe('API GET route', () => {
        const route = read(
            'src/app/api/t/[tenantSlug]/evidence/route.ts',
        );

        it('EvidenceQuerySchema accepts folder', () => {
            expect(route).toMatch(/folder:\s*z\.string\(\)\.optional\(\)/);
        });

        it('threads query.folder into the filters object', () => {
            expect(route).toMatch(/folder:\s*query\.folder/);
        });
    });

    describe('Upload route forwards folder', () => {
        const upload = read(
            'src/app/api/t/[tenantSlug]/evidence/uploads/route.ts',
        );

        it('reads folder from the multipart form data', () => {
            // R5-P3 #6 — folder is now read through the Zod metadata schema
            // (empty() coerces blank → undefined) but still sourced from formData.
            expect(upload).toMatch(
                /folder:\s*empty\(formData\.get\(['"]folder['"]\)\)/,
            );
        });
    });

    describe('Filter defs surface the Folder filter', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/evidence/filter-defs.ts',
        );

        it('declares the folder filter def', () => {
            // Label migrated to next-intl; assert the folder def references
            // the key and it resolves to "Folder" in the en catalog.
            expect(src).toMatch(/folder:\s*\{[\s\S]{0,400}label:\s*t\('filters\.folder'\)/);
            const en = JSON.parse(read('messages/en.json')) as {
                evidence: { filters: Record<string, string> };
            };
            expect(en.evidence.filters.folder).toBe('Folder');
        });

        it('builds folder options at render time from loaded evidence', () => {
            expect(src).toMatch(/export function folderOptionsFromEvidence/);
            expect(src).toMatch(/__none__/);
        });

        it('buildEvidenceFilters accepts evidence + injects folder options', () => {
            expect(src).toMatch(
                // EP-3 intersected the evidence param type with
                // EvidenceCategoryLike; the folder contract still holds.
                /buildEvidenceFilters\([\s\S]{0,200}evidence: ReadonlyArray<EvidenceFolderLike/,
            );
        });
    });

    describe('Modals + table', () => {
        const newText = read(
            'src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
        );
        const upload = read(
            'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
        );
        const edit = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal.tsx',
        );
        const client = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
        );

        it('New TEXT evidence modal carries a Folder input', () => {
            expect(newText).toMatch(/data-testid="text-evidence-folder-input"/);
            expect(newText).toMatch(/list="evidence-folder-suggestions"/);
        });

        it('Upload modal carries a Folder input', () => {
            expect(upload).toMatch(/data-testid="upload-evidence-folder-input"/);
            expect(upload).toMatch(/list="evidence-folder-suggestions"/);
        });

        it('Upload mutation forwards the folder value via FormData', () => {
            expect(upload).toMatch(/formData\.append\(['"]folder['"]/);
        });

        it('Edit modal accepts a folder seed + renders a Folder input', () => {
            expect(edit).toMatch(/folder\?:\s*string\s*\|\s*null/);
            expect(edit).toMatch(/data-testid="edit-evidence-folder-input"/);
        });

        it('EvidenceClient threads evidence into the filter toolbar (via buildEvidenceFilters)', () => {
            // R-filter-gear (2026-06-07): the filters are now built in the
            // PARENT (so the filter gear can sit beside the columns gear in
            // the actions slot) and the visible subset is passed down — but
            // `evidence` still drives the folder filter options through
            // buildEvidenceFilters, and the built defs reach the toolbar.
            expect(client).toMatch(/buildEvidenceFilters\([\s\S]{0,120}evidence/);
            expect(client).toMatch(
                /<EvidenceFilterToolbar[\s\S]{0,120}filters=\{visibleFilterDefs\}/,
            );
        });

        it('EvidenceClient declares a global folder-suggestions datalist', () => {
            expect(client).toMatch(/<datalist id="evidence-folder-suggestions">/);
        });

        it('EvidenceClient adds a Folder column to the table', () => {
            // Header migrated to next-intl; match the key + resolve its en value.
            expect(client).toMatch(/id:\s*['"]folder['"][\s\S]{0,200}header:\s*tx\(['"]colHeaders\.folder['"]\)/);
            const en = JSON.parse(read('messages/en.json')) as {
                evidence: { colHeaders: Record<string, string> };
            };
            expect(en.evidence.colHeaders.folder).toBe('Folder');
        });
    });
});
