import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import {
    getRunStepFeed,
    isLiveRunStatus,
    MAX_STEP_FEED_TAKE,
    type RunStepFeedRow,
} from '@/app-layer/usecases/workflow-run-steps';
import { trackRunStream, untrackRunStream } from '@/lib/agentic/open-run-streams';
import { logger } from '@/lib/observability/logger';

/**
 * GET — the LIVE TAIL of one agent run's step ledger (#3472, plan point 08).
 *
 * ## Why this polls the database instead of subscribing to a bus
 *
 * `api/notifications/stream` subscribes to an in-process bus, and its own
 * docblock states the limit: "events published on one Node process don't fan
 * out to subscribers on another". That limit is fatal here rather than
 * tolerable. A Flue run executes in the BullMQ WORKER (`agent-run-execute`),
 * and this stream is served by the WEB tier — so a bus in the web process
 * would see exactly nothing a run ever wrote, and the stream would heartbeat
 * forever beside a run that was producing steps the whole time.
 *
 * Polling the ledger is not a concession; it is exact. `WorkflowStep` is
 * append-only, ordered, and indexed `[runId, seq]`, so a cursor read
 * (`seq > last`) cannot miss a step and cannot re-send one: no row can be
 * inserted behind the cursor. Each tick is one indexed range query bounded by
 * `take`, which is strictly less work than the 3-second whole-table poll the
 * automation overlay already runs in production.
 *
 * Redis pub/sub would remove the latency floor, and it is deliberately not
 * taken yet: it would mean the worker publishing on every step write, a second
 * delivery path to keep consistent with the ledger, and a new failure mode
 * (published-but-not-committed) on the one surface whose whole value is that
 * it reflects the ledger exactly.
 *
 * ## What bounds it
 *
 * Three things, because one is not enough:
 *
 *   1. `take` per tick — the usecase clamps it. A run with a thousand steps
 *      delivers them over several ticks rather than one 1000-row response.
 *   2. The run's own status — once it is terminal, the tail sends `end` and
 *      closes. A completed run is replay, and replay is the paged route's job.
 *   3. A wall-clock cap. A PAUSED run waiting on a human can sit for days, and
 *      a connection held that long is a file descriptor and a database poll
 *      spent on a tab somebody left open. On expiry the stream sends
 *      `end` with `reason: "timeout"` and closes; `EventSource` reconnects on
 *      its own and the client's cursor resumes exactly where it stopped.
 *
 * ## Authorization
 *
 * `requirePermission('admin.view')` — the gate the run detail PAGE applies
 * (`ctx.appPermissions.admin.view`), spelled as the middleware so a denial
 * writes the hash-chained `AUTHZ_DENIED` row that a usecase-level
 * `assertCanRead` would not. Tenant scope is the usecase's: every read runs
 * through `runInTenantContext` with `tenantId` in the predicate, so a run in
 * another tenant is `notFound`, not `forbidden` — the same anti-enumeration
 * shape the rest of the surface uses.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
/** 15 minutes. Long enough for any run the shipped definitions produce. */
const MAX_STREAM_MS = 15 * 60_000;

const encoder = new TextEncoder();

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET = requirePermission<{ tenantSlug: string; id: string }>(
    'admin.view',
    async (req: NextRequest, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const runId = params.id;

        // A `?sinceSeq=` the client already holds, so a reconnect resumes
        // rather than replaying. Exclusive, and -1 means "from the first step".
        const raw = req.nextUrl.searchParams.get('sinceSeq');
        const parsed = raw === null || raw.trim() === '' ? NaN : Number(raw);
        let cursor = Number.isFinite(parsed) ? parsed : -1;

        // THE FIRST READ HAPPENS BEFORE THE STREAM OPENS, so an unreadable run
        // is an ordinary 404 rather than a 200 that immediately ends. A client
        // cannot distinguish "no such run" from "a run with no steps yet" once
        // the headers have been sent.
        const first = await getRunStepFeed(ctx, runId, { sinceSeq: cursor });

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                let closed = false;
                let poll: ReturnType<typeof setInterval> | undefined;
                let heartbeat: ReturnType<typeof setInterval> | undefined;
                let deadline: ReturnType<typeof setTimeout> | undefined;

                const safeEnqueue = (chunk: string) => {
                    if (closed) return;
                    try {
                        controller.enqueue(encoder.encode(chunk));
                    } catch {
                        // Torn down mid-flush (the client went away). Drop it.
                        closed = true;
                    }
                };

                const cleanup = () => {
                    if (closed) return;
                    closed = true;
                    if (poll) clearInterval(poll);
                    if (heartbeat) clearInterval(heartbeat);
                    if (deadline) clearTimeout(deadline);
                    untrackRunStream(cleanup);
                    try {
                        controller.close();
                    } catch {
                        // Already closed upstream — fine.
                    }
                };

                const end = (reason: string) => {
                    safeEnqueue(sse('end', { runId, reason, cursor }));
                    cleanup();
                };

                const emit = (steps: readonly RunStepFeedRow[]) => {
                    // One event PER STEP rather than one per batch. A canvas
                    // highlights the active node as each step lands, and a
                    // batched event would make a run that produced four steps
                    // between ticks skip three nodes.
                    for (const step of steps) safeEnqueue(sse('step', step));
                };

                // SIGTERM closes this deliberately instead of letting the
                // platform tear the socket down at an arbitrary moment.
                trackRunStream(cleanup);

                safeEnqueue(': connected\n\n');
                // The snapshot already read above — never re-queried, so the
                // first paint costs one round trip rather than two.
                safeEnqueue(sse('open', {
                    runId: first.runId,
                    status: first.status,
                    stepCount: first.stepCount,
                    live: first.live,
                }));
                emit(first.steps);
                cursor = first.cursor;

                if (!first.live && !first.hasMore) {
                    end('complete');
                    return;
                }

                poll = setInterval(() => {
                    if (closed) return;
                    void (async () => {
                        try {
                            const next = await getRunStepFeed(ctx, runId, {
                                sinceSeq: cursor,
                                take: MAX_STEP_FEED_TAKE,
                            });
                            emit(next.steps);
                            cursor = next.cursor;
                            // Drained AND terminal — both, in that order. A run
                            // that completed between two ticks still has its
                            // last steps to deliver, and closing on status
                            // alone would lose exactly the steps that say how
                            // it finished.
                            if (!next.hasMore && !isLiveRunStatus(next.status)) {
                                end('complete');
                            }
                        } catch (err) {
                            // The run became unreadable mid-stream (deleted, or
                            // a transient database error). Say so and close
                            // rather than looping on a failing query.
                            logger.warn('run-stream: poll failed, closing', {
                                component: 'agentic',
                                tenantId: ctx.tenantId,
                                runId,
                                error: err instanceof Error ? err.message : String(err),
                            });
                            end('error');
                        }
                    })();
                }, POLL_INTERVAL_MS);

                heartbeat = setInterval(() => {
                    safeEnqueue(': hb\n\n');
                }, HEARTBEAT_INTERVAL_MS);

                deadline = setTimeout(() => { end('timeout'); }, MAX_STREAM_MS);

                // The client closed the tab, navigated away, or lost the
                // network: Next surfaces the TCP FIN as an abort.
                req.signal.addEventListener('abort', cleanup);
            },
        });

        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                // Without these, nginx / Cloud Run buffer SSE bytes and the
                // client sees nothing until the buffer fills.
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
                Connection: 'keep-alive',
            },
        });
    },
);
