/**
 * Shared cloud-posture core (PR-3).
 *
 * The "run benchmark → parse → summarize" half of the cloud-posture
 * connector, cloud-agnostic. AWS shipped first (`aws-posture-provider.ts`);
 * Azure + GCP reuse this so a 4th cloud is incremental — implement a
 * credential-env builder + a benchmark-id map + a control map, and call
 * `runPowerpipeBenchmark`.
 *
 * The Powerpipe JSON parser + bounded summariser are genuinely
 * cloud-agnostic and already live in `aws-posture-provider.ts` (exported);
 * this module reuses them rather than duplicating.
 *
 * SECURITY: credentials are passed to the CLI via ENV, never argv (argv is
 * visible in process listings). `scrubSecrets` strips the connection's own
 * secret values + a per-cloud pattern set from any captured stdout/stderr
 * before it is surfaced or persisted.
 */
import { execFile } from 'node:child_process';
import { logger } from '@/lib/observability/logger';
import {
    parsePowerpipeBenchmarkJson,
    summariseBenchmark,
    type BenchmarkSummary,
} from '../aws-posture-provider';
import {
    childExitFromCliResult,
    classifyPowerpipeExit,
    collectorDiagnostics,
    describeChildExit,
    powerpipeRunCompleted,
    powerpipeVerdict,
    POWERPIPE_EXIT_CONTROLS_ERROR,
    type PowerpipeCliResult,
} from './powerpipe-exit';
import type { CheckResult } from '../types';

/** One entry in a cloud → IC framework control crosswalk (per-cloud data). */
export interface CloudPostureControlMapEntry {
    label: string;
    /** IC SOC 2 requirement codes this passing check evidences. */
    soc2: string[];
    /** IC NIST CSF 2.0 subcategory codes this passing check evidences. */
    nistCsf?: string[];
}

/** Framework keys the maps crosswalk to — must match the library `Framework.key`. */
export const CLOUD_POSTURE_FRAMEWORK_KEYS = { soc2: 'SOC2', nistCsf: 'NIST-CSF-2.0' } as const;

/**
 * Resolve a benchmark control id to per-framework requirement codes.
 * Shared across clouds so the collector is cloud-agnostic.
 */
export function frameworkCodesForControl(
    map: Record<string, CloudPostureControlMapEntry>,
    controlId: string,
): Array<{ frameworkKey: string; codes: string[] }> {
    const entry = map[controlId];
    if (!entry) return [];
    const out: Array<{ frameworkKey: string; codes: string[] }> = [];
    if (entry.soc2.length) out.push({ frameworkKey: CLOUD_POSTURE_FRAMEWORK_KEYS.soc2, codes: entry.soc2 });
    if (entry.nistCsf?.length) out.push({ frameworkKey: CLOUD_POSTURE_FRAMEWORK_KEYS.nistCsf, codes: entry.nistCsf });
    return out;
}

/** Redact secret values + cloud-specific credential patterns from text. */
export function scrubSecrets(text: string, secretValues: string[] = [], patterns: RegExp[] = []): string {
    let out = text ?? '';
    for (const secret of secretValues) {
        if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
    }
    for (const re of patterns) out = out.replace(re, '[REDACTED]');
    return out;
}

/**
 * Run a Powerpipe benchmark; scrub both output streams.
 *
 * The exit triple rides on the result because a caller cannot interpret an exit
 * code it never receives — this runner used to return `{ok, stdout, stderr,
 * missing}` and nothing else, so the shared core had no way to tell "exited 1
 * with a benchmark's worth of alarms" from "died on SIGTERM" (#2284).
 */
function runCli(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secretValues: string[],
    patterns: RegExp[],
): Promise<PowerpipeCliResult> {
    return new Promise((resolve) => {
        execFile(file, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
            const so = scrubSecrets(String(stdout ?? ''), secretValues, patterns);
            const se = scrubSecrets(String(stderr ?? ''), secretValues, patterns);
            const exit = describeChildExit(err);
            if (exit.failure === 'ENOENT') {
                resolve({ ok: false, stdout: so, stderr: se, missing: true, ...exit });
                return;
            }
            resolve({ ok: !err, stdout: so, stderr: se, missing: false, ...exit });
        });
    });
}

export interface RunBenchmarkInput {
    /** Powerpipe benchmark id, e.g. `azure_compliance.benchmark.soc_2`. */
    benchmarkId: string;
    /** Credential env for the CLI child (creds via env, never argv). */
    env: NodeJS.ProcessEnv;
    /** The connection's own secret values, redacted from output. */
    secretValues: string[];
    /** Cloud-specific credential regexes to redact. */
    patterns?: RegExp[];
    /** Test seam — inject a runner instead of shelling out. */
    exec?: typeof runCli;
    now?: () => number;
}

