/**
 * Every CI job is either reachable on a pull_request, or registered as not.
 *
 * THE INVARIANT. A check that cannot run at PR time can only report a failure
 * AFTER the bad commit is on main. The PR goes green, main breaks, and the
 * breakage is usually mis-attributed to whoever merged next. That is not a
 * hypothetical: it happened four times in one week.
 *
 *   - `Coverage` is push/schedule/dispatch-only, so a coverage regression is
 *     only ever seen post-merge.
 *   - The `container` path filter skipped `Docker Build` on source-only PRs, so
 *     `npm run build:worker` — which until 2026-08-25 ran ONLY inside
 *     Dockerfile:68 — was never exercised by any PR check.
 *   - `Bundle Analyze` needs a `perf-watch` label, so a dependency bump that
 *     breaks the analyzer build lands green.
 *   - semantic-release runs only on main AND only when a commit actually cuts a
 *     release, so an incompatible changelog bump (#2120) passed every PR check
 *     and sat latent through four main commits before breaking releases.
 *
 * Patching those four individually would leave the fifth to be found the same
 * way — by it breaking. This guard makes the CLASS visible instead: every job
 * that a PR cannot reach must be listed in `ci-checks-unreachable-before-merge.json` with a
 * written reason and, where one exists, the PR-time check that covers the same
 * risk. A new unreachable job fails CI until somebody triages it.
 *
 * WHY AN EXPRESSION EVALUATOR AND NOT A REGEX. The obvious implementation —
 * "does the `if:` mention github.event_name without mentioning pull_request" —
 * is wrong on this repo's real conditions. Several jobs carry
 * `if: github.event_name != 'merge_group'`, which excludes the merge QUEUE and
 * is fully PR-reachable; a substring rule marks them unreachable and the
 * registry fills with false entries. So this parses the subset of GitHub
 * expression syntax actually in use and asks a precise question: with
 * `github.event_name` bound to 'pull_request', is this condition SATISFIABLE?
 *
 * Terms it cannot resolve — contains(), vars.*, needs.*, inputs.*, always(),
 * cancelled() — are treated as UNKNOWN rather than assumed. A job that is
 * reachable only when an unknown is true is classified `conditional`, which
 * still requires a registry entry: `Bundle Analyze`'s label gate is exactly
 * that shape, and it is one of the four incidents above.
 *
 * VACUITY. The characteristic failure of a guard like this is a parser that
 * yields nothing and passes silently — an absence being read as a pass. The
 * first test asserts the census is plausibly sized, so a parse that collapses
 * fails loudly instead of certifying an empty set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const WF_DIR = path.join(ROOT, '.github/workflows');

type Reach = 'yes' | 'conditional' | 'never';
type Tri = true | false | 'unknown';

interface RegistryEntry {
    kind: 'never' | 'conditional';
    reason: string;
    /** The PR-time check covering the same risk, or an explicit acceptance. */
    coveredBy: string;
}

const REGISTRY: Record<string, RegistryEntry> = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'ci-checks-unreachable-before-merge.json'), 'utf8'),
);

