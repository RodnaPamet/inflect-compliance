/**
 * No tracked source file carries a C0 control byte other than tab/LF/CR — or DEL.
 *
 * ═══ THE DEFECT, AND WHY IT IS AN ENCODING DEFECT AND NOT A BUG ═══
 *
 * Five source files held a raw control byte where a visible escape belongs
 * (#3161). Every one was deliberate in intent — a delimiter, a sentinel, a
 * header-injection fixture — and defective only in how it was spelled:
 *
 *   src/app-layer/services/sarif.ts                      4x NUL, hash delimiter
 *   tests/guardrails/dependency-paths-are-resolved.ts    1x NUL, OPAQUE sentinel
 *   tests/guards/still-surface-button-material.test.ts   1x NUL, corpus separator
 *   tests/helpers/prisma-enum-order.ts                   2x NUL, .join() delimiter
 *   tests/unit/content-disposition.test.ts               NUL, 0x0b, 0x1f fixtures
 *
 * All five now write the escape (`\0`, `\x0b`, `/[\r\n\x00-\x1f]/`). The escape
 * is byte-identical, so nothing changed behaviourally — including the SHA-256
 * fingerprints `sarif.ts` has already persisted.
 *
 * ═══ WHAT THE RAW BYTE COSTS ═══
 *
 * One NUL makes a whole file binary to POSIX text tooling, and the failure is
 * SILENT. Measured on `still-surface-button-material.test.ts` (32 KB, 7
 * `describe` blocks) while investigating an unrelated button regression:
 *
 *     $ grep -c 'describe(' tests/guards/still-surface-button-material.test.ts
 *     0
 *     $ grep -ac 'describe(' tests/guards/still-surface-button-material.test.ts
 *     7
 *
 * Zero, not an error. An hour went into concluding that guard asserted nothing
 * about press states. It asserts plenty.
 *
 * ═══ WHY THIS GUARD READS BYTES, AND NOT grep ═══
 *
 * This is the whole motivation, and the obvious implementations are all blind
 * in exactly the way the defect is:
 *
 *   - `grep -lIP` — the first hunt for this used it, and found only the two
 *     vendored Swagger-UI bundles. `-I` means "skip binary files", and a file
 *     with a NUL *is* a binary file, so `-I` skips precisely the files that
 *     have the defect. The three `tests/` offenders and `sarif.ts` were
 *     invisible to the search looking for them.
 *   - plain `grep` with no `-a` — prints nothing at all and exits 1 for a file
 *     containing a NUL (GNU grep 3.11 prints `Binary file … matches` for a
 *     *match*, but a non-matching pattern in a binary file is a silent 1).
 *   - `file -b --mime-encoding` — calls both Swagger-UI bundles `utf-8`
 *     *despite* their 0x07/0x1b, because those sit past `file`'s sniff buffer.
 *     This is how the original count came out at 5 instead of 8.
 *   - a first-KB NUL sniff, as `no-secrets.test.ts` uses to classify unknown
 *     extensions — same blindness as `-I`, and all five offenders carried
 *     their byte well past the first KB.
 *
 * So: `fs.readFileSync` into a Buffer, every byte compared. No text decode, no
 * heuristic, no early exit. ~70 MB over 7,142 files; the sweep runs in a few seconds.
 *
 * ═══ THE POPULATION AND ITS EXCLUSIONS ═══
 *
 * `git ls-files` — tracked files only. Deliberately NOT
 * `tests/helpers/repo-files.ts`'s `repoRelativeFiles()`, which adds
 * untracked-but-unignored files: with an EMPTY allowlist, one stray local
 * download or core dump would redden this guard for whoever has it and stay
 * green on CI. Tracked-only means the swept set is the same set a reviewer
 * sees in a diff.
 *
 * Exclusions are STRUCTURAL, with the reason written down, rather than three
 * literal path exceptions — see EXCLUSIONS below. They cover the three
 * legitimately-binary files in the tree, and would cover a fourth of the same
 * kind without anybody editing this file.
 *
 * The SOURCE allowlist ships EMPTY, and must stay that way unless someone
 * argues for an entry in a diff. That is the point of it.
 *
 * ═══ WHY DEL AND THE REST OF C0, NOT JUST NUL ═══
 *
 * NUL is the byte that causes the tooling blindness, but 0x0b/0x0c/0x1b/0x7f in
 * source are the same category of mistake and the tree is already clean of them
 * outside the three binaries — so the wider net costs nothing and does not have
 * to be widened later, under pressure, by whoever hits the next one.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BINARY_EXTENSIONS } from '../helpers/binary-extensions';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The three control bytes source text legitimately contains. Everything else
 * below 0x20, plus DEL, is banned.
 */
