/**
 * Enum member ORDER, reconstructed from `prisma/migrations` and compared
 * against `prisma/schema`.
 *
 * ─── Why order is a thing to compare at all ─────────────────────────
 *
 * A Postgres enum is an ordered type. Member order is part of the type's
 * identity, not presentation: every member has an ordinal, `<` `>` between
 * members compares ordinals, and `ORDER BY <enum column>` sorts by ordinal
 * — never alphabetically, never by the schema's declaration order.
 *
 * `ALTER TYPE … ADD VALUE 'X'` with no `BEFORE`/`AFTER` clause APPENDS.
 * So a member written into the MIDDLE of an `enum { }` block in
 * `prisma/schema` lands at the END of the physical type, and the two
 * disagree from that moment on.
 *
 * ─── Why the existing gate cannot see it (issue #2475) ──────────────
 *
 * `scripts/check-fresh-db-schema-drift.mjs` runs `prisma migrate diff`,
 * which treats enum values as a SET, not a sequence. Measured on
 * 2026-09-11 while PR #2477 added two `NotificationType` members in the
 * middle of the block: the migrations append them, the schema declares
 * them mid-list, and the gate reported `✓ matches the committed residue
 * — 10 statement(s) compared`. The residue did not move. Order
 * disagreement is a class that gate is silent about BY DESIGN.
 *
 * This module is the static half that can see it. It needs no database,
 * which is also why it can run where the drift gate cannot.
 *
 * ─── The reconstruction ─────────────────────────────────────────────
 *
 * Migrations are replayed in the order Prisma applies them — directory
 * name, lexicographic — and the enum DDL is folded into a member list per
 * PHYSICAL type name:
 *
 *   CREATE TYPE "T" AS ENUM ('A','B')     seats the list
 *   ALTER TYPE "T" ADD VALUE 'C'          appends
 *   ALTER TYPE "T" ADD VALUE 'C' BEFORE 'B'   inserts at the anchor
 *   ALTER TYPE "T" RENAME VALUE 'A' TO 'Z'    renames IN PLACE (ordinal kept)
 *   ALTER TYPE "T" RENAME TO "U"          carries the list to the new name
 *   DROP TYPE "T"                         forgets it
 *
 * PHYSICAL name, not Prisma name: five enums here carry `@@map()`
 * (`TaskPriority` is physically `WorkItemPriority`), and the migrations
 * only ever spell the physical one.
 *
 * ─── The parser's blind spots are reported, not swallowed ───────────
 *
 * A guard cannot see a shape it has no pattern for, and the failure mode
 * of an unrecognised DDL shape is a SILENTLY SMALLER population — the
 * enum drops out of the comparison and the guard stays green. So every
 * statement containing `CREATE TYPE` / `ALTER TYPE` / `DROP TYPE` that no
 * pattern consumed is returned in `unreadableDdl`, and the guard fails on
 * a non-empty list. That is not a formality: 21 of this repo's enum
 * statements are wrapped in `DO $$ BEGIN … EXCEPTION WHEN duplicate_object
 * THEN null; END $$`, and a first draft that split only on top-level `;`
 * missed every one of them — including `EmploymentStatus`,
 * `TrainingStatus` and `DevicePlatform`, three of the seven enums whose
 * ordinals are load-bearing today.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readPrismaSchema } from './prisma-schema';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

/** A `CREATE`/`ALTER`/`DROP TYPE` statement no pattern in here understood. */
export interface UnreadableDdl {
    /** Migration directory name. */
    migration: string;
    /** The normalised statement text, truncated for a readable failure. */
    sql: string;
}

/** An `ADD VALUE … BEFORE/AFTER 'x'` whose anchor `x` does not exist yet. */
export interface DanglingAnchor {
    migration: string;
    type: string;
    value: string;
    anchor: string;
}

/** One `enum X { … }` block in `prisma/schema`. */
export interface DeclaredEnum {
    /** The name Prisma uses, e.g. `TaskPriority`. */
    prismaName: string;
    /** The Postgres type name — `@@map()` if present, else `prismaName`. */
    physicalName: string;
    /** Members in declaration order. */
    members: string[];
}

/** An enum whose schema order and migration order disagree. */
export interface OrderDifference {
    physicalName: string;
    prismaName: string;
    schemaOrder: string[];
    migrationOrder: string[];
    /** First index at which the two lists differ — where to look. */
    firstDivergence: number;
}

