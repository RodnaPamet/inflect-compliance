/**
 * Structural ratchet — Redis production-authentication hardening.
 *
 * REGRESSION CLASS
 * ----------------
 * The production-like Docker Compose files originally ran Redis with
 * NO authentication:
 *
 *     redis-server --appendonly yes --maxmemory … --maxmemory-policy …
 *
 * and the app connected with `REDIS_URL: redis://redis:6379` — no
 * password anywhere. Redis stays internal-only today (no host port
 * publishing), but a future networking change, a misconfigured
 * overlay network, or a debugging port-publish would expose an open
 * Redis to anyone who can reach the port: sessions, rate-limit
 * counters, and the BullMQ job queue all live there.
 *
 * The fix landed in coordinated surfaces:
 *
 *   1. Each production-like compose `redis` service now runs
 *      `redis-server --requirepass "${REDIS_PASSWORD:?…}"` — the :?
 *      fail-fast syntax aborts `docker compose up` if REDIS_PASSWORD
 *      is unset (same convention as DATA_ENCRYPTION_KEY / GAP-03).
 *   2. The app `REDIS_URL` carries the password
 *      (`redis://:${REDIS_PASSWORD}@redis:6379`).
 *   3. `src/env.ts` rejects an unauthenticated `REDIS_URL` under
 *      NODE_ENV=production — the URL must parse and carry a non-empty
 *      password.
 *
 * A "simplify the compose files" PR could quietly drop `--requirepass`
 * or revert `REDIS_URL` to the bare form; a "simplify env validation"
 * PR could drop the password check. This guardrail fails CI before
 * either regression can land.
 *
 * EXEMPTION
 * ---------
 * `docker-compose.test.yml` is intentionally exempt — the test Redis
 * is ephemeral (`--appendonly no --save ""`), bound to the local CI
 * runner only, and contains no production data. Requiring a password
 * there would only add ceremony to the test stack. It is listed as a
 * documented exemption below.
 *
 * The functional behaviour is covered separately by
 * `tests/unit/env.test.ts` ("Redis production-auth rule").
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

import { codeOf } from '../helpers/source-blocks';

// #2246 Class A — the mask goes at the READ SEAM, and WHICH masker depends on
// the language. `readRepoFile` stays RAW because six of its seven callers read
// docker-compose YAML, and `codeOf` is a TypeScript lexer: it read the `//` in
// `REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379` as the start of a comment
// and blanked the rest of the line, leaving `REDIS_URL: redis:` — turning a
// password-presence guard GREEN-to-RED on a file that was fine. In YAML that
// URL is a bare scalar, not a quoted string, so nothing told the lexer to keep
// it. The ONE TypeScript caller uses `readRepoSrc`, which masks.
function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}
function readRepoSrc(rel: string): string {
    return codeOf(readRepoFile(rel));
}

/**
 * Extract the lines belonging to a top-level service block from a
 * docker-compose file. Returns the slice from the `  <service>:`
 * line up to (but not including) the next sibling service or
 * top-level key at the same indentation. The production-like compose
 * files name the service `redis`; the test compose names it
 * `redis-test`.
 */
function extractServiceBlock(src: string, service: string): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex(
        (l) => new RegExp(`^ {2}${service}:\\s*$`).test(l),
    );
    if (startIdx === -1) return '';
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        // Next sibling service (2-space indent + key) or a top-level
        // key (0-indent) ends the block. Blank/comment lines are skipped.
        if (/^ {2}\S/.test(line) || /^\S/.test(line)) {
            endIdx = i;
            break;
        }
    }
    return lines.slice(startIdx, endIdx).join('\n');
}

const PRODUCTION_LIKE_COMPOSE = [
    'docker-compose.prod.yml',
    'docker-compose.staging.yml',
    'deploy/docker-compose.prod.yml',
];

// Documented exemption — test Redis stays unauthenticated by design.
// The test compose names the service `redis-test` (not `redis`).
const EXEMPT_COMPOSE: ReadonlyArray<{ file: string; service: string }> = [
    { file: 'docker-compose.test.yml', service: 'redis-test' },
];

