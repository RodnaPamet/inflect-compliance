/**
 * R5-P1 — evidence/file DOWNLOAD-path security (structural ratchet).
 *
 * The primary `downloadEvidenceFile` was correct; PR-1 brought the adjacent
 * serving paths up to it. This locks the load-bearing guarantees so a refactor
 * can't quietly reopen the cross-tenant read chain or drop an AV gate:
 *   1. downloadFile asserts the tenant key + resolves via FileRecord, and the
 *      caller-writable-content ownership check (isFileOwnedByTenant) is gone.
 *   2. createEvidence refuses FILE-via-JSON (content = server-derived key only).
 *   3. The deprecated flat/never-scanned uploadFile() helper is gone.
 *   4. Every serving path runs through the ONE isDownloadAllowed predicate.
 *   5. downloadEvidenceFile resolves the version chain + gates deleted/archived.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const FILE_USECASE = 'src/app-layer/usecases/file.ts';
const EVIDENCE = 'src/app-layer/usecases/evidence.ts';
const FILE_REPO = 'src/app-layer/repositories/FileRepository.ts';
const LIB_STORAGE = 'src/lib/storage.ts';
const ACCESS_REVIEW_ROUTE = 'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/evidence/route.ts';
const BUNDLE = 'src/app-layer/services/bundle-attachments.ts';

describe('R5-P1 (1) downloadFile closes the cross-tenant chain', () => {
    const src = read(FILE_USECASE);
    it('asserts the tenant key and resolves via FileRecord — not content-ownership', () => {
        expect(src).toMatch(/assertTenantKey\(fileName, ctx\.tenantId\)/);
        expect(src).toMatch(/db\.fileRecord\.findFirst/);
        // no CALL to the removed content-ownership check (a comment may explain it)
        expect(src).not.toMatch(/FileRepository\.isFileOwnedByTenant\(/);
    });
    it('the broken content-based ownership check is removed from the repository', () => {
        expect(read(FILE_REPO)).not.toMatch(/static async isFileOwnedByTenant/);
    });
    it('the unused/broken tenant files route is deleted', () => {
        expect(existsSync(join(ROOT, 'src/app/api/t/[tenantSlug]/files/[fileName]/route.ts'))).toBe(false);
    });
});

describe('R5-P1 (2) createEvidence refuses FILE-via-JSON', () => {
    it('rejects caller-supplied content for FILE type', () => {
        const src = read(EVIDENCE);
        expect(src).toMatch(/data\.type === 'FILE'[\s\S]{0,300}FILE_VIA_UPLOAD/);
    });
});

describe('R5-P1 (3) the deprecated uploadFile helper is gone', () => {
    it('lib/storage no longer exports uploadFile', () => {
        expect(read(LIB_STORAGE)).not.toMatch(/export async function uploadFile\(/);
    });
});

describe('R5-P1 (4) one AV predicate on every serving path', () => {
    it('downloadFile + downloadEvidenceFile gate on isDownloadAllowed', () => {
        expect(read(FILE_USECASE)).toMatch(/isDownloadAllowed\(fileRecord\.scanStatus\)/);
        const ev = read(EVIDENCE);
        expect(ev).toMatch(/isDownloadAllowed\(fileRecord\.scanStatus\)/);
        // the inline `scanMode === 'strict'` reimplementation is gone
        expect(ev).not.toMatch(/scanMode === 'strict'/);
    });
    it('the access-review + bundle serving paths gate too', () => {
        expect(read(ACCESS_REVIEW_ROUTE)).toMatch(/isDownloadAllowed\(fileRecord\.scanStatus\)/);
        expect(read(BUNDLE)).toMatch(/isDownloadAllowed\(record\.scanStatus\)/);
    });
});

describe('R5-P1 (5) version-aware deleted/archived gate', () => {
    const src = read(EVIDENCE);
    it('downloadEvidenceFile walks the version chain + checks deleted AND archived', () => {
        expect(src).toMatch(/previousFileRecordId: headFileId/);
        expect(src).toMatch(/evidence\?\.deletedAt/);
        expect(src).toMatch(/evidence\?\.isArchived/);
    });
});
