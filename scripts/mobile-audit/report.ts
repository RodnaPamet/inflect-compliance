/**
 * The audit's report: one record per captured page and configuration
 * (`metrics.json`), and the summary a person reads (`summary.md`) — the
 * roadmap's headline table (pages failing each check, per configuration), the
 * routes and states that could not be captured and why, and the worst pages
 * per check.
 *
 * `compareReports` is the whole-product ratchet a pull request can run: it
 * compares a fresh report against a reference one (typically `main`) and
 * fails when any count of pages failing a check went UP, or when more routes
 * went uncaptured — a page that stops rendering must not lower a count.
 *
 * Counts are compared over the routes BOTH reports captured. A route captured
 * for the first time (a new page, or a detail page whose record the fixture
 * setup now creates) has no previous count to have risen from: it is listed
 * as newly measured and becomes part of the comparison from the next run on.
 * A route that stopped being captured is caught by the uncaptured count.
 */
import { MOBILE_METRICS, type MetricCounts, type MobileMetricId, type MeasureSample } from './measure';
import type { Leak } from './leaks';

export interface CapturedPage {
    kind: 'route' | 'state';
    /** The route pattern, or `state:<id>`. */
    id: string;
    config: string;
    url: string;
    /** Where the browser ended up (a redirect lands elsewhere). */
    finalUrl: string;
    status: number | null;
    counts: MetricCounts;
    samples: Partial<Record<string, MeasureSample[]>>;
    leaks: Leak[];
    consoleErrors: string[];
    screenshot?: string;
}

export interface UncapturedPage {
    kind: 'route' | 'state';
    id: string;
    config: string;
    reason: string;
}

export interface AuditReport {
    generatedAt: string;
    baseUrl: string;
    commit: string | null;
    configs: string[];
    routeCount: number;
    captured: CapturedPage[];
    uncaptured: UncapturedPage[];
    /** What the fixture setup did (`--create-records`); absent when it did not run. */
    setup?: { created: string[]; minted: string[]; failed: Record<string, string> };
}

/** The route patterns captured in `config`. */
export function capturedRoutes(report: AuditReport, config: string): Set<string> {
    return new Set(report.captured.filter((p) => p.kind === 'route' && p.config === config).map((p) => p.id));
}

/**
 * Pages (routes, not states) failing each check, per configuration; with
 * `only`, counting only the routes it holds for that configuration.
 */
export function headline(
    report: AuditReport,
    only?: (config: string) => ReadonlySet<string>,
): Record<string, Record<MobileMetricId, number>> {
    const out: Record<string, Record<MobileMetricId, number>> = {};
    for (const config of report.configs) {
        const row = Object.fromEntries(MOBILE_METRICS.map((m) => [m.id, 0])) as Record<MobileMetricId, number>;
        const within = only?.(config);
        for (const p of report.captured) {
            if (p.kind !== 'route' || p.config !== config) continue;
            if (within && !within.has(p.id)) continue;
            for (const m of MOBILE_METRICS) if (p.counts[m.id] > 0) row[m.id] += 1;
        }
        out[config] = row;
    }
    return out;
}

export function uncapturedRouteCount(report: AuditReport, config: string): number {
    return report.uncaptured.filter((u) => u.kind === 'route' && u.config === config).length;
}

