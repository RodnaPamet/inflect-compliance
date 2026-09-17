/**
 * A HUMAN DECIDES WHEN PRODUCTION MOVES — and the gate is not a YAML line.
 *
 * WHAT THIS PINS AND WHY IT IS NOT THE SAME PROPERTY AS THE SCAN
 * ──────────────────────────────────────────────────────────────
 * `tests/guardrails/publish-scans-before-push.test.ts` pins that nothing
 * reaches GHCR unscanned. That is a statement about CVEs. It says nothing
 * about INTENT: a scan passes on an image nobody meant to ship, and the
 * measured production topology turns a merge into a deployment in about a
 * minute — Watchtower polls `ghcr.io/rodnapamet/inflect-compliance:latest`
 * every 60 SECONDS on the VM, unpinned. On a product whose 05:00 leaver pass
 * DISABLES REAL ACCOUNTS in customers' Entra/AD directories, the blast radius
 * of an unintended merge is other companies' employees losing their logins.
 *
 * So `.github/workflows/ghcr-publish.yml` now splits the two tags across two
 * jobs, and this file pins the split:
 *
 *   · `build-push` runs with NOBODY in the path and publishes ONLY the
 *     immutable `:sha-<short>` tag. Keeping it ungated is deliberate — every
 *     commit stays built, scanned and present in GHCR as a rollback target,
 *     so `main` is never unable to publish.
 *   · `promote-latest` declares `environment: production-rollout` and is the
 *     ONLY thing that moves the rolling tag Watchtower follows.
 *
 * THE FAILURE MODE THIS FILE EXISTS FOR (#2246)
 * ─────────────────────────────────────────────
 * `environment: production-rollout` is the entire mechanism, and by itself it
 * does nothing. GitHub CREATES an environment the first time a workflow names
 * one that does not exist, with ZERO protection rules, and a job whose
 * environment protects nothing starts immediately — exactly as if the line
 * were absent. The approval lives in a REPOSITORY SETTING no file in this
 * repository can create, and this test cannot see that setting either. What
 * it CAN do is pin the two things that make the setting's absence visible
 * instead of silent:
 *
 *   1. the rolling tag is unreachable from the ungated job, so the setting is
 *      the only thing standing between a merge and production; and
 *   2. the gated job's FIRST step reads the environment back through the API
 *      and refuses to move the tag unless a required-reviewers rule is
 *      actually there — `scripts/assert-approval-gate.mjs`, whose decision
 *      table is EXECUTED below against synthetic API payloads rather than
 *      matched as text.
 *
 * Point 2 is the one that matters most, because it is the only assertion in
 * this repo that can distinguish "a reviewer is required" from "somebody
 * wrote the word environment". Everything else here is shape.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM
 * ──────────────────────────────────────────
 * It does not claim the repository setting exists. It cannot: repository
 * settings are not in the source tree, and a guard that asserted a fact it
 * cannot observe would be the exact thing being guarded against. The setting
 * is written down in `docs/deploy-approval-gate.md`, and the preflight is
 * what enforces it — at run time, on the runner, with the tag still unmoved.
 *
 * POPULATION
 * ──────────
 * One workflow file, parsed as the YAML GitHub executes, with its job list
 * asserted by name so a rename shows up here rather than as a vacuous pass.
 * The script's decision table is driven by synthetic payloads including both
 * a PASSING one and every failing one, so a green run means the detector can
 * tell them apart rather than that it answers the same way to everything.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { REPO_ROOT } from '../helpers/repo-files';

const PUBLISH_WORKFLOW = '.github/workflows/ghcr-publish.yml';
const UNGATED_JOB = 'build-push';
const GATED_JOB = 'promote-latest';
const PREFLIGHT_SCRIPT = 'scripts/assert-approval-gate.mjs';

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, unknown>;
    if?: unknown;
    'continue-on-error'?: unknown;
}
interface Job {
    steps?: Step[];
    environment?: unknown;
    permissions?: Record<string, unknown>;
    needs?: unknown;
    env?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
}
interface Workflow {
    env?: Record<string, unknown>;
    jobs?: Record<string, Job>;
}

function loadWorkflow(): Workflow {
    return yaml.load(fs.readFileSync(path.join(REPO_ROOT, PUBLISH_WORKFLOW), 'utf8')) as Workflow;
}

function stepName(step: Step, index: number): string {
    return step.name ?? step.uses ?? `step ${index}`;
}

/* ─────────────────────────── the detectors ───────────────────────────
 *
 * Each takes its input as an argument rather than reading the tree, so the
 * controls below can hand it a shape the repo does not have. A detector only
 * ever driven by the passing case has never been shown to discriminate.
 */

