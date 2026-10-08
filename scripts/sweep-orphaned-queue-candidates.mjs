#!/usr/bin/env node
/**
 * Cancel the CI runs of merge-queue candidates that can no longer merge.
 *
 * THE DEFECT (#3282)
 * ──────────────────
 * When a queue entry is ejected, dequeued, or has its PR closed, its
 * `gh-readonly-queue/<branch>/pr-<n>-<sha>` CI run KEEPS EXECUTING. Those jobs
 * cannot merge anything and they compete for the same Actions concurrency as
 * the rebuilt candidates of every entry behind them.
 *
 * Measured 2026-10-08. #3246 ejected at 12:38:09Z; observed 2m40s later, its
 * candidate run still held or awaited FIVE job slots out of roughly twenty —
 * about a quarter of the pool, spent at the exact moment scarcity had just been
 * proven. Separately on 2026-10-06, closing #3195 as superseded left its
 * candidate running a further 48 minutes against a PR that no longer existed.
 *
 * The resource an ejection proves is scarce is the resource the ejected entry
 * keeps consuming, and ejection at position 1 simultaneously forces everything
 * behind it to rebuild. That is the compounding part.
 *
 * WHY NOT `cancel-in-progress`
 * ───────────────────────────
 * It is deliberately `false`, and `ci.yml` documents why: a CANCELLED
 * merge-queue run reports FAILURE, which ejects the PR. Merge-queue runs are
 * also per-entry concurrency groups (`github.ref` is the readonly-queue ref), so
 * nothing supersedes them automatically. The fix has to be an explicit cancel of
 * runs whose entry is GONE — which is a different predicate, not a config flag.
 *
 * THE SAFETY PROPERTY THAT MATTERS MOST
 * ─────────────────────────────────────
 * Cancelling the OPERATIVE candidate reports FAILURE and ejects a healthy PR.
 * So a failed read of the merge queue must never be indistinguishable from an
 * empty one: `queuedPrNumbers: null` means UNKNOWN and nothing is cancelled,
 * while `[]` means the queue was read and is genuinely empty. A probe that
 * could not look returns unknown, never zero.
 *
 * WHY "a newer candidate exists" RATHER THAN "the base is wrong"
 * ─────────────────────────────────────────────────────────────
 * The sha in the ref is the BASE the candidate was built on, and for an entry at
 * position N that base is main plus the N-1 entries ahead — not main. So
 * "base != main" is wrong for every entry below the front, and reconstructing
 * the expected base means replaying the queue. Supersession has a simpler and
 * total test: for one PR, the newest candidate is the live one and every older
 * one is dead. #3246 held two simultaneously (bases 2e9a4d896 at 12:56:33 and
 * 6ec5e774a at 12:57:48); the older was as dead as an ejected run.
 */

const CANDIDATE_REF = /^gh-readonly-queue\/(?<branch>.+)\/pr-(?<pr>\d+)-(?<base>[0-9a-f]{40})$/;

/** @typedef {{id:number, headBranch:string, createdAt:string}} CandidateRun */
/** @typedef {{runId:number, pr:number|null, base:string|null, verdict:'cancel'|'keep', reason:string}} Verdict */

/**
 * Decide, for each in-flight candidate run, whether it can still merge.
 *
 * PURE — no network, no clock. Every branch below is reachable from
 * `selfTest()`, which is why the workflow runs `--self-test` before `--apply`.
 *
 * @param {{queuedPrNumbers: number[]|null, runs: CandidateRun[]}} input
 * @returns {Verdict[]}
 */
