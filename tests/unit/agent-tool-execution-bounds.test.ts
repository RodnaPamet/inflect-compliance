/**
 * Bound tool execution (OWASP ASI05) — a tool that executes code or shells out
 * has a deadline and an output cap, and BREACHING EITHER HALTS.
 *
 * ## Why halting is the whole point
 *
 * A truncated tool output is not a degraded result, it is a WRONG one that
 * announces nothing. The agent receives a JSON document that stops early, or a
 * findings list missing its tail, and reasons over it as complete — the bytes
 * that would have said otherwise are precisely the bytes that were dropped. The
 * same holds for the deadline: an aborted tool surfacing as
 * `{ stdout: '' }` reads as "the tool ran and found nothing", which is a
 * conclusion nobody is entitled to.
 *
 * So every assertion below is of the form "it THREW", never "it returned less".
 *
 * ## No subprocess is spawned here
 *
 * The executor and the timer are both injected. A test that shells out is slow,
 * flaky under a loaded CI box, and answers a question about the host rather
 * than about this module — and it could not test the deadline at all without
 * sleeping for it.
 */
import {
    classifyChildExit,
    digestOutput,
    MAXBUFFER_ERROR_CODE,
    runBoundedTool,
    TOOL_EXEC_MAX_OUTPUT_BYTES,
    TOOL_EXEC_TIMEOUT_MS,
    ToolExecutionFailedError,
    ToolExecutionOutputCapError,
    ToolExecutionTimeoutError,
    type RawExecResult,
    type TimerApi,
    type ToolExecutor,
} from '@/lib/agentic/bounded-exec';

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── A controllable clock ───────────────────────────────────────────

/**
 * A timer API whose only way to advance is `fire()`. Injected rather than
 * driven with jest fake timers so the deadline is asserted by construction:
 * nothing here can pass because a real millisecond elapsed.
 */
function makeTimers(): TimerApi & { fire: () => void; pending: () => number } {
    let scheduled: Array<{ fn: () => void; cancelled: boolean }> = [];
    return {
        setTimeout(fn: () => void) {
            const entry = { fn, cancelled: false };
            scheduled.push(entry);
            return entry;
        },
        clearTimeout(handle: unknown) {
            const entry = handle as { cancelled: boolean } | null;
            if (entry) entry.cancelled = true;
        },
        fire() {
            const due = scheduled.filter((e) => !e.cancelled);
            scheduled = [];
            for (const e of due) e.fn();
        },
        pending() {
            return scheduled.filter((e) => !e.cancelled).length;
        },
    };
}

/** An executor that never answers — the hang case. Records the abort signal. */
function hangingExecutor(): ToolExecutor & { aborted: () => boolean } {
    let signal: AbortSignal | null = null;
    const exec: ToolExecutor = (_file, _args, options) => {
        signal = options.signal;
        return new Promise<RawExecResult>(() => {
            /* never settles */
        });
    };
    return Object.assign(exec, { aborted: () => signal?.aborted === true });
}

/** An executor that answers immediately with a fixed result. */
function fixedExecutor(result: RawExecResult): ToolExecutor {
    return () => Promise.resolve(result);
}

/** The error shape Node produces when a stream passes `maxBuffer`. */
function maxBufferError(): Error & { code: string; signal: string } {
    return Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: MAXBUFFER_ERROR_CODE,
        // Node kills the child, so an overflow carries a SIGTERM *as well as*
        // the code — the same shape a deadline kill has. Reproduced here
        // deliberately: a classifier that reads the signal first cannot tell
        // them apart, which is the defect `powerpipe-exit.ts` already records.
        signal: 'SIGTERM',
    });
}

// ─── The deadline ───────────────────────────────────────────────────

