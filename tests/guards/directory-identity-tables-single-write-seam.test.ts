/**
 * `IdentityAccountLink` and `ConnectedIdentityAccount` have one write seam each,
 * and legacy code has none.
 *
 * ═══ WHY THIS EXISTS BEFORE THE CODE IT CONSTRAINS ═══
 *
 * The legacy-access recertification subsystem reads directory accounts to bridge
 * legacy usernames onto employees. Reading is all it may ever do. A second writer
 * would be invisible in the worst way: `IdentityAccountLink` is what
 * `findLeaverCandidates` consults to decide whether a departing employee still
 * holds access, and `ConnectedIdentityAccount.email` is what the JML reconcile
 * matches on byte for byte. A row written by a matcher that guessed would not look
 * wrong — it would look like a directory sync had found it.
 *
 * So the guard lands first, while the allowlist is still three files and can be
 * verified by reading them.
 *
 * ═══ WHY A GUARD RATHER THAN AN ESLINT RULE ═══
 *
 * `eslint-rules/README.md` draws the line at syntax: a banned call is a rule, and
 * the AST survives reformatting where a regex does not. That argument is real, and
 * two requirements put this on the other side of the line anyway:
 *
 *   - the population must come from **git**, not a config glob, so a file nobody
 *     added to a lint target cannot escape it;
 *   - the assertion is a **cross-file registry** — an allowlist of seams that has
 *     to stay in step with what the tree actually does — which the README assigns
 *     to `tests/guards/` explicitly.
 *
 * The README's warning is answered rather than ignored: every detector runs over
 * `codeOf()`, so a doc-block naming a banned call cannot fail the build, and
 * `STALE_ALLOWLIST` below fails if a seam stops writing, which is the way an
 * allowlist normally rots.
 *
 * ═══ THREE DETECTION PATHS ═══
 *
 * A write reaches these tables three ways, and a guard that saw only the first
 * would read as protection while leaving two doors open:
 *
 *   1. a delegate call on any client — `prisma.`, `db.`, `tx.`, a destructured
 *      alias. The detector never anchors on the receiver, so it cannot be evaded
 *      by renaming the client;
 *   2. the same call on an interactive transaction client, which is only case 1
 *      with a different receiver — covered by construction, and tested anyway
 *      because "covered by construction" is a claim, not a test;
 *   3. raw SQL. `$executeRaw`, `$executeRawUnsafe` and a `$queryRaw` carrying a
 *      mutating verb all bypass the delegate entirely.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/** Prisma delegate property → the table it writes. */
const DELEGATES = {
    identityAccountLink: 'IdentityAccountLink',
    connectedIdentityAccount: 'ConnectedIdentityAccount',
} as const;
type Delegate = keyof typeof DELEGATES;

/**
 * The only files that may write each table.
 *
 * Taken from a scan of `src/`, then checked against the seams `CLAUDE.md` names —
 * they agreed exactly, which is why there is nothing extra here. An unnamed writer
 * is reported, never allowlisted: the whole value of this list is that it is short
 * enough to read.
 */
const SEAMS: Readonly<Record<Delegate, readonly string[]>> = {
    identityAccountLink: ['src/app-layer/usecases/identity-account-link.ts'],
    connectedIdentityAccount: [
        'src/app-layer/usecases/identity-sync.ts',
        'src/app-layer/usecases/identity-account-protection.ts',
    ],
};

const WRITE_VERBS = [
    'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
] as const;

/**
 * Raw entry points, longest-first.
 *
 * ONE regex with ordered alternation, not a list of `indexOf` scans: `$executeRaw`
 * is a prefix of `$executeRawUnsafe`, so scanning for each separately found every
 * `Unsafe` call twice. A duplicate finding is not harmless here — it is a count
 * the assertions compare against.
 */
const RAW_METHOD_RE = /\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)/g;
/** A raw statement only counts as a write when it carries one of these. */
const SQL_MUTATORS = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i;

export interface Finding {
    delegate: Delegate;
    path: 'delegate' | 'raw-sql';
    detail: string;
}

/**
 * Delegate writes, receiver-agnostic.
 *
 * Deliberately NOT `prisma\.` — anchoring on the client name is how this kind of
 * check gets evaded for free by `const c = prisma; c.identityAccountLink.update(…)`.
 */
