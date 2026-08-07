/**
 * A Next.js route directory is not a module other surfaces import from.
 *
 * WHAT HAPPENED
 * -------------
 * `controls/` became a de-facto shared namespace. Five surfaces depended on
 * its internals — `src/components/AttachedEvidencePanel.tsx` imported
 * `EvidenceSubTable` from `controls/[controlId]/_tabs/`, a Next.js
 * `_`-prefixed directory whose whole point is to signal PRIVATE; Tasks
 * imported `TaskEditPanel` and `EvidenceSubTable` from `controls/`; Risk
 * detail and Asset detail inherited both transitively through
 * `AttachedEvidencePanel`.
 *
 * The consequence was not abstract. Both components called
 * `useTranslations('controls')`, so the Tasks list, Task detail, Risk detail
 * and Asset detail pages all rendered copy from the `controls` namespace —
 * a translator editing `controls.*` was editing four non-control pages.
 *
 * HOW IT HAPPENED
 * ---------------
 * `EvidenceSubTable` was extracted into `_tabs/` "per the page-size
 * ratchet" — a cap on lines in `[controlId]/page.tsx`. A line cap rewards
 * moving code ANYWHERE out of the capped file, so it went to the nearest
 * directory rather than the correct one, and that private directory then
 * became a four-surface public dependency. This guard is the replacement
 * for that incentive: it measures where things live, not how long a file is.
 *
 * THE RULE
 * --------
 * Code under `src/app/**` is route-local. If two surfaces need it, it goes
 * in `src/components/` (or another shared module) — which is a decision
 * someone makes, not a side effect of dodging a line count.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Every .ts/.tsx file under src/, repo-relative with forward slashes. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            sourceFiles(full, acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
    }
    return acc;
}

/** Import specifiers in a file (static imports + re-exports + dynamic). */
function importsOf(file: string): string[] {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const specs: string[] = [];
    const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    return specs;
}

/** Resolve an import specifier to a repo-relative path prefix, or null. */
function targetPath(file: string, spec: string): string | null {
    if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
    if (spec.startsWith('.')) {
        const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), spec),
        );
        return resolved;
    }
    return null; // package import
}

/** The route segment a file belongs to, e.g. 'controls' — or null. */
function routeSurface(p: string): string | null {
    const m = p.match(/^src\/app\/t\/\[tenantSlug\]\/\(app\)\/([^/]+)\//);
    return m ? m[1] : null;
}


/**
 * Pre-existing violations, OUTSIDE the Controls surface this guard was
 * written for. Each is a real instance of the same inversion and should be
 * fixed the same way — promote the shared component out of the route — but
 * doing it here would turn a Controls change into a Processes/Tasks/Calendar
 * change with no test coverage of its own.
 *
 * This list may only SHRINK. A new entry needs the same justification as
 * disabling the guard, because that is what it is.
 */
const BASELINE = new Set<string>([
    // The Processes canvas: six shared components import back into the
    // route that owns the canvas state. Untangling needs the canvas's
    // state to move first, which is its own change.
    'src/components/LinkedTasksPanel.tsx -> @/app/t/[tenantSlug]/(app)/tasks/NewTaskModal',
    'src/components/processes/CanvasDocumentBar.tsx -> @/app/t/[tenantSlug]/(app)/processes/ProcessesClient',
    'src/components/processes/ManualTriggerPanel.tsx -> @/app/t/[tenantSlug]/(app)/processes/RulesTab',
    'src/components/processes/PersistedProcessCanvas.tsx -> @/app/t/[tenantSlug]/(app)/processes/ProcessesClient',
    'src/components/processes/RuleBuilderModal.tsx -> @/app/t/[tenantSlug]/(app)/processes/RulesTab',
    'src/components/processes/RuleDetailSheet.tsx -> @/app/t/[tenantSlug]/(app)/processes/RulesTab',
    'src/components/processes/RuleDetailSheet.tsx -> @/app/t/[tenantSlug]/(app)/processes/automation-filter-defs',
    // Calendar reuses the Tasks create modal. Same fix as EvidenceSubTable:
    // promote it to src/components/. Left for a Tasks/Calendar change.
    'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx -> @/app/t/[tenantSlug]/(app)/tasks/NewTaskModal',
]);

describe('route directories are not shared modules', () => {
    const files = sourceFiles(SRC);

    it('src/components/** never imports from a route directory', () => {
        // A shared component reaching into a route is the strongest form of
        // the inversion: the shared layer becomes downstream of one page.
        const offenders: string[] = [];
        for (const file of files) {
            if (!file.startsWith('src/components/')) continue;
            for (const spec of importsOf(file)) {
                const target = targetPath(file, spec);
                if (target && target.startsWith('src/app/')) {
                    const entry = `${file} -> ${spec}`;
                    if (!BASELINE.has(entry)) offenders.push(entry);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no route surface imports another route surface\'s internals', () => {
        // Cross-surface imports are how `controls/` accreted four external
        // dependents. Shared code belongs in src/components/.
        const offenders: string[] = [];
        for (const file of files) {
            const from = routeSurface(file);
            if (!from) continue;
            for (const spec of importsOf(file)) {
                const target = targetPath(file, spec);
                if (!target) continue;
                const to = routeSurface(target);
                if (to && to !== from) {
                    const entry = `${file} -> ${spec}`;
                    if (!BASELINE.has(entry)) offenders.push(entry);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('nothing imports a Next.js private (_-prefixed) directory from outside its own surface', () => {
        // `_tabs/`, `_components/`, `_lib/` are private BY CONVENTION and
        // carry no enforcement — which is exactly why one became a
        // four-surface dependency.
        const offenders: string[] = [];
        for (const file of files) {
            const from = routeSurface(file);
            for (const spec of importsOf(file)) {
                const target = targetPath(file, spec);
                if (!target || !/\/_[a-z]/.test('/' + target)) continue;
                const to = routeSurface(target);
                if (to && to !== from) {
                    offenders.push(`${file} -> ${spec}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the BASELINE has no stale entries', () => {
        // When one of these is fixed, its line must go in the same diff —
        // otherwise the list grows stale and quietly permits a regression
        // at a path nobody is watching any more.
        const live: string[] = [];
        for (const file of files) {
            for (const spec of importsOf(file)) {
                const target = targetPath(file, spec);
                if (!target) continue;
                const entry = `${file} -> ${spec}`;
                if (BASELINE.has(entry)) live.push(entry);
            }
        }
        const stale = [...BASELINE].filter((e) => !live.includes(e)).sort();
        expect(stale).toEqual([]);
    });
});
