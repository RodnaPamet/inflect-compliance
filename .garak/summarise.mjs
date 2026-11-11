#!/usr/bin/env node
/**
 * Turn one role's garak report (JSONL) and the target proxy's ledger into the
 * night's RECORD for that role, plus a markdown summary for the job page.
 *
 *   node .garak/summarise.mjs <report.jsonl> <ledger.json> <allowlist.tsv> <role> [--md <out.md>]
 *
 * The record (schema `inflect-garak-night/1`) is the Phase 0 shape Phase 2
 * turns into a committed evaluation record:
 *
 *   raw       one row per (probe, detector) exactly as garak scored it —
 *             `evaluated` and `hits`. The source of truth.
 *   families  hit rate per probe family, DERIVED from `raw` on every run and
 *             never stored anywhere else (G11: aggregates are recomputed from
 *             raw answers, a stored figure is never trusted).
 *   complete  TRUE only when something was evaluated AND no request was cut
 *             by the wire cap AND none failed upstream. Zero evaluations is
 *             never a clean night: "no hits" over nothing evidences nothing.
 *   allowlisted  the probe classes .garak/allowlist.tsv names, REPORTED beside
 *             their hits, never subtracted from them.
 *
 * Exit code is 0 whenever a record was written: the nightly is non-blocking
 * (GARAK-NON-BLOCKING-UNTIL in the workflow), and the verdict belongs to
 * Phase 2's threshold assertion. It exits 2 only when its inputs cannot be
 * read, so a broken summary is not mistaken for a quiet night.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RECORD_SCHEMA = 'inflect-garak-night/1';

/** `dan.DanInTheWild` -> `dan`. */
export const familyOf = (probe) => String(probe).replace(/^probes\./, '').split('.')[0];

/** Parse garak's JSONL report; tolerates the field names of 0.1x versions. */
export function parseReport(jsonl) {
    const raw = [];
    let garakVersion = null;
    for (const line of jsonl.split('\n')) {
        if (line.trim() === '') continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.entry_type === 'init' && typeof entry.garak_version === 'string') {
            garakVersion = entry.garak_version;
        }
        if (entry.entry_type !== 'eval') continue;
        const evaluated = Number(entry.total_evaluated ?? entry.total ?? 0);
        const passed = Number(entry.passed ?? 0);
        if (!Number.isFinite(evaluated) || !Number.isFinite(passed)) continue;
        raw.push({
            probe: String(entry.probe).replace(/^probes\./, ''),
            detector: String(entry.detector).replace(/^detector\./, '').replace(/^detectors\./, ''),
            evaluated,
            hits: Math.max(0, evaluated - passed),
        });
    }
    raw.sort((a, b) => (a.probe + a.detector).localeCompare(b.probe + b.detector));
    return { raw, garakVersion };
}

export function parseAllowlist(tsv) {
    return tsv
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('#'))
        .map((l) => l.split('\t'))
        .filter((cols) => cols.length >= 3 && cols[2].trim() !== '')
        .map((cols) => ({ probe: cols[0].trim(), action: cols[1].trim(), reason: cols[2].trim() }));
}

/** Hit rate per family, recomputed from raw. A family with nothing evaluated has rate null. */
export function familiesFrom(raw) {
    const out = {};
    for (const row of raw) {
        const f = (out[familyOf(row.probe)] ??= { evaluated: 0, hits: 0, hitRate: null });
        f.evaluated += row.evaluated;
        f.hits += row.hits;
    }
    for (const f of Object.values(out)) f.hitRate = f.evaluated > 0 ? f.hits / f.evaluated : null;
    return out;
}

export function buildRecord({ report, ledger, allowlist, role }) {
    const { raw, garakVersion } = parseReport(report);
    const evaluated = raw.reduce((n, r) => n + r.evaluated, 0);
    const incompleteReasons = [];
    if (evaluated === 0) incompleteReasons.push('NO_EVALUATIONS');
    if ((ledger.overCap ?? 0) > 0) incompleteReasons.push('REQUEST_CAP_REACHED');
    if ((ledger.upstreamErrors ?? 0) > 0) incompleteReasons.push('UPSTREAM_ERRORS');
    if ((ledger.forwarded ?? 0) === 0) incompleteReasons.push('NOTHING_FORWARDED');
    const allowed = parseAllowlist(allowlist);
    return {
        schema: RECORD_SCHEMA,
        role,
        garakVersion,
        complete: evaluated > 0 && incompleteReasons.length === 0,
        incompleteReasons,
        ledger,
        families: familiesFrom(raw),
        allowlisted: allowed.map((a) => ({
            ...a,
            hits: raw.filter((r) => r.probe === a.probe).reduce((n, r) => n + r.hits, 0),
        })),
        raw,
    };
}

export function toMarkdown(record) {
    const lines = [
        `### garak — ${record.role}`,
        '',
        `Complete: **${record.complete ? 'yes' : 'NO'}**` +
            (record.incompleteReasons.length ? ` (${record.incompleteReasons.join(', ')})` : ''),
        '',
        `Requests forwarded ${record.ledger.forwarded} of cap ${record.ledger.maxRequests}; ` +
            `guard refusals input ${record.ledger.guardRefusedInput}, output ${record.ledger.guardRefusedOutput}; ` +
            `over cap ${record.ledger.overCap}; upstream errors ${record.ledger.upstreamErrors}.`,
        '',
        '| family | evaluated | hits | hit rate |',
        '| --- | ---: | ---: | ---: |',
    ];
    for (const [name, f] of Object.entries(record.families).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(
            `| ${name} | ${f.evaluated} | ${f.hits} | ${f.hitRate === null ? '-' : `${(f.hitRate * 100).toFixed(1)}%`} |`,
        );
    }
    if (record.allowlisted.length) {
        lines.push('', 'Allowlisted (reported, not subtracted):');
        for (const a of record.allowlisted) lines.push(`- ${a.probe} (${a.action}): ${a.hits} hits — ${a.reason}`);
    }
    return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [reportPath, ledgerPath, allowlistPath, role] = process.argv.slice(2, 6);
    const mdAt = process.argv.indexOf('--md');
    if (!reportPath || !ledgerPath || !allowlistPath || !role) {
        process.stderr.write('usage: summarise.mjs <report.jsonl> <ledger.json> <allowlist.tsv> <role> [--md <out>]\n');
        process.exit(2);
    }
    let ledger;
    try {
        ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    } catch {
        process.stderr.write(`summarise: cannot read the proxy ledger at ${ledgerPath}\n`);
        process.exit(2);
    }
    // A missing report is a run that never produced one: recorded as incomplete,
    // never skipped.
    const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';
    const allowlist = existsSync(allowlistPath) ? readFileSync(allowlistPath, 'utf-8') : '';
    const record = buildRecord({ report, ledger, allowlist, role });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (mdAt > 0 && process.argv[mdAt + 1]) writeFileSync(process.argv[mdAt + 1], toMarkdown(record));
}
