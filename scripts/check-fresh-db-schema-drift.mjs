#!/usr/bin/env node
/**
 * Does a database built ONLY from `prisma/migrations` reproduce
 * `prisma/schema`? — and if not, is the difference the one we signed off?
 *
 * ─── The hazard ─────────────────────────────────────────────────────
 *
 * `prisma/schema` is the file everyone reads and the file the client is
 * generated from. `prisma/migrations` is what actually builds a database.
 * Nothing in the Prisma toolchain compares the two: `migrate deploy`
 * applies files, `migrate status` counts them, and `validate` only parses
 * the schema. So the two drift apart silently, and the first symptom is a
 * developer reading a column default, an index, or a referential action
 * out of the schema that production does not have.
 *
 * Measured on `main` at 3.33.9 (issue #2367): 59 statements of drift, 53
 * of them ALTER TABLE. None of it was visible in CI.
 *
 * ─── The instrument ─────────────────────────────────────────────────
 *
 *     prisma migrate diff --from-config-datasource --to-schema prisma/schema
 *
 * `--from-config-datasource` reads the LIVE database in
 * `DIRECT_DATABASE_URL` — in CI that database was created seconds earlier
 * by `prisma migrate deploy` against an empty Postgres, so it is exactly
 * "what the migrations build". The output is the SQL that would be needed
 * to turn that database into `prisma/schema`; an empty output means the
 * migrations reproduce the schema exactly.
 *
 * ─── Why an expected-residue file and not "must be empty" ───────────
 *
 * Some of the drift is INTENTIONAL and cannot be removed:
 *
 *   • `gin_trgm_ops` indexes are not expressible in Prisma at all.
 *   • Three columns are deliberately NOT NULL in the database and
 *     optional in the schema (GAP-21; pinned by
 *     tests/guardrails/pii-hash-not-null.test.ts).
 *
 * "Must be empty" would therefore be a gate nobody can ever satisfy, and
 * a gate that cannot go green gets disabled. So the committed file names
 * the residue we have signed off, statement by statement, and the gate
 * fails on ANY difference from it IN EITHER DIRECTION:
 *
 *   • a statement the diff produces that the file does not list — new
 *     drift, i.e. someone changed prisma/schema without a migration (or
 *     wrote a migration that does not match the schema);
 *   • a statement the file lists that the diff no longer produces — an
 *     intentional divergence was "fixed", or the residue shrank for a
 *     good reason and the file was not updated in the same commit.
 *
 * The second direction is the one that makes this a ratchet rather than a
 * ceiling. Shrinking `prisma/fresh-db-schema-drift.expected.sql` is an
 * EXPECTED outcome of the follow-up PR that carries the referential-action
 * migration — the failure message says so, so a reviewer seeing this gate
 * go red on a shrunk residue knows to update the file, not to revert.
 *
 * ─── Comparison rules ───────────────────────────────────────────────
 *
 * SQL comments and blank lines are ignored, so the expected file can carry
 * per-group prose (it does — read it). Statements are compared as a
 * MULTISET of whitespace-normalised text: content differences fail,
 * a reordering by a future Prisma release does not. Duplicates count,
 * so "the same statement twice" is still a difference.
 *
 * ─── Exit codes (an absence is not a pass) ──────────────────────────
 *
 *   0  match        — the diff is exactly the committed residue; N compared
 *   1  mismatch     — named, in both directions
 *   2  unavailable  — no database URL, unreachable, or the diff failed to
 *                     run at all. NOT a pass: nothing was compared.
 *
 * Usage:
 *     npm run db:check-schema-drift
 *     npm run db:check-schema-drift -- --url postgresql://…
 *     npm run db:check-schema-drift -- --write   # regenerate the residue
 *                                                # file's statement block
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'prisma', 'schema');
const EXPECTED_FILE = path.join(ROOT, 'prisma', 'fresh-db-schema-drift.expected.sql');

const requireFromHere = createRequire(import.meta.url);

/**
 * ASK NODE where the Prisma CLI is; never spell the path.
 *
 * A literal join to the installed tree is a lie in any checkout that does not
 * own its install — `.claude/worktrees/<id>/` has no install of its own and
 * resolves upward — and CI, with its single checkout, is the one place the lie
 * holds. `tests/guardrails/dependency-paths-are-resolved.test.ts` fails on that
 * shape, and it named this file the first time it was written the wrong way.
 *
 * The package's own `bin` entry is read rather than assumed, then resolved as a
 * subpath so Node's resolver (and Prisma's `exports` map) answers.
 */
