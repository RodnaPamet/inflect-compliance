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

/**
 * Strip comments, so prose ABOUT a thing never registers as the thing.
 *
 * Both the block form and the line form go. The line form is anchored at
 * start-of-line-or-whitespace rather than only at the start of a line, so a
 * TRAILING `// isDownloadAllowed(...) is handled upstream` is stripped too —
 * that is a comment as much as a full-line one is. Requiring whitespace before
 * the slashes is what keeps a URL intact (in `https://…` the slashes follow a
 * colon): over-stripping would be the same failure in the other direction,
 * silently shrinking the set of files the scan looks at.
 */
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/**
 * Does this source actually CALL the download gate?
 *
 * This used to be `source.includes('isDownloadAllowed')` — a substring test
 * against RAW source, in a file that strips comments before deciding which
 * files are storage readers in the first place. Those two halves disagreed:
 * a file whose only mention of the predicate sat in a docstring was found by
 * the (comment-stripped) reader scan and then certified as gated by the (raw)
 * substring test — no call, no allowlist entry, no failure. That is not
 * hypothetical prose: `src/app-layer/services/file-scan.ts` and
 * `src/lib/evidence-scan.ts` both mention the predicate in comments today and
 * would have satisfied the old check for free the day either one grew a
 * `readStream` call.
 *
 * Requiring the open-paren means the assertion is about conduct — a call —
 * rather than about the file containing a word.
 */
const callsDownloadGate = (source: string): boolean =>
    /\bisDownloadAllowed\s*\(/.test(stripComments(source));

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
    'src/app-layer/jobs/av-rescan.ts':
        'Reads bytes back only to hash them and hand them to the scanner; both consume the buffer and it is discarded. AvRescanResult is counters only — no bytes, no pathKey, no signed URL. Gating on isDownloadAllowed would deadlock it, because the verdict that gate reads is the thing this job exists to produce for rows that have none.',
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
        'SERVES user-uploaded bytes, unscanned. Not FileRecord-backed, so there is no scanStatus to gate on — that is a gap, not a refutation. Accepted on three mitigations: a 512KB cap, a magic-byte sniff, and a forced image/webp content-type with no Content-Disposition, so the response renders rather than downloads. That blocks the stored-XSS and dropper shapes but NOT a malicious-decoder payload. Readable by the subject and by users holding an ACTIVE membership in a tenant the subject is also ACTIVE in (#2104) — so a hostile payload reaches colleagues, not the whole userbase. Routing avatars through FileRecord + scan is the real fix and is a product decision, not a line.',
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

    // `stripComments` is hoisted to module scope alongside `callsDownloadGate`
    // — the reader scan and the gate check MUST see the same text, and keeping
    // one of them local to this block is how they drifted apart.
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

    it('every storage reader CALLS isDownloadAllowed or is a declared non-serving read', () => {
        const ungated = callers.filter(
            (f) =>
                !callsDownloadGate(read(f)) &&
                !(f in NON_SERVING_READS) &&
                !(f in SERVES_UNSCANNED_BY_DESIGN),
        );
        expect(ungated).toEqual([]);
    });

    /**
     * In-memory regression proof for the detector itself.
     *
     * The gate check above is only worth its name if a MENTION cannot satisfy
     * it. These cases run the detector over source strings rather than repo
     * files, so the proof holds even after every real file changes.
     */
    describe('the gate detector requires a call, not a mention', () => {
        it('a comment-only mention reports as UNGATED', () => {
            const commentOnly = [
                '/**',
                ' * The gate (`isDownloadAllowed`) is applied on every serving path.',
                ' */',
                "import { provider } from '@/lib/storage';",
                'export async function serve(key: string) {',
                '    // isDownloadAllowed(record.scanStatus) is handled by the caller',
                '    return provider.readStream(key); // isDownloadAllowed() upstream',
                '}',
            ].join('\n');

            // The token IS present — this is exactly the shape the old
            // substring check certified as gated.
            expect(commentOnly.includes('isDownloadAllowed')).toBe(true);
            expect(callsDownloadGate(commentOnly)).toBe(false);
        });

        it('a real call reports as GATED', () => {
            const realCall =
                'if (!isDownloadAllowed(fileRecord.scanStatus)) {\n' +
                '    throw forbidden(getBlockedReason(fileRecord.scanStatus));\n' +
                '}';
            expect(callsDownloadGate(realCall)).toBe(true);
            // whitespace before the paren is still a call
            expect(callsDownloadGate('if (!isDownloadAllowed (s)) return;')).toBe(true);
        });

        it('the repo file that mentions the predicate in prose is not counted as gating', () => {
            // src/app-layer/services/file-scan.ts describes the gate in its
            // header docstring and never calls it. It is not a storage reader
            // today, so nothing is wrong — it is the live proof that the trap
            // was reachable, and it is asserted here so a future edit that
            // turns that file into a serving path has to face the gate.
            const src = read('src/app-layer/services/file-scan.ts');
            expect(src.includes('isDownloadAllowed')).toBe(true);
            expect(callsDownloadGate(src)).toBe(false);
        });

        it('a URL is not mistaken for a comment (the stripper does not over-strip)', () => {
            const withUrl =
                "const docs = 'https://example.test/av'; if (!isDownloadAllowed(s)) return;";
            expect(callsDownloadGate(withUrl)).toBe(true);
        });
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
            // "still ungated" means it does not CALL the predicate. Asking
            // whether the word appears would fail the moment someone explains
            // in a comment why this file cannot gate — the very reason the
            // entry exists.
            expect(callsDownloadGate(read(declared))).toBe(false);
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
