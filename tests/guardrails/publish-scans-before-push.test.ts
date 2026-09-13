/**
 * Every image push must be GATED by a vulnerability scan that ran first.
 *
 * THE BUG THIS COMES FROM
 * ───────────────────────
 * `.github/workflows/ghcr-publish.yml` is the only deploy path this product
 * has: it pushes `:latest` to GHCR on every push to `main`, and the
 * production VM runs Watchtower unpinned on that tag. Until 2026-09-13 it
 * contained ZERO references to Trivy. The scan lived only in `ci.yml`, in a
 * job declared `needs: [docker]`, running in a DIFFERENT workflow on a
 * different clock.
 *
 * On 2026-09-12 that arrangement failed in the only way that matters. For
 * the sha that actually published (75496ea46, publish run 34722259794):
 *
 *   · the publish workflow pushed `:latest`, and Watchtower — which polls
 *     every 60 SECONDS — stopped the production containers at 22:37:20,
 *     about a minute after the rolling tag moved;
 *   · that was 24 minutes BEFORE its CI run (34722259790) reached the point
 *     of not scanning it: `Docker Build` completed `skipped` at 23:01:48 and
 *     `Trivy Image Scan` completed `skipped` at 23:01:49;
 *   · the skip was NOT a killed Docker Build. An upstream `build` job
 *     FAILED, so `docker` (declared `needs: [build, changes]`) skipped, and
 *     `trivy` skipped behind it. A skipped dependent is not a failure, so
 *     the run never went red on the scan's absence.
 *
 * An unscanned image reached production and nothing anywhere was red. The
 * mechanism is broader than any one timeout: ANY failure or skip upstream of
 * `docker` deletes the verdict, and none of them turn the publish red,
 * because the publish is a different workflow that never consults it. The
 * fix was structural — the workflow that publishes the image is now the
 * workflow that scans it, and it scans BEFORE it pushes.
 *
 * WHY THE ORDER IS THE WHOLE ASSERTION
 * ────────────────────────────────────
 * A scan bolted on AFTER the push gates nothing. By the time it runs the
 * bytes are on `:latest` and Watchtower may already have pulled them — and
 * with a 60-second poll, "may" is "will, within the minute". The scan's only
 * remaining power is to turn a workflow red while the vulnerable image
 * serves traffic. "The publish workflow mentions Trivy" is therefore not the
 * property worth guarding, and a grep for `trivy` in the file would have
 * been satisfied by exactly the arrangement that fails. So this file parses
 * the YAML that GitHub executes and asserts a relationship between two step
 * INDICES inside one job.
 *
 * WHAT COUNTS AS A PUSH — AN ALLOWLIST, NOT A LIST OF SPELLINGS
 * ─────────────────────────────────────────────────────────────
 * The first version of this file asked whether a `run:` block matched
 * `/\bdocker\s+push\b/` or `/\bimagetools\s+create\b/`. An adversarial
 * review inserted a step running
 * `docker image push "ghcr.io/rodnapamet/inflect-compliance:latest"`
 * immediately ABOVE the gate and this file reported 12/12 green — the
 * central invariant defeated at a live site, by docker's own management-
 * command spelling, which this very workflow already uses two steps up as
 * `docker image prune` / `docker image ls`. Six of nine enumerated spellings
 * were invisible.
 *
 * A denylist of push spellings is unbounded: `docker image push`,
 * `docker buildx build --push`, `--output type=registry`, `skopeo copy`,
 * `crane push`, `regctl image copy`, `oras push`, `"$DOCKER" push`. What IS
 * bounded is the set of things a step legitimately does to a local image
 * before it has been scanned. So the rule is inverted:
 *
 *   · a run-line whose command is a REGISTRY-CAPABLE TOOL is a push UNLESS
 *     its subcommand chain is on `LOCAL_ONLY_SUBCOMMANDS` and it carries no
 *     registry-output flag (`--push`, `type=registry`);
 *   · `docker/build-push-action` is a push unless `push:` is literally
 *     absent/false AND every `outputs:` entry names a LOCAL exporter;
 *   · a command resolved from a shell variable cannot be read statically, so
 *     it fails closed when it runs a registry-write verb or names a registry.
 *
 * Adding a legitimately-local command means adding it to the allowlist — an
 * edit a reviewer sees. Adding a push does not require anyone's cooperation,
 * which is why it must not be the case that needs enumerating.
 *
 * WHAT COUNTS AS A GATE
 * ─────────────────────
 * An `aquasecurity/trivy-action` step with `exit-code: "1"`, a severity list
 * containing both CRITICAL and HIGH, NO `if:` and NO `continue-on-error`.
 * The last two are not decoration and were the second and third findings of
 * the same review: `continue-on-error: true` makes the step's conclusion
 * `success`, and a skipped step does not falsify the default `success()`
 * condition on the push step below — so in BOTH cases the push still runs
 * and the job still concludes success. Either one turns a gate into a
 * notification while leaving it fully visible in the YAML, which is the most
 * expensive failure of the three because it survives a reviewer reading the
 * file. `tests/guardrails/schema-drift-gate-runs-in-ci.test.ts` had already
 * written that sentence down for its own gate; this file now implements the
 * same two checks (`step.if !== undefined`, `step['continue-on-error'] !==
 * undefined`) plus a test named for being unconditional.
 *
 * WHAT COUNTS AS SCANNING THE RIGHT IMAGE
 * ───────────────────────────────────────
 * The gate's `image-ref` is pinned to `${{ env.SCAN_REF }}`, and `SCAN_REF`
 * is asserted to be registry-LESS. Re-pointing it at
 * `ghcr.io/rodnapamet/inflect-compliance:latest` scans the PREVIOUSLY
 * PUBLISHED image pulled from GHCR instead of the one about to ship — a scan
 * that passes while saying nothing about what is being published. The
 * workflow's own `SCAN_REF` comment names that hazard; nothing enforced it
 * until this file did.
 *
 * POPULATION
 * ──────────
 * `repoRelativeFiles()` — what git says is in the repo — filtered to
 * `.github/workflows/*.yml`. Not an `fs.readdirSync` walk: a worktree under
 * `.claude/` holds a full second copy of every workflow in this repo, and a
 * directory walk reads it (see
 * `tests/guardrails/source-scan-population.test.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const WORKFLOW_DIR = '.github/workflows';
const PUBLISH_WORKFLOW = 'ghcr-publish.yml';
const PUBLISH_JOB = 'build-push';

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: unknown;
    'continue-on-error'?: unknown;
}
interface Job {
    steps?: Step[];
}
interface Workflow {
    env?: Record<string, unknown>;
    jobs?: Record<string, Job>;
}

interface WorkflowDoc {
    /** Repo-relative path, e.g. `.github/workflows/ghcr-publish.yml`. */
    file: string;
    wf: Workflow;
}

