/**
 * The production-like Compose stacks keep their database off the network,
 * refuse to start on a guessable password, and initialise the roles the
 * migrations need.
 *
 * Three defects this holds:
 *
 *   #5088 — the staging stack published PgBouncer on every host interface
 *   and fell back to `staging_password_change_me`, a password printed in the
 *   repository. Anybody who could reach the host could log in to the pooler.
 *
 *   #5302 — the root production and staging stacks mounted no init script.
 *   A fresh volume had no `postgres` role, the RLS-setup migration's
 *   `GRANT app_user TO postgres` failed, `prisma migrate deploy` exited and
 *   the app crash-looped with the migration recorded as failed.
 *
 * The files are the same production-like set `redis-production-auth`
 * holds. The dev and test stacks publish their ports on purpose and use
 * throwaway passwords, so they are out of scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

const PRODUCTION_LIKE_COMPOSE = [
    'docker-compose.prod.yml',
    'docker-compose.staging.yml',
    'deploy/docker-compose.prod.yml',
] as const;

interface Service {
    image?: string;
    ports?: Array<string | { host_ip?: string; published?: string | number }>;
    volumes?: Array<string | { source?: string; target?: string }>;
    environment?: Record<string, string> | string[];
}

function services(file: string): Record<string, Service> {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8')) as { services?: Record<string, Service> };
    return doc.services ?? {};
}

const isPostgres = (s: Service) => String(s.image ?? '').startsWith('postgres:');
const isDatabaseFacing = (s: Service) => isPostgres(s) || /pgbouncer/.test(String(s.image ?? ''));

/** A short-syntax port is published on all interfaces unless it names a loopback host IP. */
function publishedBeyondLoopback(port: Service['ports'] extends Array<infer P> | undefined ? P : never): boolean {
    if (typeof port === 'object' && port !== null) return !port.host_ip || !/^127\.|^::1$|^localhost$/.test(port.host_ip);
    const parts = String(port).split(':');
    // HOST_IP:HOST:CONTAINER has three parts; HOST:CONTAINER and CONTAINER do not name an IP.
    if (parts.length < 3) return parts.length > 1;
    return !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(parts[0]);
}

describe('production-like Compose stacks harden their database (#5088, #5302)', () => {
    it('reads a postgres service from every file (positive control)', () => {
        for (const file of PRODUCTION_LIKE_COMPOSE) {
            expect(Object.values(services(file)).filter(isPostgres)).toHaveLength(1);
        }
    });

    it.each(PRODUCTION_LIKE_COMPOSE)('%s publishes no database port beyond loopback', (file) => {
        const exposed = Object.entries(services(file))
            .filter(([, s]) => isDatabaseFacing(s))
            .flatMap(([name, s]) => (s.ports ?? []).filter(publishedBeyondLoopback).map((p) => `${name}: ${String(p)}`));
        expect(exposed).toEqual([]);
    });

    it.each(PRODUCTION_LIKE_COMPOSE)('%s has no default for the database password', (file) => {
        // `${POSTGRES_PASSWORD:-x}` starts the stack on `x` when the operator
        // set nothing; `:?` refuses. A bare `${POSTGRES_PASSWORD}` after a
        // `:?` use in the same file is fine: Compose aborts on the first.
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        expect(text.match(/\$\{POSTGRES_PASSWORD:-[^}]*\}/g) ?? []).toEqual([]);
        expect(text.match(/\$\{POSTGRES_PASSWORD:\?[^}]*\}/g)?.length ?? 0).toBeGreaterThan(0);
    });

    it.each(PRODUCTION_LIKE_COMPOSE)('%s mounts an init-roles script into the postgres initdb directory', (file) => {
        const [pg] = Object.values(services(file)).filter(isPostgres);
        const targets = (pg.volumes ?? []).map((v) => (typeof v === 'string' ? v : `${v.source}:${v.target}`));
        expect(targets.filter((v) => /init-roles\.sh:\/docker-entrypoint-initdb\.d\//.test(v))).toHaveLength(1);
    });
});

describe('the port classifier', () => {
    it.each([
        ['5435:5432', true],
        ['0.0.0.0:5435:5432', true],
        ['127.0.0.1:5435:5432', false],
        ['127.0.0.1:${DB_PORT:-5435}:5432', false],
        ['5432', false],
    ])('%s published beyond loopback: %s', (port, expected) => {
        expect(publishedBeyondLoopback(port)).toBe(expected);
    });
});
