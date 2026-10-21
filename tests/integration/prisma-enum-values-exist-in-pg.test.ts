/**
 * Every value a Prisma enum declares exists in its physical Postgres type.
 *
 * ═══ THE FAILURE THIS EXISTS FOR (#3903) ═══
 *
 * `prisma/migrations/20261011090000_grant_expiry_verification` adds
 * `GRANT_EXPIRY` to `WorkItemSource` with
 * `ALTER TYPE … ADD VALUE IF NOT EXISTS`. On the shared test database that
 * migration was RECORDED as applied — `_prisma_migrations.finished_at` not
 * null — and its DDL was not there. A peer's freshly-deployed database proved
 * the statement itself is fine, which leaves `prisma migrate resolve` (or an
 * equivalent) marking a row without running anything.
 *
 * It surfaced as `invalid input value for enum "WorkItemSource": "GRANT_EXPIRY"`
 * from a `prisma.task.create` deep inside an unrelated feature suite, which is
 * exactly the shape `tests/setup/globalSetup.ts` says it exists to prevent:
 * "the one that cost hours (#2640)".
 *
 * ═══ WHY THREE EXISTING CHECKS MISSED IT ═══
 *
 *   · `globalSetup` compares the migration TABLE to the migrations DIRECTORY
 *     and reported "379 applied, all 379 present". A migration ROW is evidence
 *     that a migration was RECORDED, not that its DDL took effect.
 *   · `tests/unit/test-db-migration-drift.test.ts` passes 12/12, for the same
 *     reason: it compares lists.
 *   · `tests/integration/task-enum-db-mapping.test.ts` comes closest and is
 *     the sibling of this file. It pins `Task.source` to the physical type
 *     `WorkItemSource` through `pg_attribute`/`pg_type` — the type's IDENTITY,
 *     never its CONTENTS — and its query-time test binds ONE value,
 *     `TaskSource.RISK_MONITOR`, which existed. Binding the newest value
 *     would have caught this.
 *
 * So: **a check on a type's identity is not a check on its contents, and one
 * that binds a single value only proves that value exists.** This file checks
 * contents, for every enum.
 *
 * ═══ DERIVED, WHICH IS THE WHOLE POINT ═══
 *
 * Both halves come from the product, not from a list written here:
 *
 *   · the VALUES from the generated client (`Prisma`'s exported enum objects),
 *     which is what application code will actually send;
 *   · the PHYSICAL TYPE NAME from the schema's `@@map`, defaulting to the
 *     enum's own name.
 *
 * A hand-written list would have omitted `GRANT_EXPIRY` for the same reason
 * the migration's effect was missing — it is a second thing to remember, and
 * the first one had already been forgotten.
 *
 * `Prisma.dmmf.datamodel.enums` is empty in this client build, which is why
 * the mapping is read from the schema rather than from runtime metadata.
 */
import { PrismaClient } from '@prisma/client';
import * as PrismaClientModule from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SCHEMA_DIR = path.join(process.cwd(), 'prisma/schema');

/**
 * Schema source with comments removed.
 *
 * Load-bearing, and found the hard way while building this: a `///` doc
 * comment inside `SuggestionItemStatus` reads
 * "the `@@map("WorkItem*")` pins record", and an extractor that does not strip
 * comments reads `WorkItem*` as that enum's physical type name. It then looks
 * for a type that cannot exist and reports a missing one — a false finding, in
 * the file whose job is reporting real ones.
 */
function schemaSource(): string {
    let out = '';
    for (const f of readdirSync(SCHEMA_DIR)) {
        if (!f.endsWith('.prisma')) continue;
        out += `${readFileSync(path.join(SCHEMA_DIR, f), 'utf8')}\n`;
    }
    return out
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/\/?.*$/gm, '');
}

interface SchemaEnum {
    /** The Prisma-side name, which is what the client exports. */
    readonly name: string;
    /** The physical Postgres type: `@@map` when present, else the name. */
    readonly pgType: string;
    readonly mapped: boolean;
}

function schemaEnums(): SchemaEnum[] {
    const out: SchemaEnum[] = [];
    for (const m of schemaSource().matchAll(/enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
        const mapped = /@@map\("([^"]+)"\)/.exec(m[2]);
        out.push({
            name: m[1],
            pgType: mapped === null ? m[1] : mapped[1],
            mapped: mapped !== null,
        });
    }
    return out;
}

/** The values the generated client will send for one enum, or null if absent. */
function clientValues(name: string): string[] | null {
    const mod = PrismaClientModule as unknown as Record<string, unknown>;
    const e = mod[name];
    if (e === undefined || e === null || typeof e !== 'object') return null;
    return Object.keys(e as Record<string, string>);
}

