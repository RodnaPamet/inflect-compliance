/**
 * `tests/setup/globalSetup.ts` must REFUSE to start a run against a test
 * database that is behind this branch (#2640).
 *
 * ── Why the assertion is on globalSetup and not on the detector ──────
 *
 * The detector has its own tests (`test-db-migration-drift.test.ts`), and
 * they cannot catch the regression this file exists for. The defect in #2640
 * is not "the check computes the wrong answer" — it is that nothing acts on
 * the answer loudly enough to stop the run. A detector that returns `behind`
 * to a caller which logs it and carries on is exactly as silent as no
 * detector at all: the warning scrolls past in Jest's startup noise, and the
 * failure it predicted arrives later in an unrelated suite, wearing a
 * product defect's clothes. That cost two sessions hours, once.
 *
 * So these tests EXECUTE globalSetup, with the helper module faked, and
 * assert on what it does with each outcome. The two mutations they are built
 * to catch are both at this call site: softening the `throw` into a
 * `console.warn`, and deleting the call entirely.
 *
 * ── Why faking the helper is not faking the subject ──────────────────
 *
 * The subject is globalSetup's reaction, and the fake supplies only its
 * inputs — the run lock, the marker path, and the drift outcome. The real
 * module is not loaded, so nothing here touches Postgres, migrates anything,
 * or writes to the marker four sessions share. The marker path is redirected
 * into a per-test temp directory for the same reason.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TestDbMigrationDriftOutcome, MigrationDriftReport } from '../helpers/db';

type GlobalSetup = (config?: { maxWorkers?: number }) => Promise<void>;

const BEHIND_REPORT: MigrationDriftReport = {
    onDisk: 2,
    applied: 1,
    behind: ['20260917170000_agent_risk_assessment_stale_notification'],
    ahead: [],
};

const BEHIND: TestDbMigrationDriftOutcome = {
    status: 'behind',
    report: BEHIND_REPORT,
    database: 'postgresql://test:***@127.0.0.1:5434/inflect_test',
    message: '[test-setup] REFUSING TO RUN: the shared test database is 1 migration behind this branch.',
};

const CURRENT: TestDbMigrationDriftOutcome = {
    status: 'current',
    report: { onDisk: 2, applied: 2, behind: [], ahead: [] },
    database: 'postgresql://test:***@127.0.0.1:5434/inflect_test',
};

const UNKNOWN: TestDbMigrationDriftOutcome = {
    status: 'unknown',
    reason: 'cannot reach the test database (ECONNREFUSED 127.0.0.1:5434)',
};

interface Harness {
    run: GlobalSetup;
    markerPath: string;
    releases: number;
    logs: string[];
    warnings: string[];
    cleanup: () => void;
}

/**
 * Load a FRESH copy of the real globalSetup with a faked `../helpers/db`.
 * `jest.doMock` rather than `jest.mock` so each case can supply its own
 * drift outcome without the hoisting dance.
 */
