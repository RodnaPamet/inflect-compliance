/**
 * Container healthcheck for the `worker` service (#2745).
 *
 * Exits 0 if the worker has completed a job recently, 1 otherwise. Reads the
 * key `scripts/worker.ts` refreshes from BullMQ's `completed` event, so a pass
 * means the worker pulled a job off the queue, ran it and came back — not
 * merely that a process is alive.
 *
 * WHY THIS SHAPE. Docker healthchecks run a COMMAND inside the container, and
 * the worker serves no HTTP, so there is nothing to curl. This bundles to
 * `dist/worker-healthcheck.mjs` alongside `worker.mjs` and `scheduler.mjs`,
 * which is why it can `import` from `src/`: esbuild inlines it, and the runner
 * image carries no source tree.
 *
 * WHAT A FAILURE MEANS. The key is TTL'd, never deleted, so `EXISTS` falling
 * to 0 is the whole signal — four consecutive missed beats. Every cause is
 * worth waking up for: a blocked event loop, a severed Redis connection, every
 * concurrency slot held by a hung handler, or a scheduler that never
 * registered the `health-check` repeatable that drives the beat.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not enqueue anything. A probe that
 * creates work would add load proportional to how often it runs and — worse —
 * would keep passing while the worker's own consumption was dead, because it
 * would be testing Redis rather than the worker. It only READS.
 *
 * @module scripts/worker-healthcheck
 */
import Redis from 'ioredis';

import { WORKER_HEARTBEAT_KEY } from '../src/app-layer/jobs/worker-heartbeat';

const CONNECT_TIMEOUT_MS = 5_000;

async function main(): Promise<number> {
    const url = process.env.REDIS_URL;
    if (!url) {
        // Fail, do not skip. A missing REDIS_URL in the worker container is
        // itself a broken worker, and reporting healthy because the probe
        // could not run is the same silent pass this whole issue is about.
        process.stderr.write('worker-healthcheck: REDIS_URL is not set\n');
        return 1;
    }

    const redis = new Redis(url, {
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        // Do not let ioredis sit in a reconnect loop inside a healthcheck that
        // Docker will kill anyway; an unreachable Redis is a failure, fast.
        retryStrategy: () => null,
        lazyConnect: true,
    });

    try {
        await redis.connect();
        const exists = await redis.exists(WORKER_HEARTBEAT_KEY);
        if (exists === 1) return 0;
        process.stderr.write(
            `worker-healthcheck: ${WORKER_HEARTBEAT_KEY} is absent — ` +
                'the worker has not completed a job within the heartbeat TTL\n',
        );
        return 1;
    } catch (err) {
        process.stderr.write(
            `worker-healthcheck: ${err instanceof Error ? err.message : 'probe failed'}\n`,
        );
        return 1;
    } finally {
        redis.disconnect();
    }
}

main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
