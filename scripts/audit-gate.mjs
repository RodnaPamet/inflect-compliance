#!/usr/bin/env node
/**
 * The npm-audit gate, with a tracked allowlist for advisories that have no
 * fixed version.
 *
 * The gate itself is UNCHANGED — still
 *
 *     npm audit --omit=dev --audit-level=moderate
 *
 * on the production dependency tree. This wrapper exists only so a finding
 * that genuinely cannot be fixed today can be tolerated WITH A WRITTEN
 * REASON, instead of the alternative everyone reaches for under pressure:
 * quietly lowering the global gate to `high` and losing every moderate
 * finding along with it. `tests/guardrails/security-gate-strictness.test.ts`
 * blocks that, and this script is the escape hatch it assumes exists.
 *
 * Three ways this fails, all deliberate:
 *
 *   1. An advisory at moderate+ that is NOT allowlisted → fail. The normal
 *      case; nothing about the gate has softened.
 *   2. An allowlisted entry past its `reviewBy` → fail. An exemption with
 *      no expiry is a permanent hole with extra steps.
 *   3. An allowlisted entry that matches NOTHING → fail as STALE. When
 *      upstream ships a fix, the entry must go; otherwise it sits there
 *      silently pre-authorising the next advisory to reuse that id.
 *
 * And one that is NOT a way this may fail: an unreachable registry must never
 * be reported as any of the three. `npm audit` exits non-zero both when it
 * finds advisories and when it cannot reach the registry, and in the second
 * case it writes an `{ "error": … }` object to STDOUT — the same channel, and
 * valid JSON. Parsed as a report that yields zero advisories, which makes
 * every allowlist entry look STALE and tells the reader to delete exemptions
 * that are still entirely valid (#2306). "We could not look" and "we looked
 * and found nothing" are different answers and only one of them is evidence.
 *
 * Run: node scripts/audit-gate.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(ROOT, 'security', 'audit-allowlist.json');
const BLOCKING = new Set(['moderate', 'high', 'critical']);

/**
 * Attempts to reach the registry before giving up.
 *
 * The budget here is not a taste question — the `security` job is
 * `timeout-minutes: 12` and spends roughly a third of that installing before
 * this step runs. A failing `npm audit` does not fail fast: measured on CI
 * 2026-09-04, one took ~5 minutes to give up. Three unbounded attempts
 * therefore blew the job budget and the run was CANCELLED mid-retry, which is
 * strictly worse than the failure it replaced — a cancelled job reports
 * "The operation was canceled" and says nothing about the registry at all.
 *
 * So each attempt is bounded, and the attempts are few: 2 x 180s + 5s of
 * backoff is ~6 minutes worst case, inside the ~8 minutes this step actually
 * has. A healthy audit of this tree takes about a minute, so the per-attempt
 * ceiling is 3x the normal duration and will not cut a working one short.
 */
const AUDIT_ATTEMPTS = 2;
/** Backoff before each retry, in ms. One entry shorter than AUDIT_ATTEMPTS. */
const AUDIT_BACKOFF_MS = [5000];
/**
 * Per-attempt wall clock. A hung npm must not eat the job's whole budget.
 *
 * Overridable ONLY so the regression test can exercise the timeout in seconds
 * rather than minutes. It bounds how long we WAIT; it cannot change what the
 * gate accepts, so a smaller value can only make the gate give up sooner, never
 * let a finding through.
 */
const AUDIT_ATTEMPT_TIMEOUT_MS = Number(process.env.AUDIT_ATTEMPT_TIMEOUT_MS) || 180_000;

/** Block the thread without pulling in a dependency — this script is sync throughout. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One `npm audit`. Returns its stdout, or null if the attempt did not complete.
 *
 * npm exits non-zero when it FINDS something, so a non-zero exit carrying a
 * report on stdout is the ordinary case and is returned. A timeout or a kill
 * yields no usable report, and is reported as null so the caller can retry
 * rather than crash — `execFileSync` surfaces those as a throw with
 * `killed: true`, not as an exit code.
 */
function auditOnce() {
    try {
        return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: AUDIT_ATTEMPT_TIMEOUT_MS,
        });
    } catch (err) {
        if (err.killed || err.signal) return null;
        if (typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
        return null;
    }
}

/**
 * Did npm hand us something that is not a report?
 *
 * Two shapes mean "no answer", and neither is distinguishable from a clean
 * result once you read `.vulnerabilities`:
 *   - `{ "error": { … } }`, which is what a registry 503 / offline run emits;
 *   - anything lacking BOTH `vulnerabilities` and `metadata`, which every real
 *     report carries (npm emits `vulnerabilities: {}` when the tree is clean,
 *     so an absent key is never the clean case).
 */
