/**
 * Every path that accepts user-supplied FILE BYTES scans them.
 *
 * `uploadEvidenceFile` has called `scanUploadOrRefuse` since #1903.
 * `replaceEvidenceFile` — which takes a `File` from the same user, over an
 * evidence row that may already be APPROVED — did not, and passed no verdict
 * to `markStored`. Its FileRecord therefore sat at the schema's PENDING with
 * nothing in the system ever scanning it.
 *
 * The consequence differed by AV_SCAN_MODE, which is why it survived review
 * and why no single test would have exposed it:
 *   - `strict`     → PENDING is refused at download, so replacing a file
 *                    silently made it undownloadable (a functional bug),
 *   - `permissive` → PENDING is served, so unscanned bytes were handed out
 *                    behind an existing evidence row (a security bug).
 * Neither mode errors. Both look like the feature working.
 *
 * A behavioural test would have to mock storage, Prisma, the scanner and the
 * repository just to observe one call. This asserts the invariant structurally
 * instead — the property being "every byte-accepting path reaches the
 * scanner", which is exactly the shape a future third upload path would break.
 *
 * @see tests/unit/av-scan-terminal-verdict.test.ts — the webhook's half
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'src/app-layer/usecases/evidence.ts');

/**
 * THE READER IS THE SEAM, and this file is where getting it wrong is worst.
 *
 * Every assertion below is a source match, so every one of them was
 * satisfiable by a COMMENT while the read was raw. That is not theoretical
 * here: the ordering assertion is an `indexOf` comparison between two literal
 * strings, so a note NAMING the scanner above the write inverts it. Measured
 * on this file, before this change — move the AV scan below `storage.write`
 * in `replaceEvidenceFile` and leave
 *
 *     // Scan moved below the write so the buffer is streamed once:
 *     // scanUploadOrRefuse(ctx, buffer, ...) now runs on the stored object.
 *
 * above it, and the guard was **5/5 GREEN** on exactly the bug its own header
 * describes ("unscanned bytes were handed out behind an existing evidence
 * row"). Every other suite in the repo that mentions `scanUploadOrRefuse` was
 * green on it too — this guard is the sole detector, so its blind spot was
 * the whole coverage.
 *
 * `codeOf` blanks comments (keeping string literals, which several assertions
 * here are about) before any matching starts, so prose cannot satisfy, and —
 * because it preserves offsets — cannot reorder either.
 */
const read = (): string => codeOf(fs.readFileSync(EVIDENCE, 'utf8'));

/**
 * `functionBodyOf` from ../helpers/source-blocks, not a local extractor.
 *
 * This file used to hand-roll the walk, with a docstring explaining why the
 * shared helper was not right: `declarationOf` anchors on `const <name>` and
 * these are `function` declarations. True — and the wrong helper was named.
 * `functionBodyOf` bounds a `function` declaration by its body braces, walks
 * the parameter list at paren depth first (so an inline object type in the
 * params is not mistaken for the body), throws rather than returning '' when
 * the target is missing, and runs its anchor search and its RESULT over a
 * comment-masked view. The local copy had the first two properties and
 * neither of the last two.
 */
const bodyOf = (src: string, name: string): string => functionBodyOf(src, name);

const BYTE_ACCEPTING_USECASES = ['uploadEvidenceFile', 'replaceEvidenceFile'];

describe('evidence byte-accepting paths are scanned', () => {
    const src = read();

    it.each(BYTE_ACCEPTING_USECASES)('%s calls scanUploadOrRefuse', (fn) => {
        // Bounded to the function's own declaration. Scanning the whole file
        // would pass on the OTHER path's call — which is precisely the false
        // green that let this ship: the file always contained the string.
        // `bodyOf` throws when the function is gone, which is louder than the
        // `toBeTruthy()` that used to stand here — that could only ever have
        // failed on a '' the old extractor never returned.
        const block = bodyOf(src, fn);
        expect(block).toMatch(/scanUploadOrRefuse\(/);
    });

    it.each(BYTE_ACCEPTING_USECASES)('%s persists the verdict via markStored', (fn) => {
        // Scanning and then discarding the verdict leaves the row PENDING,
        // which is the same end state as not scanning at all. The call has to
        // carry its result.
        const block = bodyOf(src, fn);
        expect(block).toMatch(/markStored\([^)]*\bscan\b/);
    });

    it('the scan happens BEFORE the bytes reach storage', () => {
        // Order matters beyond tidiness: refusing after the write leaves an
        // infected object in the bucket AND in the SHA-256 dedup index, where
        // a later identical upload would reuse its FileRecord.
        //
        // This is the assertion the raw read broke. It compares two `indexOf`
        // results, so it is decided by WHERE the two strings appear — and a
        // comment naming `scanUploadOrRefuse(` above the write put the scanner
        // "first" with the real call sitting after `storage.write`. Reading
        // code rather than text is the whole fix; the comparison itself is an
        // ORDER, not a character budget, so it needs nothing else.
        for (const fn of BYTE_ACCEPTING_USECASES) {
            const block = bodyOf(src, fn);
            const scanAt = block.indexOf('scanUploadOrRefuse(');
            const writeAt = block.indexOf('storage.write(');
            expect(scanAt).toBeGreaterThan(-1);
            expect(writeAt).toBeGreaterThan(-1);
            expect({ fn, scanBeforeWrite: scanAt < writeAt }).toEqual({
                fn,
                scanBeforeWrite: true,
            });
        }
    });
});
