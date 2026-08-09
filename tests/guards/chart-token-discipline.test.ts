/**
 * Polish PR-7 — chart-token discipline ratchet.
 *
 * Bans hex literals (`#abc`, `#abcdef`) and `rgb(...)` calls in
 * chart, heatmap, and per-domain dashboard files. Charts MUST flow
 * through `@/lib/design/status-tone` (Tailwind class tokens) or
 * through CSS custom properties (`var(--brand-default)` etc.) so a
 * theme flip re-tones every chart automatically.
 *
 * Why
 *   Until this PR each chart shipped its own colour function — risk
 *   heatmap had hand-thresholded bg classes; CalendarHeatmap had a
 *   brand-alpha staircase; CalendarMonth + GanttTimeline had
 *   parallel category maps; CoverageClient hardcoded hex on the
 *   donut. The result was that dark↔light parity was brittle and
 *   chart vocabulary differed across the product.
 *
 * What this ratchet detects
 *   In every chart-shaped file (see CHART_NAME_RE + the dashboard
 *   sweep below):
 *     - any `#[0-9a-fA-F]{3,8}` hex literal (3-, 6-, or 8-digit)
 *     - any `rgb(` or `rgba(` call
 *   Comment lines are skipped — PR references like `#536` are not
 *   colours.
 *
 * WHY THIS IS A GLOB AND NOT A LIST
 *   It used to be a hand-maintained `SCAN_FILES` array, with the
 *   stated rationale "keep the scope tight so it's actionable".
 *   The effect was that a NEW chart component was exempt by default:
 *   `ReadinessScoreRing.tsx` shipped `#22c55e` / `#eab308` / `#ef4444`
 *   and no ratchet could see them, because nothing adds a file to a
 *   list it doesn't know exists. An allowlist that exempts new code
 *   by default inverts the point of a ratchet — the rule has to find
 *   the code, not wait to be told about it.
 *
 *   Measured before switching: across every file the glob now
 *   catches, the only pre-existing hits were PR-number references
 *   inside comments (`#536`, `#753`) — i.e. the widened net cost
 *   nothing to adopt. EXCEPTIONS below stays small and each entry
 *   carries a reason.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// A file is chart-shaped if its NAME says so. Naming is the honest signal
// here: a component called `…Chart` / `…Ring` / `…Heatmap` paints colour, and
// its author named it that way before this ratchet existed. Case-insensitive
// because the repo has both `DonutChart.tsx` and `line-chart.tsx`.
const CHART_NAME_RE =
    /(chart|heatmap|ring|gantt|sparkline|timeline|gauge|histogram|donut|matrix|sankey|calendar|curve|axis|bars|areas|funnel|radar)[\w.-]*\.tsx$/i;

// Roots swept for chart-shaped filenames.
const COMPONENT_ROOTS = ['src/components/ui', 'src/components/charts'];

// Everything under here IS a chart, whatever the filename says.
const CHART_DIRS = ['src/components/ui/charts'];

// Plus the per-domain dashboards + coverage, which paint colour inline
// rather than through a named chart component.
const EXTRA_FILES: string[] = [
    'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx',
    'src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx',
    // /tasks/dashboard retired in TP-7 (redirect shim, no charts).
    'src/app/t/[tenantSlug]/(app)/controls/dashboard/page.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/dashboard/page.tsx',
    'src/app/t/[tenantSlug]/(app)/tests/dashboard/page.tsx',
    // The readiness ring lives on the audits surface, not under
    // components/ui — named explicitly so the glob's blind spot
    // (chart-shaped files outside the component roots) is covered
    // for the one case that bit us.
    'src/app/t/[tenantSlug]/(app)/audits/cycles/ReadinessScoreRing.tsx',
];

/** Every file this ratchet polices. */
function scanFiles(): string[] {
    const out = [...EXTRA_FILES];
    for (const root of COMPONENT_ROOTS) {
        const abs = path.resolve(ROOT, root);
        if (!fs.existsSync(abs)) continue;
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '__tests__') continue;
                    walk(full);
                } else if (
                    entry.name.endsWith('.tsx') &&
                    (CHART_NAME_RE.test(entry.name) ||
                        CHART_DIRS.some((d) =>
                            path.relative(ROOT, dir).split(path.sep).join('/').startsWith(d),
                        ))
                ) {
                    out.push(path.relative(ROOT, full));
                }
            }
        };
        walk(abs);
    }
    return out;
}

