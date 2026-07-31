/**
 * `useTenantSWR` / `usePrefetchTenant` take TENANT-RELATIVE paths.
 *
 * Both hooks resolve their argument through `useTenantApiUrl()`, which
 * PREPENDS `/api/t/{tenantSlug}` (see `src/lib/hooks/use-tenant-swr.ts`
 * and `src/lib/tenant-context-provider.tsx`). Passing an already-absolute
 * `/api/t/${tenantSlug}/vendors/metrics` therefore builds
 * `/api/t/{slug}/api/t/{slug}/vendors/metrics` — a 404, retried by SWR.
 *
 * This is a SILENT, REPEATABLE footgun:
 *
 *   - The call site type-checks: the hook takes `string`, and a
 *     template literal with the slug in it looks obviously correct.
 *   - SWR swallows the failure. `data` is `undefined`, so a component
 *     that defaults with `?? 0` / `?? []` renders plausible-looking
 *     zeros instead of an error. Two shipped regressions were found
 *     this way: the vendors-list KPI cards read 0 for every vendor, and
 *     the access-review directory-availability gate never applied at
 *     all because its account list never loaded.
 *
 * Fix at the call site — pass the tenant-relative path (`'/vendors/metrics'`).
 * Do NOT make `useTenantApiUrl` strip an existing prefix: silently
 * repairing the argument hides the mistake from the next reader instead
 * of correcting it.
 *
 * A path that legitimately targets an UNSCOPED or ORG-level endpoint
 * must not use these hooks at all — call `useSWR` with `apiGet` directly
 * (the module docstring on `use-tenant-swr.ts` says so).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src'];

const EXEMPT_DIR_NAMES = new Set<string>(['node_modules', '__tests__', '__mocks__']);
const EXEMPT_FILE_PATTERNS: RegExp[] = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\.stories\.tsx?$/];

/** The tenant-prefixing hooks. Both funnel through `useTenantApiUrl`. */
const PREFIXING_HOOKS = ['useTenantSWR', 'usePrefetchTenant'] as const;

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXEMPT_DIR_NAMES.has(entry.name)) continue;
            out.push(...walk(full));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (EXEMPT_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
        out.push(full);
    }
    return out;
}

/**
 * Extract the first-argument source text of every `hook(...)` call in
 * `source`, tracking nesting so a nested call (e.g. `CACHE_KEYS.x(y)`)
 * doesn't truncate the argument early. Returns `{ arg, line }` pairs.
 *
 * Deliberately a hand-rolled scanner rather than a regex: the first
 * argument is frequently a template literal or a nested call, both of
 * which defeat a naive `\(([^)]*)\)`.
 */
function firstArgs(source: string, hook: string): Array<{ arg: string; line: number }> {
    const found: Array<{ arg: string; line: number }> = [];
    // `useTenantSWR<Foo>(` — allow an optional type argument list.
    const callRe = new RegExp(`\\b${hook}\\s*(?:<[^(]*>)?\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source)) !== null) {
        const start = m.index + m[0].length;
        let depth = 1;
        let i = start;
        while (i < source.length && depth > 0) {
            const ch = source[i];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            else if (depth === 1 && ch === ',') break;
            i++;
        }
        found.push({
            arg: source.slice(start, i),
            line: source.slice(0, m.index).split('\n').length,
        });
    }
    return found;
}

/** A string/template literal beginning with `/api/` anywhere in the argument. */
const ABSOLUTE_API_PATH_RE = /['"`]\s*\/api\//;

interface Violation {
    file: string;
    line: number;
    hook: string;
    arg: string;
}

function scan(): { violations: Violation[]; callSites: number } {
    const violations: Violation[] = [];
    let callSites = 0;
    for (const dir of SCAN_DIRS) {
        for (const file of walk(path.join(ROOT, dir))) {
            const source = fs.readFileSync(file, 'utf8');
            for (const hook of PREFIXING_HOOKS) {
                if (!source.includes(hook)) continue;
                for (const { arg, line } of firstArgs(source, hook)) {
                    callSites++;
                    if (ABSOLUTE_API_PATH_RE.test(arg)) {
                        violations.push({
                            file: path.relative(ROOT, file),
                            line,
                            hook,
                            arg: arg.replace(/\s+/g, ' ').trim().slice(0, 120),
                        });
                    }
                }
            }
        }
    }
    return { violations, callSites };
}

describe('useTenantSWR call sites pass tenant-relative paths', () => {
    const { violations, callSites } = scan();

    it('finds the tenant-prefixing hook call sites (scan is not vacuous)', () => {
        // If a refactor renames the hooks or moves them out of `src/`,
        // the scan above would silently pass on zero input. The floor is
        // deliberately well below the real count (~200 call sites) so it
        // never needs churn — it only proves the scanner still resolves
        // call sites at all.
        expect(callSites).toBeGreaterThan(20);
    });

    it('never passes an absolute /api/... path to a tenant-prefixing hook', () => {
        const message = violations
            .map(
                (v) =>
                    `  ${v.file}:${v.line} — ${v.hook}(${v.arg})\n` +
                    `      → drop the '/api/t/{slug}' prefix; the hook adds it.`,
            )
            .join('\n');
        expect(
            violations.length === 0 ? '' : `\n${message}\n`,
        ).toBe('');
    });

    it('detects a double-prefixed path when one is introduced (detector proof)', () => {
        // In-memory mutation regression proof: the scanner must actually
        // catch the shape it claims to, so a future refactor of
        // `firstArgs` that quietly stops matching fails HERE rather than
        // passing vacuously above.
        const sample = [
            "const a = useTenantSWR<Foo>('/vendors/metrics');",
            'const b = useTenantSWR<Bar>(`/api/t/${tenantSlug}/vendors/metrics`);',
            "const c = usePrefetchTenant();",
            "prefetch('/api/t/' + slug + '/controls');",
        ].join('\n');

        const bad = firstArgs(sample, 'useTenantSWR').filter((f) =>
            ABSOLUTE_API_PATH_RE.test(f.arg),
        );
        expect(bad).toHaveLength(1);
        expect(bad[0]!.arg).toContain('/api/t/');

        const good = firstArgs(sample, 'useTenantSWR').filter(
            (f) => !ABSOLUTE_API_PATH_RE.test(f.arg),
        );
        expect(good).toHaveLength(1);
        expect(good[0]!.arg).toContain('/vendors/metrics');
    });
});