export function classifyCandidates({ queuedPrNumbers, runs }) {
    // UNKNOWN is not EMPTY. A GraphQL error, a rate limit, or a transport
    // failure must leave every candidate alone — the alternative is cancelling
    // the whole queue and ejecting every healthy PR in it.
    if (queuedPrNumbers === null || queuedPrNumbers === undefined) {
        return runs.map((r) => ({
            runId: r.id,
            pr: null,
            base: null,
            verdict: 'keep',
            reason: 'queue-unknown: the merge queue could not be read, so nothing is cancelled',
        }));
    }

    const inQueue = new Set(queuedPrNumbers);

    /**
     * Newest candidate REF per PR — not newest RUN per PR.
     *
     * THE BUG THIS REPLACES, which cancelled a healthy PR's required checks.
     * A candidate fans out across SEVERAL WORKFLOWS on one ref: measured, 33
     * refs in this repo carry three apiece (`CI`, `Integration Stress`,
     * `Bundle Analyze`). Grouping by PR and keeping the highest-id run therefore
     * kept ONE of them and called the other two superseded — and when `CI` was
     * among the losers, cancelling it reported FAILURE on the live entry, which
     * is what `ci.yml` warns about and what took #3277 to UNMERGEABLE.
     *
     * Two runs sharing a ref are never superseded relative to each other: they
     * are different checks on the SAME speculative merge. Supersession is a
     * property of refs, so the comparison must be between refs, and every run
     * on the newest ref is operative.
     */
    const newestRefForPr = new Map();
    for (const r of runs) {
        const m = CANDIDATE_REF.exec(r.headBranch);
        if (!m) continue;
        const pr = Number(m.groups.pr);
        const prev = newestRefForPr.get(pr);
        // Earliest creation seen for a ref is its creation: the workflows on one
        // ref start within the same second, and comparing a LATER sibling's
        // timestamp against another ref could order two refs backwards.
        const isNewer =
            prev === undefined ||
            r.createdAt > prev.createdAt ||
            // Same instant, different ref: fall back to the ref string so the
            // order is total. NEVER to run id — ids differ between workflows on
            // one ref, which is precisely how the old code split a candidate.
            (r.createdAt === prev.createdAt && r.headBranch > prev.headBranch);
        if (isNewer || r.headBranch === prev?.headBranch) {
            // Keep the EARLIEST timestamp for the winning ref, so a slow sibling
            // starting later cannot make its own ref look newer than it is.
            if (prev !== undefined && r.headBranch === prev.headBranch) {
                newestRefForPr.set(pr, {
                    headBranch: prev.headBranch,
                    createdAt: r.createdAt < prev.createdAt ? r.createdAt : prev.createdAt,
                });
            } else {
                newestRefForPr.set(pr, { headBranch: r.headBranch, createdAt: r.createdAt });
            }
        }
    }

    return runs.map((r) => {
        const m = CANDIDATE_REF.exec(r.headBranch);
        // An unrecognised ref is NOT an orphan. Never cancel what you cannot
        // identify — a ref-format change upstream would otherwise turn this
        // sweep into an outage.
        if (!m) {
            return {
                runId: r.id,
                pr: null,
                base: null,
                verdict: 'keep',
                reason: `unparseable-ref: ${r.headBranch}`,
            };
        }
        const pr = Number(m.groups.pr);
        const base = m.groups.base;

        if (!inQueue.has(pr)) {
            return {
                runId: r.id,
                pr,
                base,
                verdict: 'cancel',
                reason: `pr-not-in-queue: #${pr} is ejected, dequeued or closed`,
            };
        }
        const newest = newestRefForPr.get(pr);
        if (newest !== undefined && newest.headBranch !== r.headBranch) {
            return {
                runId: r.id,
                pr,
                base,
                verdict: 'cancel',
                reason: `superseded: #${pr} has a newer candidate ref (${newest.headBranch.slice(-40, -33)}…, this run is on ${base.slice(0, 7)}…)`,
            };
        }
        return {
            runId: r.id,
            pr,
            base,
            verdict: 'keep',
            reason: `operative: on the newest candidate ref for #${pr}, which is in the queue`,
        };
    });
}

/**
 * Built-in fixtures. The workflow runs this BEFORE touching anything, so a
 * refactor that breaks the predicate cannot reach the cancel call.
 */