/** An enum whose schema members and migration members are not the same SET. */
export interface MemberSetDifference {
    physicalName: string;
    prismaName: string;
    /** Declared in `prisma/schema`, never created by a migration. */
    schemaOnly: string[];
    /** Created by a migration, absent from `prisma/schema`. */
    migrationOnly: string[];
}

export interface EnumOrderReport {
    /** Every `enum` block in `prisma/schema`. */
    declared: DeclaredEnum[];
    /** Physical type name -> member order a freshly-migrated DB would hold. */
    reconstructed: Map<string, string[]>;
    /** Statements the parser could not read. Non-empty means it is blind. */
    unreadableDdl: UnreadableDdl[];
    /** Insertions naming an anchor that is not a member at that point. */
    danglingAnchors: DanglingAnchor[];
    /** Declared enums no migration ever created. */
    missingFromMigrations: string[];
    /** Sets that disagree — order is not comparable for these. */
    memberSetDifferences: MemberSetDifference[];
    /** Sets that agree but sequences do not. THE FINDING #2475 IS ABOUT. */
    orderDifferences: OrderDifference[];
    /** How many migration directories were replayed. The denominator. */
    migrationsReplayed: number;
}

/**
 * Remove SQL comments without touching string literals, quoted identifiers
 * or dollar-quoted bodies.
 *
 * Needed because this repo's migrations carry long prose headers that
 * DISCUSS enum DDL — `-- ALTER TYPE … ADD VALUE is forward-compatible`.
 * A parser that greps the raw text finds twelve `ALTER TYPE` statements
 * that do not exist.
 */
export function stripSqlComments(sql: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < sql.length) {
        if (sql.startsWith('--', i)) {
            const j = sql.indexOf('\n', i);
            i = j === -1 ? sql.length : j;
            continue;
        }
        if (sql.startsWith('/*', i)) {
            const j = sql.indexOf('*/', i + 2);
            i = j === -1 ? sql.length : j + 2;
            continue;
        }
        const chunk = readOpaque(sql, i);
        if (chunk !== null) {
            out.push(chunk.text);
            i = chunk.next;
            continue;
        }
        out.push(sql[i]);
        i += 1;
    }
    return out.join('');
}

/**
 * If a literal / quoted identifier / dollar-quoted body starts at `i`,
 * return it whole. Keeping these opaque is what stops a `;` or a `--`
 * inside a value from being read as syntax.
 */
