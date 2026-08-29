#!/usr/bin/env node
/**
 * HIGH+ gate for the OWASP ZAP scans (nightly baseline + weekly full).
 *
 * `fail_action: true` already fails the job on any alert that is not
 * listed in `.zap/rules.tsv`. But an `IGNORE` line in that file silences
 * an alert at ANY risk level — which is what we want for the Medium-and-
 * below framework false-positives the allowlist was built for, and NOT
 * what we want for a High. A High is fixed, not silenced.
 *
 * So this gate re-reads the ZAP JSON report and fails on every alert with
 * riskcode >= 3 (High / Critical) found in EITHER `alerts` (live) or
 * `ignoredAlerts` (allowlisted). Adding a rules.tsv entry therefore cannot
 * turn a High green.
 *
 * A missing or unparseable report is also a failure: a scan that produced
 * no report is indistinguishable from a scan that found nothing, and the
 * point of this gate is that a green run means the check actually ran.
 *
 * Usage:  node .zap/assert-no-high-risk.mjs <report_json.json>
 * Exit:   0 = no HIGH+ alerts   1 = HIGH+ found, or report unreadable
 */
import { readFileSync } from 'node:fs';

/** ZAP riskcode: 3 = High (the top of the scale; "Critical" is not emitted). */
const HIGH_RISK_CODE = 3;

const reportPath = process.argv[2] || 'report_json.json';

/** GitHub Actions surfaces `::error::` lines in the job summary + annotations. */
const fail = (message) => {
    console.error(`::error::${message}`);
    process.exit(1);
};

let report;
try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
} catch (err) {
    fail(
        `ZAP HIGH+ gate could not read the scan report at "${reportPath}" ` +
            `(${err.message}). A missing report is treated as a FAILURE — it means ` +
            `the scan did not run to completion, not that it found nothing.`,
    );
}

const sites = Array.isArray(report.site) ? report.site : [];
if (sites.length === 0) {
    fail(
        `ZAP HIGH+ gate found no scanned site in "${reportPath}". The scan ` +
            `produced a report but recorded no target, so nothing was actually checked.`,
    );
}

const riskCodeOf = (alert) => {
    const code = Number(alert.riskcode);
    if (Number.isFinite(code)) return code;
    // Fall back to the human string ("High (Medium)") if riskcode is absent.
    return /^high|^critical/i.test(String(alert.riskdesc ?? '')) ? HIGH_RISK_CODE : 0;
};

const high = [];
let scanned = 0;

for (const site of sites) {
    const live = Array.isArray(site.alerts) ? site.alerts : [];
    const ignored = Array.isArray(site.ignoredAlerts) ? site.ignoredAlerts : [];
    scanned += live.length + ignored.length;
    for (const [alerts, allowlisted] of [
        [live, false],
        [ignored, true],
    ]) {
        for (const alert of alerts) {
            if (riskCodeOf(alert) >= HIGH_RISK_CODE) {
                high.push({
                    site: site['@name'] ?? '(unknown site)',
                    pluginId: String(alert.pluginid ?? alert.alertRef ?? 'unknown'),
                    name: alert.alert ?? alert.name ?? '(unnamed alert)',
                    risk: alert.riskdesc ?? `riskcode ${alert.riskcode}`,
                    allowlisted,
                    urls: (Array.isArray(alert.instances) ? alert.instances : [])
                        .map((i) => i.uri)
                        .filter(Boolean)
                        .slice(0, 5),
                });
            }
        }
    }
}

if (high.length > 0) {
    console.error(`ZAP HIGH+ gate: ${high.length} High/Critical alert(s) must be triaged:`);
    for (const a of high) {
        console.error(
            `  - [${a.pluginId}] ${a.name} — ${a.risk}` +
                `${a.allowlisted ? ' (ALLOWLISTED in .zap/rules.tsv — an IGNORE line does NOT clear a HIGH)' : ''}`,
        );
        for (const url of a.urls) console.error(`      ${url}`);
    }
    fail(
        `ZAP HIGH+ gate FAILED: ${high.length} High/Critical alert(s) in "${reportPath}". ` +
            `Fix the app — a HIGH cannot be cleared by adding it to .zap/rules.tsv. ` +
            `See docs/dast.md ("Triaging a finding").`,
    );
}

// Say what was checked, so a passing run is evidence the gate ran rather
// than an ambiguous silence.
console.log(
    `ZAP HIGH+ gate PASSED: 0 High/Critical alerts across ${scanned} alert group(s) ` +
        `in ${sites.length} site(s) from "${reportPath}".`,
);