export function selfTest() {
    const R = (id, pr, base, createdAt) => ({
        id,
        headBranch: `gh-readonly-queue/main/pr-${pr}-${base}`,
        createdAt,
    });
    const sha = (c) => c.repeat(40);
    const failures = [];
    const check = (name, got, want) => {
        if (got !== want) failures.push(`${name}: got ${got}, want ${want}`);
    };

    // 1. a PR that has left the queue is cancelled
    let v = classifyCandidates({
        queuedPrNumbers: [111],
        runs: [R(1, 222, sha('a'), '2026-01-01T00:00:00Z')],
    });
    check('ejected PR is cancelled', v[0].verdict, 'cancel');

    // 2. two candidates for a queued PR: the older goes, the newer stays
    v = classifyCandidates({
        queuedPrNumbers: [333],
        runs: [
            R(10, 333, sha('b'), '2026-01-01T00:00:00Z'),
            R(11, 333, sha('c'), '2026-01-01T00:01:00Z'),
        ],
    });
    check('older candidate cancelled', v.find((x) => x.runId === 10).verdict, 'cancel');
    check('newest candidate kept', v.find((x) => x.runId === 11).verdict, 'keep');

    // 3. THE CRITICAL ONE — an unreadable queue cancels nothing
    v = classifyCandidates({
        queuedPrNumbers: null,
        runs: [R(20, 444, sha('d'), '2026-01-01T00:00:00Z')],
    });
    check('unknown queue cancels nothing', v[0].verdict, 'keep');

    // 4. a genuinely empty queue DOES cancel — distinct from unknown
    v = classifyCandidates({
        queuedPrNumbers: [],
        runs: [R(30, 555, sha('e'), '2026-01-01T00:00:00Z')],
    });
    check('empty queue cancels', v[0].verdict, 'cancel');

    // 5. an unrecognised ref is never cancelled
    v = classifyCandidates({
        queuedPrNumbers: [],
        runs: [{ id: 40, headBranch: 'refs/heads/main', createdAt: '2026-01-01T00:00:00Z' }],
    });
    check('unparseable ref kept', v[0].verdict, 'keep');

    // 6. SEVERAL WORKFLOWS ON ONE REF — all kept. The case the old fixtures
    //    could not express, and the one that cancelled a healthy PR's required
    //    checks: a candidate fans out across `CI`, `Integration Stress` and
    //    `Bundle Analyze` on the SAME ref, with different run ids and the same
    //    creation second. Grouping by PR and keeping the highest id kept one and
    //    called the other two superseded.
    const sameRef = sha('f');
    v = classifyCandidates({
        queuedPrNumbers: [777],
        runs: [
            R(100, 777, sameRef, '2026-01-01T00:00:00Z'),
            R(101, 777, sameRef, '2026-01-01T00:00:00Z'),
            R(102, 777, sameRef, '2026-01-01T00:00:01Z'),
        ],
    });
    check('all runs on one ref are kept', v.filter((x) => x.verdict === 'keep').length, 3);
    check('none on one ref is cancelled', v.filter((x) => x.verdict === 'cancel').length, 0);

    // 7. three workflows on the NEWEST ref, two on an older one: 3 kept, 2 gone.
    //    A later-starting sibling on the OLD ref must not drag the old ref ahead
    //    of the new one, which is why the winning ref keeps its EARLIEST stamp.
    v = classifyCandidates({
        queuedPrNumbers: [888],
        runs: [
            R(200, 888, sha('0'), '2026-01-01T00:00:00Z'),
            R(201, 888, sha('0'), '2026-01-01T00:00:09Z'), // slow sibling, OLD ref
            R(202, 888, sha('1'), '2026-01-01T00:00:05Z'),
            R(203, 888, sha('1'), '2026-01-01T00:00:05Z'),
            R(204, 888, sha('1'), '2026-01-01T00:00:06Z'),
        ],
    });
    check('newest ref keeps all its runs', v.filter((x) => x.verdict === 'keep').length, 3);
    check('older ref loses all its runs', v.filter((x) => x.verdict === 'cancel').length, 2);
    check(
        'the slow sibling on the old ref is still cancelled',
        v.find((x) => x.runId === 201).verdict,
        'cancel',
    );

    // 8. same createdAt, different REF — the tie-break is total, so exactly one
    //    ref wins rather than both or neither.
    v = classifyCandidates({
        queuedPrNumbers: [666],
        runs: [
            R(50, 666, sha('0'), '2026-01-01T00:00:00Z'),
            R(51, 666, sha('1'), '2026-01-01T00:00:00Z'),
        ],
    });
    check('a same-instant REF tie keeps exactly one ref', v.filter((x) => x.verdict === 'keep').length, 1);

    return failures;
}