export function auditUnavailable(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return true;
    if ('error' in report) return true;
    return report.vulnerabilities === undefined && report.metadata === undefined;
}

/**
 * Read the audit report, retrying a registry that is merely having a bad day.
 *
 * Fails CLOSED when the retries are exhausted — an audit that could not run is
 * not a pass — but says so, instead of letting the empty result flow into the
 * STALE check and blame the allowlist.
 */
function runAudit() {
    for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt++) {
        const raw = auditOnce();
        let report = null;
        if (raw !== null) {
            try {
                report = JSON.parse(raw);
            } catch {
                report = null;
            }
        }
        if (!auditUnavailable(report)) return report;
        const detail =
            raw === null
                ? `no output (timed out after ${AUDIT_ATTEMPT_TIMEOUT_MS / 1000}s, or killed)`
                : report && typeof report === 'object' && report.error
                  ? JSON.stringify(report.error)
                  : 'npm returned no report';
        console.error(
            `  npm audit attempt ${attempt}/${AUDIT_ATTEMPTS} did not produce a report: ${detail}`,
        );
        if (attempt < AUDIT_ATTEMPTS) sleepSync(AUDIT_BACKOFF_MS[attempt - 1]);
    }
    console.error(
        '\nnpm audit gate FAILED — the audit could not be run (production deps, moderate+):\n\n' +
            `  The registry did not return a report after ${AUDIT_ATTEMPTS} attempts.\n` +
            '  This is NOT a clean result and NOT a finding about your dependencies.\n\n' +
            '  Do NOT edit security/audit-allowlist.json in response to this. An audit that\n' +
            '  could not run reports zero advisories, which makes every exemption look stale;\n' +
            '  deleting one on that basis removes a real control (#2306).\n\n' +
            '  Re-run the job. If it persists, check https://status.npmjs.org.\n',
    );
    process.exit(1);
}

/** Every advisory id at moderate+ in the production tree, with context. */
function blockingAdvisories(report) {
    const found = new Map();
    for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
        for (const via of v.via ?? []) {
            if (typeof via !== 'object') continue;
            const severity = via.severity ?? v.severity;
            if (!BLOCKING.has(severity)) continue;
            // `via.url` is the advisory permalink; the GHSA id is its tail.
            const id = (via.url ?? '').split('/').filter(Boolean).pop() ?? String(via.source ?? '');
            if (!id) continue;
            found.set(id, { id, pkg, severity, title: via.title ?? '' });
        }
    }
    return found;
}

const report = runAudit();
const found = blockingAdvisories(report);

const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
const entries = allowlist.allow ?? [];
const today = new Date().toISOString().slice(0, 10);

const failures = [];

// 1. Findings nobody has justified.
const unlisted = [...found.values()].filter(
    (f) => !entries.some((e) => e.advisory === f.id),
);
for (const f of unlisted) {
    failures.push(`UNLISTED  ${f.severity.padEnd(8)} ${f.id}  ${f.pkg} — ${f.title}`);
}

// 2. Exemptions that have outlived their review date.
for (const e of entries) {
    if (!e.reviewBy || e.reviewBy < today) {
        failures.push(
            `EXPIRED   ${e.advisory}  ${e.package} — reviewBy ${e.reviewBy ?? '(missing)'} has passed. ` +
                `Re-assess and extend with a fresh reason, or remove it.`,
        );
    }
}

// 3. Exemptions that no longer match anything — upstream fixed it.
for (const e of entries) {
    if (!found.has(e.advisory)) {
        failures.push(
            `STALE     ${e.advisory}  ${e.package} — no longer reported. ` +
                `Delete this entry; leaving it pre-authorises whatever reuses the id.`,
        );
    }
}

if (failures.length > 0) {
    console.error('\nnpm audit gate FAILED (production deps, moderate+):\n');
    for (const f of failures) console.error('  ' + f);
    console.error(
        '\nTo exempt an advisory it must be genuinely unfixable — no released version ' +
            'resolves it. Add it to security/audit-allowlist.json with a reason, a ' +
            'reachability assessment, a reviewBy date and an upgrade plan.\n',
    );
    process.exit(1);
}

const allowed = entries.length;
console.log(
    `npm audit gate PASSED — no unlisted moderate+ advisories in production deps` +
        (allowed ? ` (${allowed} tracked exemption${allowed === 1 ? '' : 's'}, all matched and in date).` : '.'),
);