const ALLOWED_CONTROL_BYTES: ReadonlySet<number> = new Set([
    0x09, // tab
    0x0a, // LF
    0x0d, // CR
]);

function isBannedByte(b: number): boolean {
    return (b < 0x20 && !ALLOWED_CONTROL_BYTES.has(b)) || b === 0x7f;
}

/**
 * Structural reasons a tracked file is not source. Each carries the reason in
 * code, and what it covers TODAY — so a reviewer can tell an exclusion that
 * still earns its place from one that has rotted.
 */
const EXCLUSIONS: readonly { label: string; reason: string; covers: (rel: string) => boolean }[] = [
    {
        label: 'public/**',
        reason:
            'Static assets served verbatim — never source. Mirrors the `public/**` ' +
            'ignore already in eslint.config.mjs, for the same reason it exists there: ' +
            'the vendored, minified Swagger-UI bundles. Their 0x07/0x1b sit inside ' +
            'minified third-party string data and are not ours to re-spell.',
        covers: (rel) => rel === 'public' || rel.startsWith('public/'),
    },
    {
        label: 'binary extensions',
        reason:
            'Files whose contents ARE bytes, so a control byte is content and not a ' +
            'typo. Extension set shared with tests/guardrails/no-secrets.test.ts via ' +
            'tests/helpers/binary-extensions.ts so the two sweeps cannot drift. ' +
            'Covers src/app/favicon.ico, a real 65-byte 1x1 .ico.',
        covers: (rel) => BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase()),
    },
];

/**
 * Source files permitted to carry a banned byte, path -> written reason.
 *
 * EMPTY ON PURPOSE, and the staleness check below keeps it that way: every key
 * must still be in the swept population AND still actually carry a banned byte.
 * A new entry is a diff a reviewer has to approve, which is the only mechanism
 * that has held here. If you are adding one, say which byte, at which offset,
 * and why the escape will not do.
 */
const SOURCE_ALLOWLIST: Readonly<Record<string, string>> = {};

/**
 * Population floor. Today's tracked count is 7,148; a sweep that finds a
 * fraction of that has lost its population, and an empty sweep passes every
 * assertion below vacuously.
 */
const MIN_TRACKED_FILES = 6_000;

/** Bytes floor, for the same reason. Today's swept total is ~70.5 MB (7,142 files). */
const MIN_BYTES_READ = 10_000_000;

/**
 * Cap on how much of the tracked tree the structural exclusions may remove.
 * Today they remove 6 files (5 under `public/`, plus `src/app/favicon.ico`);
 * the headroom is for a handful of future images. A widened exclusion is the
 * one change that would gut this sweep silently, so the count is asserted.
 */
const MAX_EXCLUDED_FILES = 20;

interface Hit {
    byte: number;
    offset: number;
    line: number;
    column: number;
    excerpt: string;
}

interface Offender {
    rel: string;
    hits: readonly Hit[];
}

/** What a reader hands the sweep: the bytes, and what the filesystem claims. */
interface ReadResult {
    bytes: Buffer;
    declaredSize: number;
}

type Reader = (rel: string) => ReadResult;

const MAX_HITS_PER_FILE = 5;

/**
 * Trim a list for a failure MESSAGE only — every assertion still compares the
 * full count, which is also what the message leads with. A neutered reader or
 * a widened exclusion puts thousands of paths in these lists, and a
 * seven-thousand-line Jest failure is one nobody reads to the end of.
 */
function sample(items: readonly string[], limit = 10): string {
    const shown = items.slice(0, limit).join('\n  - ');
    const rest = items.length - limit;
    return rest > 0 ? `${shown}\n  … and ${rest} more` : shown;
}

