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

const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'src/app-layer/usecases/evidence.ts');

/**
 * Extract one `export async function <name>(…) { … }` body by BALANCED
 * BRACES.
 *
 * Not `declarationOf` from ../helpers/source-blocks — that anchors on
 * `const <name>`, and these are function declarations. And deliberately not a
 * slice between two function NAMES or a byte window: reordering the file
 * yields a backwards slice (silently empty, so every assertion inside it
 * passes while checking nothing), and an unrelated edit upstream slides a
 * fixed window off the target.
 */
function functionBody(src: string, name: string): string {
    const start = src.search(
        new RegExp(`\\bexport\\s+async\\s+function\\s+${name}\\s*\\(`),
    );
    if (start < 0) throw new Error(`function not found: ${name}`);

    // Walk the PARAMETER LIST to its closing paren first. Taking the next `{`
    // after the function name finds the brace of an inline object TYPE in the
    // params (`metadata: { controlId?: string }`) rather than the body, and
    // then closes early — yielding a short block in which a later
    // `scanUploadOrRefuse` is invisible. That is a false NEGATIVE, so it fails
    // loudly; the mirror-image bug in a `not.toMatch` guard would pass
    // silently.
    const paren = src.indexOf('(', start);
    let parenDepth = 0;
    let bodyStart = -1;
    for (let i = paren; i < src.length; i++) {
        if (src[i] === '(') parenDepth++;
        else if (src[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                bodyStart = src.indexOf('{', i);
                break;
            }
        }
    }
    if (bodyStart < 0) throw new Error(`body not found: ${name}`);

    let depth = 0;
    for (let i = bodyStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Usecases that take raw bytes from a caller. Adding one means adding it here
 * — the list is the point, not an implementation detail.
 */
const BYTE_ACCEPTING_USECASES = ['uploadEvidenceFile', 'replaceEvidenceFile'];

describe('evidence byte-accepting paths are scanned', () => {
    const src = fs.readFileSync(EVIDENCE, 'utf8');

    it.each(BYTE_ACCEPTING_USECASES)('%s calls scanUploadOrRefuse', (fn) => {
        // Bounded to the function's own declaration. Scanning the whole file
        // would pass on the OTHER path's call — which is precisely the false
        // green that let this ship: the file always contained the string.
        const block = functionBody(src, fn);
        expect(block).toBeTruthy();
        expect(block).toMatch(/scanUploadOrRefuse\(/);
    });

    it.each(BYTE_ACCEPTING_USECASES)('%s persists the verdict via markStored', (fn) => {
        // Scanning and then discarding the verdict leaves the row PENDING,
        // which is the same end state as not scanning at all. The call has to
        // carry its result.
        const block = functionBody(src, fn);
        expect(block).toMatch(/markStored\([^)]*\bscan\b/);
    });

    it('the scan happens BEFORE the bytes reach storage', () => {
        // Order matters beyond tidiness: refusing after the write leaves an
        // infected object in the bucket AND in the SHA-256 dedup index, where
        // a later identical upload would reuse its FileRecord.
        for (const fn of BYTE_ACCEPTING_USECASES) {
            const block = functionBody(src, fn);
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