/** Every enum type in `public`, with its values. ONE query, not 163. */
async function pgEnums(): Promise<Map<string, Set<string>>> {
    const rows = await prisma.$queryRaw<Array<{ typname: string; enumlabel: string }>>`
        SELECT t.typname, e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
    `;
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
        const set = out.get(r.typname) ?? new Set<string>();
        set.add(r.enumlabel);
        out.set(r.typname, set);
    }
    return out;
}

describeFn('every Prisma enum value exists in its physical Postgres type', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the extraction can see the population it claims to cover', () => {
        // The denominator. An extractor that silently matched nothing would
        // make every assertion below pass over an empty set — which is the
        // failure mode of the three checks that already missed #3903.
        const enums = schemaEnums();
        expect(enums.length).toBeGreaterThanOrEqual(150);

        // Every schema enum must be findable in the client, or the pairing
        // skips it and the skip is invisible.
        const unpaired = enums.filter((e) => clientValues(e.name) === null).map((e) => e.name);
        expect(unpaired).toEqual([]);

        const values = enums.reduce((n, e) => n + (clientValues(e.name)?.length ?? 0), 0);
        expect(values).toBeGreaterThanOrEqual(700);

        // And the `@@map`ed ones specifically, because an identity-mapped enum
        // cannot catch a MAPPING error — only a contents error.
        expect(enums.filter((e) => e.mapped).length).toBeGreaterThanOrEqual(5);
    });

    it('comments are stripped, so a quoted @@map in prose is not read as a mapping', () => {
        // Pins the bug this file's own extractor had. `SuggestionItemStatus`
        // has NO `@@map`; its doc comment merely mentions one.
        const sis = schemaEnums().find((e) => e.name === 'SuggestionItemStatus');
        expect(sis).toBeDefined();
        expect(sis?.mapped).toBe(false);
        expect(sis?.pgType).toBe('SuggestionItemStatus');

        // The positive control: that prose really is in the file, so this is
        // not passing because the sentence moved.
        const raw = readFileSync(path.join(SCHEMA_DIR, 'enums.prisma'), 'utf8');
        expect(raw).toContain('@@map("WorkItem*")');
        expect(schemaSource()).not.toContain('@@map("WorkItem*")');
    });

    it('every declared enum has a physical type', async () => {
        const db = await pgEnums();
        const missing = schemaEnums()
            .filter((e) => !db.has(e.pgType))
            .map((e) => `${e.name} -> ${e.pgType}`);
        expect(missing).toEqual([]);
    });

    it('every client value exists in its physical type', async () => {
        // THE ASSERTION. A failure names `Type.VALUE` for each one, so the
        // message says which migration did not take rather than leaving a
        // reader to find it from a feature suite's stack trace.
        const db = await pgEnums();
        const missing: string[] = [];
        for (const e of schemaEnums()) {
            const have = db.get(e.pgType);
            if (have === undefined) continue; // reported by the test above
            for (const v of clientValues(e.name) ?? []) {
                if (!have.has(v)) missing.push(`${e.pgType}.${v}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('pins the #3903 instance specifically', async () => {
        // The general check above would catch it, but naming it means a future
        // reader of this file learns what it is FOR, and a regression here
        // fails with a message that cites the issue.
        const db = await pgEnums();
        expect(db.get('WorkItemSource')).toBeDefined();
        expect([...(db.get('WorkItemSource') ?? [])]).toContain('GRANT_EXPIRY');
        expect(clientValues('TaskSource')).toContain('GRANT_EXPIRY');
    });

    it('the comparison can fail — a value the type lacks is detected', async () => {
        // Positive control. Without it, a bug that compared a set against
        // itself, or against an empty one, would be indistinguishable from
        // agreement.
        const db = await pgEnums();
        const have = db.get('WorkItemSource');
        expect(have).toBeDefined();
        expect(have?.has('GRANT_EXPIRY')).toBe(true);
        expect(have?.has('NO_SUCH_SOURCE_VALUE')).toBe(false);
    });

    it('is a SUBSET check, and says why equality would be wrong', async () => {
        // Postgres cannot drop an enum value. A value removed from the schema
        // therefore stays in the type for ever, so the database legitimately
        // holds values the client no longer declares — after a rename, always.
        // Asserting equality would fail on correct history.
        //
        // The direction that matters is the one checked above: a value the
        // CLIENT will send that the TYPE does not accept is a runtime error on
        // the next write. The reverse is dead weight.
        const db = await pgEnums();
        const declared = new Set(
            schemaEnums().flatMap((e) =>
                (clientValues(e.name) ?? []).map((v) => `${e.pgType}.${v}`),
            ),
        );
        const inDb: string[] = [];
        for (const [t, vs] of db) for (const v of vs) inDb.push(`${t}.${v}`);

        // Not an assertion about the count — an assertion that this file does
        // not depend on the counts being equal.
        expect(inDb.length).toBeGreaterThanOrEqual(declared.size);
    });
});