describe('runBoundedTool — the deadline', () => {
    it('waits for the deadline and settles the moment it fires, never before', async () => {
        const timers = makeTimers();
        let settled = false;
        const done = runBoundedTool({
            tool: 'hangs',
            file: 'never-answers',
            timeoutMs: 1_000,
            deps: { exec: hangingExecutor(), timers },
        })
            .catch(() => undefined)
            .then(() => {
                settled = true;
            });

        // Drain every microtask a wrapper that ignored its timer would have
        // used to settle. This half is the reason the test is here: an
        // implementation that gave up immediately would satisfy "it rejects"
        // while bounding nothing.
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(settled).toBe(false);

        timers.fire();
        await done;
        expect(settled).toBe(true);
    });

    it('raises the abort to the child rather than orphaning it behind a settled promise', async () => {
        const timers = makeTimers();
        const exec = hangingExecutor();
        const pending = runBoundedTool({
            tool: 'hangs',
            file: 'never-answers',
            timeoutMs: 1_000,
            deps: { exec, timers },
        });
        const assertion = expect(pending).rejects.toThrow(ToolExecutionTimeoutError);

        expect(exec.aborted()).toBe(false);
        timers.fire();
        await assertion;

        // Without this, the wrapper stops WAITING for the child but the child
        // keeps running — a subprocess nobody is watching and nothing will
        // reap, which is the failure a deadline is supposed to prevent.
        expect(exec.aborted()).toBe(true);
    });

    it('reports the timeout as an error, never as an empty-but-successful result', async () => {
        const timers = makeTimers();
        const pending = runBoundedTool({
            tool: 'hangs',
            file: 'never-answers',
            timeoutMs: 4_000,
            deps: { exec: hangingExecutor(), timers },
        });
        const captured = pending.then(
            (value) => ({ resolved: true as const, value }),
            (err: unknown) => ({ resolved: false as const, err }),
        );

        timers.fire();
        const outcome = await captured;

        expect(outcome.resolved).toBe(false);
        const err = (outcome as { err: ToolExecutionTimeoutError }).err;
        expect(err).toBeInstanceOf(ToolExecutionTimeoutError);
        expect(err.timeoutMs).toBe(4_000);
        expect(err.tool).toBe('hangs');
        // The distinction this pins: an agent handed `{stdout:''}` concludes
        // "ran, found nothing". There is no shape here that could say that.
        expect(err.message).toContain('aborted');
    });

    it('cancels its timer once the tool answers, so nothing fires late', async () => {
        const timers = makeTimers();
        await runBoundedTool({
            tool: 'quick',
            file: 'answers',
            deps: {
                exec: fixedExecutor({ error: null, stdout: 'done', stderr: '' }),
                timers,
            },
        });
        expect(timers.pending()).toBe(0);
    });
});

// ─── The output cap ─────────────────────────────────────────────────

