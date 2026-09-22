/**
 * The worker heartbeat is FOUR links, and any one of them silently disables it.
 *
 * #2745: production was down ~25h and nothing alerted. The uptime check covers
 * "a container that will not stay up". This covers the other shape — "up but
 * doing nothing" — and it is worth more than the uptime check precisely
 * because a wedged worker leaves every other signal green.
 *
 * The failure mode this guards against is not a broken heartbeat; it is a
 * heartbeat that has quietly stopped being wired, while the container keeps
 * reporting healthy. Each link below fails OPEN in exactly that way:
 *
 *   1. the `health-check` repeatable — remove it and an idle worker never
 *      completes anything, so the key expires and the container flaps
 *   2. `worker.on('completed')` → `beat()` — remove it and the key is never
 *      written at all
 *   3. `dist/worker-healthcheck.mjs` in the esbuild entrypoints — remove it
 *      and the compose probe runs a file that does not exist
 *   4. the compose `healthcheck:` block — remove it and nothing ever asks
 *
 * EVERY SCAN IS MASKED with `codeOf`. This file's own prose names
 * `setInterval` — the thing the beat must NOT be — and several docblocks in
 * the modules under test discuss it at length. An unmasked scan would be
 * satisfied, or defeated, by a comment.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Every read below names its file as a STRING LITERAL at the call site, rather
 * than going through a `read(rel)` helper.
 *
 * That is not style. `tests/helpers/assertion-reach.ts` resolves a whole-file
 * assertion's subject by constant-folding the path; a path that arrives as a
 * function parameter is `path-not-constant` and the assertion becomes a blind
 * spot the Class D ratchet counts. Writing the helper the obvious way put six
 * new un-analysable reads into a population this repo deliberately bounds.
 */

describe('worker heartbeat — the four links', () => {
    it('1. `health-check` is a repeatable in SCHEDULED_JOBS', () => {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'src/app-layer/jobs/schedules.ts'), 'utf-8'));
        expect(src).toMatch(/name:\s*'health-check'/);
    });

    it('2. the beat hangs off the BullMQ `completed` event, NOT a timer', () => {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'scripts/worker.ts'), 'utf-8'));
        expect(src).toMatch(/worker\.on\(\s*'completed'/);
        expect(src).toMatch(/\bbeat\s*\(/);
        // The whole point. A timer keeps firing through a severed Redis
        // connection and reports a wedged worker as healthy — the gap this
        // exists to close, reintroduced one layer down.
        expect(src).not.toMatch(/setInterval/);
    });

    it('3. the probe is an esbuild entrypoint, so the bundled file exists', () => {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'scripts/build-worker.mjs'), 'utf-8'));
        expect(src).toMatch(/scripts\/worker-healthcheck\.ts/);
        expect(src).toMatch(/dist\/worker-healthcheck\.mjs/);
    });

    it('4a. docker-compose.prod.yml probes that exact bundled file', () => {
        const src = fs.readFileSync(path.join(ROOT, 'docker-compose.prod.yml'), 'utf-8');
        expect(src).toMatch(/dist\/worker-healthcheck\.mjs/);
    });

    it('4b. deploy/docker-compose.prod.yml probes that exact bundled file', () => {
        const src = fs.readFileSync(path.join(ROOT, 'deploy/docker-compose.prod.yml'), 'utf-8');
        expect(src).toMatch(/dist\/worker-healthcheck\.mjs/);
    });
});

describe('worker heartbeat — the TTL cannot flap a healthy container', () => {
    /** Minutes from the `*​/N * * * *` cron on the health-check schedule. */
    function healthCheckCronMinutes(): number {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'src/app-layer/jobs/schedules.ts'), 'utf-8'));
        const block = src.slice(src.indexOf("name: 'health-check'"));
        const m = block.match(/pattern:\s*'\*\/(\d+) \* \* \* \*'/);
        if (!m) throw new Error('no */N cron found on the health-check schedule');
        return Number(m[1]);
    }

    function ttlSeconds(): number {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'src/app-layer/jobs/worker-heartbeat.ts'), 'utf-8'));
        const m = src.match(/WORKER_HEARTBEAT_TTL_SECONDS\s*=\s*(\d+)\s*\*\s*(\d+)/);
        if (!m) throw new Error('no TTL expression found');
        return Number(m[1]) * Number(m[2]);
    }

    it('tolerates at least three missed beats', () => {
        const cronSeconds = healthCheckCronMinutes() * 60;
        // Equal values expire the key BETWEEN beats and flap a healthy
        // container. A healthcheck that reports failure on a healthy system
        // trains people to ignore it, which is worse than not having one.
        expect(ttlSeconds()).toBeGreaterThanOrEqual(cronSeconds * 3);
    });
});

describe('worker heartbeat — the probe only READS', () => {
    it('never enqueues, and never writes the key it reads', () => {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'scripts/worker-healthcheck.ts'), 'utf-8'));
        // A probe that enqueued its own job would add load proportional to its
        // interval AND would keep passing while the worker's own consumption
        // was dead — it would be testing Redis, not the worker.
        expect(src).not.toMatch(/\.add\(/);
        expect(src).not.toMatch(/new Queue\b/);
        expect(src).not.toMatch(/redis\.set\(/);
        expect(src).toMatch(/\.exists\(/);
    });

    it('a missing REDIS_URL fails rather than passing', () => {
        const src = codeOf(fs.readFileSync(path.join(ROOT, 'scripts/worker-healthcheck.ts'), 'utf-8'));
        const block = src.slice(src.indexOf('REDIS_URL'));
        // Reporting healthy because the probe could not run is the same silent
        // pass the whole issue is about.
        expect(block).toMatch(/return 1/);
    });
});
