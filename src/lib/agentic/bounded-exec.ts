/**
 * `runBoundedTool` — the ONE seam through which an agent-reachable tool may
 * execute code or shell out (OWASP ASI05, bound tool execution).
 *
 * ## The population, stated honestly
 *
 * TODAY NO AGENT-REACHABLE TOOL EXECUTES CODE. All fourteen MCP tools
 * (`src/lib/mcp/tool-catalogue.ts`) are thin wrappers over read/propose
 * usecases that touch Prisma and nothing else; the workflow engine composes
 * exactly those tools; the five automation actions are notify / task / status /
 * webhook / subflow. The only two `child_process` call sites in `src/` are the
 * cloud-posture collectors, which a scheduled integration check reaches and an
 * agent does not.
 *
 * So this module is the seam, not a retrofit. It exists because the FIRST tool
 * that shells out is the one that will not have a bound unless the bound is
 * already here, and because `tests/guards/tool-execution-is-bounded.test.ts`
 * turns "an unbounded executor appeared" from a review question into a failing
 * build. The guard is the consumer that matters: a helper nothing is required
 * to use is decoration, which is exactly why `bounded-fetch.ts` deleted its own
 * unused second timeout.
 *
 * ## The load-bearing property: a cap HALTS, it never truncates
 *
 * A truncated tool output is worse than no output, because an agent cannot see
 * the difference. It reads a JSON document that ends early, or a control list
 * missing its tail, and reasons over it AS IF COMPLETE — then proposes on that
 * basis. Nothing downstream can recover the fact, because the bytes that would
 * have said so are the bytes that were dropped.
 *
 * So every non-`completed` outcome here THROWS. There is no arm of this module
 * that returns partial output, and the success shape is the only shape carrying
 * a `stdout` at all. An aborted tool is an error; it is never an
 * empty-but-successful result.
 *
 * ## Two independent cap detectors, deliberately
 *
 *   1. the CHILD's own report — Node kills the process and calls back with
 *      `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` once `maxBuffer` is passed;
 *   2. OUR measurement of the bytes that actually came back.
 *
 * The second is not redundant. `maxBuffer` is a property of `execFile`; an
 * injected executor, a future streaming runner, or a `spawn`-based adapter can
 * hand back a gigabyte having reported perfect success. A bound that is only as
 * good as the executor's cooperation is not a bound. Detector 2 is enforced on
 * the SUCCESS path, after the exit has been classified as completed.
 *
 * ## Two independent deadline layers, for the same reason
 *
 * The `timeout` option goes to the executor, and this module ALSO races the
 * call against its own timer and aborts the child. An executor that ignores the
 * option still cannot outlive the deadline, and — the part that makes the
 * timeout testable at all — the deadline is a plain `setTimeout` on an
 * injectable timer API, so a test drives it with no subprocess and no real
 * waiting.
 *
 * ## Exit classification is REUSED, not reinvented
 *
 * `describeChildExit` from `powerpipe-exit.ts` already solves the genuinely
 * awkward part: a `maxBuffer` overflow sets `code:'ERR_…'` AND `signal:'SIGTERM'`,
 * so it is indistinguishable from a timeout kill to anything that checks the
 * signal first. That module keeps `code` / `signal` / `failure` separate and
 * discriminates on `typeof code === 'number'`. This module imports it rather
 * than growing a second copy that would drift — the same reason the collectors
 * share it across three clouds.
 *
 * What this module adds on top is a GENERIC outcome vocabulary.
 * `classifyPowerpipeExit` cannot be reused wholesale because powerpipe
 * overloads exits 1 and 2 to mean "completed, and found something"; for an
 * arbitrary tool, a numeric status is just a status and the caller interprets
 * it.
 *
 * ## Reporting discipline
 *
 * A refusal reports a BYTE COUNT and a DIGEST. It never reports the captured
 * bytes — not in the error message, not in a log field, not in an audit row.
 * Tool output is untrusted content that may carry credentials the collector
 * scrubbers have not seen, and a cap breach is precisely the case where nobody
 * has read it.
 *
 * @see tests/unit/agent-tool-execution-bounds.test.ts   — the behaviour
 * @see tests/guards/tool-execution-is-bounded.test.ts   — that it is REACHED
 */
import { createHash } from 'node:crypto';

import { logger } from '@/lib/observability/logger';
import {
    describeChildExit,
    type ChildExit,
} from '@/app-layer/integrations/cloud-posture/powerpipe-exit';

// ─── The bounds ─────────────────────────────────────────────────────

