/**
 * Failure isolation for agentic fan-outs (OWASP ASI08 — cascading failures).
 *
 * ## The defect this closes
 *
 * A fan-out over N members that runs them in a bare `for` loop propagates the
 * first throw to every member behind it. On the agentic path there are two
 * shapes of that:
 *
 *   - the workflow engine's step loop, where ONE step throwing marked the whole
 *     run FAILED — a terminal state `resumeWorkflowRun` refuses — so every step
 *     that had already succeeded was stranded;
 *   - a per-agent sweep, where one agent's bad row would stop every agent
 *     behind it in the list.
 *
 * ## Isolation must not become swallowing
 *
 * A `try/catch` that continues quietly is the same defect as a silent
 * truncation wearing a different hat: the batch reports success and nobody
 * knows a member failed. So this module does not offer a "keep going" helper.
 * It offers a helper that RECORDS every caught failure, COUNTS it, and returns
 * a result the caller cannot read without seeing the count:
 * `IsolationOutcome.failed` sits beside `succeeded`, and `failures[]` names
 * every member that did not make it.
 *
 * ## And some failures MUST stop the run
 *
 * Isolation is wrong for a fault that invalidates the batch itself rather than
 * one member of it — a context-integrity halt, an operator kill, a cap breach.
 * Continuing past one of those is exactly the cascade the isolation is supposed
 * to prevent, arriving through the door built to prevent it.
 *
 * The two are told apart by a BRAND, never by a message match:
 * `isAgenticFatal` is true for a `ContextIntegrityError`, for an
 * `AgenticFatalError`, and for anything else carrying `agenticFatal === true`.
 * The brand check is a property read rather than an `instanceof` chain so a
 * sibling module (a kill switch, a budget cap) can mark its own error fatal
 * without this module importing it — and so a NEW error class inherits
 * nothing by falling through. Unbranded is isolable; that default is
 * deliberate and is the safe one, because an unrecognised fault on one member
 * must not be able to take out the other members by being unrecognised.
 *
 * ## A halt is announced, never trimmed
 *
 * When a fatal fires mid-list the remaining members are NOT attempted — that is
 * the point — but the outcome says so: `halted` names the member and the code,
 * and `unattempted` is the count nobody got to. A caller that logs
 * `succeeded` alone would be reporting a truncation as a clean pass, which is
 * the failure mode this repo already paid for once (#1944).
 *
 * ## Failure detail is a DIGEST, never a message
 *
 * The agentic path may not put unvetted content in a log line or a plaintext,
 * hash-chained audit row (`local/no-raw-prompt-logging`). An error message on
 * this path can carry a tool argument, a proposal payload or a model's own
 * words — a Zod issue quotes the value it rejected. So `describeFailure`
 * returns the error's CLASS and a SHA-256 digest of its message, and no caller
 * is offered the message. The digest still correlates: the same fault twice
 * produces the same digest, which is what an operator watching a spike needs.
 */
import { createHash } from 'node:crypto';

import { ContextIntegrityError } from './context-integrity';

/**
 * An error that must STOP the fan-out it is thrown inside, rather than being
 * isolated to its member.
 *
 * `agenticFatal` is a public, structural brand rather than a private field:
 * `isAgenticFatal` reads it off any object, so a module that cannot import this
 * one can still mark its error fatal by carrying the same property.
 */
export class AgenticFatalError extends Error {
    /** The structural brand `isAgenticFatal` reads. */
    public readonly agenticFatal = true as const;
    /** Short, enum-shaped reason. Safe to log — never free text. */
    public readonly code: string;

    constructor(code: string, message?: string) {
        super(message ?? `agentic run halted: ${code}`);
        this.name = 'AgenticFatalError';
        this.code = code;
    }
}

/**
 * Does this error invalidate the whole run, rather than one member of it?
 *
 * Three sources, in the order they are checked:
 *   1. `ContextIntegrityError` — the run's memory is not the one the previous
 *      step wrote. Nothing after it can be trusted, so nothing after it runs.
 *   2. `AgenticFatalError` — declared fatal at the throw site.
 *   3. the `agenticFatal === true` brand on anything else, so a sibling module
 *      can opt in without a cyclic import.
 */
