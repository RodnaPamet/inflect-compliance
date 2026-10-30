import { codeOf, functionBodyOf } from '../helpers/source-blocks';
/**
 * Per-worker test databases must not collide across CHECKOUTS.
 *
 * Two clones of this repo on one machine, pointed at one Postgres, used to
 * derive identical worker database names — the name was a pure function of the
 * database name in the URL. globalSetup then runs:
 *
 *     DROP DATABASE IF EXISTS "<name>" WITH (FORCE)
 *
 * and `FORCE` terminates every attached session first. So the second run to
 * start did not race the first; it hung up on it, mid-transaction. The symptom
 * was "Test suite failed to run" with zero failed tests, in whichever DB-backed
 * suite happened to hold a connection at that moment — a file unrelated to
 * anything either checkout had changed.
 *
 * What must stay true is a property, not a format: names derived from
 * different roots must differ, and names derived from one root must not.
 */
import * as path from 'path';

import {
    tagForRoot,
    checkoutTag,
    perWorkerDbName,
    RUN_MARKER_ENV,
    runMarkerPath,
    newRunMarkerPath,
    reapDeadRunMarkers,
    selectReapableWorkerDbs,
} from '../helpers/db';

describe('the tag separates checkouts', () => {
    it('differs for different repo roots', () => {
        // The whole point. Both of these are real paths on the machine this
        // bug was found on.
        expect(tagForRoot('/home/dev/git/inflect-compliance')).not.toBe(
            tagForRoot('/home/dev/inflect-compliance'),
        );
    });

    it('is stable for one root, so a single checkout is unchanged run to run', () => {
        // If this drifted, every run would orphan the previous run's
        // databases instead of reusing the names — a slow leak that looks
        // like nothing until the disk fills.
        expect(tagForRoot('/some/checkout')).toBe(tagForRoot('/some/checkout'));
        expect(checkoutTag()).toBe(checkoutTag());
    });

    it('distinguishes roots that differ only in a leading path segment', () => {
        // Sibling checkouts usually share a suffix — `.../inflect-compliance`
        // is the common case. A tag built from the basename would collide on
        // exactly the layout that produced this bug.
        expect(tagForRoot('/a/inflect-compliance')).not.toBe(tagForRoot('/b/inflect-compliance'));
    });

    it('is derived from the path, not from the connection URL', () => {
        // Load-bearing, and the reason this is not keyed on DATABASE_URL: the
        // two checkouts that collided reached the same database by DIFFERENT
        // routes — one through .env.test, the other through this helper's own
        // default. Two checkouts CAN legitimately hold identical URLs, so a
        // URL-derived tag agrees precisely when it must not.
        //
        // `tagForRoot` lives in the CommonJS module jest.setup.js also
        // requires (2026-10-30). `functionBodyOf` throws if it is not there,
        // so a move cannot leave this reading an empty slice and passing.
        const src = require('node:fs').readFileSync(
            path.resolve(__dirname, '../helpers/test-db-checkout.js'),
            'utf8',
        );
        const body = codeOf(functionBodyOf(src, 'tagForRoot'));
        expect(body).toMatch(/createHash/);
        expect(body).not.toMatch(/DATABASE_URL|getBaseTestDatabaseUrl|getDbName/);
    });
});

/**
 * The per-worker MARKER must not be shared across checkouts (2026-10-30), nor
 * across two runs of one checkout (#4610).
 *
 * globalSetup records the mode and the exact database names it created in a
 * marker under `node_modules/.cache/`. Workers read it to find their
 * database; teardown reads it to know what to drop. Its name used to be the
 * same in every checkout, and worktrees on the dev machine SYMLINK
 * `node_modules` to the main checkout's, so every worktree read and wrote
 * ONE file. Two worktrees running Jest at once: the later globalSetup
 * overwrote the record, the earlier run's tests connected to the other
 * checkout's databases, and the earlier run's teardown dropped the other
 * run's databases `WITH (FORCE)`.
 *
 * A name per checkout fixed that, and left two runs of ONE checkout sharing
 * the file: the run lock admits a second run pointed at another base database
 * through DATABASE_URL_TEST, and its refusal message suggests exactly that.
 * So each run now has its own marker, named by globalSetup in the environment
 * its workers inherit, and every reader takes the path from there.
 *
 * The shapes that matter are the real ones: two roots with ONE directory
 * holding both markers, and one root running twice. A test that compared two
 * path strings would pass on the old scheme whenever the roots differed; the
 * directory, and then the checkout, is what was shared.
 */