/**
 * Run a Powerpipe benchmark and return a bounded `CheckResult`. The
 * per-control status array + counts land in `details` (already size-capped
 * by `summariseBenchmark`); creds are scrubbed. `status` is FAILED on any
 * alarm, ERROR on collector/parse failure OR on any control we could not read,
 * else PASSED.
 *
 * Exits 0, 1 and 2 all mean the run COMPLETED, so all three are parsed and
 * scored — see `powerpipe-exit.ts` for the codes and for why refusing on
 * non-zero discarded every benchmark that had anything to report.
 */
export async function runPowerpipeBenchmark(input: RunBenchmarkInput): Promise<CheckResult & { summaryObj: BenchmarkSummary | null }> {
    const exec = input.exec ?? runCli;
    const nowMs = input.now ?? Date.now;
    const start = nowMs();
    const res = await exec('powerpipe', ['benchmark', 'run', input.benchmarkId, '--output', 'json'], input.env, input.secretValues, input.patterns ?? []);
    if (res.missing) {
        return { status: 'ERROR', summary: 'Powerpipe CLI not installed on the collector host.', details: { benchmark: input.benchmarkId }, durationMs: nowMs() - start, errorMessage: 'powerpipe not installed — see docs/cloud-posture-connector.md', summaryObj: null };
    }
    const exit = childExitFromCliResult(res);
    const outcome = classifyPowerpipeExit(exit);
    // The collector's own account of the run, carried into `details` so it
    // survives into `IntegrationExecution.resultJson`. Empty on a clean exit.
    const diagnostics = collectorDiagnostics(exit);
    // H2 — fail CLOSED when the run did NOT complete: a signal death (the
    // 15-minute timeout sends SIGTERM), a maxBuffer overflow, or an exit code
    // outside the documented {0,1,2}. Parsing whatever stdout survived such a
    // run is how a revoked credential became a PASS.
    //
    // The gate is deliberately NOT `!res.ok` any more. Exit 1 means "one or
    // more alarms" and exit 2 "one or more control errors" — both COMPLETED
    // runs that wrote their JSON, and exit 1 is the routine outcome of any
    // benchmark with a single failing control. Refusing them discarded the
    // verdict, the parsed controls, and every piece of evidence a real account
    // would have produced.
    if (!powerpipeRunCompleted(outcome)) {
        return { status: 'ERROR', summary: 'Powerpipe collector did not complete the run.', details: { benchmark: input.benchmarkId, ...diagnostics }, durationMs: nowMs() - start, errorMessage: `collector error; stderr: ${res.stderr.slice(0, 300)}`, summaryObj: null };
    }
    let controls;
    try {
        controls = parsePowerpipeBenchmarkJson(JSON.parse(res.stdout || '{}'));
    } catch {
        return { status: 'ERROR', summary: 'Failed to parse Powerpipe JSON output.', details: { benchmark: input.benchmarkId, ...diagnostics }, durationMs: nowMs() - start, errorMessage: `parse error; stderr: ${res.stderr.slice(0, 300)}`, summaryObj: null };
    }
    const summary = summariseBenchmark(input.benchmarkId, controls);
    // H2 — zero parsed controls is insufficient data, NOT a pass. Only allow
    // PASSED when ≥1 control parsed with a real status.
    if (summary.counts.total === 0) {
        return { status: 'ERROR', summary: `${input.benchmarkId}: no controls parsed (insufficient data).`, details: { ...summary, ...diagnostics }, durationMs: nowMs() - start, errorMessage: 'collector returned zero controls', summaryObj: summary };
    }
    if (exit.code === POWERPIPE_EXIT_CONTROLS_ERROR) {
        // Loud on purpose: exit 2 is the collector telling us a control broke.
        // The verdict below already refuses to call such a run PASSED, but the
        // code must be visible without anyone opening resultJson.
        logger.warn('powerpipe reported control errors', { component: 'cloud-posture', benchmark: input.benchmarkId, collectorExitCode: exit.code, parsedErrorControls: summary.counts.error });
    }
    // The ladder is shared with the AWS collector — an illegible control is not
    // a passing one (`unknown` joins `error`), and an exit-2 run is never PASSED.
    const status: CheckResult['status'] = powerpipeVerdict(summary.counts, outcome);
    return {
        status,
        summary: `${input.benchmarkId}: ${summary.counts.ok} ok / ${summary.counts.alarm} alarm / ${summary.counts.error} error / ${summary.counts.skip} skip / ${summary.counts.unknown} unknown of ${summary.counts.total}`,
        details: { ...summary, ...diagnostics },
        durationMs: nowMs() - start,
        summaryObj: summary,
    };
}