export function resolvePrismaCli(resolver = requireFromHere) {
    const pkg = JSON.parse(readFileSync(resolver.resolve('prisma/package.json'), 'utf8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prisma;
    if (!binRel) throw new Error("the installed `prisma` package declares no `bin.prisma`");
    return resolver.resolve(`prisma/${binRel.replace(/^\.\//, '')}`);
}

/** Everything below this line in the expected file is compared. */
export const SENTINEL = '-- ==== EXPECTED RESIDUE BEGINS BELOW ====';

export const EXIT_MATCH = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_UNAVAILABLE = 2;

/**
 * SQL text → array of whitespace-normalised statements.
 * Comments and blank lines are dropped; a statement may span lines.
 */
export function parseStatements(sql) {
    const out = [];
    let buf = '';
    for (const raw of sql.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('--')) continue;
        buf += (buf ? ' ' : '') + line;
        if (line.endsWith(';')) {
            out.push(buf.replace(/\s+/g, ' '));
            buf = '';
        }
    }
    // A trailing fragment with no `;` is still content — surface it rather
    // than swallowing it, or a truncated file would read as a shorter list.
    if (buf.trim() !== '') out.push(buf.replace(/\s+/g, ' '));
    return out;
}

/** Statements after the sentinel; the whole file if there is no sentinel. */
export function expectedStatements(fileText) {
    const idx = fileText.indexOf(SENTINEL);
    const body = idx === -1 ? fileText : fileText.slice(idx + SENTINEL.length);
    return parseStatements(body);
}

/** Multiset difference, both directions. */
export function compare(actual, expected) {
    const count = (xs) => {
        const m = new Map();
        for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
        return m;
    };
    const a = count(actual);
    const e = count(expected);
    const unexpected = [];
    const missing = [];
    for (const [stmt, n] of a) {
        const extra = n - (e.get(stmt) ?? 0);
        for (let i = 0; i < extra; i++) unexpected.push(stmt);
    }
    for (const [stmt, n] of e) {
        const gone = n - (a.get(stmt) ?? 0);
        for (let i = 0; i < gone; i++) missing.push(stmt);
    }
    return { unexpected, missing };
}

export function resolveDatabaseUrl(argv = [], env = process.env) {
    const flag = argv.indexOf('--url');
    if (flag !== -1 && argv[flag + 1]) return { url: argv[flag + 1], source: '--url' };
    if (env.DIRECT_DATABASE_URL) return { url: env.DIRECT_DATABASE_URL, source: 'DIRECT_DATABASE_URL' };
    if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: 'DATABASE_URL' };
    return { url: undefined, source: 'none' };
}

function runDiff(url, cli) {
    const res = spawnSync(
        process.execPath,
        [cli, 'migrate', 'diff', '--from-config-datasource', '--to-schema', SCHEMA_DIR, '--script'],
        { cwd: ROOT, env: { ...process.env, DIRECT_DATABASE_URL: url }, encoding: 'utf8' },
    );
    if (res.error) return { ok: false, detail: res.error.message };
    if (res.status !== 0) {
        return { ok: false, detail: `prisma migrate diff exited ${res.status}\n${(res.stderr || '').trim()}` };
    }
    return { ok: true, sql: res.stdout };
}