describe('the per-worker marker is per run', () => {
    const fsx: typeof import('node:fs') = require('node:fs');
    const os: typeof import('node:os') = require('node:os');
    const { execFileSync }: typeof import('node:child_process') = require('node:child_process');

    const REAL_ROOT = path.resolve(__dirname, '../..');
    let sandbox: string;

    beforeEach(() => {
        sandbox = fsx.mkdtempSync(path.join(os.tmpdir(), 'inflect-marker-per-run-'));
    });
    afterEach(() => {
        fsx.rmSync(sandbox, { recursive: true, force: true });
    });

    /**
     * A checkout that shares its marker directory with another, as a worktree
     * on the dev machine does: its own root, with the `.cache` the marker
     * lives in reaching a directory another checkout also reaches. A worktree
     * gets there by symlinking all of `node_modules`; linking `.cache` alone
     * gives the marker the same shared directory without building a path
     * into the installed-package tree (`dependency-paths-are-resolved`).
     *
     * It carries REAL copies of the two files under test, jest.setup.js and
     * the helper it requires, at their real relative paths, so what runs
     * below is the code in this branch and not a paraphrase of it.
     */
    function checkout(name: string, sharedCache: string): string {
        const root = path.join(sandbox, name);
        fsx.mkdirSync(path.join(root, 'tests', 'helpers'), { recursive: true });
        for (const rel of ['jest.setup.js', 'tests/helpers/test-db-checkout.js']) {
            fsx.copyFileSync(path.join(REAL_ROOT, rel), path.join(root, rel));
        }
        const cacheLink = path.join(root, 'node_modules', '.cache');
        fsx.mkdirSync(path.dirname(cacheLink), { recursive: true });
        fsx.symlinkSync(sharedCache, cacheLink, 'dir');
        return root;
    }

    /** A directory two checkouts' marker directories both resolve to. */
    function sharedCacheDir(): string {
        const shared = path.join(sandbox, 'shared-cache');
        fsx.mkdirSync(shared);
        return shared;
    }

    /** Run a snippet in a clean child `node`, with no ambient DB settings. */
    function node(script: string, env: Record<string, string> = {}): string {
        return execFileSync(process.execPath, ['-e', script], {
            env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
            encoding: 'utf8',
        }).trim();
    }

    /**
     * What globalSetup does at its end, run from inside `root` and through
     * THAT checkout's own copy of the helper: write the record of the
     * databases this run created at a new marker path, and name it. Returns
     * the environment globalSetup leaves behind, which is what the run's
     * workers inherit.
     */
    function recordAsGlobalSetup(root: string, workerDbs: string[]): Record<string, string> {
        const marker = {
            perWorker: true,
            count: workerDbs.length,
            baseName: 'inflect_test',
            baseUrl: 'postgresql://test:test@127.0.0.1:5434/inflect_test?schema=public',
            workerDbs,
        };
        const env = node(
            `const fs = require('fs'); const path = require('path');
             const h = require(${JSON.stringify(path.join(root, 'tests/helpers/test-db-checkout.js'))});
             const markerPath = h.newRunMarkerPath();
             fs.mkdirSync(path.dirname(markerPath), { recursive: true });
             fs.writeFileSync(markerPath, ${JSON.stringify(JSON.stringify(marker))});
             h.publishRunMarker(markerPath);
             process.stdout.write(JSON.stringify({ [h.RUN_MARKER_ENV]: process.env[h.RUN_MARKER_ENV] }));`,
        );
        return JSON.parse(env) as Record<string, string>;
    }

    /** The database a worker of a run connects the APP to, per its checkout's jest.setup.js. */
    function appDatabaseOfWorker(
        root: string,
        runEnv: Record<string, string>,
        workerId: number,
    ): string {
        const url = node(
            `require(${JSON.stringify(path.join(root, 'jest.setup.js'))});
             process.stdout.write(process.env.DATABASE_URL);`,
            { ...runEnv, JEST_WORKER_ID: String(workerId) },
        );
        return new URL(url).pathname.slice(1);
    }

    it('has a different FILE NAME for different repo roots', () => {
        // The NAME, not the full path: two full paths under different roots
        // differ on any scheme. A shared directory leaves only the name to
        // tell two checkouts' markers apart.
        const name = (root: string) => path.basename(runMarkerPath(root, '1-abcd'));
        expect(name('/home/dev/git/inflect-compliance')).not.toBe(
            name('/home/dev/inflect-compliance'),
        );
        expect(name('/a/inflect-compliance')).not.toBe(name('/b/inflect-compliance'));
    });

    it('has a different FILE for two runs of one checkout, in the same directory', () => {
        // #4610. Same checkout, so same directory and same tag: only the run
        // can tell the two apart.
        const a = newRunMarkerPath();
        const b = newRunMarkerPath();
        expect(path.dirname(a)).toBe(path.dirname(b));
        expect(a).not.toBe(b);
        expect(path.basename(a)).toContain(checkoutTag());
        expect(path.basename(a)).toContain(`-${process.pid}-`);
    });

    it('is a different FILE for two checkouts whose marker directory is one directory', () => {
        const shared = sharedCacheDir();
        const a = checkout('worktree-a', shared);
        const b = checkout('worktree-b', shared);

        const dirA = path.dirname(runMarkerPath(a, '1-abcd'));
        const dirB = path.dirname(runMarkerPath(b, '1-abcd'));

        // The premise, checked rather than assumed: the two checkouts really
        // do reach ONE directory. Without this the assertion below could pass
        // because the fixture failed to share anything.
        expect(fsx.realpathSync(dirA)).toBe(fsx.realpathSync(dirB));

        // And yet two files in it, even for one run id.
        const fileA = path.join(fsx.realpathSync(dirA), path.basename(runMarkerPath(a, '1-abcd')));
        const fileB = path.join(fsx.realpathSync(dirB), path.basename(runMarkerPath(b, '1-abcd')));
        expect(fileA).not.toBe(fileB);
    });

    it("a worker reads its own checkout's record after another checkout's globalSetup has run", () => {
        // The 2026-10-30 bug, end to end, with the real files: A's run records
        // its databases, B's run starts later and records its own into the
        // SAME shared directory, and then a worker of A's run starts a file.
        const shared = sharedCacheDir();
        const a = checkout('worktree-a', shared);
        const b = checkout('worktree-b', shared);

        const runA = recordAsGlobalSetup(a, ['inflect_test_aaaa_w1', 'inflect_test_aaaa_w2']);
        const runB = recordAsGlobalSetup(b, ['inflect_test_bbbb_w1', 'inflect_test_bbbb_w2']);

        expect(appDatabaseOfWorker(a, runA, 2)).toBe('inflect_test_aaaa_w2');
        expect(appDatabaseOfWorker(b, runB, 2)).toBe('inflect_test_bbbb_w2');
    });

    it("a worker reads its own RUN's record after a second run of the same checkout has started", () => {
        // #4610, end to end. One checkout, two runs on different base
        // databases, as the run lock's refusal message suggests. On the
        // per-checkout name this read `inflect_scratch_cccc_w2`: run one's
        // tests in run two's database, which run two's teardown then drops.
        const root = checkout('main', sharedCacheDir());

        const runOne = recordAsGlobalSetup(root, ['inflect_test_cccc_w1', 'inflect_test_cccc_w2']);
        const runTwo = recordAsGlobalSetup(root, [
            'inflect_scratch_cccc_w1',
            'inflect_scratch_cccc_w2',
        ]);

        expect(appDatabaseOfWorker(root, runOne, 2)).toBe('inflect_test_cccc_w2');
        expect(appDatabaseOfWorker(root, runTwo, 2)).toBe('inflect_scratch_cccc_w2');
    });

    it('a process no globalSetup named a marker for stays on the database it was given', () => {
        // The scan and jsdom projects run alone, and bare scripts: no
        // globalSetup, so no per-worker databases, whatever markers a live
        // run in this checkout has written.
        const root = checkout('main', sharedCacheDir());
        recordAsGlobalSetup(root, ['inflect_test_dddd_w1', 'inflect_test_dddd_w2']);

        const url = node(
            `require(${JSON.stringify(path.join(root, 'jest.setup.js'))});
             process.stdout.write(process.env.DATABASE_URL);`,
            {
                DATABASE_URL: 'postgresql://test:test@127.0.0.1:5434/inflect_test',
                JEST_WORKER_ID: '2',
            },
        );
        expect(new URL(url).pathname.slice(1)).toBe('inflect_test');
    });

    it('is the naming globalSetup, teardown and the test client use', () => {
        // They import these from tests/helpers/db.ts. A second definition
        // there would split them from jest.setup.js again.
        const db = require('../helpers/db');
        const shared = require('../helpers/test-db-checkout');
        for (const fn of [
            'runMarkerPath',
            'newRunMarkerPath',
            'publishRunMarker',
            'currentRunMarker',
            'reapDeadRunMarkers',
        ]) {
            expect(db[fn]).toBe(shared[fn]);
        }
        expect(db.RUN_MARKER_ENV).toBe(shared.RUN_MARKER_ENV);
    });

    it("the test client reads the database its run's marker names", () => {
        // `getTestDatabaseUrl` is the test client's side of what
        // jest.setup.js does for the app. It must follow the same named
        // marker, or the app and the test would connect to different
        // databases.
        const markerPath = path.join(sandbox, 'run-marker.json');
        fsx.writeFileSync(
            markerPath,
            JSON.stringify({
                perWorker: true,
                count: 2,
                baseName: 'inflect_test',
                baseUrl: 'postgresql://test:test@127.0.0.1:5434/inflect_test?schema=public',
            }),
        );
        const priorMarker = process.env[RUN_MARKER_ENV];
        const priorWorker = process.env.JEST_WORKER_ID;
        process.env[RUN_MARKER_ENV] = markerPath;
        process.env.JEST_WORKER_ID = '2';
        try {
            jest.isolateModules(() => {
                const db = require('../helpers/db');
                expect(db.isParallelRun()).toBe(true);
                expect(db.getDbName(db.getTestDatabaseUrl())).toBe(
                    db.perWorkerDbName('inflect_test', 2),
                );
            });
        } finally {
            if (priorMarker === undefined) delete process.env[RUN_MARKER_ENV];
            else process.env[RUN_MARKER_ENV] = priorMarker;
            if (priorWorker === undefined) delete process.env.JEST_WORKER_ID;
            else process.env.JEST_WORKER_ID = priorWorker;
        }
    });

    describe('markers left by runs that died', () => {
        /** A checkout directory with these file names in its marker directory. */
        function withMarkers(names: string[]): string {
            const root = checkout('main', sharedCacheDir());
            for (const name of names) {
                fsx.writeFileSync(path.join(root, 'node_modules', '.cache', name), '{}');
            }
            return root;
        }
        const left = (root: string) =>
            fsx.readdirSync(path.join(root, 'node_modules', '.cache')).sort();

        it("deletes this checkout's markers whose run is no longer alive, and keeps a live run's", () => {
            const root = path.join(sandbox, 'main');
            const dead = path.basename(runMarkerPath(root, '111-aaaa'));
            const live = path.basename(runMarkerPath(root, '222-bbbb'));
            withMarkers([dead, live]);

            const reaped = reapDeadRunMarkers(root, (pid) => pid === 222);

            expect(reaped).toEqual([dead]);
            expect(left(root)).toEqual([live]);
        });

        it('deletes the one-per-checkout marker this checkout used to write', () => {
            const root = path.join(sandbox, 'main');
            const legacy = `inflect-test-perworker-${tagForRoot(root)}.json`;
            withMarkers([legacy]);

            expect(reapDeadRunMarkers(root, () => true)).toEqual([legacy]);
            expect(left(root)).toEqual([]);
        });

        it("never touches another checkout's markers in a shared directory, dead or not", () => {
            const root = path.join(sandbox, 'main');
            const other = path.join(sandbox, 'worktree-b');
            const theirs = [
                path.basename(runMarkerPath(other, '111-aaaa')),
                `inflect-test-perworker-${tagForRoot(other)}.json`,
                'unrelated.json',
            ];
            withMarkers(theirs);

            expect(reapDeadRunMarkers(root, () => false)).toEqual([]);
            expect(left(root)).toEqual([...theirs].sort());
        });

        it('a directory that does not exist yet reaps nothing and does not throw', () => {
            expect(reapDeadRunMarkers(path.join(sandbox, 'no-such-checkout'))).toEqual([]);
        });
    });
});

