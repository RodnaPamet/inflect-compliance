/**
 * A table the tenant purge RETAINS, whose foreign key to a table it DELETES is
 * `ON DELETE SET NULL`, must not carry an UPDATE trigger that refuses that
 * SET NULL (#5848).
 *
 * WHY THIS EXISTS
 * ───────────────
 * `tenant-purge-retained-never-cascades` holds that a retained table is never
 * reached by a CASCADE from a purged one, and points the fix at SET NULL on a
 * nullable column. A SET NULL is an UPDATE of the retained row, though, and
 * retained tables are the ones that carry immutability triggers. If the
 * trigger refuses the column, the FK action raises, and the purge's per-tenant
 * transaction rolls back — for every tenant holding such a row.
 *
 * That is #5848 exactly. `AiDecisionLog.aiSystemId` was `SET NULL
 * ("aiSystemId")` to the purged `AiSystem`, and `ai_decision_log_immutable()`
 * listed `aiSystemId` among the columns no UPDATE may change. The cascade guard
 * was green, because it reads `onDelete: Cascade` and nothing else.
 *
 * WHAT IT CHECKS, AND FROM WHERE
 * ──────────────────────────────
 * The population comes from the live catalogue the migrations built, with no
 * allowlist:
 *
 *   purged    — every `tenantId` table not in `TENANT_PURGE_RETAINED` (what
 *               `purgeSoftDeletedTenants` DELETEs), plus every table a CASCADE
 *               reaches from those;
 *   in scope  — every FK with `ON DELETE SET NULL` from a retained table to a
 *               purged one, on a retained table carrying at least one
 *               non-internal UPDATE trigger.
 *
 * Each one is then EXERCISED rather than read. Whether PL/pgSQL admits a
 * transition is not something a regex over its body can settle, so the guard
 * builds a temp copy of the retained table (`LIKE … INCLUDING DEFAULTS`), gives
 * it a temp parent through a real `ON DELETE SET NULL (col)` FK, inserts a row,
 * re-creates the table's own UPDATE triggers on the copy from
 * `pg_get_triggerdef`, and deletes the parent. The FK action then runs the
 * real trigger functions one level deep, exactly as in a purge. It does so
 * twice: once with every nullable column NULL, and once with every column set,
 * so a branch that only fires on a stamped row (`OLD."decision" IS NOT NULL`)
 * is reached too. Everything runs in a transaction that is always rolled back.
 *
 * The copy carries no CHECK constraints and no other FKs, so a refusal can only
 * be the triggers speaking. What it cannot see is a trigger function that
 * reads OTHER tables by the row's ids, since the copy's ids are dummies; none
 * on the population today does.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

type Tx = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

/** One retained-side SET NULL FK, with the UPDATE triggers its table carries. */
interface SetNullSite {
    readonly child: string;
    readonly column: string;
    readonly parent: string;
    readonly constraint: string;
    /** `pg_get_triggerdef` of every non-internal UPDATE trigger on `child`. */
    readonly triggerDefs: readonly string[];
}

const PROBE = 'purge_set_null_probe';
const PROBE_PARENT = 'purge_set_null_probe_parent';
const ROLLBACK = 'purge-set-null-probe-rollback';
const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Tables the purge removes rows from: tenant-scoped minus retained, closed over CASCADE. */
async function purgedTables(): Promise<Set<string>> {
    const tenantScoped = (await prisma.$queryRawUnsafe(`
        SELECT c.table_name AS t
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' AND t.table_type = 'BASE TABLE'
    `)) as Array<{ t: string }>;
    const cascades = (await prisma.$queryRawUnsafe(`
        SELECT child.relname AS child, parent.relname AS parent
          FROM pg_constraint con
          JOIN pg_class child  ON child.oid  = con.conrelid
          JOIN pg_class parent ON parent.oid = con.confrelid
          JOIN pg_namespace n  ON n.oid = child.relnamespace
         WHERE con.contype = 'f' AND con.confdeltype = 'c' AND n.nspname = 'public'
    `)) as Array<{ child: string; parent: string }>;
    const purged = new Set(tenantScoped.map((r) => r.t).filter((t) => !TENANT_PURGE_RETAINED.has(t)));
    const queue = [...purged];
    while (queue.length > 0) {
        const parent = queue.shift()!;
        for (const e of cascades) {
            if (e.parent === parent && !purged.has(e.child)) {
                purged.add(e.child);
                queue.push(e.child);
            }
        }
    }
    return purged;
}

/**
 * Every SET NULL FK from a retained table to a purged one, on a table with an
 * UPDATE trigger. A composite FK names the one column it nulls; a whole-FK
 * SET NULL over several columns would null `tenantId` too and is reported as
 * its own failure below.
 */