export function delegateWrites(code: string): Finding[] {
    const out: Finding[] = [];
    const verbs = WRITE_VERBS.join('|');
    for (const delegate of Object.keys(DELEGATES) as Delegate[]) {
        const re = new RegExp(`\\b${delegate}\\s*\\.\\s*(${verbs})\\s*\\(`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            out.push({ delegate, path: 'delegate', detail: `${delegate}.${m[1]}(` });
        }
    }
    return out;
}

/**
 * The statement text belonging to a raw call that starts at `from`.
 *
 * BOTH FORMS, because Prisma has two and the tagged template is the common one:
 *
 *   await prisma.$executeRawUnsafe(`UPDATE …`, a, b)   ← a call
 *   await prisma.$queryRaw`DELETE FROM …`              ← a tagged template
 *
 * The first version of this guard only understood the call form, so
 * ``$queryRaw`DELETE FROM "IdentityAccountLink"` `` was invisible to it — a hole
 * in the detection path the guard's own name promises to cover.
 *
 * Bounded on the construct's own delimiters, never a line count: a statement
 * spanning more lines than a fixed window would slip through, and a window is a
 * budget the source can exceed just by being reformatted.
 */
function rawStatementAfter(code: string, from: number): string {
    let i = from;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '(') {
        let depth = 0;
        for (let j = i; j < code.length; j++) {
            if (code[j] === '(') depth++;
            else if (code[j] === ')') {
                depth--;
                if (depth === 0) return code.slice(i, j + 1);
            }
        }
        return code.slice(i);
    }
    if (code[i] === '`') {
        // Walk to the matching backtick, stepping over escapes and `${…}` holes
        // so a nested template cannot end the scan early.
        let j = i + 1;
        while (j < code.length) {
            if (code[j] === '\\') { j += 2; continue; }
            if (code[j] === '`') return code.slice(i, j + 1);
            if (code[j] === '$' && code[j + 1] === '{') {
                let depth = 1; j += 2;
                while (j < code.length && depth > 0) {
                    if (code[j] === '{') depth++;
                    else if (code[j] === '}') depth--;
                    j++;
                }
                continue;
            }
            j++;
        }
        return code.slice(i);
    }
    return '';
}

/** Raw SQL that mutates either table. */
export function rawSqlWrites(code: string): Finding[] {
    const out: Finding[] = [];
    RAW_METHOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RAW_METHOD_RE.exec(code)) !== null) {
        const stmt = rawStatementAfter(code, m.index + m[0].length);
        if (!SQL_MUTATORS.test(stmt)) continue;
        for (const [delegate, table] of Object.entries(DELEGATES) as [Delegate, string][]) {
            if (new RegExp(`["'\`\\s.]${table}\\b`, 'i').test(stmt)) {
                out.push({ delegate, path: 'raw-sql', detail: `${m[0]}(… ${table} …)` });
            }
        }
    }
    return out;
}

export function findWrites(code: string): Finding[] {
    return [...delegateWrites(code), ...rawSqlWrites(code)];
}

/** Masked source for a repo-relative path — comments stripped, strings kept. */
const sourceOf = (abs: string) => codeOf(readFileSync(abs, 'utf8'));

describe('the directory identity tables have one write seam each', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts'] });
    const scanned = files.map((abs) => ({ rel: repoRelative(abs), writes: findWrites(sourceOf(abs)) }));

    /**
     * THE POPULATION CHECK. Every assertion below filters this list; an empty or
     * collapsed scan would satisfy them all by vacuity and report protection that
     * is not there. The counts are printed so the denominator is in the output
     * rather than inferred from a green tick.
     */
    it('scans the tree and finds the writers that exist today', () => {
        const writers = scanned.filter((s) => s.writes.length > 0).map((s) => s.rel);
        // eslint-disable-next-line no-console
        console.log(`scanned ${files.length} files under src/; ${writers.length} write a directory table`);
        expect(files.length).toBeGreaterThan(500);
        expect(writers.sort()).toEqual([
            'src/app-layer/usecases/identity-account-link.ts',
            'src/app-layer/usecases/identity-account-protection.ts',
            'src/app-layer/usecases/identity-sync.ts',
        ]);
    });

    it('no file outside its seam writes either table', () => {
        const trespassers = scanned.flatMap(({ rel, writes }) =>
            writes
                .filter((w) => !SEAMS[w.delegate].includes(rel))
                .map((w) => `${rel}: ${w.detail} [${w.path}] — ${DELEGATES[w.delegate]} is written only by ${SEAMS[w.delegate].join(', ')}`),
        );
        expect(trespassers).toEqual([]);
    });

    /**
     * STALE_ALLOWLIST. An allowlist entry that no longer writes is the normal way
     * one rots: the seam moves, the entry stays, and the next writer to appear
     * there is admitted without anybody deciding so.
     */
    it('every allowlisted seam actually writes its table', () => {
        const dead: string[] = [];
        for (const [delegate, seamPaths] of Object.entries(SEAMS) as [Delegate, readonly string[]][]) {
            for (const rel of seamPaths) {
                const entry = scanned.find((s) => s.rel === rel);
                if (!entry) { dead.push(`${rel} (allowlisted for ${delegate}) is not in the tree`); continue; }
                if (!entry.writes.some((w) => w.delegate === delegate)) {
                    dead.push(`${rel} is allowlisted for ${delegate} but writes it nowhere`);
                }
            }
        }
        expect(dead).toEqual([]);
    });
});

