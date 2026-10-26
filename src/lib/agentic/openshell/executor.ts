/**
 * An OpenShell backend for `runBoundedTool` — 4.2 (#3962).
 *
 * ═══ WHY THIS IS A `ToolExecutor` AND NOT A SECOND SEAM ═══
 *
 * Because both bounds then hold for free, and holding them twice is how they
 * drift. `runBoundedTool` applies the deadline as a RACE around whatever
 * executor it is given — its own comment says "an executor that ignores its
 * `timeout` option still loses to this" — and measures the returned bytes
 * itself, independently of the `maxBuffer` it passes down. So a backend that
 * conforms to `ToolExecutor` inherits the deadline and the output cap rather
 * than re-implementing them, and `code` / `signal` / `failure` stay separated by
 * the one `describeChildExit` the repository already shares.
 *
 * That is also why this file contains no timer and no byte counter. If it had
 * either, there would be two answers to "what is the deadline" and the honest
 * one would be whichever ran first.
 *
 * ═══ A SANDBOX THAT CANNOT BE CREATED IS A REFUSAL (4.2b, #3963) ═══
 *
 * Creation failure THROWS, and the throw is deliberate rather than incidental.
 * `RawExecResult` resolves on failure so the wrapper can classify a tool's exit
 * in one place — but a sandbox that never existed did not produce an exit, and
 * handing back `{ error }` would let it be classified as a tool that failed.
 * The caller must be able to tell "your tool exited 1" from "we could not
 * confine your tool", because only the second one means the confinement was
 * unavailable at the moment it was needed.
 *
 * There is no local-execution arm here. Not a disabled one, not one behind a
 * flag: the module imports no executor and cannot run anything itself.
 *
 * ═══ DELETION HAS FOUR OUTCOMES, AND 4.2 NAMES THREE ═══
 *
 * `DELETION_OUTCOME_UNSPECIFIED` is the proto3 zero value, so an unset field, a
 * field a proxy dropped, and a field explicitly set to zero are the same bytes.
 * It is handled pessimistically — treated as "not settled", so the wait runs —
 * because the alternative is recording a sandbox as deleted while it is running.
 */
import { logger } from '@/lib/observability/logger';

import type { RawExecResult, ToolExecutor } from '../bounded-exec';
import {
    DELETION_IS_SETTLED,
    type SandboxTransport,
    unconfiguredTransport,
} from './transport';

/** Label put on every sandbox this backend creates, so a leak is attributable. */
export const SANDBOX_OWNER_LABEL = 'inflect.dev/created-by';
export const SANDBOX_OWNER_VALUE = 'bounded-tool';

/**
 * Build the executor. One sandbox per execution, deleted afterwards.
 *
 * The transport is a parameter rather than a module-level import so that no
 * part of the main `src/` graph reaches a gateway client, and so a test can
 * drive every arm without a gateway. The default refuses everything.
 */
export function openShellToolExecutor(
    transport: SandboxTransport = unconfiguredTransport,
): ToolExecutor {
    return async (file, args, options): Promise<RawExecResult> => {
        // Outside the try: a creation failure must propagate as a REFUSAL, and
        // there is nothing to clean up because nothing was created.
        const sandbox = await transport.createSandbox({
            labels: { [SANDBOX_OWNER_LABEL]: SANDBOX_OWNER_VALUE },
        });

        try {
            const run = await transport.execSandbox({
                sandboxId: sandbox.id,
                file,
                args,
                env: options.env,
                // The wrapper's deadline aborts this. The executor does not own
                // the deadline; it only has to be interruptible by it.
                signal: options.signal,
            });

            // Shaped for `describeChildExit`, which discriminates on
            // `typeof code === 'number'`: a number is an exit status, a string
            // is a spawn/stream failure. Success is a falsy error, not a zero.
            let error: unknown = null;
            if (run.signal !== null) {
                error = { code: null, signal: run.signal };
            } else if (run.exitCode !== null && run.exitCode !== 0) {
                error = { code: run.exitCode, signal: null };
            }

            return { error, stdout: run.stdout, stderr: run.stderr };
        } finally {
            await deleteSandboxQuietly(transport, sandbox.id, options.signal);
        }
    };
}

/**
 * Delete the sandbox, handling all four outcomes.
 *
 * Deliberately does NOT throw. A tool that ran to completion has produced
 * output the caller needs, and this module's wrapper documents that losing it
 * is worse than any other failure here — "a truncated tool output is worse than
 * no output". A leaked sandbox is a real cost, so it is logged at `error` with
 * the id and the outcome, which is what makes it findable; it is not a reason to
 * discard a completed tool's result.
 */
async function deleteSandboxQuietly(
    transport: SandboxTransport,
    sandboxId: string,
    signal: AbortSignal,
): Promise<void> {
    try {
        const { outcome } = await transport.deleteSandbox({ sandboxId });

        if (DELETION_IS_SETTLED.includes(outcome)) return;

        // ACCEPTED means admitted, not performed — the gateway's own help text
        // for it reads "Does not wait for". UNSPECIFIED is the zero value and
        // carries no assurance at all, so it takes the same path rather than
        // being read as success.
        if (outcome === 'DELETION_OUTCOME_UNSPECIFIED') {
            logger.warn('sandbox deletion returned the zero value; waiting rather than assuming', {
                component: 'agentic-openshell',
                sandboxId,
                outcome,
            });
        }
        await transport.awaitDeleted({ sandboxId, signal });
    } catch (err) {
        logger.error('sandbox may have leaked: deletion did not settle', {
            component: 'agentic-openshell',
            sandboxId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