/**
 * Wall-clock ceiling for one tool execution.
 *
 * 15 minutes, matching the deliberate Powerpipe bound, so a subprocess has ONE
 * answer across the codebase regardless of who spawned it — the same coherence
 * argument `bounded-fetch.ts` makes for its 30 s.
 */
export const TOOL_EXEC_TIMEOUT_MS = 15 * 60_000;

/** Captured-output ceiling per stream, matching the Powerpipe `maxBuffer`. */
export const TOOL_EXEC_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Node's error code when a stream passes `maxBuffer`.
 *
 * There is deliberately NO spreadable `{timeout, maxBuffer}` convenience object
 * here. Nothing outside this module would consume one — the two existing
 * `child_process` call sites are cloud-posture collectors, and making a posture
 * collector import from `lib/agentic` to learn two integers would buy tidiness
 * with a dependency edge that misdescribes the system. The guard checks that
 * every call site carries BOTH options, which is the actual invariant; an
 * export nothing imports is the shape `bounded-fetch.ts` already had to delete
 * once.
 */
export const MAXBUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

// ─── Outcomes ───────────────────────────────────────────────────────

/**
 * What a bounded execution did. Only `completed` carries output.
 *
 * `timed-out` is NOT derivable from the exit triple and is deliberately absent
 * here: our deadline kills with SIGTERM and so does a `maxBuffer` overflow, so
 * the child's own report cannot tell them apart. The wrapper knows which timer
 * fired and says so; this classifier answers only for a callback that arrived.
 */
export type ChildExitOutcome =
    | 'completed'
    | 'output-capped'
    | 'signal-killed'
    | 'did-not-start';

/**
 * Classify a `ChildExit` for a generic tool.
 *
 * ORDER IS THE WHOLE THING. `failure` is checked before `signal` because an
 * overflow carries BOTH, and a naive signal-first read reports it as an
 * ordinary kill — losing the one fact that says the output is incomplete. The
 * overflow code is checked before other failures so a cap breach is reported as
 * a cap breach rather than as a generic spawn failure.
 */
export function classifyChildExit(exit: ChildExit): ChildExitOutcome {
    if (exit.failure === MAXBUFFER_ERROR_CODE) return 'output-capped';
    if (exit.failure !== null) return 'did-not-start';
    if (exit.signal !== null) return 'signal-killed';
    // Any numeric status means the child ran and ended on its own terms. What
    // the number MEANS is the caller's business — this module does not know
    // whether a 1 is an error or a benchmark with alarms.
    if (typeof exit.code === 'number') return 'completed';
    // No status, no signal, no failure: nothing that could have run did.
    return 'did-not-start';
}

// ─── Errors ─────────────────────────────────────────────────────────

/** Base class so a caller can catch every bound breach with one arm. */
export class ToolExecutionBoundError extends Error {
    readonly tool: string;
    constructor(tool: string, message: string) {
        super(message);
        this.name = 'ToolExecutionBoundError';
        this.tool = tool;
    }
}

