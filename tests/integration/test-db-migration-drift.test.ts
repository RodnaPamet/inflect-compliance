/**
 * The drift detector (#2640) against a REAL Postgres.
 *
 * The offline tests prove the comparison and the degrade-safely paths. They
 * cannot prove the one thing that decides whether this detector is alive:
 * that the query actually reads `_prisma_migrations`. A wrong table name, a
 * renamed column, a future Prisma that stores history elsewhere — each turns
 * the SELECT into a throw, which this design deliberately classifies as
 * `unknown`. That is the right call for an unreachable database and the
 * wrong one for a broken query, and the two are indistinguishable from
 * offline: the detector would go permanently quiet while every test stayed
 * green. Which is, precisely, the failure mode #2640 is about.
 *
 * So the load-bearing case here is not "the shared database is current" —
 * it is the doctored one: given a migration list this database CANNOT have
 * applied, the answer must be `behind`. Reaching that verdict requires the
 * query to have returned real rows from a real history.
 *
 * Read-only throughout: one SELECT, no transaction, no lock, no write.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DB_AVAILABLE } from './db-helper';
import { checkTestDbMigrationDrift, migrationsOnDisk } from '../helpers/db';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

describeFn('the drift detector reads a real _prisma_migrations', () => {
    it('reports BEHIND for a migration this database cannot have applied', async () => {
        // A directory of migration names that mirrors this branch plus one
        // invented name. The invented one can only be reported as missing if
        // the applied set came back from the database — an empty or failed
        // read lands in `unknown`, so this assertion cannot be satisfied by a
        // detector that never looked.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflect-2640-live-'));
        try {
            for (const name of migrationsOnDisk()) fs.mkdirSync(path.join(dir, name));
            const invented = '29991231235959_a_migration_no_database_has_applied';
            fs.mkdirSync(path.join(dir, invented));

            const outcome = await checkTestDbMigrationDrift({ migrationsDir: dir });

            expect(outcome.status).toBe('behind');
            if (outcome.status !== 'behind') return;
            expect(outcome.report.behind).toStrictEqual([invented]);
            // The denominator, beside the verdict: a real history was read.
            expect(outcome.report.applied).toBeGreaterThan(200);
            expect(outcome.message).toContain(invented);
            expect(outcome.message).toContain('npm run db:test:catchup');
            // Whatever the URL held, the printed one is redacted.
            expect(outcome.message).not.toMatch(/:\s*test:test@/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not report the shared database as behind THIS branch', async () => {
        // The complement, and it is almost tautological by the time it runs:
        // globalSetup refuses the whole run when this database is behind, so
        // a drifted database could not have got here. What it still catches
        // is a detector that reports `behind` for a database that is fine —
        // which would make the repo untestable for four sessions at once.
        const outcome = await checkTestDbMigrationDrift();
        expect(outcome.status).not.toBe('behind');
        if (outcome.status === 'current') {
            expect(outcome.report.behind).toStrictEqual([]);
            expect(outcome.report.applied).toBeGreaterThan(200);
        }
    });
});
