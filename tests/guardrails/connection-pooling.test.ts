/**
 * Guardrail: Connection Pooling Configuration
 *
 * Structural tests verifying PgBouncer/pooling is wired correctly
 * in docker-compose files, Prisma schema, and env config.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));

/** Every host port a compose file's services publish, as service → ports. */
function hostPorts(rel: string): Map<string, number[]> {
    const doc = yaml.load(readRaw(rel)) as { services: Record<string, { ports?: string[] }> };
    return new Map(
        Object.entries(doc.services).map(([name, svc]) => [
            name,
            // `[ip:]host:container`: the host port is the second-to-last field.
            (svc.ports ?? []).map((p) => Number(String(p).split(':').slice(-2)[0])),
        ]),
    );
}

/** The one host port a service publishes. */
function publishedPort(rel: string, service: string): number {
    const ports = hostPorts(rel).get(service) ?? [];
    expect(ports).toHaveLength(1);
    return ports[0];
}

/** The port in an env file's `KEY="postgresql://…:<port>/…"` line. */
function urlPort(src: string, key: string): number {
    const line = src.split(/\r?\n/).find((l) => l.startsWith(`${key}=`)) ?? '';
    const m = /@[^:/]+:(\d+)\//.exec(line);
    expect(m).not.toBeNull();
    return Number(m![1]);
}
const directUrlPort = (src: string) => urlPort(src, 'DIRECT_DATABASE_URL');

