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
import {
    parsePowerpipeBenchmarkJson,
    summariseBenchmark,
    type BenchmarkSummary,
} from '../aws-posture-provider';
import type { CheckResult } from '../types';
import { throwIfPostureCredentialFailure } from '../posture-credential-classification';

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

/** Run a Powerpipe benchmark; scrub both output streams. */
function runCli(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secretValues: string[],
    patterns: RegExp[],
): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
    return new Promise((resolve) => {
        execFile(file, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
            const so = scrubSecrets(String(stdout ?? ''), secretValues, patterns);
            const se = scrubSecrets(String(stderr ?? ''), secretValues, patterns);
            if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                resolve({ ok: false, stdout: so, stderr: se, missing: true });
                return;
            }
            resolve({ ok: !err, stdout: so, stderr: se, missing: false });
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
 * alarm, ERROR on collector/parse failure, else PASSED.
 */
export async function runPowerpipeBenchmark(input: RunBenchmarkInput): Promise<CheckResult & { summaryObj: BenchmarkSummary | null }> {
    const exec = input.exec ?? runCli;
    const nowMs = input.now ?? Date.now;
    const start = nowMs();
    const res = await exec('powerpipe', ['benchmark', 'run', input.benchmarkId, '--output', 'json'], input.env, input.secretValues, input.patterns ?? []);
    if (res.missing) {
        return { status: 'ERROR', summary: 'Powerpipe CLI not installed on the collector host.', details: { benchmark: input.benchmarkId }, durationMs: nowMs() - start, errorMessage: 'powerpipe not installed — see docs/cloud-posture-connector.md', summaryObj: null };
    }
    // H2 — fail CLOSED on a non-zero collector exit. Previously `JSON.parse(
    // res.stdout || '{}')` ran regardless of `res.ok`, so a revoked credential
    // (non-zero exit, empty stdout) parsed to zero controls and the ladder
    // below yielded PASSED — marking the tenant compliant off a broken run.
    if (!res.ok) {
        // …and a revoked credential is ALSO how a non-zero exit presents, which
        // is the half that reached nothing. The collector's `catch` is what
        // marks the connection credential-revoked, and returning ERROR here
        // meant that catch never ran — so an expired Azure client secret or a
        // deleted GCP service-account key looked identical to a network blip
        // and the banner could never be raised. Classify the (already-scrubbed)
        // stderr FIRST: an unambiguous authentication code throws, everything
        // else stays an ordinary collector ERROR. Deliberately the FULL stderr,
        // not the 300-char excerpt below — the excerpt is what the ledger shows
        // a human, and classifying a truncated copy would drop verdicts at
        // random depending on how chatty the CLI was first.
        throwIfPostureCredentialFailure(res.stderr, input.benchmarkId);
        return { status: 'ERROR', summary: 'Powerpipe collector exited non-zero.', details: { benchmark: input.benchmarkId }, durationMs: nowMs() - start, errorMessage: `collector error; stderr: ${res.stderr.slice(0, 300)}`, summaryObj: null };
    }
    let controls;
    try {
        controls = parsePowerpipeBenchmarkJson(JSON.parse(res.stdout || '{}'));
    } catch {
        return { status: 'ERROR', summary: 'Failed to parse Powerpipe JSON output.', details: { benchmark: input.benchmarkId }, durationMs: nowMs() - start, errorMessage: `parse error; stderr: ${res.stderr.slice(0, 300)}`, summaryObj: null };
    }
    const summary = summariseBenchmark(input.benchmarkId, controls);
    // H2 — zero parsed controls is insufficient data, NOT a pass. Only allow
    // PASSED when ≥1 control parsed with a real status.
    if (summary.counts.total === 0) {
        return { status: 'ERROR', summary: `${input.benchmarkId}: no controls parsed (insufficient data).`, details: summary as unknown as Record<string, unknown>, durationMs: nowMs() - start, errorMessage: 'collector returned zero controls', summaryObj: summary };
    }
    const status: CheckResult['status'] = summary.counts.alarm > 0 ? 'FAILED' : summary.counts.error > 0 ? 'ERROR' : 'PASSED';
    return {
        status,
        summary: `${input.benchmarkId}: ${summary.counts.ok} ok / ${summary.counts.alarm} alarm / ${summary.counts.skip} skip of ${summary.counts.total}`,
        details: summary as unknown as Record<string, unknown>,
        durationMs: nowMs() - start,
        summaryObj: summary,
    };
}