function readOpaque(sql: string, i: number): { text: string; next: number } | null {
    const c = sql[i];
    if (c === "'") {
        let j = i + 1;
        while (j < sql.length) {
            if (sql[j] === "'") {
                if (sql[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                break;
            }
            j += 1;
        }
        return { text: sql.slice(i, j + 1), next: j + 1 };
    }
    if (c === '"') {
        const j = sql.indexOf('"', i + 1);
        const end = j === -1 ? sql.length - 1 : j;
        return { text: sql.slice(i, end + 1), next: end + 1 };
    }
    if (c === '$') {
        const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
        if (tag !== null) {
            const j = sql.indexOf(tag[0], i + tag[0].length);
            const end = j === -1 ? sql.length : j + tag[0].length;
            return { text: sql.slice(i, end), next: end };
        }
    }
    return null;
}

/**
 * Split into statements on top-level `;`, DESCENDING INTO dollar-quoted
 * bodies rather than treating them as opaque.
 *
 * The descent is the whole point: `DO $$ BEGIN CREATE TYPE … END $$` is
 * how a third of this repo's enum creations are written, and a splitter
 * that keeps the body opaque returns one statement whose text no
 * `CREATE TYPE` pattern anchors to.
 */
export function splitSqlStatements(sql: string): string[] {
    const stmts: string[] = [];
    let buf: string[] = [];
    let i = 0;
    const flush = () => {
        const s = buf.join('').replace(/\s+/g, ' ').trim();
        if (s !== '') stmts.push(s);
        buf = [];
    };
    while (i < sql.length) {
        const tag = sql[i] === '$' ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
        if (tag !== null) {
            const close = sql.indexOf(tag[0], i + tag[0].length);
            const bodyEnd = close === -1 ? sql.length : close;
            flush();
            stmts.push(...splitSqlStatements(sql.slice(i + tag[0].length, bodyEnd)));
            i = close === -1 ? sql.length : close + tag[0].length;
            continue;
        }
        const chunk = readOpaque(sql, i);
        if (chunk !== null) {
            buf.push(chunk.text);
            i = chunk.next;
            continue;
        }
        if (sql[i] === ';') {
            flush();
            i += 1;
            continue;
        }
        buf.push(sql[i]);
        i += 1;
    }
    flush();
    return stmts;
}

/**
 * Strip the PL/pgSQL scaffolding a `DO` body wraps around real DDL:
 * `BEGIN`, `IF NOT EXISTS (SELECT …) THEN`, `EXCEPTION WHEN x THEN`,
 * `END IF`, `END`. Applied repeatedly, because they nest.
 */
const PLPGSQL_PREAMBLE =
    /^(?:BEGIN|END\s+IF|END|EXCEPTION\s+WHEN\s+\w+\s+THEN|IF\s+(?:NOT\s+)?EXISTS\s*\((?:[^()]|\([^()]*\))*\)\s+THEN)\s*/i;

export function stripPlpgsqlPreamble(stmt: string): string {
    let s = stmt.trim();
    for (;;) {
        const next = s.replace(PLPGSQL_PREAMBLE, '').trim();
        if (next === s) return s;
        s = next;
    }
}

const IDENT = '(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))';
const RE_CREATE = new RegExp(`^CREATE\\s+TYPE\\s+${IDENT}\\s+AS\\s+ENUM\\s*\\((.*)\\)$`, 'i');
const RE_ADD = new RegExp(
    `^ALTER\\s+TYPE\\s+${IDENT}\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'((?:[^']|'')*)'` +
        `(?:\\s+(BEFORE|AFTER)\\s+'((?:[^']|'')*)')?$`,
    'i',
);
const RE_RENAME_VALUE = new RegExp(
    `^ALTER\\s+TYPE\\s+${IDENT}\\s+RENAME\\s+VALUE\\s+'((?:[^']|'')*)'\\s+TO\\s+'((?:[^']|'')*)'$`,
    'i',
);
const RE_RENAME_TYPE = new RegExp(`^ALTER\\s+TYPE\\s+${IDENT}\\s+RENAME\\s+TO\\s+${IDENT}$`, 'i');
const RE_DROP = /^DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(.*)$/i;
const RE_TYPEISH = /\b(?:CREATE|ALTER|DROP)\s+TYPE\b/i;

const unquote = (v: string): string => v.replace(/''/g, "'");
const identOf = (m: RegExpExecArray, a: number, b: number): string => m[a] ?? m[b];

/** Every `'...'` literal inside a `CREATE TYPE … AS ENUM ( … )` body. */
function enumLiterals(body: string): string[] {
    return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => unquote(m[1]));
}

/** Migration directory names, in the order `prisma migrate deploy` applies them. */
export function migrationDirectories(): string[] {
    return fs
        .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
}

/**
 * Replay every migration's enum DDL and return the member order a freshly
 * migrated database would hold, per physical type name.
 */
export function reconstructEnumOrder(): {
    reconstructed: Map<string, string[]>;
    unreadableDdl: UnreadableDdl[];
    danglingAnchors: DanglingAnchor[];
    migrationsReplayed: number;
} {
    const reconstructed = new Map<string, string[]>();
    const unreadableDdl: UnreadableDdl[] = [];
    const danglingAnchors: DanglingAnchor[] = [];
    let migrationsReplayed = 0;

    for (const dir of migrationDirectories()) {
        const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
        if (!fs.existsSync(file)) continue;
        migrationsReplayed += 1;
        for (const raw of splitSqlStatements(stripSqlComments(fs.readFileSync(file, 'utf8')))) {
            if (!RE_TYPEISH.test(raw)) continue;
            const stmt = stripPlpgsqlPreamble(raw);

            const created = RE_CREATE.exec(stmt);
            if (created !== null) {
                reconstructed.set(identOf(created, 1, 2), enumLiterals(created[3]));
                continue;
            }

            const added = RE_ADD.exec(stmt);
            if (added !== null) {
                const type = identOf(added, 1, 2);
                const members = reconstructed.get(type) ?? [];
                if (!reconstructed.has(type)) reconstructed.set(type, members);
                const value = unquote(added[3]);
                // `ADD VALUE IF NOT EXISTS` on a member already present is a
                // no-op in Postgres, and the ordinal it already has is kept.
                if (members.includes(value)) continue;
                const position = added[4];
                if (position === undefined) {
                    members.push(value);
                    continue;
                }
                const anchor = unquote(added[5]);
                const at = members.indexOf(anchor);
                if (at === -1) {
                    // Postgres would raise here; record it rather than
                    // guessing a position and reporting a confident wrong order.
                    danglingAnchors.push({ migration: dir, type, value, anchor });
                    members.push(value);
                    continue;
                }
                members.splice(position.toUpperCase() === 'BEFORE' ? at : at + 1, 0, value);
                continue;
            }

            const renamedValue = RE_RENAME_VALUE.exec(stmt);
            if (renamedValue !== null) {
                const members = reconstructed.get(identOf(renamedValue, 1, 2));
                const at = members?.indexOf(unquote(renamedValue[3])) ?? -1;
                // A rename keeps the ordinal — that is exactly why the schema
                // header recommends it over drop-and-re-add.
                if (members !== undefined && at !== -1) members[at] = unquote(renamedValue[4]);
                continue;
            }

            const renamedType = RE_RENAME_TYPE.exec(stmt);
            if (renamedType !== null) {
                const from = identOf(renamedType, 1, 2);
                const to = identOf(renamedType, 3, 4);
                const members = reconstructed.get(from);
                if (members !== undefined) {
                    reconstructed.delete(from);
                    reconstructed.set(to, members);
                }
                continue;
            }

            const dropped = RE_DROP.exec(stmt);
            if (dropped !== null) {
                for (const m of dropped[1].matchAll(new RegExp(IDENT, 'g'))) {
                    const name = m[1] ?? m[2];
                    if (/^(?:CASCADE|RESTRICT)$/i.test(name)) continue;
                    reconstructed.delete(name);
                }
                continue;
            }

            unreadableDdl.push({ migration: dir, sql: stmt.slice(0, 200) });
        }
    }
    return { reconstructed, unreadableDdl, danglingAnchors, migrationsReplayed };
}

/** Every `enum X { … }` block in `prisma/schema`, in declaration order. */
export function parseDeclaredEnums(): DeclaredEnum[] {
    const schema = readPrismaSchema().replace(/\/\/[^\n]*/g, '');
    const out: DeclaredEnum[] = [];
    for (const block of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
        const members: string[] = [];
        let physicalName: string | null = null;
        for (const line of block[2].split('\n')) {
            const text = line.trim();
            if (text === '') continue;
            const mapped = /^@@map\(\s*"([^"]+)"\s*\)$/.exec(text);
            if (mapped !== null) {
                physicalName = mapped[1];
                continue;
            }
            if (text.startsWith('@@')) continue;
            const member = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
            if (member !== null) members.push(member[1]);
        }
        out.push({
            prismaName: block[1],
            physicalName: physicalName ?? block[1],
            members,
        });
    }
    return out;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

let cached: EnumOrderReport | null = null;

/** The whole comparison, cached for the test process. */
export function enumOrderReport(): EnumOrderReport {
    if (cached !== null) return cached;
    const { reconstructed, unreadableDdl, danglingAnchors, migrationsReplayed } =
        reconstructEnumOrder();
    const declared = parseDeclaredEnums();

    const missingFromMigrations: string[] = [];
    const memberSetDifferences: MemberSetDifference[] = [];
    const orderDifferences: OrderDifference[] = [];

    for (const e of declared) {
        const built = reconstructed.get(e.physicalName);
        if (built === undefined) {
            missingFromMigrations.push(e.physicalName);
            continue;
        }
        if (!sameSet(built, e.members)) {
            memberSetDifferences.push({
                physicalName: e.physicalName,
                prismaName: e.prismaName,
                schemaOnly: e.members.filter((m) => !built.includes(m)).sort(),
                migrationOnly: built.filter((m) => !e.members.includes(m)).sort(),
            });
            continue;
        }
        const firstDivergence = e.members.findIndex((m, i) => built[i] !== m);
        if (firstDivergence !== -1) {
            orderDifferences.push({
                physicalName: e.physicalName,
                prismaName: e.prismaName,
                schemaOrder: e.members,
                migrationOrder: built,
                firstDivergence,
            });
        }
    }

    cached = {
        declared,
        reconstructed,
        unreadableDdl,
        danglingAnchors,
        missingFromMigrations,
        memberSetDifferences,
        orderDifferences: orderDifferences.sort((a, b) =>
            a.physicalName.localeCompare(b.physicalName),
        ),
        migrationsReplayed,
    };
    return cached;
}
