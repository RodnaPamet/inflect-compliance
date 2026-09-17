/**
 * `Employee.status` keeps exactly ONE update seam, and the manager path is not it.
 *
 * CLAUDE.md, JML: "There is no update path for an employee's status outside
 * HRIS sync." That sentence is the reason this guard exists rather than a
 * style preference. `TERMINATED` is what makes a worker a candidate for a real
 * disable in a customer's own directory — the 05:00 leaver pass keys on it —
 * so a second writer of that column is a second way to cause an unattended
 * write to somebody's Entra or Active Directory account. `status` is the one
 * field on this row where "who last changed this" must have exactly one answer.
 *
 * #2492 added the row's second WRITE function, `setEmployeeManager`, because
 * `managerEmployeeId` previously had a single writer (the HRIS sync) and a
 * tenant with no BambooHR/Workday feed could therefore give nobody a manager —
 * which left the leaver mail with no recipient on every disable. The operator
 * decision attached to that issue was explicit: the new path must NOT be able
 * to write `status`, and the prohibition must be pinned rather than described.
 * This is the pin.
 *
 * Four claims, each failing on a different regression — plus a fifth test
 * that asserts the population is non-empty, because every census below is
 * vacuously correct over nothing:
 *
 *   1. Only two FILES write an `Employee` row at all — a third one is a
 *      finding to fix, never an entry to add. There is deliberately no
 *      allowlist.
 *   2. Inside `personnel.ts`, `status` is written by `createEmployee` and by
 *      nothing else. This is the claim that survives `setEmployeeManager`
 *      living in the same file as a legitimate `status` writer, which a
 *      file-granularity census cannot make.
 *   3. `setEmployeeManager`'s write names exactly one column. A spread of the
 *      parsed body counts as a failure, not as an unknown: the whole point of
 *      the literal is that widening the schema cannot widen the write.
 *   4. Inside `hris-sync.ts`, `status` is written by EXACTLY TWO writes — the
 *      roster mirror and the departure reconcile — and a third reddens.
 *
 * CLAIM 4 CLOSES A HOLE THIS FILE USED TO HAVE, and it is worth saying what it
 * was, because the shape recurs. `HRIS_SEAM` was declared here from the start
 * but appeared ONLY in claim 1, the file-level census: this guard knew
 * `hris-sync.ts` writes an Employee row and never looked at WHICH COLUMNS it
 * wrote. So the column discipline was enforced against `personnel.ts` alone
 * while the sanctioned HRIS seam — the one CLAUDE.md names as the only status
 * path — was unconstrained. Mutation-proved before claim 4 existed: appending a
 * second `status` writer to `hris-sync.ts` left this file at 4 passed, while the
 * identical mutant in `personnel.ts` reddened claim 2. The census worked; it
 * just never pointed there.
 *
 * Note claim 4 is TWO, not one. `status` genuinely has two legitimate writers
 * in that file and neither can be folded into the other — the mirror copies
 * what the roster says, the reconcile acts on a row's ABSENCE from it. A fix
 * that forced one seam there would have to delete a behaviour. The pin is the
 * pair, exactly.
 *
 * WHAT THIS GUARD DOES NOT PIN. The other two rails #2492 put in front of
 * `status` are a `.strict()` one-key schema and a URL that names the field.
 * The first is behavioural and is asserted in
 * `tests/unit/personnel-manager-update.test.ts`; the second is a shape, with
 * no test of its own. This file is the structural half only — do not read a
 * green run here as certifying all three.
 *
 * The census reads COLUMN NAMES OUT OF SOURCE TEXT, so a write whose key set
 * is not spelled at the call site cannot be read — `data: { ...patch }` and
 * `data: SOME_CONST` are both opaque. It does not skip them: each surfaces as
 * a sentinel (`...` / `<indirect>`) and the status census treats an opaque set
 * as a possible `status` write, so the unknown case fails CLOSED. The cost is
 * that a legitimate indirect write cannot be expressed here without reddening
 * this guard — which is the intended trade on this column, not an oversight.
 *
 * Named for the invariant, not the issue.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { repoFiles, repoRelative, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/** The two files allowed to write an `Employee` row. */
const PERSONNEL_SEAM = 'src/app-layer/usecases/personnel.ts';
const HRIS_SEAM = 'src/app-layer/usecases/hris-sync.ts';

/** The only function in `personnel.ts` allowed to write `status`. */
const STATUS_WRITER = 'createEmployee';
/** The manager path, which must write one column and no others. */
const MANAGER_WRITER = 'setEmployeeManager';
const MANAGER_COLUMN = 'managerEmployeeId';

/** Prisma write verbs. A `createMany`/`upsert` writes just as a `create` does. */
const WRITE_CALL = /\bemployee\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;

/**
 * Keys whose value is the column map of a write. `data` covers
 * create/update/updateMany/createMany; `create` + `update` cover the two arms
 * of an upsert. `where` and `select` are deliberately NOT here — a
 * `select: { status: true }` reads the column and must not be mistaken for
 * writing it, which is precisely what a regex over the whole call would do.
 */
