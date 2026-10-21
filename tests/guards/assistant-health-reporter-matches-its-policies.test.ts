/**
 * The assistant-health reporter and the two policies that watch it (#3856).
 *
 * ═══ THE FAILURE THIS GUARD EXISTS FOR ═══
 *
 * A policy filters on a metric TYPE STRING. The reporter publishes one. Nothing
 * connects them — if the two disagree by a character, the policy watches a
 * metric that will never arrive, its threshold arm can never fire, and its
 * absence arm fires forever or is muted. Both outcomes end with an alert that
 * covers nothing, and neither shows up as a failure anywhere.
 *
 * `infra/reporters/README.md` makes the point for the repo copies in general:
 * 22 alert rules "have never run". A name mismatch is how a policy joins them.
 *
 * ═══ AND THE REPORTER'S OWN THREE RULES, BY RUNNING IT ═══
 *
 * `0` is a value; an unreadable number is not zero; and the arithmetic has to
 * be right at the boundary. Those are asserted by executing the script with
 * stub `docker` and `curl` on PATH — the same seam
 * `unsettled-reporter-matches-the-product.test.ts` uses, and the reason it is
 * worth copying: a source scan would assert the SPELLING of the fallback,
 * where this asserts what gets posted.
 */

// `spawnSync`, not `execFileSync`: the latter RETURNS stdout and surfaces
// stderr only on a throw, so a successful run's journal output was invisible
// and the "names the breakdown" assertion compared against an empty string.
// Two of this suite's assertions are about what the reporter says while
// exiting 0.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPORTER = 'infra/reporters/assistant-health-reporter.sh';
const POLICIES = [
    'infra/alerts/policies/assistant-refusal-rate.json',
    'infra/alerts/policies/assistant-proposal-volume.json',
];

const read = (p: string): string => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');

/** Metric types the reporter actually publishes, read out of its `series_of` calls. */
function publishedMetrics(): string[] {
    const src = read(REPORTER);
    return [...src.matchAll(/series_of\s+([a-z_]+)\s/g)].map((m) => `custom.googleapis.com/ai/${m[1]}`);
}

/** Metric types a policy filters on. */
function watchedMetrics(policyPath: string): string[] {
    const policy = JSON.parse(read(policyPath)) as {
        conditions: Array<Record<string, { filter?: string }>>;
    };
    const out: string[] = [];
    for (const cond of policy.conditions) {
        for (const [key, body] of Object.entries(cond)) {
            if (key === 'displayName' || typeof body !== 'object' || body === null) continue;
            const m = /metric\.type="([^"]+)"/.exec(body.filter ?? '');
            if (m !== null) out.push(m[1]);
        }
    }
    return out;
}

interface RunResult {
    status: number;
    stderr: string;
    posts: string[];
}

/**
 * Run the reporter with stub `docker` and `curl` on PATH.
 *
 * `docker` stands in for the psql read and answers whatever this test wants;
 * `curl` answers the metadata server and records every POST. Nothing touches a
 * database, a VM or GCP.
 *
 * `psqlOuts` is a LIST because this reporter makes three reads (turns,
 * refusals, proposals) and the arithmetic depends on which answered what — a
 * single canned answer could not express "many refusals, few turns".
 */
