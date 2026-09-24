/**
 * The unsettled-write reporter must measure what the product settles (#2842).
 *
 * `infra/reporters/identity-unsettled-reporter.sh` is the ONLY thing that can
 * page a human about a directory write whose outcome was never confirmed. It
 * lives outside the TypeScript build, so nothing else checks that it still
 * agrees with the code it is watching — and a reporter quietly measuring a
 * different population from the code that settles the rows produces a number
 * nobody can act on, while looking exactly like coverage.
 *
 * Three classes of check here, and the second is the one that matters:
 *
 *   1. AGREEMENT — the staleness window and the unsettled outcome set are
 *      PARSED out of both the shell script and the TypeScript, and compared as
 *      values. Not a grep for a string: a grep passes when both sides say the
 *      same wrong thing, and cannot see `60 * 60 * 1000` become `6 * 60 * 1000`.
 *
 *   2. BEHAVIOUR — the script is actually EXECUTED against stub `docker` and
 *      `curl` binaries, and the assertions are about what it posted. A textual
 *      check that "the failure branch calls exit" says nothing about whether
 *      the POST is reachable from it. The load-bearing property — a failed read
 *      posts NOTHING, rather than a reassuring 0 — can only be shown by running
 *      it.
 *
 *   3. THE POLICY — parsed from the applyable JSON: both a threshold arm and an
 *      absence arm, over the same metric the script emits, with the absence
 *      window derived from the timer's own interval.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const REPORTER = 'infra/reporters/identity-unsettled-reporter.sh';
const TIMER = 'infra/reporters/identity-unsettled-reporter.timer';
const POLICY = 'infra/alerts/policies/identity-write-unsettled.json';
const CONTRACT = 'infra/alerts/gcp-custom-metrics.yml';
const PASS = 'src/app-layer/usecases/identity-leaver-pass.ts';
const JOURNAL = 'src/app-layer/usecases/identity-write-journal.ts';

const MS: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
};

/** `UNSETTLED_STALE_MS = 60 * 60 * 1000` → 3600000. Evaluated, not matched. */
function productStaleMs(): number {
    const m = /const UNSETTLED_STALE_MS = ([\d *]+);/.exec(read(PASS));
    if (!m) throw new Error('UNSETTLED_STALE_MS is gone from ' + PASS);
    return m[1]
        .split('*')
        .map((p) => Number(p.trim()))
        .reduce((a, b) => a * b, 1);
}

/** `STALE_INTERVAL='1 hour'` → 3600000. A Postgres interval, evaluated. */
function reporterStaleMs(): number {
    const m = /\nSTALE_INTERVAL='(\d+) (second|minute|hour|day)s?'\n/.exec(read(REPORTER));
    if (!m) throw new Error('STALE_INTERVAL is gone from ' + REPORTER);
    return Number(m[1]) * MS[m[2]];
}

/** Every outcome the reporter counts as unsettled, from its SQL. */
function reporterOutcomes(): string[] {
    const m = /outcome IN \(([^)]+)\)/.exec(read(REPORTER));
    if (!m) throw new Error('the reporter no longer filters on outcome');
    return m[1]
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort();
}

/**
 * Every outcome `listUnsettledWrites` counts as unsettled, from its `where`.
 *
 * BOUND TO THE FUNCTION BODY, not the file. The first `outcome: { in: [...] }` in
 * that module belongs to `findRestorableState` and reads
 * `['APPLIED', 'INDETERMINATE']` — a whole-file read silently compared the
 * reporter against the RESTORE query instead of the unsettled one, and this
 * guard caught itself doing exactly that on its first run.
 */
function productOutcomes(): string[] {
    const m = /outcome: \{ in: \[([^\]]+)\] \}/.exec(functionBodyOf(read(JOURNAL), 'listUnsettledWrites'));
    if (!m) throw new Error('listUnsettledWrites no longer filters on outcome');
    return m[1]
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort();
}

/** `OnUnitActiveSec=5min` → 300. */
function timerIntervalSeconds(): number {
    const m = /\nOnUnitActiveSec=(\d+)(s|sec|min|m)\n/.exec(read(TIMER));
    if (!m) throw new Error('OnUnitActiveSec is gone from ' + TIMER);
    return Number(m[1]) * (m[2] === 'min' || m[2] === 'm' ? 60 : 1);
}