/**
 * The GitHub Environment a job waits on, or null. `environment:` accepts both
 * a bare string and a `{ name, url }` map; both are the gate, and reading
 * only one spelling is how a gate stops being seen.
 */
function environmentOf(job: Job): string | null {
    const env = job.environment;
    if (typeof env === 'string') return env.trim() === '' ? null : env.trim();
    if (env !== null && typeof env === 'object') {
        const name = (env as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim() !== '') return name.trim();
    }
    return null;
}

/**
 * Does one shell LINE move the rolling tag?
 *
 * Line-granular, and that granularity was bought with a false positive. The
 * first version asked the question of the whole run-block, which is broader —
 * the right direction to err, since missing a spelling lets the rolling tag
 * move from a job nobody approved. But `build-push`'s push step legitimately
 * NAMES `:latest`, in the branch that REFUSES to publish it, four lines above
 * a `docker push "$tag"` of the sha tags. Block granularity cannot tell a
 * refusal from a publication, and a guard that flags the safeguard is a guard
 * somebody deletes.
 *
 * The narrowing is not free and the cost is named: a rolling tag assembled
 * into a variable (`TAG="$IMAGE:latest"; docker push "$TAG"`) is invisible
 * here. That shape is covered from the other side — `latestTagReasons` below
 * denies the ungated job any `latest` tag to assemble, and the push step's
 * own refusal branch (asserted below) rejects one it is handed anyway.
 */
function movesRollingTagOnOneLine(line: string): boolean {
    if (!line.includes(':latest')) return false;
    return (
        line.includes('imagetools create') ||
        /\bdocker\s+(?:image\s+)?push\b/.test(line) ||
        /\bcrane\s+(?:push|copy|tag)\b/.test(line) ||
        /\bskopeo\s+copy\b/.test(line) ||
        /\bregctl\s+(?:image\s+copy|index\s+create|tag\s+create)\b/.test(line)
    );
}

function rollingTagMoves(step: Step): boolean {
    return (step.run ?? '').split('\n').some(movesRollingTagOnOneLine);
}

/**
 * Does a run-block REFUSE a `:latest` it is handed?
 *
 * The other half of the narrowing above. `build-push` publishes whatever
 * metadata-action resolved, so if that tag list ever regrows a `latest` the
 * ungated job would push it — and the assertion that the list is clean lives
 * in a different place from the loop that consumes it. The refusal is the
 * belt to that braces, and it only counts if it EXITS: a branch that logs and
 * carries on is the same publication with a warning attached.
 */
function refusesRollingTag(run: string): boolean {
    const lines = run.split('\n');
    const at = lines.findIndex((line) => line.includes(':latest)'));
    if (at === -1) return false;
    return lines.slice(at + 1, at + 6).some((line) => /\bexit\s+1\b/.test(line));
}

/** Every `<jobId>:<stepIndex>` in a workflow that can move `:latest`. */
function rollingTagMovers(wf: Workflow): Array<{ jobId: string; index: number; name: string }> {
    const found: Array<{ jobId: string; index: number; name: string }> = [];
    for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        (job.steps ?? []).forEach((step, index) => {
            if (rollingTagMoves(step)) found.push({ jobId, index, name: stepName(step, index) });
        });
    }
    return found;
}

/**
 * Why a docker/metadata-action step would mint a `latest` tag. Empty ⇒ it
 * cannot.
 *
 * TWO spellings, because there are two. `type=raw,value=latest` in `tags:` is
 * the obvious one; `flavor: latest=auto` (metadata-action's DEFAULT when the
 * key is absent) is the one that mints it with nothing in `tags:` mentioning
 * the word at all. An assertion that read only `tags:` would go green on a
 * one-line deletion that restores the ungated auto-deploy.
 */
function latestTagReasons(step: Step): string[] {
    const reasons: string[] = [];
    const w = step.with ?? {};
    const tags = String(w.tags ?? '');
    for (const entry of tags.split('\n').map((t) => t.trim()).filter(Boolean)) {
        if (/(^|[,=])latest\b/.test(entry) || /value=latest\b/.test(entry)) {
            reasons.push(`\`tags:\` entry \`${entry}\` mints a latest tag`);
        }
    }
    const flavor = String(w.flavor ?? '');
    const latestFlavor = /(?:^|\n)\s*latest\s*=\s*([a-zA-Z]+)/.exec(flavor)?.[1];
    if (latestFlavor === undefined) {
        reasons.push('`flavor:` does not set `latest=`, so metadata-action defaults to `latest=auto`');
    } else if (latestFlavor.toLowerCase() !== 'false') {
        reasons.push(`\`flavor: latest=${latestFlavor}\` is not \`false\``);
    }
    return reasons;
}

