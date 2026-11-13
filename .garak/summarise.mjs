#!/usr/bin/env node
/**
 * Turn one role's garak report (JSONL) and the target proxy's ledger into the
 * night's RECORD for that role, plus a markdown summary for the job page.
 *
 *   node .garak/summarise.mjs <report.jsonl> <ledger.json> <allowlist.tsv> <role>
 *       --probes <comma-separated probe_spec> --garak-exit <code>
 *       [--provenance <provenance.json>] [--md <out.md>]
 *
 * The record (schema `inflect-garak-night/1`) is the Phase 0 shape Phase 2
 * turns into a committed evaluation record:
 *
 *   raw       one row per (probe, detector) exactly as garak scored it —
 *             `evaluated` and `hits`. The source of truth.
 *   families  hit rate per probe family, DERIVED from `raw` on every run and
 *             never stored anywhere else (G11: aggregates are recomputed from
 *             raw answers, a stored figure is never trusted).
 *   complete  TRUE only when EVERY configured probe has scored outputs, garak
 *             exited 0, no request was cut by the wire cap, none failed
 *             upstream and no rate limit was abandoned. A night garak left
 *             partway (killed by the timeout, a crash between probes) writes
 *             eval rows for the probes it finished and none for the rest, and
 *             no ledger counter moves, so "something was evaluated" alone
 *             would call a subset of the families a complete night. Zero
 *             evaluations is never a clean night either: "no hits" over
 *             nothing evidences nothing.
 *   notEvaluated  the configured probes with no scored output, by name.
 *   provenance  how the role's ANSWERS were produced, from the product's own
 *             Art 12 rows (AiDecisionLog, feature 'assistant'; the workflow
 *             counts the rows the role added, .garak/provenance.sql). An
 *             answer garak scored is a statement about the MODEL only when a
 *             model produced it: the keyword router's posture sentence and the
 *             loop's "the language model was unavailable" notice both pass
 *             every detector, so a night of them reads as a perfect score
 *             while measuring nothing (runs 43337664860 and 43380024012). So:
 *             no turn reached the model -> NO_MODEL_TURNS; some answers did
 *             not -> ANSWERS_NOT_FROM_MODEL; fewer rows than answers ->
 *             ANSWERS_UNRECORDED; no provenance at all ->
 *             MODEL_PROVENANCE_UNKNOWN. Each makes the night incomplete.
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

/** The configured probes that produced no scored output at all. */
export function probesNotEvaluated(raw, probes) {
    const scored = new Set(raw.filter((r) => r.evaluated > 0).map((r) => r.probe));
    return probes.map((p) => p.replace(/^probes\./, '')).filter((p) => !scored.has(p));
}

/**
 * @param {{ report: string, ledger: object, allowlist: string, role: string,
 *           probes: string[], garakExit: number | null }} input
 *   `probes` is the configured probe_spec; `garakExit` is garak's exit code
 *   (null when it was not recorded, which is never read as success).
 */
/**
 * The provenance reasons, on their own so the rule is testable without a report.
 *
 * A turn REACHED the model when its row carries tokens (the provider's own
 * usage count), or when the egress guard withheld its answer (the guard ran on
 * model output, and that turn writes no row). A row naming a model provider
 * with no tokens is a turn whose provider call failed: the loop answered with
 * its "model was unavailable" notice.
 */
export function provenanceReasons(ledger, provenance) {
    if (provenance === null || provenance === undefined) return ['MODEL_PROVENANCE_UNKNOWN'];
    const reasons = [];
    const reachedModel = (provenance.fromModel ?? 0) + (ledger.guardRefusedOutput ?? 0);
    if ((ledger.forwarded ?? 0) > 0 && reachedModel === 0) reasons.push('NO_MODEL_TURNS');
    else if ((provenance.deterministic ?? 0) + (provenance.modelUnreached ?? 0) > 0) {
        reasons.push('ANSWERS_NOT_FROM_MODEL');
    }
    if ((provenance.recorded ?? 0) < (ledger.answers ?? 0)) reasons.push('ANSWERS_UNRECORDED');
    return reasons;
}

