/**
 * postgres-pgvector's image is the official postgres:16-alpine plus pgvector at
 * a pinned tag and commit, built and scanned before it is published, on the
 * cadence the owner chose (vector store Phase 1.1; D-L4-1 2026-11-11, D-L4-8
 * 2026-11-12).
 *
 * Each assertion is one an easy edit would undo with nothing failing at build:
 * a base moved to Debian (which changes the collation under the production
 * volume), a base pinned by digest (which reverses the 2026-10-10 decision and
 * freezes the patches the tag delivers), pgvector built for the runner's CPU, a
 * toolchain left in the image, a publish that stops gating, or a schedule that
 * stops rebuilding. Parsed (YAML, Dockerfile instructions), so each is on a
 * value rather than a needle in a file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const DOCKERFILE = 'deploy/postgres/Dockerfile';
const SMOKE = 'deploy/postgres/smoke.sh';
const PUBLISH = '.github/workflows/postgres-pgvector-image.yml';
const OURS = 'ghcr.io/rodnapamet/postgres-pgvector';
/** pgvector v0.8.7, released 2026-10-01: the tag and the commit it names. */
const PGVECTOR_VERSION = 'v0.8.7';
const PGVECTOR_COMMIT = 'f37c13f68b57d2c3472b2214fbcff699d6d34876';

/** Dockerfile instructions: comments dropped, continuations joined. */
function instructions(src: string): { op: string; args: string }[] {
    const joined = src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .replace(/\\\n/g, ' ');
    return joined
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => {
            const m = /^(\S+)\s+(.*)$/.exec(l);
            return { op: (m?.[1] ?? l).toUpperCase(), args: m?.[2] ?? '' };
        });
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; steps: Step[]; needs?: unknown; outputs?: Record<string, string> };
type Workflow = {
    on?: unknown;
    true?: unknown;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
};

const loadWorkflow = (rel: string): Workflow => yaml.load(read(rel)) as Workflow;
/** js-yaml reads a bare `on:` key as the boolean `true`. */
const triggersOf = (wf: Workflow): Record<string, unknown> =>
    (wf.on ?? wf.true ?? {}) as Record<string, unknown>;
const gateOf = (job: Job): Step | undefined =>
    job.steps.find((s) => (s.name ?? '').startsWith('Gate: Trivy scan of the postgres-pgvector image'));

describe('deploy/postgres/Dockerfile — postgres:16-alpine plus pinned pgvector, and nothing else', () => {
    const ops = instructions(read(DOCKERFILE));

    it('is FROM, two ARGs and one RUN (the scan is not vacuous)', () => {
        expect(ops.map((o) => o.op)).toEqual(['FROM', 'ARG', 'ARG', 'RUN']);
    });

    it('builds FROM the official 16-alpine TAG: same musl, no digest (2026-10-10, D-L4-8)', () => {
        expect(ops[0].args).toBe('postgres:16-alpine');
    });

    it('pins pgvector by tag and by the commit that tag names', () => {
        expect(ops[1].args).toBe(`PGVECTOR_VERSION=${PGVECTOR_VERSION}`);
        expect(ops[2].args).toBe(`PGVECTOR_COMMIT=${PGVECTOR_COMMIT}`);
    });

    it('fetches, verifies, builds portably, installs and removes the toolchain in one layer', () => {
        const commands = ops[3].args.split('&&').map((c) => c.trim().replace(/\s+/g, ' '));
        expect(commands).toEqual([
            'set -eux',
            'apk add --no-cache --virtual .pgvector-build build-base git',
            'git clone --quiet --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector',
            'test "$(git -C /tmp/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}"',
            'make -C /tmp/pgvector OPTFLAGS="" with_llvm=no',
            'make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install',
            'rm -rf /tmp/pgvector',
            'apk del --no-network .pgvector-build',
        ]);
    });
});

describe('deploy/postgres/smoke.sh — the extension loads and a cosine query answers', () => {
    const src = read(SMOKE);

    it('expects the version the Dockerfile pins', () => {
        expect(/^PGVECTOR_VERSION="([^"]*)"$/m.exec(src)?.[1]).toBe(PGVECTOR_VERSION.slice(1));
    });

    it('creates the extension, queries by cosine distance, through HNSW with iterative scans', () => {
        for (const needle of [
            'CREATE EXTENSION vector;',
            'USING hnsw (embedding vector_cosine_ops)',
            'SET hnsw.iterative_scan = strict_order;',
        ]) {
            expect(src.split('\n').filter((l) => l.includes(needle))).toHaveLength(1);
        }
    });

    it('refuses an image that is not musl or still carries the toolchain', () => {
        expect(src.split('\n').filter((l) => l.includes("ls /lib/ld-musl-*.so.1"))).toHaveLength(1);
        expect(/^for tool in (.*); do$/m.exec(src)?.[1].split(' ')).toEqual(['gcc', 'cc', 'make', 'git']);
    });

    it('is executable, as both workflows invoke it directly', () => {
        expect(fs.statSync(path.join(REPO_ROOT, SMOKE)).mode & 0o111).not.toBe(0);
    });
});