/**
 * The detector is fed a synthetic second writer per path. Without this the three
 * assertions above pass just as well with a detector that returns nothing — which
 * is the failure mode a guard is most likely to have and least likely to show.
 */
describe('the detector is not vacuous', () => {
    it('catches a delegate write on the default client', () => {
        const src = `await prisma.identityAccountLink.createMany({ data: rows });`;
        expect(findWrites(codeOf(src))).toEqual([
            { delegate: 'identityAccountLink', path: 'delegate', detail: 'identityAccountLink.createMany(' },
        ]);
    });

    it('catches the same write on an aliased transaction client', () => {
        // The receiver is `tx`, not `prisma`. A detector anchored on the client
        // name would see nothing here, which is why it is not anchored.
        const src = `await tx.connectedIdentityAccount.update({ where: { id }, data: { email } });`;
        expect(findWrites(codeOf(src)).map((f) => f.path)).toEqual(['delegate']);
    });

    it('catches a write through an arbitrary alias, so renaming the client evades nothing', () => {
        const src = `const c = prisma; await c.connectedIdentityAccount.upsert({ where: {}, create: {}, update: {} });`;
        expect(findWrites(codeOf(src))).toHaveLength(1);
    });

    it.each(WRITE_VERBS)('catches the write verb %s', (verb) => {
        const src = `await db.identityAccountLink.${verb}({});`;
        expect(findWrites(codeOf(src))).toHaveLength(1);
    });

    it('catches raw SQL that mutates a table, across lines', () => {
        const src = [
            'await tx.$executeRawUnsafe(`',
            '  UPDATE "ConnectedIdentityAccount"',
            '     SET "email" = $1',
            '   WHERE "id" = $2`, a, b);',
        ].join('\n');
        expect(findWrites(codeOf(src)).map((f) => f.path)).toEqual(['raw-sql']);
    });

    it('catches a mutating $queryRaw, which is not a read just because of its name', () => {
        const src = `await prisma.$queryRaw\`DELETE FROM "IdentityAccountLink" WHERE id = \${id}\`;`;
        expect(findWrites(codeOf(src)).map((f) => f.path)).toEqual(['raw-sql']);
    });

    // ── and the other direction: what must NOT be flagged ──────────────
    it('does not flag a read', () => {
        const src = `const rows = await prisma.identityAccountLink.findMany({ where: { tenantId } });
                     const one = await db.connectedIdentityAccount.findUnique({ where: { id } });`;
        expect(findWrites(codeOf(src))).toEqual([]);
    });

    it('does not flag a read-only raw statement that merely names the table', () => {
        const src = `await prisma.$queryRaw\`SELECT count(*) FROM "ConnectedIdentityAccount"\`;`;
        expect(findWrites(codeOf(src))).toEqual([]);
    });

    /**
     * The README names this exact failure: a doc-block mentioning a banned call
     * failing the build is why `detail-page-back-prop-ban` needed a hand-rolled
     * comment stripper. `codeOf` is that stripper, and this is its test.
     */
    it('does not flag a comment that names the call', () => {
        const src = [
            '// Never write it: prisma.identityAccountLink.updateMany({}) is forbidden here.',
            '/* and connectedIdentityAccount.delete({}) likewise */',
            'const rows = await prisma.identityAccountLink.findMany({});',
        ].join('\n');
        expect(findWrites(codeOf(src))).toEqual([]);
    });
});
