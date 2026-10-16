import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { trace } from '@opentelemetry/api';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun } from '@/lib/agentic/flue/run-binding';
import { installFlueTelemetry } from '@/lib/agentic/flue/telemetry';
import {
    releaseDelegationCounts,
    _resetDelegationCounts,
} from '@/lib/agentic/flue/delegation-gate';

/**
 * THE PRODUCTION INTERCEPTOR, EXECUTED (#3617).
 *
 * ── THE GAP THIS CLOSES, AND WHY IT WAS INVISIBLE ───────────────────────────
 *
 * `src/lib/agentic/flue/telemetry.ts` had **zero execution coverage** across the
 * entire CI suite — all six shards, measured on run 38794086501. It is the
 * single seam every tool call and model call passes through: the span, the run
 * binding read, the delegation gate before `next()`, and the answer guard after
 * it. `instrument()` throws on a second install, so by design everything that
 * needs the seam composes there.
 *
 * Two test files pointed at it and neither ran it:
 *
 *   • `tests/flue/delegation-is-capped.test.ts` calls `instrument()` itself,
 *     SEVEN times, reproducing the composition rather than importing it. Its own
 *     header says so, and says the guard below is "the other half ... none of
 *     which this file can see".
 *   • `tests/guards/flue-telemetry-carries-no-content.test.ts` reads the module
 *     as SOURCE TEXT and asserts about the call order. A source assertion
 *     produces no coverage and cannot catch a hook that is wired to the wrong
 *     field.
 *
 * That combination has already failed once: blanking `binding?.onDelegationComplete`
 * left 35 flue assertions green, and the response was to add another source
 * assertion to the guard — which left the execution gap exactly where it was.
 *
 * ── SO THIS FILE IMPORTS `installFlueTelemetry` AND SUPPLIES NOTHING ────────
 *
 * The interceptor is the real one. The assertions are on its EFFECTS — which
 * hooks fired, with what, and in what order — read from the binding's callbacks
 * and from an in-memory span exporter, never from a structure this file built.
 */

/** What the run binding's hooks recorded, in call order. */
interface Recorded {
    guarded: Array<{ text: string; taskId: string | undefined }>;
    completed: Array<{
        agent: string;
        taskId: string;
        answerAccepted: boolean;
        fromSeq: number | null;
    }>;
    ledgerSeqReads: number;
}

interface Outcome {
    rec: Recorded;
    spans: Array<{ name: string; attrs: Record<string, unknown>; error: boolean }>;
    replied: string | null;
    threw: string | null;
}

/**
 * Drive one dispatch through the PRODUCTION interceptor.
 *
 * The tracer provider is registered before `installFlueTelemetry()`, because
 * that function resolves its tracer at install time — a provider registered
 * afterwards would leave every span a no-op and the span assertions vacuous.
 */
async function runThroughProductionInterceptor(opts: {
    runId: string;
    /** Model script: how many `task` calls, and whether to call a real tool. */
    taskCalls: number;
    callTool?: boolean;
    cap?: number;
    /** Make the answer guard throw, as a content refusal would. */
    guardThrows?: boolean;
    ledgerSeq?: number;
}): Promise<Outcome> {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.disable();
    trace.setGlobalTracerProvider(provider);

    const rec: Recorded = { guarded: [], completed: [], ledgerSeqReads: 0 };

    // THE REAL INSTALL. Everything below observes what it did.
    const dispose = installFlueTelemetry();

    const faux = fauxProvider();
    const calls = [
        ...Array.from({ length: opts.taskCalls }, (_, i) =>
            fauxToolCall('task', { prompt: `sub ${i}`, agent: 'risk_analyst' }),
        ),
        ...(opts.callTool ? [fauxToolCall('echo', { text: 'plain' })] : []),
    ];
    faux.setResponses([
        fauxAssistantMessage(calls),
        fauxAssistantMessage('finished'),
        fauxAssistantMessage('finished'),
    ]);

    bindRun(opts.runId, {
        tools: [
            {
                name: 'echo',
                description: 'Echo a string back.',
                input: v.object({ text: v.string() }),
                annotations: { readOnlyHint: true, destructiveHint: false, title: 'Echo' },
                run: async () => 'echoed',
            },
        ],
        skills: [],
        modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        maxSubagentsPerTurn: opts.cap ?? 3,
        currentLedgerSeq: () => {
            rec.ledgerSeqReads += 1;
            return opts.ledgerSeq ?? 7;
        },
        guardDelegateOutput: async (text, taskId) => {
            rec.guarded.push({ text, taskId });
            if (opts.guardThrows) throw new Error('egress_refused: the delegate leaked');
        },
        onDelegationComplete: async (d) => {
            rec.completed.push({
                agent: d.agent,
                taskId: d.taskId,
                answerAccepted: d.answerAccepted,
                fromSeq: d.fromSeq,
            });
        },
    });

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    let replied: string | null = null;
    let threw: string | null = null;
    try {
        const agent = init(InflectAgent, { id: opts.runId });
        const reply = await agent.read(
            await agent.dispatch({ message: 'go', initialData: { runId: opts.runId } }),
        );
        replied = reply?.text ?? null;
    } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
    }

    // SPANS READ BEFORE TEARDOWN, and that ordering is the whole point.
    // `provider.shutdown()` shuts the processor down, which shuts the exporter
    // down, and `InMemorySpanExporter.shutdown()` calls `reset()` — it CLEARS
    // the spans it has collected. Reading afterwards returned an empty array
    // while the interceptor had in fact produced 31 spans, so the span
    // assertions failed for a teardown reason and read as "no spans emitted".
    let collected: Array<{ name: string; attrs: Record<string, unknown>; error: boolean }> = [];
    try {
        await provider.forceFlush();
        collected = exporter.getFinishedSpans().map((sp) => ({
            name: sp.name,
            attrs: { ...sp.attributes },
            error: sp.attributes['error'] === true,
        }));
    } finally {
        await flue.stop();
        await dispose();
        releaseRun(opts.runId);
        releaseDelegationCounts(opts.runId);
        await provider.shutdown();
        trace.disable();
    }

    // A HARNESS THAT BROKE MUST SAY SO. Without this the `catch` above turns a
    // malformed binding into empty hook arrays, and every assertion below fails
    // with "expected length 1, received 0" — which reads as the interceptor not
    // calling its hooks. That cost a debugging cycle when the tool shape used
    // `parameters`/`execute` instead of `input`/`run`.
    if (!opts.guardThrows && threw !== null) {
        throw new Error(`harness: the dispatch threw unexpectedly — ${threw}`);
    }

    return { rec, spans: collected, replied, threw };
}