const SCAN_FILES: string[] = scanFiles();

// Line-level exceptions: (file, line-substring, reason). Keep small, and
// every entry states WHY the literal is unavoidable — an exception with no
// reason is just an allowlist growing back.
const ALLOWLIST: Array<{ file: string; substring: string; reason: string }> = [
    {
        file: 'src/components/ui/charts/chart-gloss.tsx',
        substring: '#ffffff',
        reason:
            'Specular highlight, not a status colour. The gloss overlay is white ' +
            'at a low alpha in BOTH themes by design — a token would re-tone it ' +
            'and destroy the highlight it exists to draw.',
    },
    {
        file: 'src/components/ui/charts/chart-3d.tsx',
        substring: "'#ffffff'",
        reason:
            'Last-resort return from the CSS-var resolver when there is no ' +
            'computed style to read (SSR / detached node). It is the fallback ' +
            'FOR the token path, not a bypass of it.',
    },
    {
        file: 'src/components/ui/charts/funnel-chart.tsx',
        substring: 'shadow-[inset_0_0_0_1px_#0003]',
        reason:
            'A 1px inset hairline at 20% black inside a Tailwind arbitrary ' +
            'value — a shape separator on top of whatever the segment colour ' +
            'is, so it must not follow the theme.',
    },
];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_RE = /\brgba?\s*\(/;

/**
 * `var(--token, #hex)` is token-FIRST with a degradation fallback — the
 * opposite of the failure this ratchet exists for. Strip those before
 * testing, so the rule reads "no hex that a theme flip cannot reach"
 * rather than "no `#` character". Encoded as a rule and not as five
 * allowlist rows because it is a pattern, and a pattern that recurs is a
 * rule.
 */
const VAR_FALLBACK_RE = /var\(\s*--[\w-]+\s*,[^)]*\)/g;

interface Hit {
    file: string;
    line: number;
    text: string;
    kind: string;
}

describe('Chart token discipline (Polish PR-7)', () => {
    it('zero hex / rgb literals in chart, heatmap, and dashboard files', () => {
        const offenders: Hit[] = [];
        for (const rel of SCAN_FILES) {
            const abs = path.resolve(ROOT, rel);
            if (!fs.existsSync(abs)) continue;
            const content = fs.readFileSync(abs, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('*') ||
                    trimmed.startsWith('/*') ||
                    // JSX comments — `{/* … pre-#536 … */}`. Missing this is
                    // how a PR reference reads as a colour.
                    trimmed.startsWith('{/*')
                )
                    return;
                // Token-with-fallback is compliant; test what is left.
                const line_ = line.replace(VAR_FALLBACK_RE, 'var(--token)');
                const allowed = ALLOWLIST.some(
                    (a) => a.file === rel && line.includes(a.substring),
                );
                if (allowed) return;
                if (HEX_RE.test(line_)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'hex',
                    });
                }
                if (RGB_RE.test(line_)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'rgb',
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line} [${o.kind}]\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} chart-discipline violation(s).\n\nCharts and dashboards MUST flow through '@/lib/design/status-tone' (Tailwind class tokens) or through CSS custom properties (var(--…)). Hex literals don't re-theme; the semantic tokens are tuned to WCAG AA in both themes.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('every explicitly-named file exists', () => {
        // Only EXTRA_FILES can go stale — the globbed ones are discovered
        // from the filesystem, so they exist by construction.
        for (const rel of EXTRA_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
    });

    it('the glob actually finds chart components — it is not silently empty', () => {
        // A discovery bug (wrong root, over-tight regex) would make this
        // ratchet pass by scanning nothing, which is exactly the failure it
        // replaced. Assert it found a healthy number of real files.
        const globbed = SCAN_FILES.filter((f) => !EXTRA_FILES.includes(f));
        expect(globbed.length).toBeGreaterThanOrEqual(10);
        expect(SCAN_FILES).toContain(
            'src/app/t/[tenantSlug]/(app)/audits/cycles/ReadinessScoreRing.tsx',
        );
    });
});
