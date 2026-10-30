/**
 * `npm run db:test:reap` drops a checkout's per-worker databases only while
 * it holds that checkout's run lock (2026-10-30).
 *
 * ── The hazard ───────────────────────────────────────────────────────
 *
 * The reaper picks "strays" by connection count, and a Jest run's per-worker
 * databases read 0 connections between test files. So a count says nothing
 * while a run is live. `--mine` printed "safe: the run lock covers this tag"
 * and never took the lock. Run beside a live Jest run of the same checkout,
 * it dropped that run's idle databases, and the run's next DB-backed suite
 * failed on a database that no longer existed.
 *
 * The run lock is what globalSetup holds from setup to teardown, keyed on
 * the (checkout tag, base database) pair the names are built from. These
 * tests take it the way globalSetup does, run the REAL script, and read
 * `pg_database` afterwards: what was dropped is the assertion, not what the
 * script printed.
 *
 * Every case uses its own throwaway base database name, so the lock pair and
 * every database here belong to this file alone. The base database itself is
 * never created: the reaper only reads names and connects to `postgres`.
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { Client } from 'pg';

import { DB_AVAILABLE } from './db-helper';
import {
    CHECKOUT_ROOT,
    RUN_LOCK_LABEL_PREFIX,
    acquireTestDbRunLock,
    adminConnectionString,
    checkoutTag,
    getBaseTestDatabaseUrl,
    testDbRunLockKey,
    testDbRunLockKeyForTag,
    withDbName,
} from '../helpers/db';

// Cold tsx compile + the helper's Prisma import + the checkout enumeration,
// per spawn, under whatever else the machine is running.
jest.setTimeout(180_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The tsx CLI, located by Node's resolver (see framework-import-cli.test.ts for why). */
const TSX_CLI: string = (() => {
    const pkgJson = require.resolve('tsx/package.json', { paths: [CHECKOUT_ROOT] });
    const bin = (JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> }).bin;
    const entry = typeof bin === 'string' ? bin : bin?.tsx;
    if (!entry) throw new Error(`tsx@${pkgJson} declares no \`bin\` entry point.`);
    return path.resolve(path.dirname(pkgJson), entry);
})();

const TAG = checkoutTag();

interface Fixture {
    base: string;
    /** This checkout's tag, nothing attached: a stray. */
    mineIdle: string[];
    /** This checkout's tag, a connection held open by the test. */
    mineBusy: string;
    /** A tag no checkout on this machine derives. */
    theirTag: string;
    theirs: string;
    all: string[];
}

let seq = 0;
const opened: Client[] = [];
const fixtures: Fixture[] = [];
const held: Array<() => Promise<void>> = [];

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: adminConnectionString() });
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end().catch(() => {});
    }
}

async function makeFixture(): Promise<Fixture> {
    seq += 1;
    const base = `inflect_reap_${process.pid}_${seq}_${crypto.randomBytes(2).toString('hex')}`;
    let theirTag = crypto.randomBytes(4).toString('hex');
    while (theirTag === TAG) theirTag = crypto.randomBytes(4).toString('hex');
    const name = (tag: string, n: number) => `${base}_${tag}_w${n}`;
    const f: Fixture = {
        base,
        mineIdle: [name(TAG, 901), name(TAG, 902)],
        mineBusy: name(TAG, 903),
        theirTag,
        theirs: name(theirTag, 901),
        all: [],
    };
    f.all = [...f.mineIdle, f.mineBusy, f.theirs].sort();
    fixtures.push(f);
    await admin(async (c) => {
        for (const db of f.all) await c.query(`CREATE DATABASE "${db}"`);
    });
    const busy = new Client({ connectionString: withDbName(adminConnectionString(), f.mineBusy) });
    await busy.connect();
    opened.push(busy);
    return f;
}

async function existing(f: Fixture): Promise<string[]> {
    return admin(async (c) => {
        const { rows } = await c.query<{ datname: string }>(
            'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
            [`${f.base}\\_%`],
        );
        return rows.map((r) => r.datname);
    });
}

/** Run the real script against a fixture's base, from this checkout. */
function reap(f: Fixture, args: string[]): { code: number | null; out: string } {
    const r = spawnSync(process.execPath, [TSX_CLI, 'scripts/reap-test-databases.ts', ...args], {
        cwd: CHECKOUT_ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            DATABASE_URL_TEST: withDbName(getBaseTestDatabaseUrl(), f.base),
            SKIP_ENV_VALIDATION: '1',
        },
        timeout: 150_000,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Hold a run lock in THIS process for the rest of the case. */
async function hold(key: readonly [number, number]): Promise<void> {
    const lock = await acquireTestDbRunLock({ key, label: `${RUN_LOCK_LABEL_PREFIX}${process.pid}` });
    if (lock.status !== 'acquired') {
        throw new Error(`fixture could not take the lock it needs: ${JSON.stringify(lock)}`);
    }
    held.push(lock.release);
}

async function releaseAll(): Promise<void> {
    while (held.length > 0) await held.pop()!();
}

describeFn('db:test:reap holds the run lock of every checkout it drops for', () => {
    afterEach(releaseAll);
    afterAll(async () => {
        await releaseAll();
        while (opened.length > 0) await opened.pop()!.end().catch(() => {});
        await admin(async (c) => {
            for (const f of fixtures) {
                for (const db of f.all) {
                    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
                }
            }
        });
    });

    it('--mine refuses, and drops nothing, while a test run of this checkout holds the lock', async () => {
        const f = await makeFixture();
        // Exactly the key globalSetup takes: from the checkout ROOT. The script
        // derives it from the tag; this also proves the two agree.
        await hold(testDbRunLockKey(CHECKOUT_ROOT, f.base));

        const r = reap(f, ['--mine']);

        expect(r.code).toBe(1);
        expect(r.out).toContain('a test run in this checkout is in progress');
        expect(r.out).toContain('Nothing was dropped');
        expect(await existing(f)).toEqual(f.all);
    });

    it('--mine, with the lock free, drops only this checkout\'s idle databases', async () => {
        // Vacuity companion: a reaper that refused unconditionally would pass
        // the case above.
        const f = await makeFixture();

        const r = reap(f, ['--mine']);

        expect(r.code).toBe(0);
        // Left: our database with a live connection, and the other tag's.
        expect(await existing(f)).toEqual([f.mineBusy, f.theirs].sort());
    });

    it('--unmatched --yes leaves a tag whose run lock is held, and takes it once free', async () => {
        // A checkout the enumeration cannot find still holds its own lock
        // while a run is live, and the lock is derivable from the tag alone.
        const f = await makeFixture();
        await hold(testDbRunLockKeyForTag(f.theirTag, f.base));

        const whileHeld = reap(f, ['--unmatched', '--yes']);
        expect(whileHeld.code).toBe(0);
        expect(whileHeld.out).toContain('holds its run lock');
        expect(await existing(f)).toEqual(f.all);

        await releaseAll();
        const whenFree = reap(f, ['--unmatched', '--yes']);
        expect(whenFree.code).toBe(0);
        // Ours are never --unmatched's, idle or not.
        expect(await existing(f)).toEqual([...f.mineIdle, f.mineBusy].sort());
    });
});
