/**
 * The detector behind #2640: "is the database this run is about to test
 * against missing a migration that is on this branch?"
 *
 * The defect it exists to close is SILENCE. `globalSetup` skips
 * `prisma migrate deploy` under CI=1 — correctly, on a database four
 * sessions share — and every local run sets CI=1, so the only path that
 * advanced the shared database was one nobody takes. It fell a migration
 * behind `main` and stayed there for two days, surfacing as
 * `invalid input value for enum "NotificationType"` in four tests of a
 * feature that was fine.
 *
 * Everything below therefore tests one of two things: that the detector
 * FIRES when a migration is missing, and — the half that is easy to skip —
 * that it does not fire when it could not look. A check that reports
 * "up to date" because it failed to connect has gone quiet in exactly the
 * way the issue is about, so `unknown` is a first-class outcome here and
 * each of its causes gets its own case.
 *
 * These are offline: the pure comparison plus the degrade-safely paths.
 * The live-Postgres proof (that the SQL really reads `_prisma_migrations`,
 * so a typo cannot make the detector permanently blind) is in
 * `tests/integration/test-db-migration-drift.test.ts`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    compareMigrations,
    migrationsOnDisk,
    migrationDriftRefusal,
    checkTestDbMigrationDrift,
    MIGRATIONS_DIR,
} from '../helpers/db';

describe('compareMigrations splits behind from ahead', () => {
    it('names every migration on disk the database has not applied', () => {
        const report = compareMigrations(
            ['20260101000000_a', '20260102000000_b', '20260103000000_c'],
            ['20260101000000_a'],
        );
        expect(report.behind).toStrictEqual(['20260102000000_b', '20260103000000_c']);
        expect(report.onDisk).toBe(3);
        expect(report.applied).toBe(1);
    });

    it('orders the missing names oldest first, so the first one printed is the oldest', () => {
        // Prisma's directory names are timestamp-prefixed; the refusal leans
        // on that to say "oldest first" truthfully.
        const report = compareMigrations(
            ['20260103000000_c', '20260101000000_a', '20260102000000_b'],
            [],
        );
        expect(report.behind[0]).toBe('20260101000000_a');
    });

    it('reports a migration the DATABASE has but this branch does not as AHEAD, not behind', () => {
        // The normal state of a machine running several branches at once.
        // Calling it "behind" would refuse every run on such a machine, and
        // that class is already owned by `npm run db:check-migration-drift`.
        const report = compareMigrations(['20260101000000_a'], ['20260101000000_a', '20260109000000_other_branch']);
        expect(report.behind).toStrictEqual([]);
        expect(report.ahead).toStrictEqual(['20260109000000_other_branch']);
    });

    it('is empty on both sides when the two agree — the case that must NOT refuse', () => {
        const report = compareMigrations(['20260101000000_a'], ['20260101000000_a']);
        expect(report.behind).toStrictEqual([]);
        expect(report.ahead).toStrictEqual([]);
    });
});

describe('migrationsOnDisk reads this branch', () => {
    it('returns the real migration directories and nothing else', () => {
        const names = migrationsOnDisk();
        // A positive control on the denominator: an empty list would make
        // every comparison below vacuously "current", which is the silence
        // this whole file exists to prevent.
        expect(names.length).toBeGreaterThan(200);
        // `migration_lock.toml` is a FILE in that directory and must not be
        // mistaken for a migration — it would be permanently "missing" from
        // every database and refuse every run.
        expect(names).not.toContain('migration_lock.toml');
        expect(fs.existsSync(path.join(MIGRATIONS_DIR, names[0], 'migration.sql'))).toBe(true);
    });
});

describe('the refusal says what to do about it', () => {
    const report = compareMigrations(
        ['20260917170000_agent_risk_assessment_stale_notification', '20260101000000_a'],
        ['20260101000000_a'],
    );
    const message = migrationDriftRefusal(report, 'postgresql://test:***@127.0.0.1:5434/inflect_test');

    it('names the count, the database and the exact missing migration', () => {
        expect(message).toContain('1 migration behind');
        expect(message).toContain('127.0.0.1:5434/inflect_test');
        expect(message).toContain('20260917170000_agent_risk_assessment_stale_notification');
    });

    it('names the command that fixes it', () => {
        // Without this the reader is told they are stuck, not how to proceed
        // — which is how a refusal becomes something people route around.
        expect(message).toContain('npm run db:test:catchup');
    });

    it('carries no password', () => {
        expect(message).not.toMatch(/test:test@/);
    });
});

describe('a check that could not run reports UNKNOWN, never "up to date"', () => {
    // This is the property the issue turns on. Each cause below would, if
    // folded into "current", restore the exact silence #2640 is about; if
    // folded into "behind", it would block the DB-free CI job and every
    // offline run.
    jest.setTimeout(30_000);

    it('an unreachable database is unknown', async () => {
        const outcome = await checkTestDbMigrationDrift({
            // Nothing listens on port 1.
            url: 'postgresql://nobody:nothing@127.0.0.1:1/inflect_test',
        });
        expect(outcome.status).toBe('unknown');
        expect(outcome.status === 'unknown' && outcome.reason).toMatch(/cannot reach/i);
    });

    it('an unparseable URL is unknown', async () => {
        const outcome = await checkTestDbMigrationDrift({ url: 'not a url at all' });
        expect(outcome.status).toBe('unknown');
    });

    it('a migrations directory that cannot be read is unknown', async () => {
        const outcome = await checkTestDbMigrationDrift({
            url: 'postgresql://nobody:nothing@127.0.0.1:1/inflect_test',
            migrationsDir: path.join(os.tmpdir(), 'inflect-no-such-migrations-dir-2640'),
        });
        expect(outcome.status).toBe('unknown');
        expect(outcome.status === 'unknown' && outcome.reason).toMatch(/prisma\/migrations/);
    });

    it('an EMPTY migrations directory is unknown rather than "nothing missing"', async () => {
        // The vacuity case, and the one that would have been easiest to get
        // wrong: zero migrations on disk means zero can be missing, so a
        // naive implementation reports "current" for a database it never
        // looked at. It also never reaches Postgres, which is why the
        // unreachable URL here does not decide the outcome.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflect-2640-empty-'));
        try {
            const outcome = await checkTestDbMigrationDrift({
                url: 'postgresql://nobody:nothing@127.0.0.1:1/inflect_test',
                migrationsDir: dir,
            });
            expect(outcome.status).toBe('unknown');
            expect(outcome.status === 'unknown' && outcome.reason).toMatch(/no migrations/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