/** metadata-action steps in a job, with their latest-tag reasons. */
function metadataSteps(job: Job): Array<{ index: number; name: string; reasons: string[] }> {
    return (job.steps ?? [])
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => (step.uses ?? '').includes('docker/metadata-action'))
        .map(({ step, index }) => ({
            index,
            name: stepName(step, index),
            reasons: latestTagReasons(step),
        }));
}

function isTrivyStep(step: Step): boolean {
    return (step.uses ?? '').includes('aquasecurity/trivy-action');
}

/**
 * Why a Trivy step is not a blocking gate. Empty ⇒ it can fail the job.
 * Same four defects `publish-scans-before-push.test.ts` enumerates, restated
 * locally so the NEW job is covered by an assertion that names it rather than
 * by one that happens to sweep it up.
 */
function gateDefects(step: Step): string[] {
    const defects: string[] = [];
    const w = step.with ?? {};
    if (String(w['exit-code'] ?? '').trim() !== '1') {
        defects.push(`exit-code is "${String(w['exit-code'] ?? '')}", not "1"`);
    }
    const severities = String(w.severity ?? '')
        .toUpperCase()
        .split(',')
        .map((s) => s.trim());
    if (!(severities.includes('CRITICAL') && severities.includes('HIGH'))) {
        defects.push(`severity "${String(w.severity ?? '')}" does not block both CRITICAL and HIGH`);
    }
    if (step.if !== undefined) defects.push('carries an `if:`');
    if (step['continue-on-error'] !== undefined) defects.push('carries `continue-on-error`');
    return defects;
}

/** Index of the step that runs the approval preflight, or -1. */
function preflightIndex(job: Job): number {
    return (job.steps ?? []).findIndex((step) => (step.run ?? '').includes(PREFLIGHT_SCRIPT));
}

/* ───────────────── the preflight script, EXECUTED ───────────────── */

interface GateRun {
    status: number | null;
    output: string;
}

/**
 * Run the real script against a payload, exactly as the workflow step does.
 *
 * Executed rather than read, because the property is a DECISION, not a
 * spelling. A text assertion over this script would stay green on a change
 * from `reviewers.length === 0` to `reviewers.length < 0`, which is the whole
 * class of edit this file exists to catch.
 */