/** OUR deadline fired. The child was aborted; nothing it produced is returned. */
export class ToolExecutionTimeoutError extends ToolExecutionBoundError {
    readonly timeoutMs: number;
    constructor(tool: string, timeoutMs: number) {
        super(tool, `Tool "${tool}" exceeded its ${timeoutMs}ms execution deadline and was aborted.`);
        this.name = 'ToolExecutionTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/**
 * The output cap was hit. THE CAPTURED BYTES ARE NOT ON THIS ERROR, on purpose.
 *
 * A cap breach is the one case where nobody has read the output, so it is also
 * the one case where nobody can say it holds no credential. The fields here are
 * everything an operator needs to size the problem — which stream, how much,
 * against what limit, and a digest to correlate two occurrences — and none of
 * them is content.
 */
export class ToolExecutionOutputCapError extends ToolExecutionBoundError {
    readonly stream: 'stdout' | 'stderr';
    readonly limitBytes: number;
    /** Bytes we observed. `null` when the child was killed before we saw them. */
    readonly observedBytes: number | null;
    /** Short SHA-256 of what was captured — an identifier, never the content. */
    readonly digest: string;
    /** Which detector fired: the child's own report, or our measurement. */
    readonly detectedBy: 'child-report' | 'own-measurement';

    constructor(input: {
        tool: string;
        stream: 'stdout' | 'stderr';
        limitBytes: number;
        observedBytes: number | null;
        digest: string;
        detectedBy: 'child-report' | 'own-measurement';
    }) {
        super(
            input.tool,
            `Tool "${input.tool}" exceeded its ${input.limitBytes}-byte ${input.stream} cap ` +
                `(${input.observedBytes ?? 'unknown'} bytes observed, digest ${input.digest}). ` +
                'The output was DISCARDED rather than truncated: a partial result would be ' +
                'indistinguishable from a complete one to whatever reads it.',
        );
        this.name = 'ToolExecutionOutputCapError';
        this.stream = input.stream;
        this.limitBytes = input.limitBytes;
        this.observedBytes = input.observedBytes;
        this.digest = input.digest;
        this.detectedBy = input.detectedBy;
    }
}

/** The child died on a signal, or never started. Carries the exit triple. */
export class ToolExecutionFailedError extends ToolExecutionBoundError {
    readonly outcome: Exclude<ChildExitOutcome, 'completed' | 'output-capped'>;
    readonly exit: ChildExit;
    constructor(
        tool: string,
        outcome: Exclude<ChildExitOutcome, 'completed' | 'output-capped'>,
        exit: ChildExit,
    ) {
        super(
            tool,
            `Tool "${tool}" ${outcome === 'did-not-start' ? 'did not start' : 'was killed'} ` +
                `(code=${exit.code ?? 'none'} signal=${exit.signal ?? 'none'} failure=${exit.failure ?? 'none'}).`,
        );
        this.name = 'ToolExecutionFailedError';
        this.outcome = outcome;
        this.exit = exit;
    }
}

// ─── The executor + timer seams ─────────────────────────────────────

export interface ToolExecOptions {
    env?: NodeJS.ProcessEnv;
    /** Wall-clock ceiling handed to the executor (belt; the wrapper is braces). */
    timeout: number;
    /** Per-stream capture ceiling handed to the executor. */
    maxBuffer: number;
    /** Aborted when the wrapper's own deadline fires. */
    signal: AbortSignal;
}

/**
 * What an executor hands back. It RESOLVES on failure rather than rejecting —
 * `error` is the `execFile` callback's first argument — so the wrapper does the
 * classification in one place instead of splitting it across a catch.
 */
export interface RawExecResult {
    error: unknown;
    stdout: string;
    stderr: string;
}

export type ToolExecutor = (
    file: string,
    args: readonly string[],
    options: ToolExecOptions,
) => Promise<RawExecResult>;

/** The slice of the timer API the deadline needs, so a test can supply its own. */
export interface TimerApi {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
}

const SYSTEM_TIMERS: TimerApi = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The real executor. Lazily imports `node:child_process` so that importing this
 * module from an edge/client bundle does not drag the subprocess API in.
 */
export const nodeToolExecutor: ToolExecutor = async (file, args, options) => {
    const { execFile } = await import('node:child_process');
    return new Promise<RawExecResult>((resolve) => {
        execFile(
            file,
            [...args],
            {
                env: options.env,
                timeout: options.timeout,
                maxBuffer: options.maxBuffer,
                signal: options.signal,
            },
            (error, stdout, stderr) => {
                resolve({
                    error,
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? ''),
                });
            },
        );
    });
};

// ─── Reporting helpers ──────────────────────────────────────────────

/**
 * A short SHA-256 of captured output.
 *
 * Sixteen hex characters — enough to tell two occurrences apart in a log, far
 * too few to be a channel for the content. Never log the input to this.
 */
export function digestOutput(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ─── The seam ───────────────────────────────────────────────────────

export interface BoundedToolInput {
    /**
     * A stable label for reporting. NOT the argv: arguments can carry secrets,
     * which is why the collectors pass credentials by env in the first place.
     */
    tool: string;
    file: string;
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    deps?: {
        exec?: ToolExecutor;
        timers?: TimerApi;
    };
}

/** The ONLY shape carrying output. There is no partial-output shape. */
export interface BoundedToolResult {
    stdout: string;
    stderr: string;
    exit: ChildExit;
    stdoutBytes: number;
    stderrBytes: number;
}

/**
 * Run a tool under an explicit deadline and an explicit output cap.
 *
 * Resolves ONLY for a child that ran to a numeric exit status with both streams
 * inside the cap. Every other outcome throws a `ToolExecutionBoundError`
 * subclass — including a timeout, which must never surface as an empty success.
 */
export async function runBoundedTool(input: BoundedToolInput): Promise<BoundedToolResult> {
    const {
        tool,
        file,
        args = [],
        env,
        timeoutMs = TOOL_EXEC_TIMEOUT_MS,
        maxOutputBytes = TOOL_EXEC_MAX_OUTPUT_BYTES,
    } = input;
    const exec = input.deps?.exec ?? nodeToolExecutor;
    const timers = input.deps?.timers ?? SYSTEM_TIMERS;

    const controller = new AbortController();
    let deadlineFired = false;

    // Started BEFORE the deadline so the timer can be cancelled the moment the
    // executor answers. Ordering the other way needs the exec promise inside
    // the timer's own constructor, which is a hoisting trap rather than a
    // design.
    const settled = exec(file, args, {
        env,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        signal: controller.signal,
    });

    // The deadline is a RACE, not a hope. An executor that ignores its
    // `timeout` option still loses to this, and the abort is what stops the
    // child rather than orphaning it behind a resolved promise.
    let handle: unknown = null;
    const deadline = new Promise<'timed-out'>((resolve) => {
        handle = timers.setTimeout(() => {
            deadlineFired = true;
            // Raised to the child, not merely recorded: an unaborted subprocess
            // outlives the promise that stopped waiting for it.
            controller.abort();
            resolve('timed-out');
        }, timeoutMs);
    });
    // Cancel the timer as soon as the executor answers, so a fast tool leaves
    // no pending timer behind (and, under a test clock, nothing fires late).
    // `catch` is a no-op: an executor that rejects is handled by the race.
    void settled.then(
        () => timers.clearTimeout(handle),
        () => timers.clearTimeout(handle),
    );

    const raced = await Promise.race([settled, deadline]);

    if (raced === 'timed-out' || deadlineFired) {
        logger.warn('bounded tool execution aborted at its deadline', {
            component: 'agentic-tool-exec',
            tool,
            timeoutMs,
        });
        throw new ToolExecutionTimeoutError(tool, timeoutMs);
    }

    // The `||` above already excludes the `'timed-out'` arm, so this narrows a
    // known union to one of its members; it widens nothing. (Spelling the
    // banned cast out here, even inside a comment, trips the repo's `any`
    // ratchet — it scans comment text too.)
    const result = raced as RawExecResult;
    const exit = describeChildExit(result.error);
    const outcome = classifyChildExit(exit);

    // DETECTOR 1 — the child's own report. Checked before the generic failure
    // arm so an overflow is named as an overflow.
    if (outcome === 'output-capped') {
        throw capError(tool, result, maxOutputBytes, 'child-report');
    }

    if (outcome !== 'completed') {
        logger.warn('bounded tool execution did not complete', {
            component: 'agentic-tool-exec',
            tool,
            outcome,
            signal: exit.signal,
            failure: exit.failure,
        });
        throw new ToolExecutionFailedError(tool, outcome, exit);
    }

    // DETECTOR 2 — our own measurement, on the SUCCESS path. An executor that
    // does not honour `maxBuffer` (an injected one, a future `spawn` adapter)
    // reports a clean exit while handing back arbitrarily many bytes; without
    // this, the cap would be only as strong as the executor's cooperation.
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
    if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        throw capError(tool, result, maxOutputBytes, 'own-measurement');
    }

    return { stdout: result.stdout, stderr: result.stderr, exit, stdoutBytes, stderrBytes };
}

/**
 * Build the cap refusal, and log it — with a digest and a byte count, and with
 * no captured byte anywhere in either.
 */
function capError(
    tool: string,
    result: RawExecResult,
    limitBytes: number,
    detectedBy: 'child-report' | 'own-measurement',
): ToolExecutionOutputCapError {
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
    // Attribute to whichever stream is larger. On the child-report path both
    // may be under the limit (the child was killed as it crossed), which is why
    // `observedBytes` is a fact about what we HOLD, not a claim about what the
    // tool produced.
    const stream: 'stdout' | 'stderr' = stderrBytes > stdoutBytes ? 'stderr' : 'stdout';
    const captured = stream === 'stderr' ? result.stderr : result.stdout;
    const err = new ToolExecutionOutputCapError({
        tool,
        stream,
        limitBytes,
        observedBytes: stream === 'stderr' ? stderrBytes : stdoutBytes,
        digest: digestOutput(captured),
        detectedBy,
    });
    logger.warn('bounded tool execution exceeded its output cap', {
        component: 'agentic-tool-exec',
        tool,
        stream,
        limitBytes,
        observedBytes: err.observedBytes,
        // A digest, never the bytes. The output is unread and therefore unknown
        // to be free of credentials.
        digest: err.digest,
        detectedBy,
    });
    return err;
}
