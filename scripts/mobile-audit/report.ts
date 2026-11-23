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
}

/** Pages (routes, not states) failing each check, per configuration. */
export function headline(report: AuditReport): Record<string, Record<MobileMetricId, number>> {
    const out: Record<string, Record<MobileMetricId, number>> = {};
    for (const config of report.configs) {
        const row = Object.fromEntries(MOBILE_METRICS.map((m) => [m.id, 0])) as Record<MobileMetricId, number>;
        for (const p of report.captured) {
            if (p.kind !== 'route' || p.config !== config) continue;
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
    const rh = headline(reference);
    const ch = headline(current);
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
