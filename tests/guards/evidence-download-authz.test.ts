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
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const FILE_USECASE = 'src/app-layer/usecases/file.ts';
const EVIDENCE = 'src/app-layer/usecases/evidence.ts';
const FILE_REPO = 'src/app-layer/repositories/FileRepository.ts';
const LIB_STORAGE = 'src/lib/storage.ts';
const ACCESS_REVIEW_ROUTE = 'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/evidence/route.ts';
const BUNDLE = 'src/app-layer/services/bundle-attachments.ts';
const TRUST_DOWNLOAD_ROUTE = 'src/app/api/trust/download/[token]/route.ts';

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

/**
 * (4b) DISCOVERY — the enumeration above cannot catch the next serving path.
 *
 * The four named files were the four that existed when this guard was written.
 * `src/app/api/trust/download/[token]/route.ts` — the repo's ONLY
 * unauthenticated download — was added later, selected just
 * `{ pathKey, originalName }`, and served INFECTED, mid-scan and soft-deleted
 * files to anonymous callers for as long as it existed. A hardcoded list is
 * green the entire time that is true, which is precisely how it got through.
 *
 * So this scans instead: every file that reaches a storage READ primitive must
 * either gate on `isDownloadAllowed` or be listed below as a non-serving read.
 * "Non-serving" is a narrow claim — the bytes never reach a caller as bytes or
 * as a signed URL. Hashing a file, extracting its text for indexing, or reading
 * back something this process itself just wrote are all non-serving. Handing a
 * user a stream or a redirect is not, no matter how the route is authenticated.
 */
const NON_SERVING_READS: Record<string, string> = {
    'src/lib/account/avatar.ts':
        'Account avatars — not FileRecord-backed evidence; no scanStatus column exists on that path.',
    'src/app-layer/jobs/evidence-import.ts':
        'Reads back its OWN staging upload to parse it — this runs BEFORE the file becomes servable evidence, so gating on the scan it precedes would deadlock the import.',
    'src/app-layer/services/import-snapshot.ts':
        'Reads back a snapshot this process wrote moments earlier; never serves it to a caller.',
    'src/app-layer/usecases/risk-report.ts':
        'Streams a report the generator itself just produced into storage — system-authored bytes, never user-uploaded content.',
    'src/app-layer/usecases/audit-hardening.ts':
        'Reads to compute a SHA-256 integrity hash. The bytes are consumed by crypto.createHash and discarded; hashing an infected file is safe precisely because nothing is served.',
};

describe('R5-P1 (4b) every storage read is gated or declared non-serving', () => {
    /** Storage READ primitives — the ways bytes or a URL leave the provider. */
    const READ_PRIMITIVE = /\.readStream\(|\.createSignedDownloadUrl\(/;

    function walk(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next') continue;
                walk(rel, out);
            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
                out.push(rel);
            }
        }
        return out;
    }

    /** Strip comments so prose about `readStream` doesn't register as a call. */
    const stripComments = (s: string) =>
        s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const callers = walk('src')
        // The provider implementations DEFINE these primitives; they are the
        // thing being gated, not a caller of it.
        .filter((f) => !f.startsWith('src/lib/storage/'))
        .filter((f) => READ_PRIMITIVE.test(stripComments(read(f))));

    it('finds the known serving paths (the scan itself works)', () => {
        // If this drops to a handful, the detector broke and every assertion
        // below is passing vacuously.
        expect(callers.length).toBeGreaterThanOrEqual(8);
        expect(callers).toContain(TRUST_DOWNLOAD_ROUTE);
        expect(callers).toContain(EVIDENCE);
    });

    it('every storage reader gates on isDownloadAllowed or is a declared non-serving read', () => {
        const ungated = callers.filter(
            (f) => !read(f).includes('isDownloadAllowed') && !(f in NON_SERVING_READS),
        );
        expect(ungated).toEqual([]);
    });

    it('the trust-center public download gates on scan + lifecycle', () => {
        // Called out separately because it is the only UNAUTHENTICATED serving
        // path in the repo: no session, no tenant context, just a token.
        const src = read(TRUST_DOWNLOAD_ROUTE);
        expect(src).toMatch(/scanStatus: true/);
        expect(src).toMatch(/status: true/);
        expect(src).toMatch(/deletedAt: true/);
        expect(src).toMatch(/isDownloadAllowed\(file\.scanStatus\)/);
        expect(src).toMatch(/file\.status !== 'STORED'/);
        // 404 not 403 — a distinguishable 403 confirms the document exists to
        // an anonymous caller replaying or guessing a token.
        expect(src).not.toMatch(/status: 403/);
    });

    it('NON_SERVING_READS has no stale entries', () => {
        for (const declared of Object.keys(NON_SERVING_READS)) {
            expect(existsSync(join(ROOT, declared))).toBe(true);
            // If it stopped reading storage, or started gating, drop the entry.
            expect(callers).toContain(declared);
        }
    });

    it('INFECTED is refused before the disabled-mode bypass', () => {
        // Ordering is the whole assertion: `disabled` sitting first meant a
        // file already known to be malware became servable the moment an
        // operator turned scanning off.
        const av = read('src/lib/storage/av-scan.ts');
        const infectedAt = av.indexOf("if (scanStatus === 'INFECTED') return false;");
        const disabledAt = av.indexOf("if (mode === 'disabled') return true;", infectedAt - 2000);
        expect(infectedAt).toBeGreaterThan(-1);
        expect(disabledAt).toBeGreaterThan(infectedAt);
    });

    it('the shared predicate accepts an absent scanStatus (so call sites need no guard)', () => {
        // A call site writing `x !== undefined && !isDownloadAllowed(x)` builds
        // a fail-OPEN wrapper around a fail-closed predicate — that is how an
        // unscanned attachment reached an export bundle. The type must permit
        // undefined so no one is pushed into writing that again.
        expect(read('src/lib/storage/av-scan.ts')).toMatch(
            /export function isDownloadAllowed\([\s\S]{0,600}?undefined,?\s*\)/,
        );
        expect(read(BUNDLE)).not.toMatch(/scanStatus !== undefined && !isDownloadAllowed/);
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