interface StepRef {
    index: number;
    name: string;
    /** Why this step was classified as a push / why a scan is not a gate. */
    why: string[];
}

interface Site {
    /** Basename, so the identifiers in failure messages stay short. */
    workflow: string;
    jobId: string;
    pushes: StepRef[];
    /** Trivy steps that can actually fail the job at CRITICAL,HIGH. */
    blockingScans: StepRef[];
    /** Every Trivy step, blocking or not — used to tell the two cases apart. */
    allScans: StepRef[];
}

/** The workflow files git considers part of this repo, parsed. */
function workflowFileList(): string[] {
    return repoRelativeFiles().filter(
        (rel) => rel.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(rel),
    );
}

function workflowDocs(): WorkflowDoc[] {
    return workflowFileList().map((rel) => ({
        file: rel,
        wf: yaml.load(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Workflow,
    }));
}

function stepName(step: Step, index: number): string {
    return step.name ?? step.uses ?? `step ${index}`;
}

/* ───────────────────────── run-block analysis ───────────────────────── */

/** Command-line tools that can write image bytes into a registry. */
const REGISTRY_TOOLS = new Set([
    'docker',
    'podman',
    'nerdctl',
    'buildah',
    'skopeo',
    'crane',
    'regctl',
    'oras',
    'ctr',
    'img',
    'buildctl',
]);

/**
 * ALLOWLIST — subcommand chains a registry-capable tool may run that cannot
 * put bytes in a registry. Anything not here is treated as a push.
 *
 * Longest match wins, and the token AFTER the matched chain is re-checked
 * against the write verbs, so `docker compose push` cannot pass by matching
 * the one-word `compose`.
 */
const LOCAL_ONLY_SUBCOMMANDS: readonly string[] = [
    // build / read / tag — local daemon only
    'build',
    'buildx build',
    'image build',
    'tag',
    'image tag',
    'pull',
    'image pull',
    'load',
    'image load',
    'import',
    'image import',
    'save',
    'image save',
    'export',
    'image ls',
    'image list',
    'images',
    'image inspect',
    'inspect',
    'manifest inspect',
    'buildx imagetools inspect',
    // housekeeping
    'image prune',
    'image rm',
    'rmi',
    'buildx prune',
    'builder prune',
    'system prune',
    'container prune',
    'volume prune',
    'network prune',
    // daemon / builder lifecycle
    'login',
    'logout',
    'version',
    'info',
    'buildx create',
    'buildx use',
    'buildx ls',
    'buildx rm',
    'buildx version',
    'buildx inspect',
    // running containers
    'run',
    'exec',
    'ps',
    'start',
    'stop',
    'rm',
    'kill',
    'logs',
    'cp',
    'wait',
    'port',
    'top',
    'compose',
];

/** Verbs that move an image INTO a registry, whatever the tool. */
const REGISTRY_WRITE_VERBS = new Set(['push', 'copy', 'create', 'publish']);

/** Exporters that write to the local filesystem or daemon, never a registry. */
const LOCAL_EXPORTERS = new Set(['docker', 'oci', 'tar', 'local', 'cacheonly']);

const OCI_REGISTRY_REF = /(?:^|[@/"'\s])(?:ghcr\.io|docker\.io|quay\.io|[a-z0-9-]+\.pkg\.dev|[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com)\//;

/** Shell wrappers that precede the real command word. */
const COMMAND_WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'exec', 'nohup', 'builtin']);

function unquote(token: string): string {
    return token.replace(/^["']/, '').replace(/["']$/, '');
}

function looksLikeVariable(token: string): boolean {
    return /\$\{?\{?/.test(token);
}

/**
 * Split a `run:` block into individual command invocations. Deliberately
 * crude — `&&`, `||`, `;`, `|` and newlines — because the only job here is to
 * find the command WORD at the head of each fragment.
 */
function commandLines(run: string): string[] {
    return run
        .split(/&&|\|\||\||;|\n/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Tokens of one command, with env assignments and wrappers stripped. */
function commandTokens(line: string): string[] {
    let tokens = line.split(/\s+/).filter(Boolean);
    for (;;) {
        const head = tokens[0];
        if (head === undefined) break;
        if (COMMAND_WRAPPERS.has(head) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
            tokens = tokens.slice(1);
            continue;
        }
        break;
    }
    return tokens;
}

/** The leading non-flag words after the tool name, e.g. ['image', 'prune']. */
function subcommandWords(rest: string[]): string[] {
    const words: string[] = [];
    for (const token of rest) {
        if (token.startsWith('-')) break;
        words.push(unquote(token));
    }
    return words;
}

/** `--push`, `--output type=registry`, `-o type=image,push=true`, … */
function registryOutputFlag(rest: string[]): string | null {
    for (const raw of rest) {
        const token = unquote(raw);
        if (token === '--push' || token === '--push=true') return '`--push`';
        if (/type=registry/.test(token)) return '`type=registry`';
        if (/type=image/.test(token) && /push=true/.test(token)) return '`type=image,push=true`';
    }
    return null;
}

/**
 * The longest allowlisted subcommand chain for `words`, or null when none of
 * them is on the allowlist.
 */
function allowlistedChain(words: string[]): { chain: string; length: number } | null {
    for (let n = Math.min(3, words.length); n >= 1; n -= 1) {
        const chain = words.slice(0, n).join(' ');
        if (LOCAL_ONLY_SUBCOMMANDS.includes(chain)) return { chain, length: n };
    }
    return null;
}

/** Every reason a `run:` block might reach a registry. Empty ⇒ it cannot. */
function registryWritesIn(run: string): string[] {
    const reasons: string[] = [];
    for (const line of commandLines(run)) {
        const tokens = commandTokens(line);
        if (tokens.length === 0) continue;
        const head = unquote(tokens[0]);
        const rest = tokens.slice(1);

        if (REGISTRY_TOOLS.has(path.basename(head))) {
            const words = subcommandWords(rest);
            const match = allowlistedChain(words);
            if (match === null) {
                reasons.push(
                    `\`${[head, ...words].join(' ')}\` is not on the local-only allowlist for \`${head}\``,
                );
                continue;
            }
            const next = words[match.length];
            if (next !== undefined && REGISTRY_WRITE_VERBS.has(next)) {
                reasons.push(`\`${head} ${match.chain} ${next}\` runs the registry-write verb \`${next}\``);
                continue;
            }
            const flag = registryOutputFlag(rest);
            if (flag !== null) {
                reasons.push(`\`${head} ${match.chain}\` carries ${flag}, which publishes from the build`);
            }
            continue;
        }

        if (looksLikeVariable(head)) {
            // A command name this cannot resolve. Fail closed on anything that
            // looks like it moves an image: `"$DOCKER" push "$tag"`.
            const verb = subcommandWords(rest).find((w) => REGISTRY_WRITE_VERBS.has(w));
            if (verb !== undefined) {
                reasons.push(
                    `\`${tokens[0]} … ${verb}\` — the command name comes from a shell variable this cannot resolve, and it runs \`${verb}\``,
                );
                continue;
            }
            if (OCI_REGISTRY_REF.test(line)) {
                reasons.push(
                    `\`${tokens[0]} …\` — the command name comes from a shell variable this cannot resolve, and the line names a registry`,
                );
            }
        }
    }
    return reasons;
}

/* ───────────────────────── step classification ───────────────────────── */

/** Why a `docker/build-push-action` step reaches the registry. Empty ⇒ it does not. */
function buildActionPushes(step: Step): string[] {
    const reasons: string[] = [];
    const w = step.with ?? {};

    // ALLOWLIST on `push:`: only a literal absent/false is "does not push".
    // Everything else — `true`, and any `${{ … }}` GitHub resolves at run time
    // — counts, which is the conservative direction: a genuinely conditional
    // push sitting above the scan IS the hazard, so the red is correct rather
    // than noise.
    const push = String(w.push ?? '').trim().toLowerCase();
    if (push !== '' && push !== 'false') {
        reasons.push(`\`push: ${String(w.push)}\` is not a literal false`);
    }

    // `outputs: type=registry` is buildx's documented equivalent of
    // `push: true` on the same action, under a different input name.
    const outputs = String(w.outputs ?? '').trim();
    if (outputs !== '') {
        for (const entry of outputs.split('\n').map((e) => e.trim()).filter(Boolean)) {
            const type = /(?:^|,)\s*type=([a-zA-Z]+)/.exec(entry)?.[1];
            if (type === undefined) {
                reasons.push(`\`outputs: ${entry}\` declares no \`type=\`, so its destination cannot be read`);
            } else if (!LOCAL_EXPORTERS.has(type)) {
                reasons.push(`\`outputs: ${entry}\` uses the non-local exporter \`type=${type}\``);
            } else if (/push=true/.test(entry)) {
                reasons.push(`\`outputs: ${entry}\` carries \`push=true\``);
            }
        }
    }
    return reasons;
}

/** A step that puts image bytes into a registry, with the reasons why. */
function pushReasons(step: Step): string[] {
    if ((step.uses ?? '').includes('docker/build-push-action')) {
        return buildActionPushes(step);
    }
    return registryWritesIn(step.run ?? '');
}

function isTrivyStep(step: Step): boolean {
    return (step.uses ?? '').includes('aquasecurity/trivy-action');
}

/**
 * Why a Trivy step is NOT a gate. Empty ⇒ it can fail the job on a
 * CRITICAL/HIGH finding, unconditionally.
 */
function gateDefects(step: Step): string[] {
    const defects: string[] = [];
    const w = step.with ?? {};
    if (String(w['exit-code'] ?? '').trim() !== '1') {
        defects.push(`exit-code is "${String(w['exit-code'] ?? '')}", not "1" — it reports, it cannot fail the job`);
    }
    const severities = String(w.severity ?? '')
        .toUpperCase()
        .split(',')
        .map((s) => s.trim());
    if (!(severities.includes('CRITICAL') && severities.includes('HIGH'))) {
        defects.push(`severity "${String(w.severity ?? '')}" does not block both CRITICAL and HIGH`);
    }
    if (step.if !== undefined) {
        defects.push(
            'carries an `if:` — a SKIPPED step does not falsify the default success() condition on the push below, so the push still runs',
        );
    }
    if (step['continue-on-error'] !== undefined) {
        defects.push(
            'carries `continue-on-error` — its conclusion becomes success, so the push below still runs and the job still concludes success',
        );
    }
    return defects;
}

/**
 * Every job that pushes an image, with the scan steps it contains.
 *
 * Parameterised on the document list rather than reading the tree itself, so
 * the detector can be driven by synthetic workflows below — including the
 * empty list, which is the control that proves this guard cannot pass by
 * having found nothing.
 */
function auditPushSites(docs: WorkflowDoc[]): Site[] {
    const sites: Site[] = [];
    for (const { file, wf } of docs) {
        for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
            const steps = job.steps ?? [];
            const pushes: StepRef[] = [];
            const blockingScans: StepRef[] = [];
            const allScans: StepRef[] = [];
            steps.forEach((step, index) => {
                const name = stepName(step, index);
                const why = pushReasons(step);
                if (why.length > 0) pushes.push({ index, name, why });
                if (isTrivyStep(step)) {
                    const defects = gateDefects(step);
                    allScans.push({ index, name, why: defects });
                    if (defects.length === 0) blockingScans.push({ index, name, why: [] });
                }
            });
            if (pushes.length > 0) {
                sites.push({ workflow: path.basename(file), jobId, pushes, blockingScans, allScans });
            }
        }
    }
    return sites;
}

/** Human-readable violations: a push that is not preceded by a blocking scan. */
function offendersOf(sites: Site[]): string[] {
    const offenders: string[] = [];
    for (const site of sites) {
        const where = `${site.workflow}:${site.jobId}`;
        const firstGate = site.blockingScans.length > 0 ? site.blockingScans[0].index : -1;
        for (const push of site.pushes) {
            if (firstGate === -1) {
                offenders.push(
                    site.allScans.length === 0
                        ? `${where} pushes at step ${push.index} ("${push.name}") with no Trivy scan in the job`
                        : `${where} pushes at step ${push.index} ("${push.name}"); its Trivy step at step ${site.allScans[0].index} is not a blocking gate: ${site.allScans[0].why.join('; ')}`,
                );
            } else if (firstGate > push.index) {
                offenders.push(
                    `${where} pushes at step ${push.index} ("${push.name}") BEFORE its blocking scan at step ${firstGate} ("${site.blockingScans[0].name}")`,
                );
            }
        }
    }
    return offenders;
}

/**
 * The vacuity guard, as a throwing function so the empty-selection control
 * can assert it goes RED rather than quietly reporting zero violations.
 */
function assertPopulation(sites: Site[]): void {
    if (sites.length === 0) {
        throw new Error(
            'no image-push site found in any workflow. Either the publish path was deleted, ' +
                'or the detector stopped recognising a push — both of which would make every ' +
                'ordering assertion in this file pass by emptiness.',
        );
    }
}

/* ───── the publish job's composition: an allowlist for what runs first ───── */

/**
 * ALLOWLIST — actions a step ABOVE the gate may `uses:`.
 *
 * This is the second half of the answer to the review's first finding. The
 * ordering rule below catches a push it RECOGNISES; this one catches a step
 * it does not recognise at all, in the one job where that matters. An action
 * nobody has classified sitting between the build and the scan is not
 * assumed harmless — `redhat-actions/push-to-registry`, say, publishes and
 * contains none of the words this file greps for.
 */
const INERT_PRE_GATE_ACTIONS = new Set([
    'actions/checkout',
    'actions/cache',
    'actions/download-artifact',
    'docker/setup-buildx-action',
    'docker/login-action',
    'docker/metadata-action',
    'docker/build-push-action',
]);

/** Everything wrong with the steps that run before the gate in the publish job. */
function preGateComplaints(steps: Step[], gateIndex: number): string[] {
    const complaints: string[] = [];
    steps.slice(0, gateIndex).forEach((step, index) => {
        const name = stepName(step, index);
        if (step.uses !== undefined) {
            const action = step.uses.split('@')[0];
            if (!INERT_PRE_GATE_ACTIONS.has(action)) {
                complaints.push(
                    `step ${index} ("${name}") uses \`${action}\`, which is not on the inert allowlist for steps above the gate`,
                );
                return;
            }
        } else if (step.run === undefined) {
            complaints.push(`step ${index} ("${name}") has neither \`uses:\` nor \`run:\` — it cannot be classified`);
            return;
        }
        for (const reason of pushReasons(step)) {
            complaints.push(`step ${index} ("${name}") can reach the registry before the scan: ${reason}`);
        }
    });
    return complaints;
}

/* ───────────────────────── synthetic fixtures ───────────────────────── */

/** Build a one-job synthetic workflow document for the detector controls. */
function synthetic(file: string, steps: Step[]): WorkflowDoc {
    return { file, wf: { jobs: { publish: { steps } } } };
}

const BUILD_AND_PUSH: Step = {
    name: 'Build and push',
    uses: 'docker/build-push-action@v7',
    with: { push: true, tags: 'ghcr.io/x/y:latest' },
};
const BUILD_NO_PUSH: Step = {
    name: 'Build image (load locally, NO push)',
    uses: 'docker/build-push-action@v7',
    with: { push: false, load: true, tags: 'ghcr.io/x/y:latest' },
};
const BLOCKING_SCAN: Step = {
    name: 'Gate: Trivy vulnerability scan (critical+high)',
    uses: 'aquasecurity/trivy-action@v0.36.0',
    with: { 'image-ref': 'x:y', 'exit-code': '1', severity: 'CRITICAL,HIGH' },
};
const REPORTING_SCAN: Step = {
    name: 'Trivy SARIF report',
    uses: 'aquasecurity/trivy-action@v0.36.0',
    with: { 'image-ref': 'x:y', 'exit-code': '0', severity: 'CRITICAL,HIGH', format: 'sarif' },
};
const RUN_PUSH: Step = { name: 'Push scanned image to GHCR', run: 'docker push "$tag"' };

/**
 * The nine spellings the adversarial review enumerated against the first
 * detector, which saw three of them. Each is a REAL way to put bytes in a
 * registry, and each must be visible to the allowlist detector.
 */
const PUSH_SPELLINGS: ReadonlyArray<{ label: string; run: string }> = [
    { label: 'docker push', run: 'docker push ghcr.io/x/y:latest' },
    { label: 'docker  push (double space)', run: 'docker  push ghcr.io/x/y:latest' },
    { label: 'docker buildx imagetools create', run: 'docker buildx imagetools create -t ghcr.io/x/y:latest ghcr.io/x/y@sha256:dead' },
    { label: 'docker image push', run: 'docker image push "ghcr.io/rodnapamet/inflect-compliance:latest"' },
    { label: 'docker buildx build --push', run: 'docker buildx build --push -t ghcr.io/x/y:latest .' },
    { label: 'skopeo copy', run: 'skopeo copy docker-daemon:x:y docker://ghcr.io/x/y:latest' },
    { label: 'crane push', run: 'crane push image.tar ghcr.io/x/y:latest' },
    { label: 'regctl image copy', run: 'regctl image copy x:y ghcr.io/x/y:latest' },
    { label: '"$DOCKER" push (variable indirection)', run: '"$DOCKER" push "$tag"' },
];

/** Lines this workflow (and ci.yml) really run, none of which is a push. */
const LOCAL_ONLY_LINES: ReadonlyArray<{ label: string; run: string }> = [
    { label: 'sudo docker image prune', run: 'sudo docker image prune --all --force 2>/dev/null || true' },
    { label: 'docker buildx prune', run: 'docker buildx prune --all --force 2>/dev/null || true' },
    { label: 'docker image ls', run: 'docker image ls inflect-compliance' },
    { label: 'docker tag', run: 'docker tag "${SCAN_REF}" "$tag"' },
    { label: 'docker load', run: 'docker load --input /tmp/image-abc.tar' },
    { label: 'docker build (no flags)', run: 'docker build -t inflect-compliance:local .' },
    { label: 'a plain shell line', run: 'df -h /' },
];

/* ───────────────────────────── the assertions ───────────────────────────── */

describe('an image push is gated by a scan that ran before it', () => {
    const docs = workflowDocs();
    const sites = auditPushSites(docs);
    const publishDoc = docs.find((d) => path.basename(d.file) === PUBLISH_WORKFLOW);
    const publishSteps = publishDoc?.wf.jobs?.[PUBLISH_JOB]?.steps ?? [];

    it('parses every workflow git lists, and the list is not empty', () => {
        // The denominator, printed. A collapsed population is the failure
        // mode that makes every other assertion here vacuous, so it is
        // asserted before anything is concluded from a zero.
        //
        // Stated as "every file git lists parsed", not as a magic floor. The
        // old `>= 11` had zero slack against `git ls-files` returning exactly
        // 11, so deleting an unrelated workflow turned this red for a reason
        // that has nothing to do with image scanning.
        const listed = workflowFileList();
        expect(docs).toHaveLength(listed.length);
        const names = docs.map((d) => path.basename(d.file)).sort();
        expect(names).toContain(PUBLISH_WORKFLOW);
        expect(names).toContain('ci.yml');
        // …and each one really parsed into a job map, rather than yielding
        // `undefined` that the audit would skip in silence.
        const jobless = docs.filter((d) => Object.keys(d.wf?.jobs ?? {}).length === 0);
        expect(jobless.map((d) => d.file)).toEqual([]);
    });

    it('finds the image-push sites in this repo, by name', () => {
        // The exact list. A publish job that stops being recognised as one —
        // renamed step, new push mechanism — shows up here as a shrinking
        // list rather than as a silently-green ordering check below.
        expect(sites.map((s) => `${s.workflow}:${s.jobId}`).sort()).toEqual(['ghcr-publish.yml:build-push']);
        expect(() => assertPopulation(sites)).not.toThrow();
    });

    it('every push is preceded by a BLOCKING Trivy scan in the same job', () => {
        assertPopulation(sites);
        expect(offendersOf(sites)).toEqual([]);
    });

    it('the publish job scans at a lower step index than it pushes', () => {
        // The same property as the test above, stated as the two numbers, so
        // a failure reports WHERE rather than only THAT.
        const publish = sites.find((s) => s.workflow === PUBLISH_WORKFLOW);
        expect(publish).toBeDefined();
        const gate = publish!.blockingScans[0];
        const push = publish!.pushes[0];
        expect(gate).toBeDefined();
        expect(push).toBeDefined();
        expect(gate.index).toBeLessThan(push.index);
    });

    it('the publish gate is unconditional — no `if:` and no `continue-on-error`', () => {
        // Mirrors `tests/guardrails/schema-drift-gate-runs-in-ci.test.ts`,
        // which had already written down why: both turn a gate into a
        // notification while leaving it visible in the YAML. Reported per
        // step so the failure names the defect, not just the count.
        const scans = publishSteps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => isTrivyStep(step));
        expect(scans.map(({ index }) => index)).not.toEqual([]);
        const guarded = scans.filter(({ step }) => step.if !== undefined);
        const tolerated = scans.filter(({ step }) => step['continue-on-error'] !== undefined);
        expect(guarded.map(({ step, index }) => `step ${index} ("${stepName(step, index)}")`)).toEqual([]);
        expect(tolerated.map(({ step, index }) => `step ${index} ("${stepName(step, index)}")`)).toEqual([]);
    });

    it('the publish gate scans the image about to ship, not one pulled from the registry', () => {
        // `image-ref` is pinned to the env var, and the env var is asserted
        // registry-LESS. Re-pointing it at
        // `ghcr.io/rodnapamet/inflect-compliance:latest` scans the previously
        // PUBLISHED image — a pass that says nothing about what is shipping.
        const gate = publishSteps.find((step) => isTrivyStep(step) && gateDefects(step).length === 0);
        expect(gate).toBeDefined();
        expect(String((gate!.with ?? {})['image-ref'])).toBe('${{ env.SCAN_REF }}');

        const scanRef = String(publishDoc!.wf.env?.SCAN_REF ?? '');
        expect(scanRef).not.toBe('');
        const repository = scanRef.split(':')[0];
        // A registry-shaped ref has a host segment before the first `/`, and
        // a host is what makes docker pull rather than read the local daemon.
        expect(repository).not.toMatch(/\//);
        expect(repository).not.toMatch(/\./);
    });

    it('every step above the publish gate is on the inert allowlist', () => {
        // The second half of the push-spelling answer. The ordering rule
        // catches a push this file RECOGNISES; this catches a step it cannot
        // classify at all, in the one job where an unclassified step sitting
        // between the build and the scan is the whole hazard.
        const gateIndex = publishSteps.findIndex(
            (step) => isTrivyStep(step) && gateDefects(step).length === 0,
        );
        expect(gateIndex).toBeGreaterThan(-1);
        expect(preGateComplaints(publishSteps, gateIndex)).toEqual([]);
    });

    it('the publish job builds without pushing, so the registry is unreachable before the gate', () => {
        // The teeth. If a future edit flips the build step back to
        // `push: true` — or adds `outputs: type=registry`, which is buildx's
        // equivalent under a different input name — the build BECOMES a push
        // site sitting above the scan, and the ordering assertions go red.
        const builds = publishSteps.filter((s) => (s.uses ?? '').includes('docker/build-push-action'));
        expect(builds.length).toBeGreaterThan(0);
        const pushing = builds.filter((s) => buildActionPushes(s).length > 0);
        expect(pushing.map((s) => s.name)).toEqual([]);
        // …and each build loads locally, which is what makes a later
        // `docker push` of the SCANNED bytes possible at all.
        const notLoading = builds.filter((s) => String((s.with ?? {}).load ?? '').toLowerCase() !== 'true');
        expect(notLoading.map((s) => s.name)).toEqual([]);
    });
});

describe('the detector itself — driven by synthetic workflows', () => {
    // A guard whose detector is never shown a violation is a guard that has
    // never been proved to have one. Each control below produces the failing
    // input directly.

    it('flags a push that happens before the scan', () => {
        const sites = auditPushSites([synthetic('a.yml', [BUILD_AND_PUSH, BLOCKING_SCAN])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([
            'a.yml:publish pushes at step 0 ("Build and push") BEFORE its blocking scan at step 1 ("Gate: Trivy vulnerability scan (critical+high)")',
        ]);
    });

    it('flags a push with no scan at all — the shape this repo shipped until 2026-09-13', () => {
        const sites = auditPushSites([synthetic('b.yml', [BUILD_AND_PUSH])]);
        expect(offendersOf(sites)).toEqual([
            'b.yml:publish pushes at step 0 ("Build and push") with no Trivy scan in the job',
        ]);
    });

    it('flags a push preceded only by a NON-blocking scan', () => {
        const sites = auditPushSites([synthetic('c.yml', [BUILD_NO_PUSH, REPORTING_SCAN, RUN_PUSH])]);
        expect(offendersOf(sites)).toHaveLength(1);
        expect(offendersOf(sites)[0]).toContain('is not a blocking gate');
        expect(offendersOf(sites)[0]).toContain('exit-code is "0"');
    });

    it('accepts build → blocking scan → push, the shape this repo now has', () => {
        const sites = auditPushSites([synthetic('d.yml', [BUILD_NO_PUSH, BLOCKING_SCAN, RUN_PUSH])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([]);
    });

    it('FAILS CLOSED on an expression-valued push: it cannot evaluate', () => {
        // The evasion this closes: `push: ${{ … }}` is resolved by GitHub at
        // run time, so a detector that string-compares against 'true' reads
        // it as "not a push" and goes green on a workflow that publishes
        // from above the gate on every push to main.
        const conditionalPush: Step = {
            name: 'Build and push (conditionally)',
            uses: 'docker/build-push-action@v7',
            with: { push: "${{ github.event_name != 'pull_request' }}", tags: 'ghcr.io/x/y:latest' },
        };
        const sites = auditPushSites([synthetic('g.yml', [conditionalPush, BLOCKING_SCAN])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([
            'g.yml:publish pushes at step 0 ("Build and push (conditionally)") BEFORE its blocking scan at step 1 ("Gate: Trivy vulnerability scan (critical+high)")',
        ]);
        // …and the same expression BELOW a blocking scan is accepted, so the
        // rule above is "fail closed", not "reject every expression".
        const after = auditPushSites([synthetic('h.yml', [BUILD_NO_PUSH, BLOCKING_SCAN, conditionalPush])]);
        expect(offendersOf(after)).toEqual([]);
    });

    it('sees `outputs: type=registry`, buildx\'s equivalent of push:true', () => {
        // Same action, different input name, documented as equivalent. The
        // first detector read only `push:` and went green on this.
        const registryOutput: Step = {
            name: 'Build image (registry exporter)',
            uses: 'docker/build-push-action@v7',
            with: { push: false, load: true, outputs: 'type=registry', tags: 'ghcr.io/x/y:latest' },
        };
        expect(buildActionPushes(registryOutput)).toEqual([
            '`outputs: type=registry` uses the non-local exporter `type=registry`',
        ]);
        const sites = auditPushSites([synthetic('i.yml', [registryOutput, BLOCKING_SCAN])]);
        expect(offendersOf(sites)).toHaveLength(1);
        // …while ci.yml's real tarball exporter stays local and is accepted.
        const tarball: Step = {
            name: 'Build Docker image (no push)',
            uses: 'docker/build-push-action@v7',
            with: { push: false, outputs: 'type=docker,dest=/tmp/image.tar' },
        };
        expect(buildActionPushes(tarball)).toEqual([]);
    });

    it.each(PUSH_SPELLINGS.map((s) => [s.label, s.run] as const))(
        'sees a push spelled `%s`',
        (label, run) => {
            const reasons = registryWritesIn(run);
            expect({ label, reasons }).toEqual({ label, reasons: expect.any(Array) });
            expect(reasons.length).toBeGreaterThan(0);
            // …and it is a push wherever it sits, so the ordering rule fires.
            const sites = auditPushSites([
                synthetic('spelling.yml', [BUILD_NO_PUSH, { name: label, run }, BLOCKING_SCAN]),
            ]);
            expect(offendersOf(sites)).toHaveLength(1);
            expect(offendersOf(sites)[0]).toContain('BEFORE its blocking scan');
        },
    );

    it.each(LOCAL_ONLY_LINES.map((s) => [s.label, s.run] as const))(
        'does NOT see a push in `%s`',
        (label, run) => {
            // The other half of the allowlist: it has to stay usable. Four of
            // these lines are in ghcr-publish.yml today, two steps above the
            // gate, and a detector that flagged them would be routed around.
            expect({ label, reasons: registryWritesIn(run) }).toEqual({ label, reasons: [] });
        },
    );

    it('a CRITICAL-only gate does not count as blocking', () => {
        const criticalOnly: Step = {
            name: 'Gate: Trivy (critical only)',
            uses: 'aquasecurity/trivy-action@v0.36.0',
            with: { 'image-ref': 'x:y', 'exit-code': '1', severity: 'CRITICAL' },
        };
        const sites = auditPushSites([synthetic('e.yml', [BUILD_NO_PUSH, criticalOnly, RUN_PUSH])]);
        expect(offendersOf(sites)).toHaveLength(1);
        expect(offendersOf(sites)[0]).toContain('does not block both CRITICAL and HIGH');
    });

    it('an `if:` or `continue-on-error` on the gate stops it counting as one', () => {
        // Both leave a Trivy step with exit-code 1 and CRITICAL,HIGH sitting
        // above the push, fully visible in the YAML, while the push below
        // still runs. The detector must disagree with the reviewer's eye.
        const skippable: Step = { ...BLOCKING_SCAN, if: "github.event_name != 'workflow_dispatch'" };
        const tolerated: Step = { ...BLOCKING_SCAN, 'continue-on-error': true };

        expect(gateDefects(skippable)).toHaveLength(1);
        expect(gateDefects(skippable)[0]).toContain('carries an `if:`');
        expect(gateDefects(tolerated)).toHaveLength(1);
        expect(gateDefects(tolerated)[0]).toContain('carries `continue-on-error`');

        for (const gate of [skippable, tolerated]) {
            const sites = auditPushSites([synthetic('j.yml', [BUILD_NO_PUSH, gate, RUN_PUSH])]);
            expect(offendersOf(sites)).toHaveLength(1);
            expect(offendersOf(sites)[0]).toContain('is not a blocking gate');
        }
    });

    it('an unclassified action above the gate is a complaint, not a shrug', () => {
        const unknownPublisher: Step = {
            name: 'Publish to registry',
            uses: 'redhat-actions/push-to-registry@v2',
            with: { tags: 'ghcr.io/x/y:latest' },
        };
        const steps = [BUILD_NO_PUSH, unknownPublisher, BLOCKING_SCAN, RUN_PUSH];
        expect(preGateComplaints(steps, 2)).toEqual([
            'step 1 ("Publish to registry") uses `redhat-actions/push-to-registry`, which is not on the inert allowlist for steps above the gate',
        ]);
        // …and the allowlisted ones produce nothing.
        expect(preGateComplaints([BUILD_NO_PUSH, BLOCKING_SCAN], 1)).toEqual([]);
    });

    it('EMPTY-SELECTION CONTROL: a collapsed population reports zero violations, so the guard fails on the population instead', () => {
        // An empty scan is a PASS. Point the audit at nothing and it agrees
        // that nothing is wrong — which is exactly how a guard whose
        // population quietly collapsed goes on reporting success forever.
        const collapsed = auditPushSites([]);
        expect(collapsed).toEqual([]);
        expect(offendersOf(collapsed)).toEqual([]);

        // So the population is asserted separately, and THAT is what goes red.
        expect(() => assertPopulation(collapsed)).toThrow(/no image-push site/i);

        // Positive control: against the real tree it does not throw, so the
        // assertion above is testing emptiness rather than a broken helper.
        expect(() => assertPopulation(auditPushSites(workflowDocs()))).not.toThrow();

        // And a workflow set that parses but contains no pushes collapses the
        // same way — the file list being non-empty is not enough on its own.
        const noPushes = auditPushSites([synthetic('f.yml', [BUILD_NO_PUSH, BLOCKING_SCAN])]);
        expect(noPushes).toEqual([]);
        expect(() => assertPopulation(noPushes)).toThrow(/no image-push site/i);
    });
});
