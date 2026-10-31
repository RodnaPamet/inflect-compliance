/**
 * RUN THE POWERPIPE COLLECTORS IN A SANDBOX — 4.1 (#3961).
 *
 * The collectors `execFile` a third-party binary while holding cloud
 * credentials. This is the bridge that moves that execution into an OpenShell
 * sandbox, and it is deliberately thin: every piece it needs already exists,
 * and reusing them rather than reimplementing is the point.
 *
 *   `runBoundedTool`            the 15-minute deadline and the 64 MB cap, which
 *                               are already its defaults — so "the bounds move
 *                               with the call" is satisfied by using it rather
 *                               than by copying two constants
 *   `openShellToolExecutor`     the sandbox lifecycle, and it already shapes its
 *                               result for `describeChildExit`
 *   `collectorSandboxPolicy`    4.1's policy: every endpoint enforcing, landlock
 *                               hard_requirement, read-only root, non-root user
 *   `childExitFromCliResult`    the collectors' existing fail-closed classifier
 *
 * ═══ WHY THIS RETURNS A `PowerpipeCliResult` AND NOTHING SMARTER ═══
 *
 * Because the fail-closed semantics are already correct and already tested, and
 * a second copy of them would be the thing that drifts. `runPowerpipeBenchmark`
 * refuses a run that did not complete, a parse failure, zero controls and an
 * exit-2 run, and `powerpipeVerdict` will not call any of them PASSED. So this
 * bridge's whole job is to land a sandbox failure in the SAME shape an
 * `execFile` failure lands in — a `ChildExit` whose `signal` or `failure` is
 * non-null — and let the existing ladder reach ERROR on its own.
 *
 * Every sandbox failure mode therefore maps to `failure`, which
 * `classifyPowerpipeExit` reads as `did-not-complete`:
 *
 *   gateway unreachable / not configured   SANDBOX_UNREACHABLE
 *   stream closed with no exit event       SANDBOX_EXEC_INCOMPLETE
 *   deadline or output cap                 SANDBOX_BOUND_<name>
 *   creation or provider attach refused    SANDBOX_SETUP_REFUSED
 *
 * The second of those is the issue's own requirement — "treat that throw as a
 * failed collection, never a partial success" — and it is why this catches
 * rather than lets the throw escape: an escaping throw is an unhandled
 * rejection in a scheduled job, which is a different and worse failure than a
 * recorded ERROR.
 *
 * ═══ CREDENTIALS DO NOT PASS THROUGH HERE ═══
 *
 * No `env` is forwarded to the sandbox. The gateway holds the credential as a
 * named provider and injects it, which is the bullet's distinction: an env var
 * is readable by the binary we are confining, by anything it spawns, and by
 * `/proc/<pid>/environ`. The provider is attached and WAITED FOR before the
 * exec, because the gateway applies an attachment asynchronously and a
 * collector that ran before its credential arrived would fail in a way that
 * looks like a revoked key.
 */
import {
    runBoundedTool,
    ToolExecutionBoundError,
    TOOL_EXEC_MAX_OUTPUT_BYTES,
    TOOL_EXEC_TIMEOUT_MS,
} from '@/lib/agentic/bounded-exec';
import { env } from '@/env';
import { openShellToolExecutor } from '@/lib/agentic/openshell/executor';
import {
    SandboxExecIncompleteError,
    SandboxUnreachableError,
    unconfiguredTransport,
    type SandboxTransport,
} from '@/lib/agentic/openshell/transport';
import { readSandboxExecutionPlatformEnabled } from '@/app-layer/usecases/sandbox-runtime-config';
import { scrubSecrets } from './powerpipe-core';
import {
    gatewayIsReady,
    startGatewayAndWait,
    type StartResult,
} from '@/lib/sandbox-runtime/gateway-start';
import type { PowerpipeCliResult } from './powerpipe-exit';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';

/** Exit status a shell gives for a binary that is not there. */
const EXIT_COMMAND_NOT_FOUND = 127;

/** The collectors' runner shape, which this bridge has to satisfy exactly. */
export type CollectorExec = (
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secretValues: string[],
    patterns: RegExp[],
) => Promise<PowerpipeCliResult>;