const COLUMN_MAP_KEYS = ['data', 'create', 'update'] as const;

/**
 * Blank every string / template literal, preserving offsets. `codeOf` has
 * already blanked comments; this removes the other thing that can carry a
 * stray brace or a colon and move a boundary. Identifiers — which is what
 * every column name is — survive untouched.
 */
function maskLiterals(code: string): string {
    let out = '';
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            out += ' ';
            i += 1;
            while (i < code.length) {
                if (code[i] === '\\') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (code[i] === ch) {
                    out += ' ';
                    i += 1;
                    break;
                }
                out += code[i] === '\n' ? '\n' : ' ';
                i += 1;
            }
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/** The balanced `(…)` or `{…}` beginning at `from`, inclusive of both ends. */
function balanced(text: string, from: number, open: '(' | '{'): string {
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
        if (text[i] === open) depth += 1;
        else if (text[i] === close) {
            depth -= 1;
            if (depth === 0) return text.slice(from, i + 1);
        }
    }
    throw new Error(`unterminated ${open}…${close} at offset ${from}`);
}

/** Split an object literal's body on its own top-level commas. */
function topLevelEntries(objectLiteral: string): string[] {
    const inner = objectLiteral.slice(1, -1);
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i];
        if (ch === '{' || ch === '[' || ch === '(') depth += 1;
        else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
        else if (ch === ',' && depth === 0) {
            parts.push(inner.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(inner.slice(start));
    return parts.filter((p) => p.trim().length > 0);
}

/**
 * Column-set tokens that mean "this write's keys are not knowable from the
 * text". Both must read as a possible `status` write rather than as an empty
 * set — see the status-attribution census below.
 */
const UNKNOWABLE = ['...', '<indirect>'] as const;

/**
 * The column names an object literal writes. A spread is reported as the
 * literal token `...`, because its key set is not knowable from the text and
 * "unknown" must read as a failure rather than as an empty set.
 */
function writtenColumns(objectLiteral: string): string[] {
    return topLevelEntries(objectLiteral).map((entry) => {
        const trimmed = entry.trim();
        if (trimmed.startsWith('...')) return '...';
        const m = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(trimmed);
        return m ? m[1] : `<unparsed:${trimmed.slice(0, 24)}>`;
    });
}

/** Every `employee.<verb>(…)` call in one masked source, with its columns. */
interface EmployeeWrite {
    /** Offset of the verb match, for attributing the call to a function. */
    index: number;
    verb: string;
    columns: string[];
}

function employeeWrites(masked: string): EmployeeWrite[] {
    const out: EmployeeWrite[] = [];
    WRITE_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WRITE_CALL.exec(masked)) !== null) {
        const parenAt = masked.indexOf('(', m.index);
        const args = balanced(masked, parenAt, '(');
        const braceAt = args.indexOf('{');
        const columns: string[] = [];
        if (braceAt >= 0) {
            const argObject = balanced(args, braceAt, '{');
            for (const entry of topLevelEntries(argObject)) {
                const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(entry)?.[1];
                if (key === undefined) continue;
                if (!(COLUMN_MAP_KEYS as readonly string[]).includes(key)) continue;
                const valueAt = entry.indexOf('{', entry.indexOf(':'));
                if (valueAt < 0) {
                    // `data: TERMINATION_PATCH` rather than `data: { … }`. The
                    // key set is not knowable from the text, so it surfaces as
                    // a sentinel for exactly the reason a spread does: skipping
                    // it would contribute ZERO columns and make the write
                    // invisible to the attribution filter below — a new
                    // function writing `status` through a variable would pass.
                    // Unknown must read as a failure, never as an empty set.
                    columns.push('<indirect>');
                    continue;
                }
                columns.push(...writtenColumns(balanced(entry, valueAt, '{')));
            }
        }
        out.push({ index: m.index, verb: m[1], columns });
    }
    return out;
}

/** The nearest `function <name>` declaration at or before `index`. */
function enclosingFunction(masked: string, index: number): string {
    const decls = [...masked.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)];
    let name = '<module scope>';
    for (const d of decls) {
        if (d.index !== undefined && d.index < index) name = d[1];
        else break;
    }
    return name;
}

function maskedSource(relPath: string): string {
    return maskLiterals(codeOf(readFileSync(path.join(REPO_ROOT, relPath), 'utf8')));
}