describe('runBoundedTool — the output cap', () => {
    it('HALTS when the child reports a maxBuffer overflow, and never returns the partial bytes', async () => {
        const timers = makeTimers();
        // Node hands back whatever it captured BEFORE killing the child. That
        // partial buffer is exactly what must not become a return value.
        const partial = '{"controls":[{"id":"a"},{"id":"b"';
        const pending = runBoundedTool({
            tool: 'floods',
            file: 'writes-too-much',
            maxOutputBytes: 16,
            deps: {
                exec: fixedExecutor({ error: maxBufferError(), stdout: partial, stderr: '' }),
                timers,
            },
        });

        const outcome = await pending.then(
            (value) => ({ resolved: true as const, value }),
            (err: unknown) => ({ resolved: false as const, err }),
        );

        expect(outcome.resolved).toBe(false);
        const err = (outcome as { err: ToolExecutionOutputCapError }).err;
        expect(err).toBeInstanceOf(ToolExecutionOutputCapError);
        expect(err.detectedBy).toBe('child-report');
        expect(err.limitBytes).toBe(16);
        // The report exists and is quantitative — a cap that halts silently is
        // only half the requirement.
        expect(err.observedBytes).toBe(Buffer.byteLength(partial, 'utf8'));
    });

    it('caps by its OWN measurement when the executor reports success over the limit', async () => {
        const timers = makeTimers();
        // An executor that does not honour `maxBuffer` — an injected one, or a
        // future streaming/`spawn` adapter. Nothing about the exit says the
        // output is oversized; only measuring it does.
        const flood = 'x'.repeat(4_096);
        const pending = runBoundedTool({
            tool: 'lies',
            file: 'reports-clean-exit',
            maxOutputBytes: 1_024,
            deps: {
                exec: fixedExecutor({ error: null, stdout: flood, stderr: '' }),
                timers,
            },
        });

        const outcome = await pending.then(
            (value) => ({ resolved: true as const, value }),
            (err: unknown) => ({ resolved: false as const, err }),
        );

        expect(outcome.resolved).toBe(false);
        const err = (outcome as { err: ToolExecutionOutputCapError }).err;
        expect(err).toBeInstanceOf(ToolExecutionOutputCapError);
        expect(err.detectedBy).toBe('own-measurement');
        expect(err.observedBytes).toBe(4_096);
        expect(err.limitBytes).toBe(1_024);
    });

    it('caps an oversized stderr as well as an oversized stdout', async () => {
        const timers = makeTimers();
        const pending = runBoundedTool({
            tool: 'noisy',
            file: 'writes-to-stderr',
            maxOutputBytes: 32,
            deps: {
                exec: fixedExecutor({ error: null, stdout: 'ok', stderr: 'y'.repeat(512) }),
                timers,
            },
        });
        const err = await pending.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ToolExecutionOutputCapError);
        expect((err as ToolExecutionOutputCapError).stream).toBe('stderr');
    });

    it('carries the digest of what it captured, so two breaches are correlatable', async () => {
        const timers = makeTimers();
        const flood = 'q'.repeat(2_048);
        const err = (await runBoundedTool({
            tool: 'floods',
            file: 'writes-too-much',
            maxOutputBytes: 64,
            deps: { exec: fixedExecutor({ error: null, stdout: flood, stderr: '' }), timers },
        }).catch((e: unknown) => e)) as ToolExecutionOutputCapError;

        expect(err.digest).toBe(digestOutput(flood));
        expect(err.digest).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('ToolExecutionOutputCapError — what a refusal is allowed to say', () => {
    it('reports bytes and a digest, and never the captured content', () => {
        // Tested on the ERROR rather than through an execution, so this
        // property cannot be broken or fixed by anything to do with detection.
        // A cap breach is the one case where nobody has READ the output, so it
        // is the one case where nobody can say it holds no credential.
        // The token below is AWS's own published documentation placeholder,
        // not a credential. It is shaped like one on purpose: the property
        // under test is that a refusal never repeats captured bytes, and a
        // fixture that looks nothing like a secret would not demonstrate it.
        // (Spelling the token in this comment would itself trip the secret
        // scanner — the guard reads prose as well as code.)
        const secret = 'AKIAIOSFODNN7EXAMPLE-super-secret-value'; // pragma: allowlist secret
        const captured = `${secret}${'z'.repeat(2_048)}`;
        const err = new ToolExecutionOutputCapError({
            tool: 'leaky',
            stream: 'stdout',
            limitBytes: 64,
            observedBytes: Buffer.byteLength(captured, 'utf8'),
            digest: digestOutput(captured),
            detectedBy: 'own-measurement',
        });

        // Everything an operator needs to size the problem is present…
        expect(err.observedBytes).toBe(2_087); // 39-char token + 2048 padding
        expect(err.limitBytes).toBe(64);
        expect(err.digest).toBe(digestOutput(captured));

        // …and none of it is content. Both the message and the enumerable
        // fields, because the fields are what a structured logger serialises.
        const reported = `${err.message} ${JSON.stringify({ ...err, message: err.message })}`;
        expect(reported).not.toContain(secret);
        expect(reported).not.toContain('zzzzzzzzzz');
    });
});

// ─── The success path (the positive companion) ──────────────────────

describe('runBoundedTool — a run inside both bounds', () => {
    it('returns the whole output unmodified, with its measured size', async () => {
        const timers = makeTimers();
        const payload = '{"controls":[{"id":"a"},{"id":"b"}]}';
        const res = await runBoundedTool({
            tool: 'behaves',
            file: 'answers',
            maxOutputBytes: 1_024,
            deps: {
                exec: fixedExecutor({ error: null, stdout: payload, stderr: 'warn' }),
                timers,
            },
        });

        // Without this companion, every assertion above is satisfied by a
        // module that refuses everything — "it threw" is not evidence that the
        // allowed case still works.
        expect(res.stdout).toBe(payload);
        expect(res.stderr).toBe('warn');
        expect(res.stdoutBytes).toBe(Buffer.byteLength(payload, 'utf8'));
        expect(res.exit.code).toBe(0);
    });

    it('hands the executor the same bounds it enforces itself, defaulting to the module ones', async () => {
        const timers = makeTimers();
        const seen: Array<{ timeout: number; maxBuffer: number }> = [];
        const spy: ToolExecutor = (_f, _a, options) => {
            seen.push({ timeout: options.timeout, maxBuffer: options.maxBuffer });
            return Promise.resolve({ error: null, stdout: '', stderr: '' });
        };

        await runBoundedTool({
            tool: 'behaves', file: 'answers', timeoutMs: 5_000, maxOutputBytes: 2_048,
            deps: { exec: spy, timers },
        });
        await runBoundedTool({ tool: 'behaves', file: 'answers', deps: { exec: spy, timers } });

        // Belt as well as braces: the wrapper's own race is the guarantee, but
        // an executor told nothing would let a real child linger past the
        // moment we stopped waiting for it.
        expect(seen).toEqual([
            { timeout: 5_000, maxBuffer: 2_048 },
            { timeout: TOOL_EXEC_TIMEOUT_MS, maxBuffer: TOOL_EXEC_MAX_OUTPUT_BYTES },
        ]);
    });
});

describe('the module bounds themselves', () => {
    it('are finite and positive, not merely present', () => {
        // `timeout: 0` DISABLES the timeout in child_process and `Infinity` is
        // a maxBuffer that caps nothing — both satisfy a check that only asks
        // whether the option was supplied.
        expect(Number.isFinite(TOOL_EXEC_TIMEOUT_MS)).toBe(true);
        expect(TOOL_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
        expect(Number.isFinite(TOOL_EXEC_MAX_OUTPUT_BYTES)).toBe(true);
        expect(TOOL_EXEC_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    });
});

// ─── Exit classification ────────────────────────────────────────────

describe('classifyChildExit', () => {
    it('reads a maxBuffer overflow as output-capped even though it also carries SIGTERM', () => {
        // The exact shape `describeChildExit` produces for an overflow. A
        // classifier that checks `signal` first calls this an ordinary kill and
        // loses the one fact that says the output is INCOMPLETE.
        expect(
            classifyChildExit({ code: null, signal: 'SIGTERM', failure: MAXBUFFER_ERROR_CODE }),
        ).toBe('output-capped');
    });

    it('separates a plain signal death from an overflow that looks identical on the signal alone', () => {
        expect(classifyChildExit({ code: null, signal: 'SIGTERM', failure: null })).toBe(
            'signal-killed',
        );
    });

    it('never reads a run that did not complete as completed', () => {
        expect(classifyChildExit({ code: null, signal: null, failure: 'ENOENT' })).toBe(
            'did-not-start',
        );
        expect(classifyChildExit({ code: null, signal: null, failure: null })).toBe(
            'did-not-start',
        );
    });

    it('treats any numeric status as completed and leaves its meaning to the caller', () => {
        expect(classifyChildExit({ code: 0, signal: null, failure: null })).toBe('completed');
        // Powerpipe's exit 1 means "completed, with alarms" — this module has no
        // business calling a numeric status a failure.
        expect(classifyChildExit({ code: 1, signal: null, failure: null })).toBe('completed');
    });
});

describe('runBoundedTool — a child that did not run', () => {
    it('throws rather than returning the empty output of a tool that never started', async () => {
        const timers = makeTimers();
        const err = await runBoundedTool({
            tool: 'absent',
            file: 'not-installed',
            deps: {
                exec: fixedExecutor({
                    error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
                    stdout: '',
                    stderr: '',
                }),
                timers,
            },
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ToolExecutionFailedError);
        expect((err as ToolExecutionFailedError).outcome).toBe('did-not-start');
    });
});