describe('the composed database name', () => {
    it('carries the base, the tag, and the worker id', () => {
        const name = perWorkerDbName('inflect_test', 3);
        expect(name).toContain('inflect_test');
        expect(name).toContain(checkoutTag());
        expect(name.endsWith('_w3')).toBe(true);
    });

    it('is no longer the bare <base>_w<id> that collided', () => {
        expect(perWorkerDbName('inflect_test', 1)).not.toBe('inflect_test_w1');
    });

    it('gives every worker a distinct name', () => {
        const names = [1, 2, 3, 4, 5, 6, 7].map((i) => perWorkerDbName('inflect_test', i));
        expect(new Set(names).size).toBe(names.length);
    });

    it('needs no quoting beyond what the callers already do', () => {
        // The name is interpolated into DDL. A hex tag keeps it in
        // [a-z0-9_], so it cannot smuggle a quote into the statement.
        expect(perWorkerDbName('inflect_test', 1)).toMatch(/^[a-z0-9_]+$/);
    });
});

describe('it refuses to be silently truncated', () => {
    it('throws rather than let Postgres cut the name at 63 bytes', () => {
        // Postgres truncates over-long identifiers WITHOUT error. Two workers
        // whose names differ only past byte 63 would then share one database
        // — the exact failure this function exists to prevent, wearing a
        // different hat. Refusing is the only safe answer.
        const long = 'x'.repeat(60);
        expect(() => perWorkerDbName(long, 1)).toThrow(/63-byte identifier limit/);
    });

    it('allows a realistic name', () => {
        expect(() => perWorkerDbName('inflect_test', 7)).not.toThrow();
    });
});

