import { instrument, type FlueExecutionOperation } from '@flue/runtime';

import { getTracer } from '@/lib/observability/tracing';

/**
 * FLUE SPANS ON THE EXISTING PIPELINE — and nothing else on it.
 *
 * ── ESM-ONLY. REACHED BY DYNAMIC IMPORT ONLY ────────────────────────────────
 *
 * Value-imports `@flue/runtime`. See `providers.ts` for the boundary rule and
 * `tests/guards/flue-esm-modules-stay-off-the-static-graph.test.ts` for what
 * enforces it.
 *
 * ── NO SECOND EXPORTER ──────────────────────────────────────────────────────
 *
 * The plan is explicit: Flue telemetry goes "into the EXISTING pipeline; no
 * second exporter". So this installs no SDK, registers no processor and owns
 * no transport. It takes `getTracer` — the same tracer every usecase and job
 * already writes to — and emits spans through it, which is what makes a Flue
 * run appear in the same trace as the HTTP request or job that started it
 * rather than in a parallel universe with its own sampling and its own
 * credentials.
 *
 * ── THE OBSERVATION STREAM IS A CONTENT FIREHOSE, AND IS NOT FORWARDED ──────
 *
 * `FlueObservationDetail` carries `agentInput`, `agentOutput` (with its
 * `text`), `args` and `effectiveResult`: the model's prompt, the model's
 * answer, and every tool's arguments and results. `@flue/runtime/telemetry`
 * ships helpers — `inputMessages`, `outputMessages`, `contentAttribute` —
 * whose whole purpose is to put that on spans, and adopting them is the
 * obvious reading of "wire up the telemetry".
 *
 * It is the wrong one here. Spans leave this system: they go to a tracing
 * backend with its own retention, its own access control and no tenant
 * isolation of ours. Putting tenant evidence and model output there would
 * defeat `no-raw-prompt-logging`, which exists to keep exactly this content
 * out of the one destination that is plaintext, exportable and outside the
 * encrypted-field manifest — and it would do it through a channel nobody
 * reviews, because a span is not a log line anyone greps.
 *
 * So `observe` is deliberately empty. The INTERCEPTOR is where the value is:
 * it sees the operation's SHAPE — an agent turn, a model call, a tool by name
 * — which is what an operator debugging a slow or looping run actually needs,
 * and it carries no content by construction.
 */

/** Span name per operation kind, aligned with GenAI semantic conventions. */
function spanNameFor(op: FlueExecutionOperation): string {
    switch (op.type) {
        case 'agent':
            return 'invoke_agent';
        case 'model':
            return 'chat';
        case 'tool':
            return 'execute_tool';
        case 'task':
            return 'flue.task';
        case 'coordinator':
            return 'flue.coordinator';
    }
}

/**
 * Attributes for one operation — IDENTIFIERS AND NAMES ONLY.
 *
 * Every value here is a ULID, a tool name from our own catalogue, or a member
 * of a closed union. None is derived from model output or tenant data. A field
 * added to `FlueExecutionOperation` upstream does NOT appear here by default:
 * this switch names what it forwards, so a new one is a deliberate decision
 * rather than an inherited leak.
 */
function attributesFor(op: FlueExecutionOperation): Record<string, string> {
    switch (op.type) {
        case 'agent':
            return {
                'flue.operation': op.type,
                'flue.operation_id': op.operationId,
                'flue.operation_kind': op.operationKind,
            };
        case 'model':
            return { 'flue.operation': op.type, 'flue.turn_id': op.turnId };
        case 'tool':
            return {
                'flue.operation': op.type,
                'flue.tool': op.toolName,
                'flue.tool_call_id': op.toolCallId,
            };
        case 'task':
            return { 'flue.operation': op.type, 'flue.task_id': op.taskId };
        case 'coordinator':
            return { 'flue.operation': op.type, 'flue.phase': op.phase };
    }
}

/**
 * Install the instrumentation. Returns the disposer `instrument` hands back.
 *
 * Called once per process, beside `start()`. `instrument` throws
 * `InstrumentationAlreadyInstalledError` on a second install, which is why the
 * caller memoises the boot rather than installing per run.
 */
export function installFlueTelemetry(): () => Promise<void> {
    const tracer = getTracer('inflect.agentic.flue');

    return instrument({
        // NOTHING. See the header: this stream carries prompts, model output,
        // tool arguments and tool results, and a span is not a place any of
        // that may go. Empty rather than absent because the interface requires
        // a subscriber, and an empty one that says why is better than a
        // forwarding one nobody re-reads.
        observe: () => {},

        interceptor: async (operation, _ctx, next) =>
            tracer.startActiveSpan(
                spanNameFor(operation),
                { attributes: attributesFor(operation) },
                async (span) => {
                    try {
                        return await next();
                    } catch (err) {
                        // The TYPE and message of the failure, which is ours or
                        // the runtime's — never the model's answer. `recordException`
                        // is deliberately not used: it attaches a stack, and a
                        // stack from a tool can quote the arguments it was called
                        // with.
                        span.setAttribute('error', true);
                        span.setAttribute(
                            'flue.error_kind',
                            err instanceof Error ? err.name : 'unknown',
                        );
                        throw err;
                    } finally {
                        span.end();
                    }
                },
            ),

        dispose: () => {},
    });
}