export function isAgenticFatal(err: unknown): boolean {
    if (err instanceof ContextIntegrityError) return true;
    if (err instanceof AgenticFatalError) return true;
    if (typeof err !== 'object' || err === null) return false;
    return (err as { agenticFatal?: unknown }).agenticFatal === true;
}

/** One member that did not complete. Carries no message text — see the header. */
export interface IsolatedFailure {
    /** Which member. An id, never content. */
    readonly key: string;
    /** The error's class or declared code — enum-shaped, safe to log. */
    readonly kind: string;
    /** SHA-256 of the message, truncated. Correlates repeats; reveals nothing. */
    readonly digest: string;
    /** Whether this failure stopped the fan-out. */
    readonly fatal: boolean;
}

/** Bytes of digest kept. 16 hex chars is ample to correlate, far short of reversible. */
const DIGEST_CHARS = 16;

/**
 * Describe a caught error for a log line, an audit row or a metric label.
 *
 * The `kind` prefers a declared code (`ContextIntegrityError.code`,
 * `AgenticFatalError.code`) over the class name, because the code is the thing
 * an operator alerts on. The message never leaves this function.
 */
export function describeFailure(key: string, err: unknown): IsolatedFailure {
    const fatal = isAgenticFatal(err);
    let kind = 'UnknownError';
    let message = '';

    if (err instanceof ContextIntegrityError) {
        kind = err.code;
        message = err.message;
    } else if (err instanceof AgenticFatalError) {
        kind = err.code;
        message = err.message;
    } else if (err instanceof Error) {
        kind = err.name || 'Error';
        message = err.message;
    } else {
        message = String(err);
    }

    const digest = createHash('sha256').update(message).digest('hex').slice(0, DIGEST_CHARS);
    return { key, kind, digest, fatal };
}

/** What a fan-out did. Every field is a count or a digest — never content. */
export interface IsolationOutcome<R> {
    /** Members the fan-out actually ran. Less than the input on a halt. */
    readonly attempted: number;
    /** Members that returned without throwing. */
    readonly succeeded: number;
    /** Members that threw an ISOLABLE error. The fan-out continued past each. */
    readonly failed: number;
    /** Members never reached, because a fatal stopped the fan-out. */
    readonly unattempted: number;
    /** The fatal that stopped it, or `null` if the whole list was attempted. */
    readonly halted: IsolatedFailure | null;
    /** Every failure, isolable and fatal alike, in the order they happened. */
    readonly failures: readonly IsolatedFailure[];
    /** The successful members' return values, in input order. */
    readonly results: readonly R[];
}

/**
 * Run `run` over every member, isolating the failures that may be isolated and
 * halting on the ones that may not.
 *
 * `onFailure` is where the caller records the failure — a metric, a log line,
 * an audit row. It is called for EVERY failure including the fatal one, before
 * the loop stops, so a halt is never the quiet case. A throw from `onFailure`
 * itself is swallowed: an observability sink that is down must not become the
 * cascade this function exists to prevent.
 *
 * Sequential on purpose. These fan-outs write rows under RLS per member and a
 * parallel map would multiply the connection demand by the member count for no
 * latency that matters in a background sweep.
 */
export async function isolateEach<T, R>(
    members: readonly T[],
    keyOf: (member: T) => string,
    run: (member: T) => Promise<R>,
    onFailure?: (failure: IsolatedFailure) => void,
): Promise<IsolationOutcome<R>> {
    const failures: IsolatedFailure[] = [];
    const results: R[] = [];
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let halted: IsolatedFailure | null = null;

    for (const member of members) {
        attempted++;
        try {
            results.push(await run(member));
            succeeded++;
        } catch (err) {
            const failure = describeFailure(keyOf(member), err);
            failures.push(failure);
            try {
                onFailure?.(failure);
            } catch {
                // A broken sink is not a reason to abandon the remaining members.
            }
            if (failure.fatal) {
                halted = failure;
                break;
            }
            failed++;
        }
    }

    return {
        attempted,
        succeeded,
        failed,
        unattempted: members.length - attempted,
        halted,
        failures,
        results,
    };
}