function runPreflight(payload: string | null, environmentName = 'production-rollout'): GateRun {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-gate-'));
    try {
        const file = path.join(dir, 'environment.json');
        if (payload !== null) fs.writeFileSync(file, payload, 'utf8');
        const result = spawnSync(
            process.execPath,
            [path.join(REPO_ROOT, PREFLIGHT_SCRIPT), file, environmentName],
            { encoding: 'utf8' },
        );
        return {
            status: result.status,
            output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A payload GitHub returns for an environment that really requires review. */
const CONFIGURED = JSON.stringify({
    name: 'production-rollout',
    protection_rules: [
        {
            id: 1,
            type: 'required_reviewers',
            prevent_self_review: false,
            reviewers: [{ type: 'User', reviewer: { login: 'an-owner' } }],
        },
    ],
});

/**
 * Every payload that must be refused, and what each one really is. The names
 * are the point: three of these are shapes a reader would call "the gate is
 * on" at a glance.
 */
const REFUSED: ReadonlyArray<{ label: string; payload: string | null }> = [
    { label: 'environment exists but protects nothing', payload: JSON.stringify({ protection_rules: [] }) },
    {
        label: 'wait timer only — a delay is not a decision',
        payload: JSON.stringify({ protection_rules: [{ type: 'wait_timer', wait_timer: 30 }] }),
    },
    {
        label: 'required_reviewers rule with an EMPTY reviewer list',
        payload: JSON.stringify({ protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }),
    },
    {
        label: 'branch policy only — scopes which refs may deploy, asks nobody',
        payload: JSON.stringify({ protection_rules: [{ type: 'branch_policy' }] }),
    },
    { label: 'a payload with no protection_rules key at all', payload: JSON.stringify({ name: 'x' }) },
    { label: 'a JSON array rather than the environment object', payload: '[]' },
    { label: 'not JSON — an API error page or a truncated body', payload: 'Not Found' },
    { label: 'no file at all — the API call itself failed', payload: null },
];

/* ───────────────────────────── the assertions ───────────────────────────── */

describe('the rolling :latest tag moves only behind a human approval', () => {
    const wf = loadWorkflow();
    const jobs = wf.jobs ?? {};
    const ungated = jobs[UNGATED_JOB];
    const gated = jobs[GATED_JOB];

    it('the publish workflow parses into exactly the two jobs this file is about', () => {
        // The denominator, printed. Every assertion below selects a job by
        // name; a rename would make each of them vacuous one at a time, so the
        // job list is asserted whole and first.
        expect(Object.keys(jobs).sort()).toEqual([UNGATED_JOB, GATED_JOB].sort());
        expect((ungated?.steps ?? []).length).toBeGreaterThan(0);
        expect((gated?.steps ?? []).length).toBeGreaterThan(0);
    });

    it('exactly one step in the whole workflow can move :latest, and it is in the GATED job', () => {
        // The central claim. If a second mover appears anywhere — a helper
        // step in `build-push`, a new job — this list grows and says where.
        const movers = rollingTagMovers(wf);
        expect(movers.map((m) => `${m.jobId}:${m.index} ("${m.name}")`)).toHaveLength(1);
        expect(movers[0].jobId).toBe(GATED_JOB);
    });

    it('the UNGATED job cannot mint a latest tag, by either metadata-action spelling', () => {
        // `build-push` runs with nobody in the path. Whatever it publishes
        // reaches the registry unreviewed, so the one thing it must not be
        // able to publish is the tag production follows.
        const metas = metadataSteps(ungated ?? {});
        expect(metas.map((m) => m.index)).not.toEqual([]);
        expect(metas.filter((m) => m.reasons.length > 0).map((m) => `${m.name}: ${m.reasons.join('; ')}`)).toEqual([]);
        // …and it is ungated on purpose: every commit must still build, scan
        // and publish its immutable tag with no human, or there is nothing to
        // roll back TO and `main` cannot publish at all.
        expect(environmentOf(ungated ?? {})).toBeNull();
    });

    it('the UNGATED job REFUSES a :latest it is handed, rather than pushing it', () => {
        // Belt to the braces above, and they fail in different places on
        // purpose. The assertion above reads the metadata-action config; this
        // one reads the loop that consumes its output. A `latest` that got
        // into the tag list by some route nobody anticipated — a
        // metadata-action default change, a `type=raw` added under a different
        // key — reaches this loop, and the loop exits rather than publishing.
        const pushes = (ungated?.steps ?? []).filter((step) => /\bdocker\s+push\b/.test(step.run ?? ''));
        expect(pushes.map((step, i) => stepName(step, i))).toHaveLength(1);
        expect({ refusesTheRollingTag: refusesRollingTag(pushes[0].run ?? '') }).toEqual({
            refusesTheRollingTag: true,
        });
    });

    it('DETECTOR CONTROL: a refusal that only logs does not count as one', () => {
        // The whole value of the assertion above is the `exit`. A branch that
        // warns and falls through publishes the tag with a log line attached,
        // and reads identically to a reviewer scanning for the word "latest".
        const exits = 'for tag in "${TAGS[@]}"; do\n  case "$tag" in\n    *:latest)\n      echo "::error::no"\n      exit 1\n      ;;\n  esac\ndone';
        const warns = 'for tag in "${TAGS[@]}"; do\n  case "$tag" in\n    *:latest)\n      echo "::warning::pushing latest"\n      ;;\n  esac\n  docker push "$tag"\ndone';
        expect({ exits: refusesRollingTag(exits), warns: refusesRollingTag(warns) }).toEqual({
            exits: true,
            warns: false,
        });
        // …and a block that never mentions the rolling tag is not a refusal.
        expect(refusesRollingTag('docker push "$tag"')).toBe(false);
    });

    it('DETECTOR CONTROL: a refusal branch is not mistaken for a move, and a move still is', () => {
        // The false positive that forced line granularity. `build-push`'s real
        // push step names `:latest` in the branch that rejects it and runs
        // `docker push` four lines later; a block-granular detector called
        // that a move and flagged the safeguard.
        const refusal = (ungated?.steps ?? []).filter((step) => /\bdocker\s+push\b/.test(step.run ?? ''))[0];
        expect(rollingTagMoves(refusal)).toBe(false);
        // The three real spellings, each on one line, are still seen.
        expect({
            imagetools: rollingTagMoves({ run: 'docker buildx imagetools create --tag "${IMAGE}:latest" "$SRC"' }),
            push: rollingTagMoves({ run: 'docker push ghcr.io/x/y:latest' }),
            crane: rollingTagMoves({ run: 'crane copy ghcr.io/x/y@sha256:d ghcr.io/x/y:latest' }),
            inspectOnly: rollingTagMoves({ run: 'docker buildx imagetools inspect "${IMAGE}:latest"' }),
        }).toEqual({ imagetools: true, push: true, crane: true, inspectOnly: false });
    });

    it('DETECTOR CONTROL: both latest-tag spellings are seen, and the real config is not', () => {
        // Without this, "no reasons found" and "the detector is broken" are
        // the same green. Each control is a real metadata-action config.
        const raw: Step = { uses: 'docker/metadata-action@v6', with: { tags: 'type=raw,value=latest\ntype=sha,prefix=sha-', flavor: 'latest=false' } };
        const defaulted: Step = { uses: 'docker/metadata-action@v6', with: { tags: 'type=sha,prefix=sha-' } };
        const auto: Step = { uses: 'docker/metadata-action@v6', with: { tags: 'type=sha,prefix=sha-', flavor: 'latest=auto' } };
        const safe: Step = { uses: 'docker/metadata-action@v6', with: { tags: 'type=sha,prefix=sha-,format=short', flavor: 'latest=false' } };
        expect(latestTagReasons(raw)).toEqual(['`tags:` entry `type=raw,value=latest` mints a latest tag']);
        expect(latestTagReasons(defaulted)).toEqual([
            '`flavor:` does not set `latest=`, so metadata-action defaults to `latest=auto`',
        ]);
        expect(latestTagReasons(auto)).toEqual(['`flavor: latest=auto` is not `false`']);
        expect(latestTagReasons(safe)).toEqual([]);
    });

    it('the GATED job declares an environment, and the preflight checks THAT environment', () => {
        // Two spellings of one name, in two places the `env` context cannot
        // bridge (`jobs.<id>.environment` has no `env` context, so the job key
        // must be a literal). A preflight pointed at a DIFFERENT environment
        // would confirm a gate that is not in this job's path — a green check
        // for a rule protecting nothing.
        const declared = environmentOf(gated ?? {});
        expect(declared).toBe('production-rollout');
        expect(String(wf.env?.APPROVAL_ENVIRONMENT ?? '')).toBe(declared);
    });

    it('DETECTOR CONTROL: environmentOf reads both spellings and rejects the empty ones', () => {
        expect(environmentOf({ environment: 'production-rollout' })).toBe('production-rollout');
        expect(environmentOf({ environment: { name: 'production-rollout', url: 'https://x' } })).toBe('production-rollout');
        expect(environmentOf({})).toBeNull();
        expect(environmentOf({ environment: '' })).toBeNull();
        expect(environmentOf({ environment: { url: 'https://x' } })).toBeNull();
    });

    it('the preflight runs FIRST, unconditionally, before anything can move the tag', () => {
        // Order is the whole assertion, as it is for the scan. A preflight
        // below the promote step would report on a tag that had already moved.
        const index = preflightIndex(gated ?? {});
        expect(index).toBeGreaterThan(-1);
        const step = (gated?.steps ?? [])[index];
        // An `if:` or a `continue-on-error:` turns it into a notification
        // while leaving it fully visible in the YAML — the most expensive
        // weakening, because it survives a reviewer reading the file.
        expect(step.if).toBeUndefined();
        expect(step['continue-on-error']).toBeUndefined();
        const mover = rollingTagMovers(wf).find((m) => m.jobId === GATED_JOB);
        expect(index).toBeLessThan(mover!.index);
        // …and the script it runs is really there.
        expect(fs.existsSync(path.join(REPO_ROOT, PREFLIGHT_SCRIPT))).toBe(true);
        // The preflight's only non-default permission need. Without
        // `actions: read`, GITHUB_TOKEN cannot read the environment back and
        // the probe fails — which the script treats as a refusal, so a
        // missing permission is a red job rather than a silent pass.
        expect(String((gated?.permissions ?? {}).actions ?? '')).toBe('read');
    });

    it('the digest that is SCANNED is the digest that is PROMOTED, and neither is a tag', () => {
        // A tag can be re-pointed between the scan and the promote; a digest
        // cannot. This is the same invariant `SCAN_REF` buys in `build-push`
        // by being registry-less, obtained from the other side.
        expect(String((gated?.env ?? {}).IMAGE ?? '')).toBe('${{ needs.build-push.outputs.image }}');
        expect(String((gated?.env ?? {}).DIGEST ?? '')).toBe('${{ needs.build-push.outputs.digest }}');
        // …and the job it reads them from actually declares them.
        expect(Object.keys(ungated?.outputs ?? {}).sort()).toEqual(['digest', 'image']);

        const gate = (gated?.steps ?? []).find((s) => isTrivyStep(s));
        expect(gate).toBeDefined();
        expect(String((gate!.with ?? {})['image-ref'])).toBe('${{ env.IMAGE }}@${{ env.DIGEST }}');

        const mover = rollingTagMovers(wf).find((m) => m.jobId === GATED_JOB)!;
        const moverRun = (gated?.steps ?? [])[mover.index].run ?? '';
        expect({
            promotesTheScannedDigest: moverRun.includes('"${IMAGE}@${DIGEST}"'),
        }).toEqual({ promotesTheScannedDigest: true });
    });

    it('a BLOCKING Trivy gate re-scans that digest before the tag moves', () => {
        // Not redundant with the scan in `build-push`: an approval can sit for
        // days, and Trivy's database moves. The re-scan is also the thing that
        // keeps the new push site compliant with
        // `publish-scans-before-push.test.ts` — scan below, push above, in the
        // same job.
        const steps = gated?.steps ?? [];
        const gates = steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => isTrivyStep(step));
        expect(gates.map(({ index }) => index)).not.toEqual([]);
        expect(
            gates.filter(({ step }) => gateDefects(step).length > 0).map(({ step, index }) => `step ${index} ("${stepName(step, index)}"): ${gateDefects(step).join('; ')}`),
        ).toEqual([]);
        const mover = rollingTagMovers(wf).find((m) => m.jobId === GATED_JOB)!;
        expect(gates[0].index).toBeLessThan(mover.index);
    });
});

describe('the approval preflight refuses everything that is not a required reviewer', () => {
    // The teeth of this file. The workflow assertions above are shape; these
    // run the real decision the runner will run, and they run BOTH directions
    // — one payload that must pass and eight that must not. A script that
    // always exited 0 would satisfy the first test and fail all eight; one
    // that always exited 1 would fail the first.

    it('ACCEPTS an environment that really requires a reviewer', () => {
        const run = runPreflight(CONFIGURED);
        expect({ status: run.status, sawReviewer: run.output.includes('an-owner') }).toEqual({
            status: 0,
            sawReviewer: true,
        });
    });

    it.each(REFUSED.map((c) => [c.label, c.payload] as const))('REFUSES: %s', (label, payload) => {
        const run = runPreflight(payload);
        // Asserted as an object carrying the label, so a failure names WHICH
        // payload slipped through rather than only that one did.
        expect({ label, status: run.status }).toEqual({ label, status: 1 });
        // …and it tells the reader what to do about it. A refusal nobody can
        // act on gets routed around by whoever is on call at 02:00.
        expect({ label, namesTheRemedy: run.output.includes('Required reviewers') }).toEqual({
            label,
            namesTheRemedy: true,
        });
    });

    it('distinguishes "provably absent" from "could not look", and refuses both', () => {
        // A failed probe is UNKNOWN, never 0. Both refuse, but they must not
        // print the same thing: one asks for a setting, the other asks whether
        // the API call worked, and telling a responder the wrong one costs the
        // incident.
        const absent = runPreflight(JSON.stringify({ protection_rules: [] }));
        const unknown = runPreflight('Not Found');
        expect({ absent: absent.status, unknown: unknown.status }).toEqual({ absent: 1, unknown: 1 });
        expect({
            absentSaysDidNotWait: absent.output.includes('did NOT wait for a human'),
            absentSaysUnknown: absent.output.includes('UNKNOWN, not "configured"'),
            unknownSaysUnknown: unknown.output.includes('UNKNOWN, not "configured"'),
        }).toEqual({ absentSaysDidNotWait: true, absentSaysUnknown: false, unknownSaysUnknown: true });
    });

    it('names the environment it was asked about, not a hard-coded one', () => {
        // The preflight takes the environment name from the workflow. If it
        // ignored the argument it would report on whatever it had baked in,
        // which is the "gate confirmed, elsewhere" failure.
        const run = runPreflight(JSON.stringify({ protection_rules: [] }), 'some-other-environment');
        expect({ status: run.status, named: run.output.includes('"some-other-environment"') }).toEqual({
            status: 1,
            named: true,
        });
    });
});