function runReporter(psqlOuts: readonly string[], psqlRc = 0): RunResult {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-health-'));
    const postLog = path.join(dir, 'posts.log');
    const countFile = path.join(dir, 'call-count');
    try {
        fs.writeFileSync(
            path.join(dir, 'docker'),
            [
                '#!/usr/bin/env bash',
                'cat > /dev/null',
                `n=$(cat ${countFile})`,
                `echo $((n + 1)) > ${countFile}`,
                'IFS="|" read -ra OUTS <<< "$STUB_PSQL_OUTS"',
                'printf %s "${OUTS[$n]:-${OUTS[-1]}}"',
                'exit "$STUB_PSQL_RC"',
                '',
            ].join('\n'),
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
        fs.writeFileSync(countFile, '0');

        const run = spawnSync('bash', [path.join(process.cwd(), REPORTER)], {
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH ?? ''}`,
                STUB_PSQL_OUTS: psqlOuts.join('|'),
                STUB_PSQL_RC: String(psqlRc),
            },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const posts = fs.readFileSync(postLog, 'utf-8').split('\n').filter(Boolean);
        return { status: run.status ?? 1, stderr: run.stderr ?? '', posts };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The int64 value posted for one metric short name.
 *
 * Split on the series boundary first, rather than one regex across the whole
 * payload: a series is `{"metric":...,"resource":...,"points":[...]}` and a
 * pattern trying to reach from the type to the value has to cross two nested
 * objects. The first version did, matched nothing, and returned null for every
 * metric — which read as "the reporter posted the wrong number" when it had
 * posted the right ones.
 *
 * The type is matched up to its closing quote so `assistant_refusal_pct`
 * cannot be found when `assistant_refusals` was asked for.
 */
function posted(posts: readonly string[], metric: string): string | null {
    for (const chunk of posts.join('\n').split('{"metric":')) {
        if (!chunk.includes(`custom.googleapis.com/ai/${metric}"`)) continue;
        const m = /"int64Value":"(\d+)"/.exec(chunk);
        if (m !== null) return m[1];
    }
    return null;
}

describe('every policy watches a metric the reporter actually publishes', () => {
    it('the scan sees both sides', () => {
        // The denominator. A regex that matched nothing would make the
        // comparison below pass over two empty sets.
        expect(publishedMetrics().length).toBeGreaterThanOrEqual(4);
        for (const p of POLICIES) {
            expect(watchedMetrics(p).length).toBeGreaterThanOrEqual(2);
        }
    });

    it.each(POLICIES)('%s filters only on published metric types', (policyPath) => {
        const published = publishedMetrics();
        for (const watched of watchedMetrics(policyPath)) {
            expect(published).toContain(watched);
        }
    });

    it('the comparison can fail — an unpublished metric type is detected', () => {
        // Positive control for the assertion above.
        expect(publishedMetrics()).not.toContain('custom.googleapis.com/ai/assistant_refusal_rate');
    });

    it.each(POLICIES)('%s has an ABSENT arm on the same metric as its threshold', (policyPath) => {
        // #3856 asks for this specifically, and the reason is in the existing
        // policies' own wording: "absence is not health". A reporter that stops
        // reporting must alarm, or the alert silently stops covering anything.
        const policy = JSON.parse(read(policyPath)) as {
            conditions: Array<Record<string, unknown>>;
        };
        const kinds = policy.conditions.flatMap((c) =>
            Object.keys(c).filter((k) => k !== 'displayName'),
        );
        expect(kinds).toContain('conditionThreshold');
        expect(kinds).toContain('conditionAbsent');

        // Both arms on the SAME metric. An absence arm pointed at a different
        // metric would report the health of something else entirely.
        const watched = watchedMetrics(policyPath);
        expect(new Set(watched).size).toBe(1);
    });
});

describe('the reporter obeys its own three rules, proved by running it', () => {
    it('posts 0 on a healthy quiet hour — 0 is a value', () => {
        const r = runReporter(['0', '0', '0']);
        expect(r.status).toBe(0);
        expect(r.posts).toHaveLength(1);
        expect(posted(r.posts, 'assistant_turns')).toBe('0');
        expect(posted(r.posts, 'assistant_refusals')).toBe('0');
        expect(posted(r.posts, 'assistant_proposal_volume')).toBe('0');
        // Zero attempts is 0% BY DEFINITION, not a missing value: nothing was
        // refused because nothing was attempted. Emitting no series here would
        // make the absence arm fire on a quiet night.
        expect(posted(r.posts, 'assistant_refusal_pct')).toBe('0');
    });

    it('posts NOTHING when the read fails', () => {
        // The rule this exists for. A fallback 0 would convert "we cannot tell"
        // into "all clear", and the absence arm would never be reached because
        // the metric would keep arriving, saying the wrong thing.
        const r = runReporter(['Error response from daemon: No such container'], 1);
        expect(r.posts).toHaveLength(0);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('an unreadable number is not a healthy one');
    });

    it('posts NOTHING when psql exits 0 but answers with an error string', () => {
        // Exit code alone is not the check — `-v ON_ERROR_STOP=1` is not always
        // reached, and a non-numeric answer must be refused on its shape.
        const r = runReporter(['ERROR:  relation "AiDecisionLog" does not exist'], 0);
        expect(r.posts).toHaveLength(0);
        expect(r.status).not.toBe(0);
    });

    it('computes the rate over ATTEMPTS, not over logged turns', () => {
        // 3 turns got through, 1 was refused -> 4 attempts, 25%.
        //
        // This is the arithmetic the policy documentation explains and the one
        // that is easy to get wrong: dividing by logged turns alone would give
        // 33% here, and would read LOWER the worse things got, because a refused
        // turn writes no decision-log row at all.
        const r = runReporter(['3', '1', '0']);
        expect(posted(r.posts, 'assistant_refusal_pct')).toBe('25');
        expect(posted(r.posts, 'assistant_turns')).toBe('3');
        expect(posted(r.posts, 'assistant_refusals')).toBe('1');
    });

    it('reports 100% when every attempt was refused', () => {
        // The case the alert is for: nothing reached the model at all, so there
        // are no logged turns and the denominator is the refusals alone. A
        // division by logged turns would divide by zero here.
        const r = runReporter(['0', '9', '0']);
        expect(posted(r.posts, 'assistant_refusal_pct')).toBe('100');
    });

    it('names the breakdown in the journal once the rate crosses the alarm', () => {
        // So whoever is paged has the WHICH as well as the HOW MANY.
        const r = runReporter(['1', '9', '0']);
        expect(r.stderr).toContain('assistant refusal rate');
        expect(posted(r.posts, 'assistant_refusal_pct')).toBe('90');
    });

    it('stays quiet in the journal when the rate is normal', () => {
        // The control for the assertion above: a reporter that logged the
        // breakdown every run would make the journal useless at the moment it
        // is needed.
        const r = runReporter(['100', '1', '3']);
        expect(r.stderr).not.toContain('assistant refusal rate');
    });

    it('posts all four series in ONE request', () => {
        // `timeSeries` accepts differing metric types, so four metrics cost one
        // request and one timer. Four posts would be four chances to half-fail.
        const r = runReporter(['5', '1', '2']);
        expect(r.posts).toHaveLength(1);
        for (const m of [
            'assistant_refusal_pct',
            'assistant_refusals',
            'assistant_turns',
            'assistant_proposal_volume',
        ]) {
            expect(posted(r.posts, m)).not.toBeNull();
        }
    });
});