describe('Employee.status keeps one update seam, and the manager path is not it', () => {
    const sources = repoFiles({ under: 'src', extensions: ['.ts'] });

    it('scans a real population (the scan itself is not vacuous)', () => {
        // Without this, a broken `repoFiles` call yields zero files and every
        // census below passes by describing nothing.
        expect(sources.length).toBeGreaterThan(500);
        expect(sources.map(repoRelative)).toEqual(
            expect.arrayContaining([PERSONNEL_SEAM, HRIS_SEAM]),
        );
    });

    it('writes an Employee row from two files only', () => {
        const writers: string[] = [];
        for (const abs of sources) {
            const masked = maskLiterals(codeOf(readFileSync(abs, 'utf8')));
            WRITE_CALL.lastIndex = 0;
            if (WRITE_CALL.test(masked)) writers.push(repoRelative(abs));
            WRITE_CALL.lastIndex = 0;
        }
        // Exact equality, not a cap. A third writer is a finding to fix, never
        // an entry to add — there is deliberately no allowlist.
        expect(writers.sort()).toStrictEqual([HRIS_SEAM, PERSONNEL_SEAM].sort());
    });

    it('writes `status` from createEmployee and from no other function in personnel.ts', () => {
        const masked = maskedSource(PERSONNEL_SEAM);
        const writes = employeeWrites(masked);

        // The extraction found the calls it is about to reason over. An empty
        // list would make the census below vacuously correct.
        expect(writes.length).toBeGreaterThanOrEqual(2);

        // An UNKNOWABLE column set counts as a status writer, and that is the
        // whole point of the two sentinels. `data: { ...patch }` and
        // `data: TERMINATION_PATCH` both hide their keys from a text scan, so
        // filtering on the literal 'status' alone would let a new function
        // write the column through one level of indirection and stay green —
        // measured, before this line existed. Unknown reads as a hit.
        const statusWriters = writes
            .filter((w) => w.columns.some((c) => c === 'status' || (UNKNOWABLE as readonly string[]).includes(c)))
            .map((w) => enclosingFunction(masked, w.index));

        expect(statusWriters.sort()).toStrictEqual([STATUS_WRITER]);
    });

    it('writes `status` from exactly two writes in hris-sync.ts — the roster mirror and the departure reconcile', () => {
        // CLAUDE.md sanctions HRIS sync as THE status seam, so this file is
        // allowed to write the column. What was never pinned is HOW MANY times
        // and from where — and the answer today is TWO, not one:
        //
        //   upsert      — mirrors the roster row (`status: e.status`, both arms)
        //   updateMany  — reconciles absence, `status: 'TERMINATED'`, unbounded
        //
        // So the single-writer rule this file enforces on personnel.ts is not
        // the right shape here; both of these are legitimate and neither can be
        // folded into the other. The pin is therefore EXACTLY THESE TWO, and a
        // third reddens.
        //
        // Attribution is by VERB, not by enclosing function: both writes live
        // in `runHrisSync`, so `enclosingFunction` returns the same name for
        // both and cannot tell them apart. Verified, not assumed — the census
        // reports `fn: 'runHrisSync'` for all three Employee writes here.
        const masked = maskedSource(HRIS_SEAM);
        const writes = employeeWrites(masked);

        // Non-vacuous: the extraction found the calls it reasons over. Three,
        // because the manager link (`managerEmployeeId`) is here too and must
        // NOT appear in the status set below.
        expect(writes.length).toBeGreaterThanOrEqual(3);

        const statusWrites = writes
            .filter((w) => w.columns.some((c) => c === 'status' || (UNKNOWABLE as readonly string[]).includes(c)))
            // `opaque` rather than the full column list on purpose. Pinning
            // every column of the roster upsert would redden this STATUS guard
            // on any unrelated mirror column being added, which couples a
            // schema addition to a safety invariant it has nothing to do with.
            // Measured: the Phase-0 write-back adds `hrisRecordId` to both arms
            // of that upsert, and this claim stays green across it by design.
            // What must not change is the NUMBER of status writes and whether
            // their key sets are readable at all.
            .map((w) => ({ verb: w.verb, opaque: w.columns.some((c) => (UNKNOWABLE as readonly string[]).includes(c)) }));

        expect(statusWrites).toStrictEqual([
            { verb: 'upsert', opaque: false },
            { verb: 'updateMany', opaque: false },
        ]);

        // The reconcile IS pinned column-for-column, unlike the mirror. It sets
        // TERMINATED on every row the pass did not see, in one unbounded
        // statement — the highest-stakes write on this column in the codebase,
        // since TERMINATED is what makes a worker a candidate for a real
        // directory disable. It has no business gaining a column quietly.
        const reconcile = writes.find((w) => w.verb === 'updateMany' && w.columns.includes('status'));
        expect(reconcile?.columns).toStrictEqual(['status', 'syncedAt']);
    });

    it('writes exactly one column from setEmployeeManager, named literally', () => {
        const masked = maskedSource(PERSONNEL_SEAM);
        const writes = employeeWrites(masked).filter(
            (w) => enclosingFunction(masked, w.index) === MANAGER_WRITER,
        );

        // Positive anchor: the function exists, and it does write.
        expect(writes).toHaveLength(1);
        // The set, not a `not.toContain('status')`: an absent `status` is also
        // true of a write that gained `endDate`, and rail 2 of #2492 is that
        // this literal names ONE column. A `...spread` surfaces here as the
        // token `...` and fails, because its key set is not knowable.
        expect(writes[0].columns).toStrictEqual([MANAGER_COLUMN]);
    });
});