function main() {
    const argv = process.argv.slice(2);
    const { url, source } = resolveDatabaseUrl(argv);

    if (!url) {
        console.error('? fresh-DB schema drift: NOT CHECKED (no-database-url)');
        console.error('  Pass --url, or set DIRECT_DATABASE_URL / DATABASE_URL.');
        console.error('  Nothing was compared. Treat this as "unknown", not "clean".');
        return EXIT_UNAVAILABLE;
    }
    let cli;
    try {
        cli = resolvePrismaCli();
    } catch (err) {
        // A resolver failure is UNAVAILABLE, never a skip-as-pass: the whole
        // point of the exit-code split is that "could not run" is loud.
        console.error('? fresh-DB schema drift: NOT CHECKED (no-prisma-cli)');
        console.error(`  Node cannot resolve the prisma CLI: ${err instanceof Error ? err.message : String(err)}`);
        console.error('  Run npm ci first.');
        return EXIT_UNAVAILABLE;
    }

    const diff = runDiff(url, cli);
    if (!diff.ok) {
        console.error('? fresh-DB schema drift: NOT CHECKED (diff-failed)');
        console.error(`  ${diff.detail}`);
        console.error('  Nothing was compared. Treat this as "unknown", not "clean".');
        return EXIT_UNAVAILABLE;
    }

    const actual = parseStatements(diff.sql);

    if (argv.includes('--write')) {
        const text = readFileSync(EXPECTED_FILE, 'utf8');
        const idx = text.indexOf(SENTINEL);
        if (idx === -1) {
            console.error(`? --write needs the sentinel line in ${path.relative(ROOT, EXPECTED_FILE)}:`);
            console.error(`  ${SENTINEL}`);
            return EXIT_UNAVAILABLE;
        }
        writeFileSync(EXPECTED_FILE, `${text.slice(0, idx + SENTINEL.length)}\n\n${diff.sql.trim()}\n`);
        console.log(`✓ wrote ${actual.length} statement(s) into ${path.relative(ROOT, EXPECTED_FILE)}`);
        console.log('  Re-read the header prose: every group there must still describe reality.');
        return EXIT_MATCH;
    }

    const expected = expectedStatements(readFileSync(EXPECTED_FILE, 'utf8'));
    const { unexpected, missing } = compare(actual, expected);

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(
            `✓ fresh-DB schema drift: matches the committed residue — ` +
                `${actual.length} statement(s) compared.`,
        );
        console.log(`  database: ${source}; residue: ${path.relative(ROOT, EXPECTED_FILE)}`);
        return EXIT_MATCH;
    }

    console.error(
        `✗ fresh-DB schema drift: ${unexpected.length + missing.length} difference(s) from ` +
            `${path.relative(ROOT, EXPECTED_FILE)} ` +
            `(diff produced ${actual.length}, file lists ${expected.length}).`,
    );
    if (unexpected.length > 0) {
        console.error('');
        console.error(`  NEW DRIFT — produced by the diff, absent from the residue file (${unexpected.length}):`);
        for (const s of unexpected) console.error(`    + ${s}`);
        console.error('');
        console.error('    A database built from prisma/migrations no longer matches prisma/schema here.');
        console.error('    Either write the migration that makes the database match the schema, or');
        console.error('    correct prisma/schema to describe what the database actually does.');
        console.error('    Adding these lines to the residue file is NOT the fix unless the divergence');
        console.error('    is intentional AND the header prose explains why.');
    }
    if (missing.length > 0) {
        console.error('');
        console.error(`  GONE — listed in the residue file, no longer produced by the diff (${missing.length}):`);
        for (const s of missing) console.error(`    - ${s}`);
        console.error('');
        console.error('    Shrinking the residue is the INTENDED outcome of the referential-action');
        console.error('    migration PR (issue #2367, PR2): if that is what this commit does, delete');
        console.error('    these lines from the residue file in the same commit and say so in the');
        console.error('    message. If it is not, an intentional divergence has just been "fixed" —');
        console.error('    check the header prose for that group before accepting it.');
    }
    console.error('');
    console.error('  Regenerate after a deliberate change:  npm run db:check-schema-drift -- --write');
    return EXIT_MISMATCH;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main();
    } catch (err) {
        console.error('? fresh-DB schema drift: NOT CHECKED (unexpected-error)');
        console.error(`  ${err instanceof Error ? err.stack : String(err)}`);
        process.exitCode = EXIT_UNAVAILABLE;
    }
}