beforeEach(() => {
    _resetDelegationCounts();
});

describe('the production interceptor runs, and its hooks receive the real call', () => {
    it('opens a named span per operation, with attributes', async () => {
        const { spans } = await runThroughProductionInterceptor({
            runId: 'tel-span',
            taskCalls: 0,
            callTool: true,
        });

        // Non-vacuous: if the provider were registered after the install, every
        // span would be a no-op and this would be an empty array.
        expect(spans.length).toBeGreaterThan(0);
        // `spanNameFor` and `attributesFor` are only reachable this way — both
        // were at zero coverage with the module.
        expect(spans.every((s) => typeof s.name === 'string' && s.name.length > 0)).toBe(true);
        expect(spans.some((s) => Object.keys(s.attrs).length > 0)).toBe(true);
    });

    it('calls the answer guard with the delegate text and a task id', async () => {
        const { rec } = await runThroughProductionInterceptor({
            runId: 'tel-guard',
            taskCalls: 1,
        });

        expect(rec.guarded).toHaveLength(1);
        expect(typeof rec.guarded[0].text).toBe('string');
        // The id comes from the RESULT's `details`, not from `ctx` — `ctx.taskId`
        // is unset on the parent's `task` call. A hook wired to `ctx` would put
        // `undefined` here and every flagged answer would be attributable to
        // nobody.
        expect(rec.guarded[0].taskId).toBeDefined();
    });

    it('records the completion with the specialist the model chose, and the ledger seq', async () => {
        const { rec } = await runThroughProductionInterceptor({
            runId: 'tel-complete',
            taskCalls: 1,
            ledgerSeq: 11,
        });

        expect(rec.completed).toHaveLength(1);
        expect(rec.completed[0].agent).toBe('risk_analyst');
        expect(rec.completed[0].answerAccepted).toBe(true);
        // `currentLedgerSeq` is READ through the binding by the interceptor. A
        // hook that ignored it would report null and the span would lose its
        // lower bound.
        expect(rec.ledgerSeqReads).toBeGreaterThan(0);
        expect(rec.completed[0].fromSeq).toBe(11);
    });

    it('does NOT invoke the delegation hooks for an ordinary tool call', async () => {
        const { rec } = await runThroughProductionInterceptor({
            runId: 'tel-plain',
            taskCalls: 0,
            callTool: true,
        });

        // The interceptor sees every operation; only a delegation may reach
        // these. Binding a real tool matters — a case that bound none would pass
        // vacuously whatever the interceptor did.
        expect(rec.guarded).toEqual([]);
        expect(rec.completed).toEqual([]);
    });

    it('a throwing answer guard still records the delegation, as refused', async () => {
        const { rec } = await runThroughProductionInterceptor({
            runId: 'tel-refuse',
            taskCalls: 1,
            guardThrows: true,
        });

        // The production comment is explicit that the two are passed together
        // "so the gate can record a REFUSED answer before the guard's throw
        // propagates. Two separate calls here would record only the delegations
        // that went well." This is that claim, executed.
        expect(rec.guarded).toHaveLength(1);
        expect(rec.completed).toHaveLength(1);
        expect(rec.completed[0].answerAccepted).toBe(false);
    });

    it('marks the span on failure and lets the error through', async () => {
        const { spans } = await runThroughProductionInterceptor({
            runId: 'tel-error',
            taskCalls: 1,
            guardThrows: true,
        });

        const failed = spans.filter((s) => s.error);
        expect(failed.length).toBeGreaterThan(0);
        // The KIND, never the message — a stack from a tool can quote the
        // arguments it was called with, which is why `recordException` is
        // deliberately not used.
        expect(failed.some((s) => typeof s.attrs['flue.error_kind'] === 'string')).toBe(true);
        expect(failed.every((s) => !('exception.message' in s.attrs))).toBe(true);
    });

    it('refuses the delegation at a cap of zero, through the real interceptor', async () => {
        const { rec } = await runThroughProductionInterceptor({
            runId: 'tel-cap0',
            taskCalls: 1,
            cap: 0,
        });

        // Refused before `next()`, so no answer was produced to guard.
        expect(rec.guarded).toEqual([]);
    });
});
