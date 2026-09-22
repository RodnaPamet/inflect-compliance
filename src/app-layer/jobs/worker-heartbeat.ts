/**
 * The worker's proof that it is CONSUMING, not merely running.
 *
 * ## Why this exists (#2745)
 *
 * On 2026-09-20 production was down ~25 hours and nothing alerted. The uptime
 * check added since (`infra/alerts/external-uptime.yml`) closes one half of
 * that: a container that will not stay up, or a dependency that is down, takes
 * `/api/readyz` to 503 and pages within ~2 minutes.
 *
 * It does not close the other half. `readyz` reports the APP tier's view of
 * redis, not whether the BullMQ worker is consuming. A wedged worker — event
 * loop blocked, Redis connection dropped without the client noticing, every
 * concurrency slot held by a hung handler — keeps its container `running` and
 * the web tier green throughout. Healthy and broken produce the same
 * observable, which is the exact shape #2745 calls "a system that is up but
 * doing nothing".
 *
 * `docker-compose.prod.yml` makes that concrete: `postgres`, `pgbouncer`,
 * `redis` and `clamav` all carry a `healthcheck:`. `app` and `worker` carry
 * none — and they are the two that crash-looped.
 *
 * ## Why it is written from a BullMQ event, not a timer
 *
 * A `setInterval` that stamps a timestamp keeps ticking through a severed
 * Redis connection, so it proves nothing about consumption — it would
 * reintroduce the very gap this module exists to close, one layer down.
 *
 * This is written from the worker's `completed` event instead, so the key is
 * refreshed only when the worker has actually pulled a job off the queue, run
 * it, and come back. Reaching `beat()` IS that whole chain: Redis reachable,
 * event loop responsive, a concurrency slot free, the executor registry
 * loadable. None of it is inferred.
 *
 * ## Why an idle worker still beats
 *
 * Events need jobs. `health-check` was registered in `executor-registry.ts`
 * and **nothing had ever dispatched it** — it returned 'pong' to nobody. It is
 * now a 2-minute repeatable in `schedules.ts`, so the `completed` event fires
 * on an otherwise quiet queue.
 *
 * That also means a green healthcheck proves the SCHEDULER's repeatables are
 * still registered: `scheduler.mjs` runs before `worker.mjs` in the same
 * command, so if the scheduler never ran, no health-check job is enqueued,
 * nothing completes, and the key goes stale on its own.
 *
 * ## The TTL is the mechanism
 *
 * Nothing deletes this key — it expires. A worker that stops completing jobs
 * stops refreshing it and `EXISTS` falls to 0 by itself. There is no cleanup
 * path that can be forgotten, and no state to reconcile.
 *
 * @module jobs/worker-heartbeat
 */
import type Redis from 'ioredis';

/**
 * Namespaced to this product. The Redis instance is inflect's own, but the key
 * is explicit rather than bare so a shared instance later cannot silently
 * collide with another product's heartbeat and report a healthy worker that
 * belongs to something else.
 */
export const WORKER_HEARTBEAT_KEY = 'inflect:worker:heartbeat';

/**
 * Seconds the key survives without a refresh.
 *
 * `health-check` runs every 2 minutes, so this tolerates FOUR consecutive
 * missed beats before the key disappears. Sized for the MISS, not the
 * interval: a TTL equal to the cron would expire the key between beats and
 * flap a perfectly healthy container, and a healthcheck that reports failure
 * on a healthy system trains people to ignore it — which is strictly worse
 * than having none.
 *
 * The margin is asserted, not merely chosen: the guard parses the cron out of
 * `schedules.ts` and requires `ttl >= cron * 3`, so shortening the TTL or
 * slowing the cron without re-deciding this reddens a test.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 8 * 60;

/**
 * Refresh the heartbeat. Never throws.
 *
 * A heartbeat write that breaks job completion would be a worse defect than
 * the one it reports: by the time this runs the job has already succeeded, and
 * losing that outcome to a monitoring write is not a trade worth making. A
 * failed write costs one missed beat, and four are needed before anything
 * reports unhealthy.
 */
export async function beat(
    connection: Redis,
    now: () => number = Date.now,
): Promise<void> {
    try {
        await connection.set(
            WORKER_HEARTBEAT_KEY,
            String(now()),
            'EX',
            WORKER_HEARTBEAT_TTL_SECONDS,
        );
    } catch {
        // Deliberately swallowed — see the docblock above.
    }
}
