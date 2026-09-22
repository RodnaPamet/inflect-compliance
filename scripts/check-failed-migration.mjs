#!/usr/bin/env node
/**
 * Is there a half-applied migration wedging this database? (#2746)
 *
 * Exit 0 = clean. Exit 1 = a migration started and never finished, which means
 * `prisma migrate deploy` will refuse with P3009 on the next container start —
 * and because `scripts/entrypoint.sh` runs it on EVERY start, the app enters a
 * crash loop it cannot leave on its own. That is what kept production down for
 * ~25 hours on 2026-09-20 (#2745).
 *
 * Deliberately a standalone .mjs with no Prisma client: it has to run against a
 * database whose migrations are, by definition, in a bad state — and against
 * production from an operator's shell, where the app may not be starting at
 * all. `pg` is the only dependency.
 *
 * READ-ONLY. It reports; it never repairs. The recovery is judgement, not a
 * command — `docs/runbooks/failed-migration-recovery.md` explains why, and in
 * particular why `applied_steps_count` must not be believed.
 */
import pg from 'pg';

const url =
    process.env.DIRECT_DATABASE_URL ||
    process.env.DATABASE_URL_TEST ||
    process.env.DATABASE_URL;

if (!url) {
    // Fail, do not skip. "I could not check" reported as "nothing is wrong" is
    // the same silent pass the whole incident was about.
    console.error('check-failed-migration: no DIRECT_DATABASE_URL / DATABASE_URL set');
    process.exit(1);
}

const client = new pg.Client({ connectionString: url });

try {
    await client.connect();
    const { rows } = await client.query(
        `SELECT migration_name, started_at, applied_steps_count
           FROM _prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL
          ORDER BY started_at`,
    );

    if (rows.length === 0) {
        console.log('check-failed-migration: OK — no unfinished migration');
        process.exit(0);
    }

    console.error(`check-failed-migration: ${rows.length} UNFINISHED migration(s)\n`);
    for (const r of rows) {
        console.error(`  ${r.migration_name}`);
        console.error(`    started_at          ${r.started_at?.toISOString?.() ?? r.started_at}`);
        console.error(`    applied_steps_count ${r.applied_steps_count}  <-- DO NOT TRUST THIS`);
    }
    console.error(
        '\n  applied_steps_count=0 does NOT mean nothing applied. Verify each statement\n' +
            '  against pg_enum / information_schema.columns / pg_constraint / pg_indexes,\n' +
            '  and note that a unique made with CREATE UNIQUE INDEX is in pg_indexes but\n' +
            '  NOT pg_constraint.\n\n' +
            '  Recovery: docs/runbooks/failed-migration-recovery.md\n' +
            '  Do not reach for `migrate resolve --rolled-back` first — it RE-RUNS the\n' +
            '  migration, and a bare ALTER TYPE ... ADD VALUE fails the second time.\n',
    );
    process.exit(1);
} catch (err) {
    console.error(`check-failed-migration: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
} finally {
    await client.end().catch(() => {});
}
