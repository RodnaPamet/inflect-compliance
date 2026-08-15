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
/**
 * Reads that genuinely never hand bytes to a caller.
 *
 * TWO ENTRIES HAVE BEEN REMOVED from this map because they did not meet its
 * own definition, and their presence made the scan certify them without ever
 * checking. That is the failure this file was written to prevent, recreated
 * one level up: the discovery scan replaced a hand-written route list, and its
 * escape hatch quietly became the new hand-written route list.
 *
 * They now live in SERVES_UNSCANNED_BY_DESIGN below, which states what is
 * actually true about them instead.
 */
const NON_SERVING_READS: Record<string, string> = {
    'src/app-layer/jobs/evidence-import.ts':
        'Reads back its OWN staging upload to parse it — this runs BEFORE the file becomes servable evidence, so gating on the scan it precedes would deadlock the import.',
    'src/app-layer/services/import-snapshot.ts':
        'Reads back a snapshot this process wrote moments earlier; never serves it to a caller.',
    'src/app-layer/usecases/audit-hardening.ts':
        'Reads to compute a SHA-256 integrity hash. The bytes are consumed by crypto.createHash and discarded; hashing an infected file is safe precisely because nothing is served.',
};

/**
 * Reads that DO serve bytes, are NOT gated on `isDownloadAllowed`, and are
 * accepted anyway — each with the actual reason, not a category error.
 *
 * The distinction from NON_SERVING_READS is the whole point. Calling a serving
 * path "non-serving" makes the scan skip it and tells the next reader there is
 * nothing here; recording it as an accepted risk keeps it visible and puts the
 * argument where it can be disagreed with.
 */
const SERVES_UNSCANNED_BY_DESIGN: Record<string, string> = {
    'src/lib/account/avatar.ts':
        'SERVES user-uploaded bytes, unscanned. Not FileRecord-backed, so there is no scanStatus to gate on — that is a gap, not a refutation. Accepted on three mitigations: a 512KB cap, a magic-byte sniff, and a forced image/webp content-type with no Content-Disposition, so the response renders rather than downloads. That blocks the stored-XSS and dropper shapes but NOT a malicious-decoder payload. Any session user can fetch any userId by design (member lists). Routing avatars through FileRecord + scan is the real fix and is a product decision, not a line.',
    'src/app-layer/usecases/risk-report.ts':
        'SERVES a report the generator itself just produced — system-authored bytes, never user-uploaded. The argument holds today; it is listed here rather than as non-serving so that an edit which reads a user-uploaded attachment INTO a report has to come past this line.',
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
            (f) =>
                !read(f).includes('isDownloadAllowed') &&
                !(f in NON_SERVING_READS) &&
                !(f in SERVES_UNSCANNED_BY_DESIGN),
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

    /**
     * The accepted-risk map needs the SAME stale check, and one more: an entry
     * that starts gating on `isDownloadAllowed` should leave this map rather
     * than sit here claiming to be an accepted risk it no longer is.
     */
    it('SERVES_UNSCANNED_BY_DESIGN has no stale entries', () => {
        for (const declared of Object.keys(SERVES_UNSCANNED_BY_DESIGN)) {
            expect({ declared, exists: existsSync(join(ROOT, declared)) }).toEqual({
                declared,
                exists: true,
            });
            expect(read(declared).includes('isDownloadAllowed')).toBe(false);
        }
    });

    it('every accepted risk states WHY, at length', () => {
        // A one-line reason is how "not FileRecord-backed" came to read as a
        // refutation instead of a description of the gap.
        for (const [file, reason] of Object.entries(SERVES_UNSCANNED_BY_DESIGN)) {
            expect({ file, long: reason.length > 120 }).toEqual({ file, long: true });
        }
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
    it('downloadEvidenceFile walks the version chain', () => {
        expect(src).toMatch(/previousFileRecordId: headFileId/);
    });

    /**
     * This used to assert `evidence?.deletedAt` and `evidence?.isArchived` —
     * the OPTIONAL-CHAINING form, which was the bug rather than the fix.
     * Evidence is soft-delete filtered, so a deleted row came back NULL and
     * `evidence?.deletedAt` evaluated to `undefined`: the gate was skipped BY
     * deletion instead of triggered by it. The guard pinned the shape of the
     * code it was written against, and that shape could not refuse anything.
     *
     * The invariant is what the gate must ACHIEVE: see the deleted row, and
     * refuse when there is no owning evidence at all.
     */
    it('fetches the owning evidence with withDeleted so the gate can see a deleted row', () => {
        expect(src).toMatch(/db\.evidence\.findFirst\(\s*withDeleted\(/);
    });

    it('refuses when there is no owning evidence, for every role', () => {
        // An orphaned FileRecord (evidence hard-purged) must not be servable.
        // Previously only the read-tier branch refused this, so write-tier
        // roles downloaded purged files.
        expect(src).toMatch(/if \(!evidence\) \{[\s\S]{0,120}?throw notFound/);
        // …and the refusal must NOT be nested inside the canWrite branch.
        const orphanCheck = src.indexOf('if (!evidence) {');
        const readTierBranch = src.indexOf('if (!ctx.permissions.canWrite)');
        expect(orphanCheck).toBeGreaterThan(-1);
        expect(orphanCheck).toBeLessThan(readTierBranch);
    });

    it('still gates on deleted AND archived', () => {
        expect(src).toMatch(/evidence\.deletedAt/);
        expect(src).toMatch(/evidence\.isArchived/);
    });
});