interface Condition {
    displayName?: string;
    conditionThreshold?: { filter: string; comparison: string; thresholdValue: number; duration: string };
    conditionAbsent?: { filter: string; duration: string };
}
interface Policy {
    combiner: string;
    enabled: boolean;
    conditions: Condition[];
    notificationChannels: string[];
    documentation?: { content: string };
}
const policy = (): Policy => JSON.parse(read(POLICY)) as Policy;

/**
 * Blank whole-line `#` comments in a shell script, preserving line count.
 *
 * Needed because the reporter's own comments QUOTE the thing they forbid — the
 * RLS trap is explained there in detail — so an unmasked read of the file
 * matches `SET ROLE app_user` in prose and the guard fires on the explanation
 * rather than on a defect. Only whole-line comments are masked: every comment
 * in the file is one, and blanking a trailing `#` would need to know about
 * quoting and parameter expansion. The positive control below proves the
 * masker has not blanked so much that the check can no longer go red.
 */
function shCodeOf(src: string): string {
    return src
        .split('\n')
        .map((line) => (/^\s*#/.test(line) ? '' : line))
        .join('\n');
}

/**
 * Executable lines of a shell script that bind the connection to `app_user`.
 *
 * Returned as a LIST rather than asserted with `toMatch` on the whole file, for
 * two reasons. A failure names the offending line instead of saying "somewhere
 * in 200 lines", and a whole-file `toMatch` against a comment-masked read is
 * exactly the un-analysable shape the Class D ratchet caps — the assertion this
 * guard makes should be one another guard can read.
 */
function setRoleLines(src: string): string[] {
    return shCodeOf(src)
        .split('\n')
        .filter((line) => /SET\s+(LOCAL\s+)?ROLE\s+app_user/i.test(line))
        .map((line) => line.trim());
}

interface ContractDoc {
    reporters: { name: string; status: string; emits: string[] }[];
    metrics: { type: string; deployed_policy_id: string | null }[];
}
const contract = (): ContractDoc => yaml.load(read(CONTRACT)) as ContractDoc;

function contractMetric(type: string): ContractDoc['metrics'][number] {
    const m = contract().metrics.find((x) => x.type === type);
    if (!m) throw new Error('the contract file does not record the metric: ' + type);
    return m;
}

/**
 * The metric types the policy's conditions actually watch, deduplicated.
 *
 * Extracted from each condition's filter rather than asserted per-condition in
 * a loop: comparing the SET against the reporter's metric says "this policy
 * watches exactly that, and nothing else", which a per-condition `toContain`
 * does not — it would pass on a policy that also watched an unrelated metric,
 * and on one whose second condition was quietly retargeted.
 */
function policyMetricTypes(): string[] {
    const filters = policy().conditions.map((c) => c.conditionThreshold?.filter ?? c.conditionAbsent?.filter);
    if (filters.some((f) => !f)) throw new Error('a policy condition carries no metric filter');
    return [...new Set(filters.map((f) => /metric\.type="([^"]+)"/.exec(f!)?.[1] ?? '<unparsable>'))].sort();
}

/** The metric type the script actually POSTs. */
function reporterMetricType(): string {
    const m = /custom\.googleapis\.com\/[a-z_]+\/[a-z_]+/.exec(read(REPORTER));
    if (!m) throw new Error('the reporter emits no custom metric');
    return m[0];
}

// ── 1. agreement with the product ───────────────────────────────────────────

describe('the reporter measures the population the product settles', () => {
    it('uses the staleness window the leaver pass defines, not one of its own', () => {
        // THIS IS THE WHOLE POINT OF THE GUARD. Both sides are parsed to a
        // number of milliseconds and compared. `60 * 60 * 1000` in the pass and
        // `'1 hour'` in the shell are written in different languages and can
        // drift silently; the arithmetic cannot.
        expect(reporterStaleMs()).toBe(productStaleMs());
    });

    it('counts exactly the outcomes listUnsettledWrites counts', () => {
        expect(reporterOutcomes()).toEqual(productOutcomes());
    });

    it('counts at least two outcomes, so the set cannot be silently emptied', () => {
        // A positive control on the parse above: if either regex started
        // returning nothing useful, `[] === []` would pass the equality test
        // while the reporter measured nothing at all.
        expect(productOutcomes().length).toBeGreaterThanOrEqual(2);
        expect(productOutcomes()).toContain('INDETERMINATE');
    });

    it('does not assume the app RLS posture, which would return zero for ever', () => {
        // `IdentityWriteJournal` is FORCE ROW LEVEL SECURITY. Measured on the
        // live database 2026-09-24: as postgres with no SET ROLE, 3 rows; under
        // `SET LOCAL ROLE app_user` with no tenant bound, 0 rows. A reporter
        // that "correctly" assumed the app's role would be silent by
        // construction, with no error anywhere to read.
        expect(setRoleLines(read(REPORTER))).toEqual([]);
    });

    it('positive control — the masker still sees a real SET ROLE in code', () => {
        // Without this, the check above is satisfied by a masker that blanks
        // everything. The script DISCUSSES `SET ROLE app_user` at length in its
        // own comments (which is why masking is needed at all), so an
        // unmasked read fails and a too-eager masker passes vacuously. This
        // pins the one case that matters: the statement present as code.
        const injected = read(REPORTER).replace(
            /\nset -uo pipefail\n/,
            '\nset -uo pipefail\npsql -c "SET LOCAL ROLE app_user"\n',
        );
        expect(injected).not.toBe(read(REPORTER));
        expect(setRoleLines(injected)).toEqual(['psql -c "SET LOCAL ROLE app_user"']);
    });
});

// ── 2. behaviour, by running it ─────────────────────────────────────────────

interface RunResult {
    status: number;
    stdout: string;
    stderr: string;
    posts: string[];
}

/**
 * Run the reporter with stub `docker` and `curl` on PATH.
 *
 * The stubs are the seam: `docker` stands in for the psql read and answers
 * whatever this test wants it to; `curl` answers the metadata server and
 * records every POST it is asked to make. Nothing touches a database, a VM, or
 * GCP.
 */
function runReporter(psqlOut: string, psqlRc: number): RunResult {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsettled-reporter-'));
    const postLog = path.join(dir, 'posts.log');
    try {
        fs.writeFileSync(
            path.join(dir, 'docker'),
            ['#!/usr/bin/env bash', 'cat > /dev/null', 'printf %s "$STUB_PSQL_OUT"', 'exit "$STUB_PSQL_RC"', ''].join('\n'),
            { mode: 0o755 },
        );
        fs.writeFileSync(
            path.join(dir, 'curl'),
            [
                '#!/usr/bin/env bash',
                'for a in "$@"; do',
                '  case "$a" in',
                '    */instance/id) echo "1"; exit 0 ;;',
                '    */instance/zone) echo "projects/1/zones/europe-west1-b"; exit 0 ;;',
                '    */service-accounts/default/token) echo \'{"access_token":"stub"}\'; exit 0 ;;',
                '  esac',
                'done',
                `echo "POST $*" >> ${postLog}`,
                'printf 200',
                '',
            ].join('\n'),
            { mode: 0o755 },
        );
        fs.writeFileSync(postLog, '');

        let status = 0;
        let stdout = '';
        let stderr = '';
        try {
            stdout = execFileSync('bash', [path.join(ROOT, REPORTER)], {
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    PATH: `${dir}:${process.env.PATH ?? ''}`,
                    STUB_PSQL_OUT: psqlOut,
                    STUB_PSQL_RC: String(psqlRc),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            const e = err as { status?: number; stdout?: string; stderr?: string };
            status = e.status ?? 1;
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
        }
        const posts = fs.readFileSync(postLog, 'utf-8').split('\n').filter(Boolean);
        return { status, stdout, stderr, posts };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('a reporter that cannot read must not read as an empty backlog', () => {
    it('posts the count on a healthy EMPTY backlog — 0 is a value', () => {
        const r = runReporter('0', 0);
        expect(r.status).toBe(0);
        expect(r.posts).toHaveLength(1);
        expect(r.posts[0]).toContain('"int64Value":"0"');
    });

    it('posts the real count when rows are stranded', () => {
        const r = runReporter('7', 0);
        expect(r.status).toBe(0);
        expect(r.posts).toHaveLength(1);
        expect(r.posts[0]).toContain('"int64Value":"7"');
    });

    it('posts NOTHING when the database read fails', () => {
        // The failure this guard exists for. A fallback `0` here would convert
        // "we cannot tell" into "all clear" and make the policy's absence arm
        // unreachable — the metric would keep arriving, saying the wrong thing.
        const r = runReporter('Error: No such container: inflect-postgres-1', 1);
        expect(r.posts).toHaveLength(0);
        expect(r.status).not.toBe(0);
    });

    it('posts NOTHING when psql exits 0 but answers with an error string', () => {
        // psql writes its errors to the same capture the count comes from, so
        // "non-empty" is not "a number". This is the shape that would otherwise
        // be handed to the metric API as a value.
        const r = runReporter('ERROR:  relation "IdentityWriteJournal" does not exist', 0);
        expect(r.posts).toHaveLength(0);
        expect(r.status).not.toBe(0);
    });

    it('posts NOTHING when the read comes back empty', () => {
        const r = runReporter('', 0);
        expect(r.posts).toHaveLength(0);
        expect(r.status).not.toBe(0);
    });
});

// ── 3. the alert policy ─────────────────────────────────────────────────────

describe('the alert policy can actually fire, and can see silence', () => {
    it('watches exactly the metric the reporter emits, and nothing else', () => {
        expect(policyMetricTypes()).toEqual([reporterMetricType()]);
    });

    it('has a threshold arm that fires above zero', () => {
        const t = policy().conditions.map((c) => c.conditionThreshold).filter(Boolean);
        expect(t).toHaveLength(1);
        expect(t[0]!.comparison).toBe('COMPARISON_GT');
        expect(t[0]!.thresholdValue).toBe(0);
    });

    it('has an absence arm, because a threshold alone is satisfied by silence', () => {
        const a = policy().conditions.map((c) => c.conditionAbsent).filter(Boolean);
        expect(a).toHaveLength(1);
    });

    it('gives the absence arm room for more than one missed run', () => {
        // Derived from the timer, not a constant repeated here. At a 5-minute
        // cadence a 1800s window is six consecutive failures, so a single
        // transient psql error cannot page anybody — while a reporter that has
        // genuinely died still does.
        const a = policy().conditions.map((c) => c.conditionAbsent).find(Boolean)!;
        const seconds = Number(/^(\d+)s$/.exec(a.duration)![1]);
        expect(seconds).toBeGreaterThanOrEqual(3 * timerIntervalSeconds());
    });

    it('ORs its conditions, so either arm alone opens an incident', () => {
        expect(policy().combiner).toBe('OR');
        expect(policy().enabled).toBe(true);
        expect(policy().notificationChannels.length).toBeGreaterThan(0);
    });
});

// ── 4. the contract file does not claim coverage it does not have ───────────

describe('the deployed-contract file stays honest', () => {
    it('does not record a deployed policy id for the unsettled metric yet', () => {
        // The alert is NOT applied — applying it is an operator action (see
        // infra/reporters/README.md). A contract file claiming otherwise is the
        // exact failure #2842 is about: a claim of coverage that stops the next
        // reader checking. When an operator applies it, they record the real id
        // and this expectation is updated in the same diff.
        //
        // PARSED, not grepped. A regex over the YAML passes on a line that
        // merely looks right; loading it means the assertion is about the value
        // the file actually carries.
        const entry = contractMetric(reporterMetricType());
        expect(entry.deployed_policy_id).toBeNull();
    });

    it('keeps the reporter status consistent with the policy id', () => {
        // The two halves can be updated independently, and a half-applied
        // record is worse than either state: `DEPLOYED` beside a null id says
        // the alert exists when it does not.
        const doc = contract();
        const reporter = doc.reporters.find((r) => r.emits.includes(reporterMetricType()));
        expect(reporter).toBeDefined();
        const applied = contractMetric(reporterMetricType()).deployed_policy_id !== null;
        expect(reporter!.status === 'DEPLOYED').toBe(applied);
    });

    it('the container-health reporter is recorded as deployed, with its id', () => {
        // Positive control on the two checks above: they must be capable of
        // seeing a DEPLOYED entry, or "not deployed" is the only answer they
        // can give and neither of them is a measurement.
        const ch = contract().reporters.find((r) => r.name === 'container-health-reporter');
        expect(ch!.status).toBe('DEPLOYED');
        for (const metric of ch!.emits) {
            expect(contractMetric(metric).deployed_policy_id).not.toBeNull();
        }
    });
});
