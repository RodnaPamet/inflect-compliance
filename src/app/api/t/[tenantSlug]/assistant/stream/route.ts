/**
 * The assistant's streaming surface (#3809).
 *
 * BESIDE `/assistant/ask`, not instead of it. That route returns a finished
 * answer and has callers depending on that contract, so it is untouched.
 *
 * ═══ NODE RUNTIME, NOT EDGE ═══
 *
 * `notifications/stream/route.ts` solved this once and states why: "Edge
 * Functions terminate after ~15s of idle connection time on most providers."
 * An assistant turn routinely exceeds that while a tool call is in flight, so
 * Edge would cut the connection mid-answer.
 *
 * The transport shape below is that route's, deliberately: the `closed` flag
 * and `safeEnqueue` (a client disconnecting MID-FLUSH throws on `enqueue`), the
 * initial comment because "EventSource doesn't fire `onopen` for some browsers
 * until at least one byte has been received", the heartbeat, the idempotent
 * cleanup, and `X-Accel-Buffering: no` — without which "nginx / Cloud Run
 * buffer SSE bytes and the client doesn't see them until the buffer fills".
 *
 * ═══ WHAT IS DELIBERATELY *NOT* COPIED FROM IT ═══
 *
 * That route authenticates with `getLegacyCtx` and leans on middleware for the
 * 401 surface. This one uses `requirePermission`, which ENFORCES and writes the
 * `AUTHZ_DENIED` audit row on denial — its own contract says so. The two
 * concerns live in the same 128 lines there, and only the transport half is the
 * reference.
 *
 * Gated on `controls.view`, matching `/assistant/ask` exactly. Match or
 * tighten, never loosen: a streaming surface easier to reach than the POST it
 * mirrors would be a privilege escalation introduced by a transport change.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { AskAssistantSchema, streamAssistant } from '@/app-layer/usecases/assistant';
import { parseJsonBody } from '@/lib/validation/route';
import { sseComment, sseData, type AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';
import { acquireStreamSlot } from '@/app-layer/ai/assistant/stream-capacity';

// Same two declarations the notifications stream carries, for the same reasons.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Matches the notifications stream, which is tuned against the same proxies. */
const HEARTBEAT_INTERVAL_MS = 25_000;

const encoder = new TextEncoder();

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('controls.view', async (req, _a, ctx) => {
        const body = await parseJsonBody(req as NextRequest, AskAssistantSchema);

        // CAPACITY BEFORE ANY WORK. A refusal must not first spend a model call,
        // and it must name the binding term — one tenant being noisy and the
        // process being full need different operator actions.
        // The cut callback is registered WITH the lease, so the set of open
        // streams and the set of cuttable streams are one population — see
        // `stream-capacity.ts`. It is filled in once the stream exists, because
        // the slot has to be taken before any work (including building the
        // stream) so a refusal costs nothing.
        const cut: { fire?: (reason: string) => void } = {};
        const lease = acquireStreamSlot(ctx.tenantId, (reason) => cut.fire?.(reason));
        if (lease === 'TENANT_AT_CAPACITY' || lease === 'PROCESS_AT_CAPACITY') {
            const reason =
                lease === 'TENANT_AT_CAPACITY'
                    ? 'Too many assistant conversations are open for your organisation right now. Close one and try again.'
                    : 'The assistant is at capacity on this server right now. Try again shortly.';
            // 429 with a BODY the client can render, rather than an empty
            // stream: the whole point of #3826 is that a refusal must never
            // look like a hang, and that applies to being refused the stream
            // itself just as much as to a guard verdict inside one.
            return new Response(JSON.stringify({ error: reason, reason: lease }), {
                status: 429,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                let closed = false;

                const safeEnqueue = (chunk: string): void => {
                    if (closed) return;
                    try {
                        controller.enqueue(encoder.encode(chunk));
                    } catch {
                        // Torn down mid-flush — the client went away between the
                        // check and the write. Drop the chunk; cleanup follows.
                        closed = true;
                    }
                };

                const emit = (event: AssistantStreamEvent): void => safeEnqueue(sseData(event));

                // One byte up front so the client's `onopen` fires.
                safeEnqueue(sseComment('connected'));

                const heartbeat = setInterval(() => safeEnqueue(sseComment('hb')), HEARTBEAT_INTERVAL_MS);
                // UNREF'd, and this is not test hygiene — it is the same
                // concern as shutdown stage 3b. A heartbeat exists to keep a
                // CONNECTION warm; it must never be the reason the PROCESS
                // stays alive. Without this, an open stream holds the event
                // loop for up to HEARTBEAT_INTERVAL_MS past the point where
                // everything else has finished, which is exactly the delay
                // that stage's "cut the streams" step is there to avoid.
                //
                // Found the hard way: CI shard 4/6 passed all 5305 tests and
                // then sat for 21 minutes until the job timed out, with
                // "Jest did not exit one second after the test run has
                // completed" as the only clue.
                heartbeat.unref?.();

                // ONE abort controller for the turn, so a client disconnect
                // reaches the provider's `fetch` (#3825). Without this an
                // abandoned tab keeps generating tokens the tenant pays for.
                const abort = new AbortController();

                const cleanup = (): void => {
                    if (closed) return;
                    closed = true;
                    clearInterval(heartbeat);
                    lease.release();
                    try {
                        controller.close();
                    } catch {
                        // Already closed upstream — fine.
                    }
                };

                // SIGTERM reaches here (#3827). The user gets a reason rather
                // than a dead socket, and the upstream call is aborted so the
                // tenant stops paying for tokens nobody will read.
                cut.fire = (reason: string) => {
                    emit({ type: 'refusal', reason });
                    emit({ type: 'done', truncatedAny: false });
                    abort.abort();
                    cleanup();
                };

                // The browser's TCP FIN surfaces here as `abort` on the request
                // signal. Aborting the upstream call FIRST, then tearing down.
                req.signal.addEventListener('abort', () => {
                    abort.abort();
                    cleanup();
                });

                void streamAssistant(ctx, body, { emit, signal: abort.signal })
                    .catch(() => {
                        // `streamAssistant` already emits a refusal or halt for
                        // every outcome a user should see. Reaching here means
                        // something unexpected threw, and the honest end is a
                        // refusal rather than a silent close — an empty stream
                        // is indistinguishable from a crash.
                        emit({
                            type: 'refusal',
                            reason: 'The assistant could not complete this turn. Nothing was created.',
                        });
                        // `done` AFTER the refusal, so there is exactly ONE
                        // terminal signal whichever path ends the turn. Without
                        // it a client cannot tell "finished" from "connection
                        // still open, nothing more coming yet" — which is the
                        // reason `done` exists at all, and `streamAssistant`
                        // already emits it on its own refusal path. A test
                        // caught this route's catch being the one exception.
                        emit({ type: 'done', truncatedAny: false });
                    })
                    .finally(cleanup);
            },
            cancel() {
                // The consumer let go without an abort on the request signal.
                // The lease still has to come back or capacity leaks upward.
                lease.release();
            },
        });

        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                // Without this, nginx / Cloud Run buffer SSE bytes until the
                // buffer fills and the client sees nothing meanwhile.
                'X-Accel-Buffering': 'no',
                Connection: 'keep-alive',
            },
        });
    }),
);
