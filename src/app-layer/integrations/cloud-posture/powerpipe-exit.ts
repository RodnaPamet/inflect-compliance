/**
 * Powerpipe collector exit-code semantics — shared by every posture provider.
 *
 * WHY THIS MODULE EXISTS. Both collectors used to refuse the run on `!res.ok`,
 * i.e. on ANY non-zero exit, and returned ERROR before the JSON was parsed. That
 * reads the exit code as "did the run happen". It does not mean that:
 *
 *   turbot/pipe-fittings `constants/exit_codes.go`
 *     0  ExitCodeSuccessful
 *     1  ExitCodeControlsAlarm
 *     2  ExitCodeControlsError
 *
 *   powerpipe.io CLI reference
 *     exit 1 — "completed with no runtime or control errors, but there were one
 *               or more alarms"
 *     exit 2 — "completed with no runtime errors, but one or more control
 *               errors occurred"
 *
 * So exit 1 is the ROUTINE outcome of every real compliance benchmark: a single
 * failing control produces it. Refusing on it discarded every benchmark that had
 * anything to report — no verdict, no parsed controls, and therefore no evidence
 * — and made the FAILED arm of the verdict ladder unreachable in production
 * (#2284). Exits 1 and 2 both say the run COMPLETED and wrote its JSON; only an
 * exit outside {0,1,2}, a signal death, or a spawn/stream failure means it did
 * not.
 *
 * The interpretation lives here, once, because it is identical for AWS, Azure
 * and GCP and because a second copy is how the two collectors drifted apart in
 * the first place.
 */

/** Exit codes a benchmark run that COMPLETED can return. */
export const POWERPIPE_EXIT_SUCCESS = 0;
export const POWERPIPE_EXIT_CONTROLS_ALARM = 1;
export const POWERPIPE_EXIT_CONTROLS_ERROR = 2;

/**
 * What the child process actually did — the three states are NOT
 * interchangeable and collapsing them is the latent bug this replaces.
 *
 *   code    a real numeric exit status, or `null` when the child never produced
 *           one. The old derivation was `err.code ?? 1`, which reported a signal
 *           death (`{code: null, signal: 'SIGTERM'}` — including the 15-minute
 *           timeout) as exit 1, i.e. as "ran fine, some controls alarmed".
 *   signal  the POSIX signal that killed the child, when one did.
 *   failure a Node error code STRING — `ENOENT`, or
 *           `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on a 64 MiB overflow. Node puts
 *           these in the same `err.code` field as a numeric status, so the old
 *           field typed `number | null` could hold a string at runtime.
 */
export interface ChildExit {
    code: number | null;
    signal: string | null;
    failure: string | null;
}

/** Truthful `ChildExit` from an `execFile` callback error (`null` on success). */
export function describeChildExit(err: unknown): ChildExit {
    if (!err) return { code: POWERPIPE_EXIT_SUCCESS, signal: null, failure: null };
    const e = err as { code?: unknown; signal?: unknown };
    const signal = typeof e.signal === 'string' && e.signal.length > 0 ? e.signal : null;
    // `typeof code === 'number'` is the discriminator: only then is it an exit
    // status. A string there is a spawn/stream failure, not a status.
    if (typeof e.code === 'number' && Number.isInteger(e.code)) {
        return { code: e.code, signal, failure: null };
    }
    const failure = typeof e.code === 'string' && e.code.length > 0 ? e.code : null;
    return { code: null, signal, failure };
}

/** The four states a collector invocation can land in. */
export type PowerpipeOutcome =
    | 'completed-clean'
    | 'completed-alarms'
    | 'completed-control-errors'
    | 'did-not-complete';

/**
 * Which of the four a `ChildExit` is.
 *
 * Signal death and spawn/stream failure are checked FIRST, so a shape that
 * carries both (maxBuffer overflow sets `code:'ERR_…'` *and* `signal:'SIGTERM'`)
 * can never be read as a completed run.
 */
export function classifyPowerpipeExit(exit: ChildExit): PowerpipeOutcome {
    if (exit.signal !== null || exit.failure !== null) return 'did-not-complete';
    switch (exit.code) {
        case POWERPIPE_EXIT_SUCCESS: return 'completed-clean';
        case POWERPIPE_EXIT_CONTROLS_ALARM: return 'completed-alarms';
        case POWERPIPE_EXIT_CONTROLS_ERROR: return 'completed-control-errors';
        // `null` (no status at all) and every undocumented code land here.
        default: return 'did-not-complete';
    }
}

/** True when the collector produced output worth parsing. */
export function powerpipeRunCompleted(outcome: PowerpipeOutcome): boolean {
    return outcome !== 'did-not-complete';
}

/**
 * The runner's result shape. `code` / `signal` / `failure` are OPTIONAL because
 * the `exec` seam accepts test doubles that model only success-vs-failure; the
 * real runner always supplies them. See `childExitFromCliResult` for how an
 * absent triple is resolved — fail-closed, never as a completed run.
 */
export interface PowerpipeCliResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    missing: boolean;
    code?: number | null;
    signal?: string | null;
    failure?: string | null;
}

/**
 * `ChildExit` for a runner result, including one from a double that omits it.
 *
 * An omitted `code` resolves to exit 0 when the double says the run succeeded
 * and to "no exit status" when it says it failed — so a double that models only
 * `{ok:false}` keeps refusing, exactly as it did before exit codes existed here.
 */
export function childExitFromCliResult(res: PowerpipeCliResult): ChildExit {
    return {
        code: res.code ?? (res.ok ? POWERPIPE_EXIT_SUCCESS : null),
        signal: res.signal ?? null,
        failure: res.failure ?? null,
    };
}

/**
 * Collector-provenance keys to merge into a `CheckResult.details`, which is what
 * the usecases persist as `IntegrationExecution.resultJson`. Empty for a clean
 * exit, so the ordinary run's summary is unchanged; non-empty means the run had
 * something to say about itself and that must not vanish.
 */
export function collectorDiagnostics(exit: ChildExit): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    if (exit.code !== null && exit.code !== POWERPIPE_EXIT_SUCCESS) out.collectorExitCode = exit.code;
    if (exit.signal !== null) out.collectorSignal = exit.signal;
    if (exit.failure !== null) out.collectorFailure = exit.failure;
    return out;
}

/** The per-control counts a verdict is decided from. */
export interface PowerpipeVerdictCounts {
    alarm: number;
    error: number;
    unknown: number;
}

/**
 * The verdict ladder, single-sourced across the three clouds.
 *
 *   alarm            → FAILED. Ranked above error on purpose: a benchmark with
 *                      40 alarms and 1 broken control is a real, actionable
 *                      compliance gap, and reporting ERROR would discard 40
 *                      findings.
 *   error / unknown  → ERROR. `unknown` is #2301's arm — a control we could not
 *                      read is not a passing one.
 *   exit 2           → ERROR rather than PASSED. The collector counted a control
 *                      error that our parse did not; we do not certify
 *                      compliance over a disagreement about what happened. It
 *                      deliberately does NOT downgrade a FAILED — that verdict
 *                      is not a manufactured pass, and the alarms are real.
 *   otherwise        → PASSED.
 */
export function powerpipeVerdict(
    counts: PowerpipeVerdictCounts,
    outcome: PowerpipeOutcome,
): 'FAILED' | 'ERROR' | 'PASSED' {
    if (counts.alarm > 0) return 'FAILED';
    if (counts.error > 0 || counts.unknown > 0) return 'ERROR';
    if (outcome === 'completed-control-errors') return 'ERROR';
    return 'PASSED';
}
