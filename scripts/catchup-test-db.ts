#!/usr/bin/env tsx
/**
 * Apply the migrations the shared TEST database is missing (#2640).
 *
 * This is the named owner of a job that previously had none. `globalSetup`
 * skips `prisma migrate deploy` under CI=1 — correctly, because a migrate
 * fired from one worktree lands on a database every parallel session shares
 * — and every local run sets CI=1. So the only path that advances the shared
 * database was one nobody is supposed to take, and it fell behind `main` and
 * stayed there until a suite failed for a reason that looked like a product
 * defect.
 *
 * `globalSetup` now REFUSES to run against a database that is behind, and the
 * refusal points here. Run it deliberately, when you have read which
 * migrations it is about to apply:
 *
 *     npm run db:test:catchup
 *
 * It resolves the database through `getBaseTestDatabaseUrl()` and applies it
 * through `migrateTestDb()` — the SAME two functions the test harness uses,
 * imported rather than re-implemented, so this can never catch up a different
 * database from the one the refusal was about. (An independent resolver here
 * would be a second source of truth for "which database do the tests use",
 * and the first thing it could do is disagree.)
 *
 * Still a shared resource: `prisma migrate deploy` is forward-only and
 * applies exactly the pending migrations, but it does so on a database other
 * sessions are reading. Run it when the refusal asks for it, not on a hunch.
 */
import {
    getBaseTestDatabaseUrl,
    migrateTestDb,
    checkTestDbMigrationDrift,
} from '../tests/helpers/db';

function redact(url: string): string {
    return url.replace(/:[^:@/]*@/, ':***@');
}

async function main(): Promise<number> {
    const url = getBaseTestDatabaseUrl();
    console.log(`[db:test:catchup] database: ${redact(url)}`);

    const before = await checkTestDbMigrationDrift();
    if (before.status === 'unknown') {
        // An absence that could not be measured is not an absence.
        console.error(`[db:test:catchup] NOT CHECKED: ${before.reason}`);
        console.error(`[db:test:catchup] Nothing was applied. This is "unknown", not "current".`);
        return 2;
    }
    if (before.status === 'current') {
        console.log(
            `[db:test:catchup] Already current: ${before.report.applied} applied, ` +
                `all ${before.report.onDisk} migrations on this branch present. Nothing to do.`,
        );
        return 0;
    }

    console.log(`[db:test:catchup] ${before.report.behind.length} migration(s) to apply:`);
    for (const name of before.report.behind) console.log(`[db:test:catchup]   - ${name}`);

    migrateTestDb();

    // Re-measure rather than trusting the command's exit: `migrateTestDb`
    // swallows a failure as a warning, so "it ran" is not "it applied".
    const after = await checkTestDbMigrationDrift();
    if (after.status === 'current') {
        console.log(
            `[db:test:catchup] Done — ${after.report.applied} applied, ` +
                `all ${after.report.onDisk} on this branch present.`,
        );
        return 0;
    }
    if (after.status === 'behind') {
        console.error(
            `[db:test:catchup] STILL BEHIND by ${after.report.behind.length}: ` +
                `${after.report.behind.join(', ')}`,
        );
        console.error(`[db:test:catchup] Read the prisma output above for why it refused.`);
        return 1;
    }
    console.error(`[db:test:catchup] Could not re-check after applying: ${after.reason}`);
    return 2;
}

main().then(
    (code) => {
        process.exitCode = code;
    },
    (err: unknown) => {
        console.error(`[db:test:catchup] unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
        process.exitCode = 2;
    },
);