async function setNullSites(purged: ReadonlySet<string>): Promise<{ sites: SetNullSite[]; unprobeable: string[] }> {
    const rows = (await prisma.$queryRawUnsafe(`
        SELECT child.relname AS child, parent.relname AS parent, con.conname AS constraint,
               ARRAY(SELECT a.attname::text FROM unnest(COALESCE(con.confdelsetcols, con.conkey)) k
                       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS nulled,
               ARRAY(SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
                      WHERE t.tgrelid = child.oid AND NOT t.tgisinternal AND (t.tgtype & 16) <> 0
                      ORDER BY t.tgname) AS triggers
          FROM pg_constraint con
          JOIN pg_class child  ON child.oid  = con.conrelid
          JOIN pg_class parent ON parent.oid = con.confrelid
          JOIN pg_namespace n  ON n.oid = child.relnamespace
         WHERE con.contype = 'f' AND con.confdeltype = 'n' AND n.nspname = 'public'
    `)) as Array<{ child: string; parent: string; constraint: string; nulled: string[]; triggers: string[] }>;
    const sites: SetNullSite[] = [];
    const unprobeable: string[] = [];
    for (const r of rows) {
        if (!TENANT_PURGE_RETAINED.has(r.child) || !purged.has(r.parent) || r.triggers.length === 0) continue;
        if (r.nulled.length !== 1) {
            unprobeable.push(`${r.child}.${r.constraint} nulls [${r.nulled.join(', ')}]`);
            continue;
        }
        sites.push({ child: r.child, column: r.nulled[0], parent: r.parent, constraint: r.constraint, triggerDefs: r.triggers });
    }
    return { sites: sites.sort((a, b) => a.constraint.localeCompare(b.constraint)), unprobeable };
}

/** A literal of the column's type, for a NOT NULL column with no default, or for the "every column set" row. */
async function dummyFor(tx: Tx, table: string, column: string): Promise<string> {
    const [t] = (await tx.$queryRawUnsafe(
        `SELECT ty.typcategory::text AS cat, format_type(a.atttypid, a.atttypmod) AS type, ty.typname::text AS name,
                (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder LIMIT 1) AS label
           FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
          WHERE a.attrelid = $1::regclass AND a.attname = $2`,
        `pg_temp.${PROBE}`,
        column,
    )) as Array<{ cat: string; type: string; name: string; label: string | null }>;
    const literal: Record<string, string> = { S: `'x'`, N: '0', B: 'false', D: 'now()', A: `'{}'` };
    if (t.cat === 'E') return `'${t.label!.replace(/'/g, "''")}'::${t.type}`;
    if (t.name === 'json' || t.name === 'jsonb') return `'{}'::${t.type}`;
    if (t.name === 'uuid') return 'gen_random_uuid()';
    if (t.name === 'bytea') return `'\\x00'::bytea`;
    if (literal[t.cat]) return `${literal[t.cat]}::${t.type}`;
    throw new Error(`no dummy value for ${table}.${column} of type ${t.type} (category ${t.cat})`);
}

/**
 * Delete a parent whose child row is a copy of `site.child`, under its own
 * UPDATE triggers, and report how the FK's SET NULL fails — or null when the
 * triggers admit it. `fill` sets every column (a stamped row) rather than only
 * the NOT NULL ones. `triggerDefs` overrides the triggers, for the mutation
 * proof. Always rolled back.
 */