// ── a very small evaluator for the GitHub expression subset in use ──
//
// Grammar: or := and ('||' and)* ; and := unary ('&&' unary)* ;
//          unary := '!' unary | primary ; primary := '(' or ')' | comparison | atom
// Anything it does not recognise evaluates to 'unknown', never to a guess.
const evaluate = (src: string, eventName: string): Tri => {
    let i = 0;
    const s = src.trim();
    const ws = (): void => { while (i < s.length && /\s/.test(s[i] as string)) i += 1; };

    const atom = (): Tri => {
        ws();
        // string literal
        if (s[i] === "'") {
            const end = s.indexOf("'", i + 1);
            if (end < 0) { i = s.length; return 'unknown'; }
            const lit = s.slice(i + 1, end);
            i = end + 1;
            return (`str:${lit}` as unknown) as Tri; // carried as a tagged string
        }
        // NOTE the `-`: job ids are hyphenated (`needs.fmt-validate.result`), and
        // omitting it made the parser stop at `needs.fmt`, abandon the rest of the
        // expression and return 'unknown' — which misreported a job that is
        // provably unreachable on a PR as merely conditional.
        const m = /^[A-Za-z_][A-Za-z0-9_.-]*(\s*\([^()]*\))?/.exec(s.slice(i));
        if (!m) { i += 1; return 'unknown'; }
        const tok = m[0];
        i += tok.length;
        if (tok === 'github.event_name') return (`str:${eventName}` as unknown) as Tri;
        if (tok === 'true') return true;
        if (tok === 'false') return false;
        return 'unknown';
    };

    const comparison = (): Tri => {
        const left = atom();
        ws();
        const op = s.slice(i, i + 2);
        if (op !== '==' && op !== '!=') return typeof left === 'string' ? 'unknown' : left;
        // (a tagged literal standing alone is not a boolean — treated as unknown above)
        i += 2;
        const right = atom();
        // Both sides must be TAGGED string literals. The Tri value 'unknown' is
        // itself a JS string, so a bare `typeof x === 'string'` test treats an
        // unresolvable term as a literal and compares it — which silently
        // resolved `vars.CODE_SCANNING_ENABLED == 'true'` to FALSE and
        // classified CodeQL as unreachable. Compare only on the 'str:' tag.
        const tagged = (v: Tri): string | null =>
            typeof v === 'string' && v.startsWith('str:') ? v.slice(4) : null;
        const ls = tagged(left);
        const rs = tagged(right);
        if (ls === null || rs === null) return 'unknown';
        return op === '==' ? ls === rs : ls !== rs;
    };

    const unary = (): Tri => {
        ws();
        if (s[i] === '!' && s[i + 1] !== '=') {
            i += 1;
            const v = unary();
            return v === 'unknown' ? 'unknown' : !v;
        }
        ws();
        if (s[i] === '(') {
            i += 1;
            const v = orExpr();
            ws();
            if (s[i] === ')') i += 1;
            return v;
        }
        return comparison();
    };

    const andExpr = (): Tri => {
        let v = unary();
        for (;;) {
            ws();
            if (s.slice(i, i + 2) !== '&&') return v;
            i += 2;
            const r = unary();
            if (v === false || r === false) v = false;
            else if (v === 'unknown' || r === 'unknown') v = 'unknown';
            else v = true;
        }
    };

    function orExpr(): Tri {
        let v = andExpr();
        for (;;) {
            ws();
            if (s.slice(i, i + 2) !== '||') return v;
            i += 2;
            const r = andExpr();
            if (v === true || r === true) v = true;
            else if (v === 'unknown' || r === 'unknown') v = 'unknown';
            else v = false;
        }
    }

    const out = orExpr();
    return typeof out === 'string' ? 'unknown' : out;
};

const stripWrapper = (raw: string): string =>
    raw.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();

interface JobInfo { key: string; reach: Reach }