describe('the publish workflow — weekly, on an upstream digest move and on dispatch, gated before it pushes', () => {
    const wf = loadWorkflow(PUBLISH);
    const decide = wf.jobs.decide;
    const job = wf.jobs['build-scan-push'];

    it('is triggered by a person or the schedule, never by a push or a pull request', () => {
        expect(Object.keys(triggersOf(wf)).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });

    it('runs a weekly rebuild and a daily digest check, and the weekly cron is the one decide names', () => {
        const crons = (triggersOf(wf).schedule as { cron: string }[]).map((c) => c.cron);
        expect(crons).toHaveLength(2);
        const weekly = crons.find((c) => /^\d+ \d+ \* \* \d$/.test(c));
        const daily = crons.find((c) => /^\d+ \d+ \* \* \*$/.test(c));
        expect(weekly).toBeDefined();
        expect(daily).toBeDefined();
        const run = decide.steps.find((s) => s.name === 'Read the upstream and published base digests')?.run ?? '';
        expect(run.includes(`[ "\${SCHEDULE}" = "${weekly}" ]`)).toBe(true);
        // A moved upstream digest rebuilds; an unreadable one fails rather than skipping.
        expect(run.includes('[ "${PUBLISHED}" != "${UPSTREAM_DIGEST}" ]')).toBe(true);
        expect(run.includes('could not read the upstream')).toBe(true);
    });

    it('holds read access to the code and write access to packages, nothing more', () => {
        expect(wf.permissions).toEqual({ contents: 'read', packages: 'write' });
    });

    it('publishes from main only, and only when decide says so', () => {
        expect(decide.if).toBe("github.ref == 'refs/heads/main'");
        expect(job.needs).toEqual(['decide']);
        expect(job.if).toBe("github.ref == 'refs/heads/main' && needs.decide.outputs.build == 'true'");
    });

    it('builds without pushing, smoke-tests, gates, and only then pushes', () => {
        const names = job.steps.map((s) => s.name ?? s.uses ?? '');
        const at = (prefix: string) => names.findIndex((n) => n.startsWith(prefix));
        expect(at('Build the postgres-pgvector image')).toBeGreaterThan(-1);
        expect(job.steps[at('Build the postgres-pgvector image')].with?.push).toBe(false);
        expect(at('Smoke-test the postgres-pgvector image')).toBeGreaterThan(at('Build the postgres-pgvector image'));
        expect(at('Gate: Trivy scan')).toBeGreaterThan(at('Smoke-test the postgres-pgvector image'));
        expect(at('Push the scanned image')).toBeGreaterThan(at('Gate: Trivy scan'));
    });

    it('builds from deploy/postgres/ on exactly the upstream digest decide read, and labels it', () => {
        const build = job.steps.find((s) => (s.name ?? '').startsWith('Build the postgres-pgvector image'));
        expect(build?.with?.context).toBe('deploy/postgres');
        expect(build?.with?.file).toBe(DOCKERFILE);
        expect(String(build?.with?.['build-contexts']).trim()).toBe(
            'postgres:16-alpine=docker-image://${{ env.UPSTREAM }}@${{ needs.decide.outputs.upstream_digest }}',
        );
        expect(String(build?.with?.labels)).toContain(
            'org.opencontainers.image.base.digest=${{ needs.decide.outputs.upstream_digest }}',
        );
        expect(wf.env?.UPSTREAM).toBe('docker.io/library/postgres:16-alpine');
    });

    it('pushes the moving line tag and an immutable per-build tag to our package', () => {
        expect(`ghcr.io/${wf.env?.IMAGE_NAME}`).toBe(OURS);
        expect(wf.env?.LINE_TAG).toBe('16-alpine');
        const push = job.steps.find((s) => s.name === 'Push the scanned image')?.run ?? '';
        const pushes = push.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('docker push'));
        // The immutable tag first: a failure between the two leaves the line where it was.
        expect(pushes).toEqual(['docker push "${BUILD_TAG}"', 'docker push "${LINE}"']);
        expect(push.includes('BUILD_TAG="${REGISTRY}/${IMAGE_NAME}:${LINE_TAG}-pgvector${PGVECTOR}-$(date -u +%Y%m%d)-${GITHUB_SHA::9}"')).toBe(true);
        expect(push.includes(':latest')).toBe(false);
    });
});

describe('the gate is the same in CI and in the publish', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml');
    const ciJob = ci.jobs['postgres-image'];
    const publishJob = loadWorkflow(PUBLISH).jobs['build-scan-push'];

    it('CI builds the same Dockerfile and runs the same smoke test', () => {
        const runs = ciJob.steps.map((s) => s.run ?? '').join('\n');
        expect(runs.split(/\s+/)).toEqual(expect.arrayContaining([DOCKERFILE, 'deploy/postgres']));
        expect(ciJob.steps.some((s) => (s.run ?? '').startsWith(SMOKE))).toBe(true);
    });

    it.each([
        ['ci.yml', () => gateOf(ciJob)],
        ['postgres-pgvector-image.yml', () => gateOf(publishJob)],
    ])('%s blocks on CRITICAL,HIGH with fixes, with the repository\'s exemptions', (_, gate) => {
        const w = gate()?.with ?? {};
        expect(w['exit-code']).toBe('1');
        expect(w.severity).toBe('CRITICAL,HIGH');
        expect(w['ignore-unfixed']).toBe(true);
        expect(w['vuln-type']).toBe('os,library');
        expect(w.trivyignores).toBe('.trivyignore');
    });

    it('CI runs it whenever deploy/postgres/ changes, and never in the merge queue', () => {
        expect(ciJob.if).toBe("${{ github.event_name != 'merge_group' && needs.changes.outputs.postgres_image == 'true' }}");
        const filter = ci.jobs.changes.steps.find((s) => s.uses?.startsWith('dorny/paths-filter'));
        const filters = yaml.load(String(filter?.with?.filters)) as Record<string, string[]>;
        expect(filters.postgres_image).toEqual(expect.arrayContaining(['deploy/postgres/**', PUBLISH]));
    });
});
