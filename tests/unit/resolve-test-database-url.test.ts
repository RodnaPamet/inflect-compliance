/**
 * Which database a Jest worker talks to (#5567).
 *
 * The decision lives in a module precisely so it can be driven here:
 * `jest.setup.js` is `setupFiles` for every project and runs before any test,
 * so anything decided inside it is unobservable — which is how a serial run
 * spent months on a placeholder URL without a single test noticing.
 *
 * The two cases that must NOT fire carry as much weight as the one that must.
 * A resolver that repointed unconditionally would take a database away from
 * whoever exported one deliberately, and a resolver that refused whenever it
 * saw the placeholder would break every unit suite that mocks Prisma.
 */
import {
    resolveTestDatabaseUrl,
    PLACEHOLDER_DATABASE_URL,
} from '../helpers/resolve-test-database-url';

const BASE = 'postgres://test:pw@127.0.0.1:5434/inflect_test?schema=public';
const REAL = 'postgres://someone:pw@db.internal:5432/their_choice';

const serialMarker = { perWorker: false, count: 1, baseName: 'inflect_test', baseUrl: BASE };
const workerMarker = {
    perWorker: true,
    count: 2,
    baseName: 'inflect_test',
    baseUrl: BASE,
    workerDbs: ['inflect_test_a1', 'inflect_test_a2'],
};

describe('a SERIAL run takes the base URL off the marker', () => {
    it('replaces the placeholder, which is the #5567 regression', () => {
        const out = resolveTestDatabaseUrl({
            current: PLACEHOLDER_DATABASE_URL,
            marker: serialMarker,
            workerId: '1',
            markerNamed: true,
        });
        expect(out).toEqual({ url: BASE, reason: 'serial-run-from-marker' });
    });

    it('and leaves a URL somebody exported ALONE', () => {
        // The half that keeps this from being a different bug. An exported URL
        // is a deliberate choice about which database a run touches; CI makes
        // it, and so does a developer with an env file.
        const out = resolveTestDatabaseUrl({
            current: REAL,
            marker: serialMarker,
            workerId: '1',
            markerNamed: true,
        });
        expect(out).toEqual({ url: null, reason: 'shell-or-env-file' });
    });
});

describe('a PARALLEL run keeps its per-worker clone', () => {
    it('uses the name globalSetup RECORDED creating', () => {
        const out = resolveTestDatabaseUrl({
            current: PLACEHOLDER_DATABASE_URL,
            marker: workerMarker,
            workerId: '2',
            markerNamed: true,
        });
        expect(out.reason).toBe('per-worker-clone');
        expect(new URL(out.url as string).pathname).toBe('/inflect_test_a2');
    });

    it('falls back to the derived name only when nothing was recorded', () => {
        const out = resolveTestDatabaseUrl({
            current: PLACEHOLDER_DATABASE_URL,
            marker: { ...workerMarker, workerDbs: undefined },
            workerId: '3',
            markerNamed: true,
        });
        expect(new URL(out.url as string).pathname).toBe('/inflect_test_w3');
    });

    it('repoints a worker even when a real URL was exported', () => {
        // Deliberately different from the serial case: the whole point of a
        // per-worker clone is that each worker must NOT share one database, so
        // here the clone outranks the exported value.
        const out = resolveTestDatabaseUrl({
            current: REAL,
            marker: workerMarker,
            workerId: '1',
            markerNamed: true,
        });
        expect(new URL(out.url as string).pathname).toBe('/inflect_test_a1');
    });
});

describe('no marker means no database was provisioned', () => {
    it('leaves the placeholder in place and does NOT refuse', () => {
        // The `scan` and `jsdom` projects carry no globalSetup, mock Prisma,
        // and are correct on the placeholder. A resolver that refused here
        // would fail hundreds of suites that never touch a database.
        const out = resolveTestDatabaseUrl({
            current: PLACEHOLDER_DATABASE_URL,
            marker: null,
            workerId: '1',
            markerNamed: false,
        });
        expect(out).toEqual({ url: null, reason: 'no-marker-shared-db' });
    });
});

describe('a provisioned database and a placeholder is refused loudly', () => {
    it('throws when the marker was named but could not be read', () => {
        expect(() =>
            resolveTestDatabaseUrl({
                current: PLACEHOLDER_DATABASE_URL,
                marker: null,
                workerId: '1',
                markerNamed: true,
            }),
        ).toThrow(/still the placeholder while globalSetup has provisioned/);
    });

    it('throws when the marker carries no base URL', () => {
        expect(() =>
            resolveTestDatabaseUrl({
                current: PLACEHOLDER_DATABASE_URL,
                marker: { perWorker: false, count: 1, baseName: 'x', baseUrl: '' },
                workerId: '1',
                markerNamed: true,
            }),
        ).toThrow(/still the placeholder/);
    });

    it('names the port and the issue, because the raw symptom names neither', () => {
        // The failure it replaces reported a BARE `PrismaClientKnownRequestError`
        // with no message on its first occurrences; the port only appeared
        // further down a hundred-failure run.
        let message = '';
        try {
            resolveTestDatabaseUrl({
                current: PLACEHOLDER_DATABASE_URL,
                marker: null,
                workerId: '1',
                markerNamed: true,
            });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('127.0.0.1:5432');
        expect(message).toContain('#5567');
        expect(message).toMatch(/\.env\.test/);
    });
});