const census = (): {
    jobs: JobInfo[];
    workflows: number;
    prFilters: string[];
    pathScoped: string[];
} => {
    const files = fs
        .readdirSync(WF_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .sort();
    const jobs: JobInfo[] = [];
    const prFilters: string[] = [];
    const pathScoped: string[] = [];

    for (const f of files) {
        const doc = yaml.load(fs.readFileSync(path.join(WF_DIR, f), 'utf8')) as Record<
            string,
            unknown
        >;
        // `on:` is parsed as boolean true by YAML 1.1
        const on = (doc['on'] ?? doc[true as unknown as string]) as
            | Record<string, unknown>
            | undefined;
        const pr = on?.['pull_request'] as Record<string, unknown> | null | undefined;
        const hasPr = on !== undefined && 'pull_request' in on;
        if (hasPr && pr && typeof pr === 'object') {
            // A `branches:` or `paths:` filter narrows which PRs fire the workflow
            // AT ALL — the workflow never triggers, so no context is reported and
            // nothing looks missing on the PR page.
            // `branches:` and `paths:` are NOT equivalent, and conflating them
            // would make this guard unlandable. `branches:` scopes by the PR's
            // BASE, so a stacked PR gets no run at all — never legitimate here.
            // `paths:` scopes by content, which is how helm/terraform correctly
            // avoid running on unrelated PRs; those are registered instead.
            if ('branches' in pr) prFilters.push(`${f}: pull_request.branches`);
            if ('paths' in pr) pathScoped.push(`${f}:pull_request.paths`);
        }
        const jobDefs = (doc['jobs'] ?? {}) as Record<string, { if?: unknown }>;
        for (const [jid, job] of Object.entries(jobDefs)) {
            const key = `${f}:${jid}`;
            if (!hasPr) { jobs.push({ key, reach: 'never' }); continue; }
            const cond = job?.if;
            if (cond === undefined || cond === null) { jobs.push({ key, reach: 'yes' }); continue; }
            const v = evaluate(stripWrapper(String(cond)), 'pull_request');
            jobs.push({ key, reach: v === true ? 'yes' : v === false ? 'never' : 'conditional' });
        }
    }
    return { jobs, workflows: files.length, prFilters, pathScoped };
};

describe('every CI job is PR-reachable or registered as not', () => {
    const { jobs, workflows, prFilters, pathScoped } = census();

    it('the census is plausibly sized (guards against a vacuous pass)', () => {
        // If the parser silently yields nothing, every assertion below passes
        // while checking nothing. These floors sit well under the real counts
        // so ordinary growth or deletion does not trip them, but a collapsed
        // parse does.
        //
        // LOWERED 2026-09-02, deliberately and once. The counts were 14
        // workflows / 39 jobs when this was written; removing the unapplied AWS
        // estate deleted `deploy.yml` (6 jobs), `terraform.yml` (3) and
        // `helm-validate.yml`, and #2270 had already removed `restore-test.yml`
        // (3) — leaving 11 workflows / 26 jobs. The old `>= 30` floor would
        // have gone red on a correct deletion, which is the failure mode a
        // floor is supposed to avoid.
        //
        // Re-baselined at roughly two thirds of the real counts rather than at
        // the counts themselves: a floor set AT the current number turns every
        // future deletion into a floor edit, and the point of these three is to
        // catch a parser that yields nothing, not to pin an inventory.
        expect(workflows).toBeGreaterThanOrEqual(8);
        expect(jobs.length).toBeGreaterThanOrEqual(18);
        expect(jobs.filter((j) => j.reach === 'yes').length).toBeGreaterThanOrEqual(8);
    });

    it('the evaluator classifies this repo\'s real condition shapes correctly', () => {
        // Pinned because a regex-based rewrite of the evaluator would get these
        // wrong in the direction that FILLS the registry with false entries.
        expect(evaluate("github.event_name != 'merge_group'", 'pull_request')).toBe(true);
        expect(evaluate("github.event_name == 'push'", 'pull_request')).toBe(false);
        expect(
            evaluate(
                "github.event_name == 'push' || github.event_name == 'schedule'",
                'pull_request',
            ),
        ).toBe(false);
        expect(
            evaluate("github.event_name == 'pull_request' && contains(x, 'y')", 'pull_request'),
        ).toBe('unknown');
        expect(evaluate("!cancelled()", 'pull_request')).toBe('unknown');
        // Regression pin. `vars.X == 'true'` must be UNKNOWN, not false: the
        // first version compared the Tri value 'unknown' as though it were a
        // string literal, resolved this to false, and classified CodeQL and
        // Docker Build as permanently unreachable.
        expect(evaluate("vars.CODE_SCANNING_ENABLED == 'true'", 'pull_request')).toBe('unknown');
        expect(
            evaluate(
                "github.event_name != 'merge_group' && vars.CODE_SCANNING_ENABLED == 'true'",
                'pull_request',
            ),
        ).toBe('unknown');
        // Regression pin: hyphenated job ids must parse as ONE identifier.
        expect(
            evaluate(
                "needs.fmt-validate.result == 'success' && github.event_name == 'push'",
                'pull_request',
            ),
        ).toBe(false);
    });

    it('no pull_request trigger is scoped by BASE BRANCH', () => {
        // Worse than a skipped job: the workflow never fires, so the PR reports
        // NO context at all and nothing looks missing. `branches: [main]` on
        // ci.yml meant a PR based on a feature branch got zero checks.
        expect(prFilters).toEqual([]);
    });

    it('every pull_request paths: filter is registered', () => {
        // Content-scoping IS legitimate — helm/terraform should not run on
        // unrelated PRs. But it is the same shape as the `container` filter that
        // hid the worker bundle, so each one is triaged rather than assumed.
        const missing = pathScoped.filter((k) => !(k in REGISTRY));
        expect(missing).toEqual([]);
    });

    it('every job a PR cannot reach is registered with a reason', () => {
        const unreachable = jobs.filter((j) => j.reach !== 'yes');
        const missing = unreachable.filter((j) => !(j.key in REGISTRY));
        expect(missing.map((m) => m.key)).toEqual([]);
    });

    it('every registry entry names a job that still exists and is still unreachable', () => {
        const byKey = new Map(jobs.map((j) => [j.key, j.reach]));
        const stale = Object.keys(REGISTRY).filter((k) => {
            if (k.endsWith(':pull_request.paths')) return !pathScoped.includes(k);
            const reach = byKey.get(k);
            return reach === undefined || reach === 'yes';
        });
        // A job that became PR-reachable, or was deleted, must lose its entry in
        // the same diff — otherwise the registry decays into a list of claims
        // nobody checks.
        expect(stale).toEqual([]);
    });

    it('every registry entry declares its kind, reason and coverage', () => {
        for (const [key, e] of Object.entries(REGISTRY)) {
            expect(['never', 'conditional', 'path-scoped']).toContain(e.kind);
            expect(typeof e.reason).toBe('string');
            expect(e.reason.length).toBeGreaterThan(30);
            expect(typeof e.coveredBy).toBe('string');
            expect(e.coveredBy.length).toBeGreaterThan(10);
            expect(`${key} ${e.reason}`).not.toMatch(/\bTODO\b|\bTBD\b|\bfixme\b/i);
        }
    });

    it('the registered kind matches the measured reachability', () => {
        const byKey = new Map(jobs.map((j) => [j.key, j.reach]));
        const wrong = Object.entries(REGISTRY)
            .filter(([k]) => !k.endsWith(':pull_request.paths'))
            .filter(([k, e]) => byKey.get(k) !== e.kind)
            .map(([k, e]) => `${k}: registered ${e.kind}, measured ${byKey.get(k)}`);
        expect(wrong).toEqual([]);
    });
});