async function probe(site: SetNullSite, fill: 'sparse' | 'full', triggerDefs = site.triggerDefs, setup = ''): Promise<string | null> {
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            if (setup) await tx.$executeRawUnsafe(setup);
            await tx.$executeRawUnsafe(
                `CREATE TEMP TABLE ${PROBE} (LIKE public.${qi(site.child)} INCLUDING DEFAULTS) ON COMMIT DROP`,
            );
            const [{ type }] = (await tx.$queryRawUnsafe(
                `SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
                  WHERE a.attrelid = $1::regclass AND a.attname = $2`,
                `pg_temp.${PROBE}`,
                site.column,
            )) as Array<{ type: string }>;
            await tx.$executeRawUnsafe(`CREATE TEMP TABLE ${PROBE_PARENT} (id ${type} PRIMARY KEY) ON COMMIT DROP`);
            await tx.$executeRawUnsafe(
                `ALTER TABLE pg_temp.${PROBE} ADD FOREIGN KEY (${qi(site.column)}) ` +
                    `REFERENCES pg_temp.${PROBE_PARENT}(id) ON DELETE SET NULL (${qi(site.column)})`,
            );
            const parentId = await dummyFor(tx, site.child, site.column);
            await tx.$executeRawUnsafe(`INSERT INTO pg_temp.${PROBE_PARENT} VALUES (${parentId})`);

            const cols = (await tx.$queryRawUnsafe(
                `SELECT a.attname::text AS name, a.attnotnull AS notnull, a.atthasdef AS hasdef
                   FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
                `pg_temp.${PROBE}`,
            )) as Array<{ name: string; notnull: boolean; hasdef: boolean }>;
            const names: string[] = [qi(site.column)];
            const values: string[] = [`(SELECT id FROM pg_temp.${PROBE_PARENT})`];
            for (const c of cols) {
                if (c.name === site.column) continue;
                if (fill === 'full' || (c.notnull && !c.hasdef)) {
                    names.push(qi(c.name));
                    values.push(await dummyFor(tx, site.child, c.name));
                }
            }
            await tx.$executeRawUnsafe(`INSERT INTO pg_temp.${PROBE} (${names.join(', ')}) VALUES (${values.join(', ')})`);

            // The row exists before the triggers do, so an INSERT-or-UPDATE
            // trigger never judges the dummy insert — only the FK's UPDATE.
            const on = new RegExp(`\\bON public\\.${qi(site.child).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
            for (const def of triggerDefs) {
                if (!on.test(def)) throw new Error(`cannot re-target trigger: ${def}`);
                await tx.$executeRawUnsafe(def.replace(on, `ON pg_temp.${PROBE}`));
            }

            await tx.$executeRawUnsafe(`DELETE FROM pg_temp.${PROBE_PARENT}`);
            const [{ n }] = (await tx.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM pg_temp.${PROBE} WHERE ${qi(site.column)} IS NULL`,
            )) as Array<{ n: number }>;
            if (n !== 1) throw new Error(`the SET NULL did not apply to the probe row (${n} nulled)`);
            throw new Error(ROLLBACK);
        });
        return null;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return message.includes(ROLLBACK) ? null : message.split('\n').filter(Boolean).pop()!;
    }
}

describeFn('tenant purge — a retained table admits the SET NULL of its FK to a purged table', () => {
    let sites: SetNullSite[];
    let unprobeable: string[];

    beforeAll(async () => {
        await prisma.$connect();
        ({ sites, unprobeable } = await setNullSites(await purgedTables()));
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the population is real — a catalogue read returning nothing must fail', () => {
        // POSITIVE CONTROLS. Both sites that carry a trigger today must be
        // found, or the invariant below is vacuous for the case it exists for.
        expect(sites.map((s) => s.constraint)).toEqual(
            expect.arrayContaining([
                'AiDecisionLog_aiSystemId_tenantId_fkey',
                'AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey',
            ]),
        );
        const adl = sites.find((s) => s.child === 'AiDecisionLog')!;
        expect(adl).toMatchObject({ column: 'aiSystemId', parent: 'AiSystem' });
        expect(adl.triggerDefs.some((d) => d.includes('ai_decision_log_immutable()'))).toBe(true);
    });

    it('every such FK nulls exactly one column — a whole composite SET NULL would null tenantId', () => {
        expect(unprobeable).toEqual([]);
    });

    it.each(['sparse', 'full'] as const)(
        'no retained table refuses the SET NULL from a purged parent (%s row)',
        async (fill) => {
            const refused: string[] = [];
            for (const site of sites) {
                const failure = await probe(site, fill);
                if (failure !== null) refused.push(`${site.child}.${site.column} -> ${site.parent}: ${failure}`);
            }
            expect(refused).toEqual([]);
        },
    );

    it('MUTATION PROOF — the trigger as it shipped before #5848 is caught', async () => {
        // The defect itself, read from the migration that last installed it,
        // under a temp name and bound to the probe in place of today's trigger.
        const mig = fs.readFileSync(
            path.resolve(
                __dirname,
                '../../prisma/migrations/20261114120000_ai_decision_log_agent_proposal_id/migration.sql',
            ),
            'utf8',
        );
        const start = mig.indexOf('CREATE OR REPLACE FUNCTION ai_decision_log_immutable()');
        const end = mig.indexOf('$$ LANGUAGE plpgsql;', start) + '$$ LANGUAGE plpgsql;'.length;
        expect(start).toBeGreaterThan(-1);
        const oldFn = mig
            .slice(start, end)
            .replace('FUNCTION ai_decision_log_immutable()', 'FUNCTION pg_temp.ai_decision_log_immutable_pre_5848()');
        const site = sites.find((s) => s.child === 'AiDecisionLog')!;
        const oldTrigger =
            `CREATE TRIGGER pre_5848 BEFORE UPDATE ON public."AiDecisionLog" ` +
            'FOR EACH ROW EXECUTE FUNCTION pg_temp.ai_decision_log_immutable_pre_5848()';
        for (const fill of ['sparse', 'full'] as const) {
            expect(await probe(site, fill, [oldTrigger], oldFn)).toContain(
                'AiDecisionLog is append-only; only humanOutcome may transition',
            );
        }
        // And today's trigger, on the same probe, admits it.
        expect(await probe(site, 'full')).toBeNull();
    });
});
