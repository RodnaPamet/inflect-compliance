#!/usr/bin/env node
/**
 * The correctness gate over a k6 summary (#4307).
 *
 * The nightly load test runs each k6 step with `continue-on-error`, because
 * its latency thresholds drift on a 2-vCPU runner and a slow night is not a
 * broken build. That also hid a broken test. For at least a month 99.7% of the
 * list requests failed (k6 emptied the cookie jar between iterations, so every
 * virtual user was signed out after its first one), and every run was green.
 *
 * A k6 run can also pass a threshold that measured nothing. A threshold on a
 * sub-metric that no sample matched evaluates as passed:
 * `checks{check:controls_ok}` matched no sample, because k6 writes its own
 * `check` tag (the check's name) over a custom tag of that name. So the
 * per-endpoint check thresholds had been passing over zero samples.
 *
 * This gate reads the summary k6 writes in `handleSummary` and fails when:
 *
 *   1. the summary is missing or unreadable — k6 did not finish, so nothing
 *      was measured;
 *   2. a metric that carries a threshold has no samples — its threshold
 *      passed over nothing;
 *   3. a rate named with `--min <metric>=<fraction>` is below that fraction,
 *      or has no samples.
 *
 * It does not judge latency. The k6 thresholds still report it.
 *
 * Usage:
 *   node scripts/k6-summary-gate.mjs <summary.json> [--min <metric>=<fraction>]...
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** How many samples a metric holds, or null when its type gives no count. */
export function sampleCount(metric) {
    const v = metric?.values ?? {};
    switch (metric?.type) {
        case 'rate':
            return (v.passes ?? 0) + (v.fails ?? 0);
        case 'counter':
            return v.count ?? 0;
        case 'trend':
            // A trend reports no count. Every value of an empty one is 0, and
            // a duration that is exactly 0 in every sample does not occur.
            return Object.values(v).every((x) => x === 0) ? 0 : null;
        default:
            // A gauge's last value can legitimately be 0.
            return null;
    }
}

/**
 * Every reason the summary fails the gate, in a stable order. An empty
 * array means it passes.
 */
export function gateFailures(summary, minimums) {
    const failures = [];
    const metrics = summary?.metrics;
    if (!metrics || typeof metrics !== 'object') {
        return ['the summary has no metrics'];
    }

    for (const name of Object.keys(metrics).sort()) {
        const metric = metrics[name];
        if (!metric?.thresholds || Object.keys(metric.thresholds).length === 0) continue;
        if (sampleCount(metric) === 0) {
            failures.push(`${name}: its threshold passed over no samples`);
        }
    }

    for (const [name, min] of minimums) {
        const metric = metrics[name];
        if (!metric) {
            failures.push(`${name}: not in the summary`);
            continue;
        }
        if (metric.type !== 'rate') {
            failures.push(`${name}: is a ${metric.type}, not a rate`);
            continue;
        }
        if (sampleCount(metric) === 0) {
            failures.push(`${name}: no samples`);
            continue;
        }
        const rate = metric.values.rate;
        if (!(rate >= min)) {
            failures.push(`${name}: ${(rate * 100).toFixed(2)}%, below the ${(min * 100).toFixed(0)}% floor`);
        }
    }
    return failures;
}

/** `--min a=0.95 --min b=0.9` → [['a', 0.95], ['b', 0.9]]. */
export function parseArgs(argv) {
    const [file, ...rest] = argv;
    const minimums = [];
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== '--min') throw new Error(`unknown argument: ${rest[i]}`);
        const spec = rest[++i] ?? '';
        const eq = spec.lastIndexOf('=');
        const min = Number(spec.slice(eq + 1));
        if (eq <= 0 || !Number.isFinite(min) || min < 0 || min > 1) {
            throw new Error(`--min needs <metric>=<fraction between 0 and 1>, got "${spec}"`);
        }
        minimums.push([spec.slice(0, eq), min]);
    }
    if (!file) throw new Error('usage: k6-summary-gate.mjs <summary.json> [--min <metric>=<fraction>]...');
    return { file, minimums };
}

function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(String(err.message ?? err));
        process.exit(2);
    }

    let summary;
    try {
        summary = JSON.parse(readFileSync(args.file, 'utf8'));
    } catch (err) {
        console.error(`FAIL  ${args.file}: no readable summary, so k6 measured nothing (${err.code ?? err.message})`);
        process.exit(1);
    }

    const failures = gateFailures(summary, args.minimums);
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL  ${f}`);
        process.exit(1);
    }
    const floors = args.minimums.map(([n, m]) => `${n} ≥ ${(m * 100).toFixed(0)}%`).join(', ');
    console.log(`PASS  ${args.file}: every thresholded metric has samples${floors ? `; ${floors}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