export function buildRecord({ report, ledger, allowlist, role, probes, garakExit, provenance = null }) {
    const { raw, garakVersion } = parseReport(report);
    const evaluated = raw.reduce((n, r) => n + r.evaluated, 0);
    const notEvaluated = probesNotEvaluated(raw, probes);
    const incompleteReasons = [];
    if (evaluated === 0) incompleteReasons.push('NO_EVALUATIONS');
    if (probes.length === 0) incompleteReasons.push('NO_PROBES_CONFIGURED');
    if (notEvaluated.length > 0) incompleteReasons.push('PROBES_NOT_EVALUATED');
    if (garakExit !== 0) incompleteReasons.push(garakExit === null ? 'GARAK_EXIT_UNKNOWN' : 'GARAK_EXIT_NONZERO');
    if ((ledger.overCap ?? 0) > 0) incompleteReasons.push('REQUEST_CAP_REACHED');
    if ((ledger.upstreamErrors ?? 0) > 0) incompleteReasons.push('UPSTREAM_ERRORS');
    if ((ledger.rateLimitAbandoned ?? 0) > 0) incompleteReasons.push('RATE_LIMITED');
    if ((ledger.forwarded ?? 0) === 0) incompleteReasons.push('NOTHING_FORWARDED');
    incompleteReasons.push(...provenanceReasons(ledger, provenance));
    const allowed = parseAllowlist(allowlist);
    return {
        schema: RECORD_SCHEMA,
        role,
        garakVersion,
        complete: evaluated > 0 && notEvaluated.length === 0 && incompleteReasons.length === 0,
        incompleteReasons,
        notEvaluated,
        garakExit,
        ledger,
        provenance,
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
        ...(record.notEvaluated.length ? [`Not evaluated: ${record.notEvaluated.join(', ')}.`, ''] : []),
        `Requests forwarded ${record.ledger.forwarded} of cap ${record.ledger.maxRequests}; ` +
            `guard refusals input ${record.ledger.guardRefusedInput}, output ${record.ledger.guardRefusedOutput}; ` +
            `over cap ${record.ledger.overCap}; over the product's question length (not deliverable, ` +
            `not scored) ${record.ledger.overLength ?? 0}; rate limits abandoned ${record.ledger.rateLimitAbandoned ?? 0}; ` +
            `upstream errors ${record.ledger.upstreamErrors}` +
            (record.ledger.upstreamErrors ? ` (${JSON.stringify(record.ledger.upstreamErrorStatuses ?? {})})` : '') +
            `; garak exit ${record.garakExit ?? 'unknown'}.`,
        '',
        record.provenance
            ? `How the answers were produced (decision log): model ${record.provenance.fromModel}, ` +
              `keyword router ${record.provenance.deterministic}, model call failed ` +
              `${record.provenance.modelUnreached}, rows ${record.provenance.recorded} for ` +
              `${record.ledger.answers} answers; egress-withheld (model reached) ${record.ledger.guardRefusedOutput}.`
            : 'How the answers were produced: UNKNOWN (no provenance recorded).',
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
    const flag = (name) => {
        const at = process.argv.indexOf(name);
        return at > 0 ? process.argv[at + 1] : undefined;
    };
    const probesArg = flag('--probes');
    const exitArg = flag('--garak-exit');
    if (!reportPath || !ledgerPath || !allowlistPath || !role || probesArg === undefined) {
        process.stderr.write(
            'usage: summarise.mjs <report.jsonl> <ledger.json> <allowlist.tsv> <role> --probes <csv> --garak-exit <code> [--md <out>]\n',
        );
        process.exit(2);
    }
    const probes = probesArg.split(',').map((p) => p.trim()).filter(Boolean);
    const garakExit = /^\d+$/.test(exitArg ?? '') ? Number(exitArg) : null;
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
    // An absent or unreadable provenance file is recorded as unknown, which
    // makes the night incomplete; it is never read as "every answer was the model's".
    const provenancePath = flag('--provenance');
    let provenance = null;
    if (provenancePath && existsSync(provenancePath)) {
        try {
            provenance = JSON.parse(readFileSync(provenancePath, 'utf-8'));
        } catch {
            provenance = null;
        }
    }
    const record = buildRecord({ report, ledger, allowlist, role, probes, garakExit, provenance });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    const mdOut = flag('--md');
    if (mdOut) writeFileSync(mdOut, toMarkdown(record));
}