/** Byte-exact. No decode, no heuristic — see the docblock. */
function findBannedBytes(bytes: Buffer): Hit[] {
    const hits: Hit[] = [];
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x0a) {
            line++;
            lineStart = i + 1;
            continue;
        }
        if (!isBannedByte(b)) continue;
        if (hits.length >= MAX_HITS_PER_FILE) {
            hits.push({
                byte: b,
                offset: i,
                line,
                column: i - lineStart + 1,
                excerpt: `(further hits in this file past offset ${i} not listed)`,
            });
            break;
        }
        let lineEnd = bytes.indexOf(0x0a, i);
        if (lineEnd === -1) lineEnd = bytes.length;
        hits.push({
            byte: b,
            offset: i,
            line,
            column: i - lineStart + 1,
            excerpt: renderVisibly(bytes.subarray(lineStart, Math.min(lineEnd, lineStart + 160))),
        });
    }
    return hits;
}

/**
 * Control bytes shown as escapes, so the failure message is not itself binary —
 * pasting it into a terminal or a PR comment must not re-create the hazard.
 *
 * Everything else is decoded as UTF-8 in RUNS rather than byte-by-byte: this
 * repo's source is full of em-dashes and Cyrillic, and a per-byte
 * `String.fromCharCode` would render the line as mojibake right where somebody
 * is trying to recognise it.
 */
function renderVisibly(bytes: Buffer): string {
    let out = '';
    let runStart = 0;
    const flush = (end: number): void => {
        if (end > runStart) out += bytes.subarray(runStart, end).toString('utf8');
    };
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (!isBannedByte(b) && b !== 0x09) continue;
        flush(i);
        out += `\\x${b.toString(16).padStart(2, '0')}`;
        runStart = i + 1;
    }
    flush(bytes.length);
    return out;
}

interface SweepResult {
    offenders: Offender[];
    allowed: string[];
    bytesRead: number;
    /** Files whose read came back shorter than the filesystem claims. */
    shortReads: string[];
}

/**
 * The sweep, parameterised on its population, its reader and its allowlist, so
 * the discriminating-pair test can drive this exact code with buffers it
 * controls. A collector only provably works if it can be shown to FAIL.
 */
function sweep(
    files: readonly string[],
    read: Reader,
    allowlist: Readonly<Record<string, string>>,
): SweepResult {
    const offenders: Offender[] = [];
    const allowed: string[] = [];
    const shortReads: string[] = [];
    let bytesRead = 0;

    for (const rel of files) {
        const { bytes, declaredSize } = read(rel);
        bytesRead += bytes.length;
        if (bytes.length !== declaredSize) {
            shortReads.push(`${rel} (read ${bytes.length} of ${declaredSize} bytes)`);
        }
        const hits = findBannedBytes(bytes);
        if (hits.length === 0) continue;
        if (Object.prototype.hasOwnProperty.call(allowlist, rel)) {
            allowed.push(rel);
            continue;
        }
        offenders.push({ rel, hits });
    }

    return { offenders, allowed, bytesRead, shortReads };
}