export interface SandboxedCollectorDeps {
    readonly transport?: SandboxTransport;
    /** The gateway-side provider holding this collector's cloud credential. */
    readonly providerName: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /**
     * Record each sandbox lifecycle decision — 5.1 (#3971).
     *
     * Optional, and the default of NOT recording is deliberate rather than
     * lazy: a caller without a tenant context has nothing to file a row
     * against, and a row written under a guessed tenant is worse than no row.
     * `sandboxDecisionRecorder(db, ctx)` builds one where a context exists.
     */
    readonly onDecision?: (decision: SandboxDecision) => Promise<void>;
    /**
     * Start the gateway VM and wait for it, before any sandbox is created — 4.3
     * (#4562). Injected so a test can drive every outcome without a VM.
     *
     * Owner decision 2026-10-30: the caller starts the machine. There is no
     * start schedule, because the 5 USD/month cap is a runtime budget of ~45
     * hours and a day with no scan must cost nothing. The accepted cost is ~45
     * seconds of cold boot inside a scan's latency budget, measured.
     */
    readonly startGateway?: () => Promise<StartResult>;
}

/** A failed result in the one shape the collectors' classifier reads. */
function didNotComplete(failure: string, stderr: string): PowerpipeCliResult {
    return { ok: false, stdout: '', stderr, missing: false, code: null, signal: null, failure };
}

/**
 * Build a collector runner that executes in a sandbox.
 *
 * `transport` defaults to the refusing stub, and that default is load-bearing
 * rather than a convenience: a deploy that has turned sandboxed execution ON
 * without a gateway to run it gets `SANDBOX_UNREACHABLE` on every collection,
 * which the ladder reports as ERROR. That is the correct direction — the deploy
 * has declared a capability it cannot provide — and it is why the switch is off
 * by default.
 */
/**
 * The default starter: read the deploy's three variables and start that VM.
 *
 * Returns `unavailable` without calling anything when the deploy names no
 * instance, and that is the common case rather than an error — a deploy with no
 * `SANDBOX_RUNTIME_GATEWAY_INSTANCE` is not describing a machine this product
 * may start. It is also what a local gateway looks like: already running,
 * started by a person, nothing for us to do.
 */
function startFromEnv(): Promise<StartResult> {
    return startGatewayAndWait({
        healthUrl: env.SANDBOX_RUNTIME_HEALTH_URL,
        project: env.SANDBOX_RUNTIME_GATEWAY_PROJECT,
        zone: env.SANDBOX_RUNTIME_GATEWAY_ZONE,
        instance: env.SANDBOX_RUNTIME_GATEWAY_INSTANCE,
    });
}

/** Whether this deploy names a VM to start at all. */
export function gatewayStartIsConfigured(): boolean {
    return Boolean(
        env.SANDBOX_RUNTIME_GATEWAY_PROJECT &&
            env.SANDBOX_RUNTIME_GATEWAY_ZONE &&
            env.SANDBOX_RUNTIME_GATEWAY_INSTANCE,
    );
}

