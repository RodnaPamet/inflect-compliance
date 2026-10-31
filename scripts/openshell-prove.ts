/**
 * Prove each collector sandbox policy is contained within the operator boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SCRIPT EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 5.3's upgrade checklist carried "policy prover re-run" as a pending tick. It
 * was not pending, it was impossible: the gateway's policy schema is version 2
 * and `openshell-prover` accepts version 1 only. `prover-policy.ts` is the
 * translation that closes that gap; this is the runner that uses it.
 *
 *   npm run openshell:prove
 *   OPENSHELL_PROVER=/path/to/openshell-prover npm run openshell:prove
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `unsupported` IS NOT A PASS, AND THAT IS THE WHOLE RISK HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The prover has FOUR outcomes, not two:
 *
 *   0  within_boundary    proven contained
 *   1  exceeds_boundary   proven NOT contained, with a counterexample
 *   2  error              the input was not a policy it could read
 *   3  unsupported        it declined to decide
 *
 * A script that branched on "exit 0 or not" would be correct. One that branched
 * on "did it print a counterexample" would read `unsupported` as a pass, which
 * is the shape this repository keeps paying for: a check that never ran is
 * absent, not green. So the pass set here is the single value
 * `within_boundary`, and every other outcome is reported with the prover's own
 * reason text rather than summarised.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A PASS DOES NOT MEAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enforcement` has no version 1 field. A containment proof bounds the SHAPE of
 * a policy and says nothing about whether the gateway acts on it, so a green
 * run here is not evidence for 0.1b. The translation reports what it had to
 * drop and this script prints it on every run, because a proof whose blind spot
 * is only in a docblock gets quoted without it.
 *
 * @module scripts/openshell-prove
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectorSandboxPolicy } from '../src/lib/agentic/openshell/collector-policy';
import { toProverPolicyV1 } from '../src/lib/agentic/openshell/prover-policy';

/** One benchmark per provider — the three the collectors actually run. */
const BENCHMARKS = [
    'aws_compliance.benchmark.soc_2',
    'azure_compliance.benchmark.soc_2',
    'gcp_compliance.benchmark.cis_v300',
] as const;

const BOUNDARY = 'deploy/openshell/prover-boundary.yaml';

/** The ONLY outcome that is a pass. */
const WITHIN = 'within_boundary';

interface ProverResult {
    readonly result?: string;
    readonly exit_code?: number;
    readonly reason_code?: string | null;
    readonly reason?: string | null;
    readonly counterexample?: unknown;
    readonly prover_version?: string;
}

function proverBinary(): string {
    const explicit = process.env.OPENSHELL_PROVER;
    if (explicit) return explicit;
    // The pinned release, installed beside the gateway binaries.
    return path.join(os.homedir(), 'openshell', 'v0.1.6', 'openshell-prover');
}

function main(): void {
    const bin = proverBinary();
    if (!fs.existsSync(bin)) {
        console.error(`openshell:prove — prover not found at ${bin}`);
        console.error('Set OPENSHELL_PROVER to its path. The binary is not vendored:');
        console.error('it is 14 MB, carries an embedded SMT solver, and is verified');
        console.error('against the published checksums at install time.');
        process.exit(2);
    }
    if (!fs.existsSync(BOUNDARY)) {
        console.error(`openshell:prove — boundary policy missing: ${BOUNDARY}`);
        process.exit(2);
    }

    const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`openshell:prove — ${version}, boundary ${BOUNDARY}\n`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-prove-'));
    let failures = 0;
    let dropped: readonly string[] = [];

    for (const benchmarkId of BENCHMARKS) {
        const policy = collectorSandboxPolicy(benchmarkId);
        const { policy: v1, unrepresentable } = toProverPolicyV1(policy);
        dropped = unrepresentable;

        const candidate = path.join(tmp, `${policy.provider}.json`);
        fs.writeFileSync(candidate, JSON.stringify(v1, null, 2));

        // `execFileSync` throws on a non-zero exit, and a non-zero exit is the
        // normal way this tool reports a refusal. So the verdict is read from
        // the JSON on BOTH paths rather than from the throw.
        let raw = '';
        try {
            /*
                THE SOLVER BUDGET IS EXPLICIT, because the default stopped being
                enough — measured on 2026-10-31.

                `--timeout` defaults to 10s, which sufficed while the boundary
                held 41 endpoints. #4569 replaced `*.amazonaws.com` with 135
                explicit hosts, taking the boundary to 175, and at 10s the
                solver returned `inconclusive` with `reason_code:
                solver_timeout` — for GCP as well, which had been proving fine.
                A timeout is NOT a pass and `openshell:prove` already treats it
                as a failure, so this would have gone red rather than quiet.

                At 60s all three prove `within_boundary` and the whole run takes
                ~35s. 120s is set rather than 60 for headroom on a slower
                machine; the honest claim is "10s is too small and 60s is
                enough", not a derived per-proof figure, because a run that
                finishes inside its bound cannot tell you how close it came.
            */
            raw = execFileSync(bin, ['check', '--boundary', BOUNDARY, candidate, '-o', 'json', '--timeout', '120s'], {
                encoding: 'utf8',
            });
        } catch (e) {
            raw = String((e as { stdout?: string }).stdout ?? '');
        }

        let parsed: ProverResult = {};
        try {
            parsed = JSON.parse(raw) as ProverResult;
        } catch {
            console.log(`  ✗ ${policy.provider.padEnd(6)} UNREADABLE prover output`);
            failures += 1;
            continue;
        }

        const verdict = parsed.result ?? 'no-result';
        const endpoints = v1.network_policies[policy.provider].endpoints.length;
        if (verdict === WITHIN) {
            console.log(`  ✓ ${policy.provider.padEnd(6)} ${verdict}  (${endpoints} endpoints)`);
            continue;
        }

        failures += 1;
        console.log(`  ✗ ${policy.provider.padEnd(6)} ${verdict}  (${endpoints} endpoints)`);
        if (parsed.reason_code) console.log(`        reason_code: ${parsed.reason_code}`);
        if (parsed.reason) console.log(`        reason: ${parsed.reason}`);
        if (parsed.counterexample) {
            console.log(`        counterexample: ${JSON.stringify(parsed.counterexample)}`);
        }
    }

    fs.rmSync(tmp, { recursive: true, force: true });

    console.log(`\n  NOT PROVEN BY ANY OF THE ABOVE: ${dropped.join(', ')}`);
    console.log('  `enforcement` has no version 1 field, so a pass here is not');
    console.log('  evidence that the policy enforces rather than audits (0.1b).');

    if (failures > 0) {
        console.error(`\nopenshell:prove — ${failures} of ${BENCHMARKS.length} not proven.`);
        process.exit(1);
    }
    console.log(`\nopenshell:prove — all ${BENCHMARKS.length} within the boundary.`);
}

main();
