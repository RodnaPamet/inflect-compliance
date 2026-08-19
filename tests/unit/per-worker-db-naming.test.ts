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

import { tagForRoot, checkoutTag, perWorkerDbName } from '../helpers/db';

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
        const src = require('node:fs').readFileSync(
            path.resolve(__dirname, '../helpers/db.ts'),
            'utf8',
        );
        const fn = src.slice(src.indexOf('export function tagForRoot'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).not.toMatch(/DATABASE_URL|getBaseTestDatabaseUrl|getDbName/);
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
    const read = (rel: string): string =>
        require('node:fs').readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

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
        expect(src).toMatch(/workerDbs/);
    });
});