describe('Redis production-auth ratchet — compose files require --requirepass', () => {
    it.each(PRODUCTION_LIKE_COMPOSE)(
        '%s — redis service requires a password via --requirepass + ${REDIS_PASSWORD:?…}',
        (file) => {
            const block = extractServiceBlock(readRepoFile(file), 'redis');
            expect(block).not.toBe('');
            // Regression: dropping --requirepass would re-open Redis.
            expect(block).toMatch(/--requirepass/);
            // The password MUST come from REDIS_PASSWORD with the :?
            // fail-fast suffix — a `:-` default or a hard-coded literal
            // would silently weaken the gate.
            expect(block).toMatch(/\$\{REDIS_PASSWORD:\?/);
        },
    );

    it.each(PRODUCTION_LIKE_COMPOSE)(
        '%s — redis healthcheck can authenticate via REDISCLI_AUTH',
        (file) => {
            const block = extractServiceBlock(readRepoFile(file), 'redis');
            // redis-cli reads REDISCLI_AUTH automatically; without it
            // the existing `redis-cli ping` healthcheck would fail
            // (NOAUTH) once --requirepass is set.
            expect(block).toMatch(/REDISCLI_AUTH:\s*\$\{REDIS_PASSWORD\}/);
        },
    );
});

describe('Redis production-auth ratchet — app REDIS_URL carries the password', () => {
    it.each(PRODUCTION_LIKE_COMPOSE)(
        '%s — does not set an unauthenticated REDIS_URL: redis://redis:6379',
        (file) => {
            const src = readRepoFile(file);
            // Regression: reverting REDIS_URL to the bare host:port form
            // would leave the app connecting unauthenticated even while
            // Redis itself requires a password (NOAUTH at runtime), or
            // — worse — pair with a no-password Redis again.
            expect(src).not.toMatch(/REDIS_URL:\s*redis:\/\/redis:6379/);
        },
    );

    it.each(PRODUCTION_LIKE_COMPOSE)(
        '%s — any inline REDIS_URL carries ${REDIS_PASSWORD}',
        (file) => {
            const src = readRepoFile(file);
            // deploy/docker-compose.prod.yml composes REDIS_URL in the
            // bootstrap script (env_file), so it may have no inline
            // REDIS_URL line — that is acceptable. But if an inline
            // REDIS_URL is present it MUST carry the password.
            const inlineUrls = src.match(/^\s*REDIS_URL:\s*\S+/gm) ?? [];
            for (const line of inlineUrls) {
                expect(line).toMatch(/\$\{REDIS_PASSWORD\}/);
            }
        },
    );
});

describe('Redis production-auth ratchet — test compose is exempt', () => {
    it.each(EXEMPT_COMPOSE)(
        '$file — test redis is intentionally unauthenticated (documented exemption)',
        ({ file, service }) => {
            const block = extractServiceBlock(readRepoFile(file), service);
            // This assertion documents the exemption: the test Redis
            // is ephemeral and CI-local. If a future change DOES add
            // auth here, update this guard rather than silently
            // diverging — the exemption is deliberate, not an oversight.
            expect(block).not.toBe('');
            expect(block).not.toMatch(/--requirepass/);
        },
    );
});

describe('Redis production-auth ratchet — env schema enforces an authenticated URL', () => {
    it('src/env.ts rejects an unauthenticated REDIS_URL in production', () => {
        const src = readRepoSrc('src/env.ts');
        // Regression: a "simplify env validation" PR that drops the
        // password check would let a bare redis://host:6379 boot in
        // production again.
        expect(src).toMatch(/REDIS_URL/);
        expect(src).toMatch(/url\.password/);
        // The check must be tied to Redis + production — a generic
        // password check elsewhere would not satisfy the intent.
        expect(src).toMatch(/AUTHENTICATED in production/);
    });
});