describe('Connection Pooling Configuration', () => {

    describe('Prisma schema + config', () => {
        // Prisma 7 — `url` / `directUrl` moved out of `datasource db`
        // and into `prisma.config.ts` (`datasource.url`). Pin both:
        //   - the schema datasource block exists (provider line),
        //   - the config file passes DATABASE_URL through (the runtime
        //     adapter reads it directly so this is also the source of
        //     truth that `prisma migrate / generate` reads).
        const schema = codeOf(readPrismaSchema());
        const config = read('prisma.config.ts');

        test('datasource block declares postgresql provider', () => {
            expect(schema).toMatch(
                /datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"postgresql"/,
            );
        });

        test('prisma.config.ts wires DATABASE_URL into datasource.url', () => {
            expect(config).toContain('DATABASE_URL');
            expect(config).toMatch(/url:\s*process\.env\./);
        });

        test('prisma.config.ts falls back to DIRECT_DATABASE_URL for migrations', () => {
            // Prisma 7 dropped the `directUrl` field. The CLI uses the
            // single `url` from prisma.config.ts; we point that at
            // DIRECT_DATABASE_URL in non-runtime contexts. Pin the
            // env-name reference so future cleanups can't drop it.
            expect(config).toContain('DIRECT_DATABASE_URL');
        });
    });

    describe('env.ts validation', () => {
        const envTs = read('src/env.ts');

        test('DATABASE_URL is required', () => {
            expect(envTs).toContain('DATABASE_URL: z.string().url()');
        });

        test('DIRECT_DATABASE_URL is defined (optional)', () => {
            expect(envTs).toContain('DIRECT_DATABASE_URL');
        });
    });

    describe('docker-compose.yml (dev)', () => {
        const compose = readRaw('docker-compose.yml');

        test('has pgbouncer service', () => {
            expect(compose).toContain('pgbouncer:');
        });

        test('pgbouncer uses transaction pool mode', () => {
            expect(compose).toContain('POOL_MODE: transaction');
        });

        test('pgbouncer has MAX_CLIENT_CONN >= 200', () => {
            const match = compose.match(/MAX_CLIENT_CONN:\s*"?(\d+)"?/);
            expect(match).toBeTruthy();
            expect(parseInt(match![1])).toBeGreaterThanOrEqual(200);
        });

        test('pgbouncer has health check', () => {
            // The compose file must contain a healthcheck for PgBouncer
            // We verify the overall file has a pg_isready check for PgBouncer
            expect(compose).toContain('pg_isready -h 127.0.0.1');
        });

        test('postgres has health check', () => {
            expect(compose).toContain('pg_isready');
        });

        test('pgbouncer depends on postgres', () => {
            expect(compose).toContain('depends_on:');
        });
    });

    describe('docker-compose.prod.yml', () => {
        const compose = readRaw('docker-compose.prod.yml');

        test('has pgbouncer service', () => {
            expect(compose).toContain('pgbouncer:');
        });

        test('app depends on pgbouncer (not db directly)', () => {
            const appSection = compose.split('# ── Next.js App')[1] || '';
            expect(appSection).toContain('pgbouncer:');
        });

        test('DATABASE_URL points to pgbouncer', () => {
            expect(compose).toContain('@pgbouncer:');
        });

        test('DATABASE_URL includes pgbouncer=true param', () => {
            expect(compose).toContain('pgbouncer=true');
        });

        test('DIRECT_DATABASE_URL points to db (not pgbouncer)', () => {
            expect(compose).toContain('DIRECT_DATABASE_URL');
            // Find the assignment line (not the comment), identified by the colon
            const directLine = compose.split(/\r?\n/).find(l =>
                l.trim().startsWith('DIRECT_DATABASE_URL:'));
            expect(directLine).toBeTruthy();
            expect(directLine).toContain('@db:');
        });

        test('pgbouncer has no ports exposed to host (internal only)', () => {
            // In prod, pgbouncer should not have ports mapped to the host
            // The pgbouncer service section is between '# ── PgBouncer' and '# ── Next.js'
            const pgbouncerSection = compose
                .split('# ── PgBouncer')[1]
                ?.split('# ── Next.js')[0] || '';
            expect(pgbouncerSection).not.toContain('ports:');
        });
    });

    describe('.env.example', () => {
        const envExample = readRaw('.env.example');

        test('has DATABASE_URL with PgBouncer port', () => {
            expect(envExample).toContain('DATABASE_URL');
            expect(envExample).toContain('5433');
        });

        test('DIRECT_DATABASE_URL points at the port the dev stack publishes for Postgres', () => {
            // Derived from docker-compose.yml rather than a literal, so moving
            // the port in one file and not the other fails here.
            expect(directUrlPort(envExample)).toBe(publishedPort('docker-compose.yml', 'postgres'));
        });

        test('DATABASE_URL points at the port the dev stack publishes for PgBouncer', () => {
            expect(urlPort(envExample, 'DATABASE_URL')).toBe(publishedPort('docker-compose.yml', 'pgbouncer'));
        });

        test('DATABASE_URL includes pgbouncer=true', () => {
            expect(envExample).toContain('pgbouncer=true');
        });
    });

    /**
     * The dev and test stacks both published Postgres on host port 5434, so
     * the second to start could not bind it, and test runs that defaulted to
     * 127.0.0.1:5434 reached the dev database instead (#5308). The dev stack's
     * direct port moved (owner decision 2026-11-14); the test stack stays on
     * 5434, which tests/helpers/db.ts and scripts/ci-local.mjs default to.
     */
    describe('the dev and test stacks can run side by side', () => {
        const dev = hostPorts('docker-compose.yml');
        const test_ = hostPorts('docker-compose.test.yml');

        it('reads the published ports of both files (the comparison is not vacuous)', () => {
            expect(publishedPort('docker-compose.yml', 'postgres')).toBeGreaterThan(0);
            expect(publishedPort('docker-compose.test.yml', 'postgres-test')).toBe(5434);
        });

        it('publish no host port in common', () => {
            const devPorts = new Set([...dev.values()].flat());
            const shared = [...test_.values()].flat().filter((p) => devPorts.has(p));
            expect(shared).toEqual([]);
        });

        it('the test database defaults point at the test stack, not the dev one', () => {
            const testPort = publishedPort('docker-compose.test.yml', 'postgres-test');
            expect(urlPort(readRaw('.env.test.example'), 'DATABASE_URL')).toBe(testPort);
            expect(directUrlPort(readRaw('.env.example'))).not.toBe(testPort);
        });
    });
});
