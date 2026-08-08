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
 * Run: node scripts/audit-gate.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(ROOT, 'security', 'audit-allowlist.json');
const BLOCKING = new Set(['moderate', 'high', 'critical']);

/** `npm audit` exits non-zero when it finds anything — capture regardless. */
function runAudit() {
    try {
        return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch (err) {
        if (typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
        throw err;
    }
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

const report = JSON.parse(runAudit());
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
