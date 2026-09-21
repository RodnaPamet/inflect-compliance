/**
 * SP-5 ratchet — audit-pack SharePoint export + the sync-health dashboard must
 * stay wired: the export usecase (FROZEN-gated ZIP upload), the AuditPack export
 * columns, the export + health routes, and the dashboard page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read in this
// file is TypeScript/TSX, re-derived rather than assumed, so `codeOf` is the
// only masker needed here.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-5 SharePoint audit-pack export + health', () => {
    it('the export usecase is FROZEN-gated, builds a ZIP, records the export', () => {
        const src = read('src/app-layer/usecases/audit-pack-sharepoint-export.ts');
        expect(src).toMatch(/export async function exportAuditPackToSharePoint/);
        expect(src).toMatch(/FROZEN/);
        expect(src).toMatch(/JSZip|generateAsync/);
        expect(src).toMatch(/uploadNewFile/);
        expect(src).toMatch(/integrationExecution\.create/);
        // SP-F2 — bundles evidence binaries under evidence/ (capped + scan-gated).
        expect(src).toMatch(/bundleEvidenceBinaries/);
        expect(src).toMatch(/SP_EXPORT_MAX_BYTES/);
        expect(src).toMatch(/isDownloadAllowed/);
    });

    it('AuditPack has the SharePoint export columns + migration', () => {
        const schema = read('prisma/schema/audit-workflow.prisma');
        for (const col of ['spExportItemId', 'spExportWebUrl', 'spExportedAt']) {
            expect(schema).toMatch(new RegExp(col));
        }
        expect(exists('prisma/migrations/20260609160000_audit_pack_sharepoint_export/migration.sql')).toBe(true);
    });

    it('the export + health routes exist (admin.manage)', () => {
        const exp = 'src/app/api/t/[tenantSlug]/audits/packs/[packId]/sharepoint-export/route.ts';
        const health = 'src/app/api/t/[tenantSlug]/integrations/sharepoint/health/route.ts';
        expect(exists(exp)).toBe(true);
        expect(exists(health)).toBe(true);
        expect(read(exp)).toMatch(/requirePermission(<[^>]*>)?\(\s*'admin\.manage'/);
        expect(read(health)).toMatch(/requirePermission(<[^>]*>)?\(\s*'admin\.manage'/);
    });

    it('the export button + health dashboard page exist', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/SharePointExportButton.tsx')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/admin/integrations/sharepoint-health/page.tsx')).toBe(true);
        expect(read('src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx')).toMatch(/SharePointExportButton/);
    });
});