export function renderSummary(report: AuditReport): string {
    const h = headline(report);
    const lines: string[] = [];
    lines.push(`# Mobile audit — ${report.generatedAt}`, '');
    lines.push(`Base URL \`${report.baseUrl}\`${report.commit ? `, commit \`${report.commit}\`` : ''}. ` +
        `${report.routeCount} routes enumerated from \`src/app/**/page.tsx\`.`, '');
    const routesCaptured = (c: string) => report.captured.filter((p) => p.kind === 'route' && p.config === c).length;
    lines.push('## Pages failing each check', '');
    lines.push(`| Check | ${report.configs.join(' | ')} |`);
    lines.push(`|---|${report.configs.map(() => '---').join('|')}|`);
    lines.push(`| Routes captured | ${report.configs.map(routesCaptured).join(' | ')} |`);
    lines.push(`| Routes not captured | ${report.configs.map((c) => uncapturedRouteCount(report, c)).join(' | ')} |`);
    for (const m of MOBILE_METRICS) {
        lines.push(`| ${m.label} | ${report.configs.map((c) => (m.id === 'englishLeaks' && !c.endsWith('-bg') ? '–' : String(h[c][m.id]))).join(' | ')} |`);
    }
    lines.push('');

    const states = report.captured.filter((p) => p.kind === 'state');
    if (states.length) {
        lines.push('## Open states', '');
        lines.push('| State | Config | Clipped | Overlay over a control | Tap < 24 | Input < 16 |');
        lines.push('|---|---|---|---|---|---|');
        for (const s of states) {
            lines.push(`| ${s.id.replace(/^state:/, '')} | ${s.config} | ${s.counts.clipped} | ${s.counts.overlayCoversControl} | ${s.counts.tapUnder24} | ${s.counts.inputUnder16} |`);
        }
        lines.push('');
    }

    if (report.setup) {
        const { created, minted, failed } = report.setup;
        lines.push('## Fixture setup', '');
        lines.push(`- Created: ${created.length ? created.join(', ') : 'nothing (every record already existed)'}`);
        lines.push(`- Tokens minted: ${minted.length ? minted.join(', ') : 'none'}`);
        const failures = Object.entries(failed);
        if (failures.length) for (const [what, why] of failures) lines.push(`- **Failed: ${what}**: ${why}`);
        else lines.push('- Failed: none');
        lines.push('');
    }

    if (report.uncaptured.length) {
        lines.push('## Not captured', '');
        const byId = new Map<string, { reason: string; configs: string[] }>();
        for (const u of report.uncaptured) {
            const e = byId.get(u.id) ?? { reason: u.reason, configs: [] };
            e.configs.push(u.config);
            byId.set(u.id, e);
        }
        for (const [id, e] of byId) lines.push(`- \`${id}\` (${e.configs.join(', ')}): ${e.reason}`);
        lines.push('');
    }

    lines.push('## Worst pages per check', '');
    for (const m of MOBILE_METRICS) {
        if (m.id === 'docScrollsSideways') continue;
        const worst = report.captured
            .filter((p) => p.counts[m.id] > 0)
            .sort((a, b) => b.counts[m.id] - a.counts[m.id])
            .slice(0, 8);
        if (!worst.length) continue;
        lines.push(`### ${m.label}`, '');
        for (const p of worst) {
            const sample = m.id === 'englishLeaks'
                ? p.leaks.slice(0, 3).map((l) => `"${l.text}"`).join(', ')
                : (p.samples[m.id] ?? []).slice(0, 2).map((s) => `\`${s.el}\` "${s.text}"`).join('; ');
            lines.push(`- ${p.id} @ ${p.config}: ${p.counts[m.id]}${sample ? ` — ${sample}` : ''}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

export interface ComparisonRow {
    config: string;
    metric: MobileMetricId | 'uncaptured';
    reference: number;
    current: number;
}

/**
 * Every (configuration, check) whose count of failing pages differs between
 * the reference and the current report, plus the uncaptured-route count.
 * `regressions` are the rows that went up.
 */
export function compareReports(reference: AuditReport, current: AuditReport): { rows: ComparisonRow[]; regressions: ComparisonRow[] } {
    const both = memoBoth(reference, current);
    const rh = headline(reference, both);
    const ch = headline(current, both);
    const rows: ComparisonRow[] = [];
    for (const config of current.configs) {
        if (!reference.configs.includes(config)) continue;
        for (const m of MOBILE_METRICS) {
            if (m.id === 'consoleErrors') continue; // timing-dependent; reported, never ratcheted
            if (rh[config][m.id] !== ch[config][m.id]) rows.push({ config, metric: m.id, reference: rh[config][m.id], current: ch[config][m.id] });
        }
        const ru = uncapturedRouteCount(reference, config);
        const cu = uncapturedRouteCount(current, config);
        if (ru !== cu) rows.push({ config, metric: 'uncaptured', reference: ru, current: cu });
    }
    return { rows, regressions: rows.filter((r) => r.current > r.reference) };
}

/** Per configuration, the routes captured in both reports: the population a count is compared over. */
function memoBoth(reference: AuditReport, current: AuditReport): (config: string) => ReadonlySet<string> {
    const memo = new Map<string, Set<string>>();
    return (config) => {
        let set = memo.get(config);
        if (!set) {
            const before = capturedRoutes(reference, config);
            set = new Set([...capturedRoutes(current, config)].filter((id) => before.has(id)));
            memo.set(config, set);
        }
        return set;
    };
}

/** Routes captured now and not in the reference, per configuration: measured for the first time, not compared. */
export function newlyCaptured(reference: AuditReport, current: AuditReport): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const config of current.configs) {
        if (!reference.configs.includes(config)) continue;
        const before = capturedRoutes(reference, config);
        const fresh = [...capturedRoutes(current, config)].filter((id) => !before.has(id)).sort();
        if (fresh.length) out[config] = fresh;
    }
    return out;
}

/** The routes failing `metric` in `config` now that did not in the reference: where to look first. */
export function newlyFailing(reference: AuditReport, current: AuditReport, config: string, metric: ComparisonRow['metric']): string[] {
    if (metric === 'uncaptured') {
        const before = new Set(reference.uncaptured.filter((u) => u.kind === 'route' && u.config === config).map((u) => u.id));
        return current.uncaptured
            .filter((u) => u.kind === 'route' && u.config === config && !before.has(u.id))
            .map((u) => `${u.id} (${u.reason})`)
            .sort();
    }
    const both = memoBoth(reference, current)(config);
    const failing = (r: AuditReport) =>
        new Set(r.captured.filter((p) => p.kind === 'route' && p.config === config && both.has(p.id) && p.counts[metric] > 0).map((p) => p.id));
    const before = failing(reference);
    return [...failing(current)].filter((id) => !before.has(id)).sort();
}

/**
 * The comparison as markdown (`comparison.md`): every count of failing pages
 * that moved and, for each one that ROSE, the routes that fail now and did not
 * before. The scheduled workflow (`.github/workflows/mobile-audit.yml`)
 * publishes it beside `summary.md` and quotes it in the issue it opens or
 * updates when a count rose.
 */
export function renderComparison(reference: AuditReport, current: AuditReport): string {
    const { rows, regressions } = compareReports(reference, current);
    const label = (m: ComparisonRow['metric']) =>
        m === 'uncaptured' ? 'Routes not captured' : (MOBILE_METRICS.find((x) => x.id === m)?.label ?? m);
    const stamp = (r: AuditReport) => `${r.generatedAt}${r.commit ? ` (commit \`${r.commit}\`)` : ''}`;
    const lines: string[] = [];
    lines.push('# Mobile audit compared with the previous run', '');
    lines.push(`Previous: ${stamp(reference)}. Now: ${stamp(current)}.`, '');
    const fresh = Object.entries(newlyCaptured(reference, current));
    if (fresh.length) {
        lines.push('Measured for the first time, so not compared (they are from the next run on):', '');
        for (const [config, ids] of fresh) lines.push(`- ${config}: ${ids.map((id) => `\`${id}\``).join(', ')}`);
        lines.push('');
    }
    if (!rows.length) {
        lines.push('No count of failing pages moved.');
        return lines.join('\n');
    }
    lines.push(
        regressions.length
            ? `**${regressions.length} ${regressions.length === 1 ? 'count' : 'counts'} rose**: a page regressed on a phone, or stopped rendering.`
            : 'Every count that moved fell.',
        '',
    );
    lines.push('| Configuration | Check | Previous | Now |', '|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.config} | ${label(r.metric)} | ${r.reference} | ${r.current} ${r.current > r.reference ? '▲' : '▼'} |`);
    lines.push('');
    for (const r of regressions) {
        lines.push(`## ${label(r.metric)}, ${r.config}`, '');
        // A count of failing routes that rose has at least one route new to it.
        for (const id of newlyFailing(reference, current, r.config, r.metric)) lines.push(`- \`${id}\``);
        lines.push('');
    }
    return lines.join('\n');
}