function trackedFiles(): string[] {
    const stdout = execFileSync('git', ['ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        // ~7k NUL-separated names. A truncated list is a silently shrunken
        // denominator; give it room it will never need.
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.split('\0').filter(Boolean).sort();
}

const fsReader: Reader = (rel) => {
    const abs = path.join(REPO_ROOT, rel);
    // stat first, read second, immediately: the pair is what proves the reader
    // actually read the file rather than returning an empty buffer.
    const declaredSize = fs.statSync(abs).size;
    return { bytes: fs.readFileSync(abs), declaredSize };
};

interface Partition {
    tracked: readonly string[];
    scanned: string[];
    excluded: { rel: string; by: string }[];
}

let cachedPartition: Partition | null = null;
function partition(): Partition {
    if (cachedPartition !== null) return cachedPartition;
    const tracked = trackedFiles();
    const scanned: string[] = [];
    const excluded: { rel: string; by: string }[] = [];
    for (const rel of tracked) {
        const hit = EXCLUSIONS.find((e) => e.covers(rel));
        if (hit === undefined) scanned.push(rel);
        else excluded.push({ rel, by: hit.label });
    }
    cachedPartition = { tracked, scanned, excluded };
    return cachedPartition;
}

let cachedSweep: SweepResult | null = null;
function repoSweep(): SweepResult {
    if (cachedSweep !== null) return cachedSweep;
    cachedSweep = sweep(partition().scanned, fsReader, SOURCE_ALLOWLIST);
    return cachedSweep;
}

describe('no control bytes in source', () => {
    it('the scanner reports a planted byte and clears a clean buffer, and the allowlist decides which', () => {
        // Positive/negative pair through the real `sweep`. Without this, a
        // scanner that can never report anything passes the repo sweep below
        // identically to one that works — and so does an allowlist that
        // swallows everything.
        const fixtures: Record<string, Buffer> = {
            'clean.ts': Buffer.from("const a = '\\0';\n// tab:\there\r\n"),
            'dirty.ts': Buffer.concat([
                Buffer.from("const a = 'x"),
                Buffer.from([0x00]),
                Buffer.from("y';\n"),
            ]),
            'dirty-allowlisted.ts': Buffer.concat([
                Buffer.from('const b = 1;\nconst c = '),
                Buffer.from([0x7f]),
                Buffer.from(';\n'),
            ]),
        };
        const fakeReader: Reader = (rel) => ({
            bytes: fixtures[rel],
            declaredSize: fixtures[rel].length,
        });
        const files = Object.keys(fixtures);

        // Negative side: no allowlist. Both dirty files are reported, the
        // clean one is not — and the clean one contains the ESCAPED forms of
        // exactly the bytes being hunted, so this also proves the scanner
        // reads bytes and not source text.
        const bare = sweep(files, fakeReader, {});
        expect(bare.offenders.map((o) => o.rel).sort()).toEqual([
            'dirty-allowlisted.ts',
            'dirty.ts',
        ]);
        expect(bare.shortReads).toEqual([]);

        // The discriminator the failure message must carry: byte and offset.
        const nul = bare.offenders.find((o) => o.rel === 'dirty.ts')?.hits[0];
        expect(nul).toMatchObject({ byte: 0x00, offset: 12, line: 1, column: 13 });
        expect(nul?.excerpt).toBe("const a = 'x\\x00y';");
        const del = bare.offenders.find((o) => o.rel === 'dirty-allowlisted.ts')?.hits[0];
        expect(del).toMatchObject({ byte: 0x7f, line: 2, column: 11 });

        // Positive side: allowlisting ONE path mutes that path and only that
        // path. Same population, same reader, same bytes.
        const withAllowlist = sweep(files, fakeReader, {
            'dirty-allowlisted.ts': 'fixture reason',
        });
        expect(withAllowlist.offenders.map((o) => o.rel)).toEqual(['dirty.ts']);
        expect(withAllowlist.allowed).toEqual(['dirty-allowlisted.ts']);

        // And a short read is reported rather than passing as a clean file.
        const starved = sweep(['dirty.ts'], (rel) => ({
            bytes: Buffer.alloc(0),
            declaredSize: fixtures[rel].length,
        }), {});
        expect(starved.offenders).toEqual([]);
        expect(starved.shortReads).toEqual(['dirty.ts (read 0 of 17 bytes)']);
    });

    it('sweeps the whole tracked tree: every file is either scanned or structurally excluded', () => {
        const { tracked, scanned, excluded } = partition();

        // Floor. An empty or decimated population passes the offender
        // assertion below for free.
        if (tracked.length < MIN_TRACKED_FILES) {
            throw new Error(
                `git ls-files returned ${tracked.length} tracked files, below the floor of ` +
                    `${MIN_TRACKED_FILES}. Either the population collapsed (not a work tree? ` +
                    'truncated buffer?) or this floor needs raising — do not lower it.',
            );
        }

        // No third bucket: nothing is dropped between "tracked" and the sweep.
        if (scanned.length + excluded.length !== tracked.length) {
            throw new Error(
                `partition lost files: ${scanned.length} scanned + ${excluded.length} excluded ` +
                    `!= ${tracked.length} tracked.`,
            );
        }

        // The exclusions must stay NARROW. This is where the teeth are: the
        // failure mode that would quietly gut both this guard and
        // no-secrets.test.ts is a widened exclusion, and the loudest symptom
        // is the excluded count. Adding `.ts` to the shared extension set, or
        // `src/**` here, takes this from 6 to thousands.
        if (excluded.length > MAX_EXCLUDED_FILES) {
            throw new Error(
                `${excluded.length} tracked files are excluded from the sweep, above the cap of ` +
                    `${MAX_EXCLUDED_FILES}. An exclusion has been widened — check EXCLUSIONS and ` +
                    'tests/helpers/binary-extensions.ts, which no-secrets.test.ts also reads.\n  - ' +
                    sample(excluded.map((x) => `${x.rel}  [${x.by}]`)),
            );
        }

        const { bytesRead, shortReads } = repoSweep();
        if (shortReads.length > 0) {
            throw new Error(
                `${shortReads.length} file(s) read shorter than the filesystem reports. The ` +
                    'sweep did not see their whole contents, so a control byte could hide in ' +
                    `the unread tail:\n  - ${sample(shortReads)}`,
            );
        }
        if (bytesRead < MIN_BYTES_READ) {
            throw new Error(
                `the sweep read ${bytesRead} bytes across ${scanned.length} files, below the ` +
                    `floor of ${MIN_BYTES_READ}. A scanner that reads nothing must not pass.`,
            );
        }
    });

    it('no tracked source file carries a C0 control byte other than tab/LF/CR, or DEL', () => {
        const { offenders } = repoSweep();
        if (offenders.length === 0) return;

        const detail = offenders
            .map(
                (o) =>
                    `  ${o.rel}\n` +
                    o.hits
                        .map(
                            (h) =>
                                `      0x${h.byte.toString(16).padStart(2, '0')} at byte offset ` +
                                `${h.offset} (line ${h.line}, column ${h.column})\n` +
                                `      ${h.excerpt}`,
                        )
                        .join('\n'),
            )
            .join('\n');

        throw new Error(
            `${offenders.length} tracked source file(s) carry a raw control byte:\n${detail}\n\n` +
                'Write the byte as an escape instead — `\\0`, `\\x0b`, `\\x1b`, `\\x7f`, or a ' +
                '`\\xNN` range inside a character class. The escape is byte-identical, so ' +
                'behaviour (and any persisted hash of the value) does not change.\n\n' +
                'A raw control byte makes the whole file binary to POSIX text tooling, and the ' +
                'failure is silent: `grep` reports ZERO matches rather than an error, and ' +
                '`grep -I` skips the file entirely. See #3161 — an hour went into trusting one ' +
                'of those zeros.',
        );
    });

    it('the source allowlist is empty, or every entry is live and reasoned', () => {
        const { scanned } = partition();
        const entries = Object.entries(SOURCE_ALLOWLIST);

        const notInPopulation = entries
            .map(([rel]) => rel)
            .filter((rel) => !scanned.includes(rel));
        if (notInPopulation.length > 0) {
            throw new Error(
                'allowlisted path(s) are not in the swept population (deleted, renamed, or ' +
                    `now structurally excluded) — delete them:\n  - ${notInPopulation.join('\n  - ')}`,
            );
        }

        const unreasoned = entries.filter(([, reason]) => reason.trim().length < 20);
        if (unreasoned.length > 0) {
            throw new Error(
                'allowlist entries need a written reason naming the byte and why an escape ' +
                    `will not do:\n  - ${unreasoned.map(([rel]) => rel).join('\n  - ')}`,
            );
        }

        // Stale in the other direction: the file was fixed but the exception
        // was left behind, so it now silently permits a future regression.
        const noLongerOffending = repoSweep().allowed;
        const fixed = entries.map(([rel]) => rel).filter((rel) => !noLongerOffending.includes(rel));
        if (fixed.length > 0) {
            throw new Error(
                'allowlisted path(s) no longer carry a control byte. The exception now permits ' +
                    `a regression nobody would notice — delete them:\n  - ${fixed.join('\n  - ')}`,
            );
        }
    });
});