export function sandboxedCollectorExec(deps: SandboxedCollectorDeps): CollectorExec {
    const transport = deps.transport ?? unconfiguredTransport;
    const startGateway = deps.startGateway ?? startFromEnv;
    const timeoutMs = deps.timeoutMs ?? TOOL_EXEC_TIMEOUT_MS;
    const maxOutputBytes = deps.maxOutputBytes ?? TOOL_EXEC_MAX_OUTPUT_BYTES;

    return async (file, args, _env, secretValues, patterns) => {
        // One scrubber for all three clouds, because the per-cloud difference is
        // the PATTERN LIST and that already rides on the call. An injectable
        // scrubber was the first shape here and it was redundant: this is the
        // value loop plus those patterns, which is exactly what each cloud's
        // own scrubber is.
        const scrub = (t: string) => scrubSecrets(t, secretValues, patterns);

        // The provider attach needs its own abort signal: it happens before
        // `runBoundedTool` owns one, and an attach that hangs must not hang the
        // collection. Bounded by the same deadline the run gets.
        const setup = new AbortController();
        const setupTimer = setTimeout(() => setup.abort(), timeoutMs);

        try {
            /*
                START THE MACHINE FIRST — 4.3 (#4562), and INSIDE this try for a
                reason a test found: the catch below is what turns a
                `SandboxUnreachableError` into a classified
                `SANDBOX_UNREACHABLE` result. Thrown from outside it, the error
                escapes as an exception and the collector stops returning a
                `PowerpipeCliResult` at all — which changes the ladder's
                semantics rather than feeding it.

                Per CALL and not per build, because the idle timer takes the VM
                down after 20 minutes of no sandbox activity: a runner built
                once and used twice an hour would find it gone the second time.

                Skipped entirely when the deploy names no instance, which is
                every deploy today and also what a local gateway looks like. A
                start that was ATTEMPTED and did not reach `readyz` refuses
                rather than proceeding, because the only thing a sandbox create
                could do then is fail more slowly having already spent the boot.
            */
            if (gatewayStartIsConfigured()) {
                const start = await startGateway();
                if (!gatewayIsReady(start.outcome)) {
                    throw new SandboxUnreachableError(
                        `the gateway VM did not become ready: ${start.outcome} after ${start.waitedMs}ms`,
                    );
                }
            }

            // The provider is attached through the executor's own hook, which
            // runs after the sandbox exists and before the tool does. Attaching
            // from out here is not possible and should not be: the executor owns
            // one sandbox per execution and never hands the id out.
            const exec = openShellToolExecutor(transport, {
                onSandboxReady: async ({ sandboxId, signal }) => {
                    await transport.attachProvider({
                        sandboxId,
                        providerName: deps.providerName,
                        signal,
                    });
                },
                // Forwarded, not wrapped: the executor is what knows the
                // lifecycle, and it already isolates a recording failure so one
                // cannot discard a collection that ran.
                onDecision: deps.onDecision,
            });
            // NOTE the absent `env`: credentials reach the sandbox through the
            // attached provider and through nothing else.
            const result = await runBoundedTool({
                tool: 'powerpipe',
                file,
                args,
                timeoutMs,
                maxOutputBytes,
                deps: { exec: async (f, a, options) => exec(f, a, { ...options, env: undefined }) },
            });
            clearTimeout(setupTimer);

            const missing = result.exit.code === EXIT_COMMAND_NOT_FOUND;
            return {
                ok: result.exit.code === 0 && result.exit.signal === null && result.exit.failure === null,
                stdout: scrub(result.stdout),
                stderr: scrub(result.stderr),
                missing,
                ...result.exit,
            };
        } catch (err) {
            clearTimeout(setupTimer);
            // ORDER MATTERS: the specific sandbox errors first, then the bound
            // errors, then anything else. A bound error carries a name worth
            // keeping (`ToolExecutionOutputCapError` vs a timeout), and an
            // unknown throw must still become a recorded ERROR rather than an
            // unhandled rejection in a scheduled job.
            if (err instanceof SandboxUnreachableError) {
                return didNotComplete('SANDBOX_UNREACHABLE', scrub(err.message));
            }
            if (err instanceof SandboxExecIncompleteError) {
                // The issue's own words: never a partial success.
                return didNotComplete('SANDBOX_EXEC_INCOMPLETE', scrub(err.message));
            }
            if (err instanceof ToolExecutionBoundError) {
                return didNotComplete(`SANDBOX_BOUND_${err.name}`, scrub(err.message));
            }
            return didNotComplete(
                'SANDBOX_SETUP_REFUSED',
                scrub(err instanceof Error ? err.message : String(err)),
            );
        }
    };
}

/**
 * The runner this deploy should use, or `null` to leave the caller's default.
 *
 * `null` is the answer whenever the platform switch is off, which is its
 * default, so an unconfigured deploy keeps the on-host `execFile` path exactly
 * as it was. Returning `undefined`-by-omission rather than a no-op runner is
 * deliberate: the providers' on-disk credential handling keys off whether a
 * runner was supplied, and a no-op runner would suppress the key write while
 * still running on the host.
 */
export function collectorExecForDeploy(
    deps: Omit<SandboxedCollectorDeps, 'providerName'> & { providerName?: string } = {},
): CollectorExec | null {
    if (!readSandboxExecutionPlatformEnabled()) return null;
    return sandboxedCollectorExec({
        ...deps,
        providerName: deps.providerName ?? 'inflect-collector',
    });
}