describe('every site that names a worker DB agrees', () => {
    // Four places must agree: globalSetup (creates), teardown (drops),
    // getTestDatabaseUrl (the test client connects) and jest.setup.js (the
    // APP's prisma client connects). They drifted during this very fix —
    // globalSetup and the helper moved to the tagged name while
    // jest.setup.js still concatenated the old one, so the app connected to
    // a database nobody had created and three integration tests failed with
    // "Database inflect_test_w1 does not exist".
    //
    // That is the failure this describe block exists to make loud, because
    // the drift is invisible until something touches the database.
    // #2246 Class A — masked at the READ SEAM. Both callers read lexable
    // source (`jest.setup.js` and `tests/setup/globalSetup.ts`), so `codeOf`
    // is the correct masker for every read that reaches this helper.
    const readRaw = (rel: string): string =>
        require('node:fs').readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
    const read = (rel: string): string => codeOf(readRaw(rel));

    it('jest.setup.js reads the recorded names rather than re-deriving them', () => {
        // It is plain JS and cannot import the TS helper, so "read the
        // record" is the only option that cannot drift.
        //
        // Assert the ASSIGNMENT, not the file. The first version of this test
        // checked that the source mentioned `marker.workerDbs` anywhere — and
        // it survived a mutation that left the lookup in place and dropped it
        // from the pathname, which is the entire bug. A mention is not a use.
        const src = read('jest.setup.js');
        const line = src.split('\n').find((l) => /u\.pathname\s*=/.test(l));
        expect(line).toBeDefined();
        expect(line).toMatch(/recorded/);
    });

    it('only tests/helpers/db.ts composes the scheme', () => {
        // Anywhere else spelling `<base>_w<id>` is a fourth copy waiting to
        // fall behind. Matches both template-literal and concatenation
        // forms — the concatenation form is the one that hid here, because
        // a grep written for the syntax you just typed does not find the
        // syntax someone else typed.
        const offenders = ['tests/setup/globalSetup.ts', 'tests/setup/teardown.ts']
            .filter((f) => {
                const code = read(f)
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/^\s*\/\/.*$/gm, '');
                return /_w\$\{/.test(code) || /['\`]_w['\`]\s*\+/.test(code);
            });
        expect(offenders).toEqual([]);
    });

    it('the marker carries the names globalSetup created', () => {
        const src = read('tests/setup/globalSetup.ts');
        // Pinned to the MARKER ASSIGNMENT, not to the identifier anywhere
        // in the file. `/workerDbs/` matched five places — the
        // declaration, the push, the marker, the log — so deleting
        // `workerDbs` from the marker, which is the only thing this test
        // is named for, left four survivors satisfying it. Adding the
        // #3356 reap, which passes `workerDbs` to the selector, made that
        // a sixth survivor and tipped the needle over
        // `assertion-needle-uniqueness-ratchet`'s 5-position threshold —
        // which is how a tautology that had been quietly true for months
        // got noticed.
        expect(src).toMatch(/marker\s*=\s*\{[^}]*\bworkerDbs\b/);
    });
});

/**
 * Which orphans the reaper is allowed to take (#3356).
 *
 * The selection is the dangerous half — a `DROP DATABASE` on a shared
 * server — so it is a pure function and these are its teeth. The case
 * that matters most is the second one: when this was measured, ALL 39
 * checkout tags on the dev server had zero live connections, 12 of them
 * belonging to checkouts still on disk. Anything that reaps by liveness
 * alone deletes other people's databases while they are between runs.
 */
describe('selecting which per-worker databases to reap', () => {
    const BASE = 'inflect_test';
    const MINE = 'aaaaaaaa';
    const THEIRS = 'bbbbbbbb';
    const row = (datname: string, conns = 0) => ({ datname, conns });

    it('takes an idle database bearing our own tag', () => {
        expect(
            selectReapableWorkerDbs([row(`${BASE}_${MINE}_w9`)], BASE, MINE, []),
        ).toEqual([`${BASE}_${MINE}_w9`]);
    });

    it('NEVER takes another checkout tag, idle or not', () => {
        const rows = [row(`${BASE}_${THEIRS}_w1`), row(`${BASE}_${THEIRS}_w7`, 3)];
        expect(selectReapableWorkerDbs(rows, BASE, MINE, [])).toEqual([]);
    });

    it('leaves the databases the current run is about to use', () => {
        const keep = [`${BASE}_${MINE}_w1`, `${BASE}_${MINE}_w2`];
        const rows = [...keep.map((n) => row(n)), row(`${BASE}_${MINE}_w3`)];
        expect(selectReapableWorkerDbs(rows, BASE, MINE, keep)).toEqual([
            `${BASE}_${MINE}_w3`,
        ]);
    });

    it('leaves one of our own that still has a connection', () => {
        expect(
            selectReapableWorkerDbs([row(`${BASE}_${MINE}_w4`, 1)], BASE, MINE, []),
        ).toEqual([]);
    });

    it('never takes the base database, which has no worker suffix', () => {
        const rows = [row(BASE), row(`${BASE}_${MINE}`), row(`${BASE}_${MINE}_w`)];
        expect(selectReapableWorkerDbs(rows, BASE, MINE, [])).toEqual([]);
    });

    it('never takes a database belonging to a different base name', () => {
        // The query is `LIKE '<base>%'`, so a longer base sharing our
        // prefix reaches this function and must not match.
        const rows = [row(`${BASE}_other_${MINE}_w1`), row(`${BASE}x_${MINE}_w1`)];
        expect(selectReapableWorkerDbs(rows, BASE, MINE, [])).toEqual([]);
    });

    it('requires a numeric worker index', () => {
        const rows = [row(`${BASE}_${MINE}_wx`), row(`${BASE}_${MINE}_w1x`)];
        expect(selectReapableWorkerDbs(rows, BASE, MINE, [])).toEqual([]);
    });

    it('matches what perWorkerDbName actually produces, for the real tag', () => {
        // Guards the two from drifting apart: a scheme change that this
        // selector did not follow would leave real orphans unreapable
        // while every synthetic case above still passed.
        const real = perWorkerDbName(BASE, 5);
        expect(selectReapableWorkerDbs([row(real)], BASE, checkoutTag(), [])).toEqual([
            real,
        ]);
    });
});