// ── IO, kept out of the predicate above ──────────────────────────────

const OWNER_REPO = process.env.GITHUB_REPOSITORY ?? 'RodnaPamet/inflect-compliance';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

async function api(path, init = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            accept: 'application/vnd.github+json',
            authorization: TOKEN ? `Bearer ${TOKEN}` : undefined,
            'x-github-api-version': '2022-11-28',
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok && res.status !== 409) {
        throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.status === 204 || res.status === 409 ? null : res.json();
}

/** @returns {Promise<number[]|null>} null means UNKNOWN, never empty-on-error. */
async function readMergeQueue(branch) {
    const query = `
      query($owner:String!, $name:String!, $branch:String!) {
        repository(owner:$owner, name:$name) {
          mergeQueue(branch:$branch) {
            entries(first:50) { nodes { pullRequest { number } } }
          }
        }
      }`;
    const [owner, name] = OWNER_REPO.split('/');
    try {
        const res = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ query, variables: { owner, name, branch } }),
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body.errors) return null;
        const nodes = body?.data?.repository?.mergeQueue?.entries?.nodes;
        if (!Array.isArray(nodes)) return null;
        return nodes.map((n) => n?.pullRequest?.number).filter((n) => typeof n === 'number');
    } catch {
        return null;
    }
}

async function inFlightCandidates() {
    const out = [];
    for (const status of ['queued', 'in_progress']) {
        let page = 1;
        for (;;) {
            const body = await api(
                `/repos/${OWNER_REPO}/actions/runs?event=merge_group&status=${status}&per_page=100&page=${page}`,
            );
            const runs = body?.workflow_runs ?? [];
            for (const r of runs) {
                out.push({ id: r.id, headBranch: r.head_branch, createdAt: r.created_at });
            }
            if (runs.length < 100) break;
            page += 1;
        }
    }
    // Dedupe: a run can change status between the two listings.
    return [...new Map(out.map((r) => [r.id, r])).values()];
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--self-test')) {
        const failures = selfTest();
        if (failures.length) {
            console.error('self-test FAILED:');
            for (const f of failures) console.error(`  ${f}`);
            process.exit(1);
        }
        console.log('self-test ok: 8 fixtures, including multi-workflow-per-ref and queue-unknown');
        return;
    }

    // `--classify` reads `{queuedPrNumbers, runs}` from stdin and prints the
    // verdicts as JSON. The seam exists so `tests/guards/` can drive the
    // predicate from EXTERNAL fixtures: `selfTest()` lives inside the artefact
    // it grades, so a refactor deleting both would leave the workflow green.
    if (argv.includes('--classify')) {
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        process.stdout.write(JSON.stringify(classifyCandidates(input)));
        return;
    }

    const branch = process.env.QUEUE_BRANCH ?? 'main';
    const apply = argv.includes('--apply');
    const queuedPrNumbers = await readMergeQueue(branch);
    const runs = await inFlightCandidates();
    const verdicts = classifyCandidates({ queuedPrNumbers, runs });

    if (argv.includes('--json')) {
        console.log(JSON.stringify({ queuedPrNumbers, verdicts }, null, 2));
        return;
    }

    // The denominator beside the result: a sweep that found no candidates and a
    // sweep whose listing broke print differently.
    console.log(`merge queue (${branch}): ${queuedPrNumbers === null ? 'UNREADABLE' : `[${queuedPrNumbers.join(', ')}]`}`);
    console.log(`in-flight merge_group runs: ${runs.length}`);
    const toCancel = verdicts.filter((v) => v.verdict === 'cancel');
    console.log(`orphaned: ${toCancel.length}`);
    for (const v of verdicts) {
        console.log(`  ${v.verdict === 'cancel' ? 'CANCEL' : 'keep  '} run=${v.runId} ${v.reason}`);
    }

    if (!apply) {
        console.log('\ndry run — pass --apply to cancel. Nothing was changed.');
        return;
    }
    for (const v of toCancel) {
        await api(`/repos/${OWNER_REPO}/actions/runs/${v.runId}/cancel`, { method: 'POST' });
        console.log(`cancelled run=${v.runId} (${v.reason})`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