function loadGlobalSetup(drift: TestDbMigrationDriftOutcome): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflect-2640-marker-'));
    const markerPath = path.join(dir, 'perworker.json');
    const state = { releases: 0 };

    jest.resetModules();
    jest.doMock('../helpers/db', () => ({
        __esModule: true,
        PER_WORKER_MARKER: markerPath,
        getBaseTestDatabaseUrl: () => 'postgresql://test:test@127.0.0.1:5434/inflect_test',
        getDbName: () => 'inflect_test',
        adminConnectionString: () => 'postgresql://test:test@127.0.0.1:5434/postgres',
        perWorkerDbName: (base: string, id: number | string) => `${base}_w${id}`,
        // 'unchecked' keeps the lock out of the way: it is the outcome that
        // holds no connection, so nothing in these tests can leak one.
        acquireTestDbRunLock: async () => ({
            status: 'unchecked',
            key: [1, 2],
            reason: 'faked in a unit test',
        }),
        rememberTestDbRunLock: () => {},
        releaseTestDbRunLock: async () => {
            state.releases += 1;
        },
        migrateTestDb: () => {
            throw new Error('migrateTestDb must not run in this test');
        },
        checkTestDbMigrationDrift: async () => drift,
    }));

    const logs: string[] = [];
    const warnings: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...a) => {
        logs.push(a.join(' '));
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...a) => {
        warnings.push(a.join(' '));
    });

    const run = require('../setup/globalSetup').default as GlobalSetup;

    return {
        run,
        markerPath,
        get releases() {
            return state.releases;
        },
        logs,
        warnings,
        cleanup: () => {
            logSpy.mockRestore();
            warnSpy.mockRestore();
            jest.dontMock('../helpers/db');
            jest.resetModules();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe('globalSetup and a test database that is BEHIND this branch', () => {
    // CI=1 is the configuration that PRODUCES the drift: it skips migrate on
    // a database four sessions share, which is correct and is why nothing
    // catches the database up. The refusal has to work in exactly that mode.
    const priorCI = process.env.CI;
    beforeEach(() => {
        process.env.CI = '1';
    });
    afterEach(() => {
        if (priorCI === undefined) delete process.env.CI;
        else process.env.CI = priorCI;
    });

    it('REJECTS — a run that would fail later for a reason that looks like a product bug never starts', async () => {
        const h = loadGlobalSetup(BEHIND);
        try {
            await expect(h.run({ maxWorkers: 1 })).rejects.toThrow(/REFUSING TO RUN/);
        } finally {
            h.cleanup();
        }
    });

    it('rejects with the message the detector composed, so the missing migration is named', async () => {
        const h = loadGlobalSetup(BEHIND);
        try {
            await expect(h.run({ maxWorkers: 1 })).rejects.toThrow(
                /1 migration behind this branch/,
            );
        } finally {
            h.cleanup();
        }
    });

    it('does NOT merely warn — nothing proceeds past the refusal', async () => {
        // The mutation this case exists for: turning the `throw` into a
        // `console.warn(...)`. A printed warning satisfies "it told someone"
        // while leaving the run to fail later under someone else's name, so
        // the marker write is the tell — it is the next thing globalSetup
        // does, and a refusal that merely logs would reach it.
        const h = loadGlobalSetup(BEHIND);
        try {
            await h.run({ maxWorkers: 1 }).then(
                () => {
                    throw new Error('globalSetup resolved on a database that is behind');
                },
                () => {},
            );
            expect(fs.existsSync(h.markerPath)).toBe(false);
        } finally {
            h.cleanup();
        }
    });

    it('hands the concurrent-run lock back before throwing', async () => {
        // A throw from globalSetup skips globalTeardown, so the release has
        // to happen here. Otherwise the next run in this checkout could be
        // refused by a process that has already given up.
        const h = loadGlobalSetup(BEHIND);
        try {
            await h.run({ maxWorkers: 1 }).catch(() => {});
            expect(h.releases).toBe(1);
        } finally {
            h.cleanup();
        }
    });
});

describe('globalSetup and the outcomes that must NOT block a run', () => {
    // Vacuity companions. A refusal that fired unconditionally would pass
    // every assertion above while making the whole repo untestable, so these
    // two are load-bearing rather than padding.
    const priorCI = process.env.CI;
    beforeEach(() => {
        process.env.CI = '1';
    });
    afterEach(() => {
        if (priorCI === undefined) delete process.env.CI;
        else process.env.CI = priorCI;
    });

    it('a CURRENT database proceeds, and writes the per-worker marker', async () => {
        const h = loadGlobalSetup(CURRENT);
        try {
            await expect(h.run({ maxWorkers: 1 })).resolves.toBeUndefined();
            expect(fs.existsSync(h.markerPath)).toBe(true);
        } finally {
            h.cleanup();
        }
    });

    it('an UNKNOWN result proceeds — an offline run is not a drifted one', async () => {
        // Unreachable Postgres is how the DB-free CI job and every offline
        // run look. Refusing them would trade one silent failure for a loud
        // one on the innocent.
        const h = loadGlobalSetup(UNKNOWN);
        try {
            await expect(h.run({ maxWorkers: 1 })).resolves.toBeUndefined();
            expect(fs.existsSync(h.markerPath)).toBe(true);
        } finally {
            h.cleanup();
        }
    });

    it('an UNKNOWN result still SAYS it did not run, rather than passing in silence', async () => {
        const h = loadGlobalSetup(UNKNOWN);
        try {
            await h.run({ maxWorkers: 1 });
            const said = h.warnings.join('\n');
            expect(said).toMatch(/DID NOT RUN/);
            expect(said).toMatch(/UNKNOWN/);
        } finally {
            h.cleanup();
        }
    });
});
