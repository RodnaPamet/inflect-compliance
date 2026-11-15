/**
 * tei-embed's image is the upstream TEI digest with its Debian packages
 * upgraded, scanned before it is published, and the only TEI image production
 * may run (owner decision 2026-11-15, option B on #5687).
 *
 * Each assertion is one an easy edit would undo with nothing failing at build:
 * a FROM moved to a tag the benchmark never measured, an ENTRYPOINT "fix" that
 * changes what the router is given, a publish that stops gating, or the
 * upstream image dropped straight into a Compose file because the patched one
 * was not published yet. Parsed (YAML, Dockerfile instructions), so each is on
 * a value rather than a needle in a file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { repoRelativeFiles } from '../helpers/repo-files';
import { EMBED_CANDIDATES, TEI_CPU_IMAGE } from '../../scripts/retriever-benchmark/candidates';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const DOCKERFILE = 'deploy/tei-embed/Dockerfile';
const SMOKE = 'deploy/tei-embed/smoke.sh';
const PUBLISH = '.github/workflows/tei-embed-image.yml';
const UPSTREAM_REPO = 'ghcr.io/huggingface/text-embeddings-inference';
const OURS = 'ghcr.io/rodnapamet/tei-embed';

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
type Job = { if?: string; steps: Step[]; needs?: unknown };
type Workflow = { on?: unknown; true?: unknown; permissions?: Record<string, string>; jobs: Record<string, Job> };

const loadWorkflow = (rel: string): Workflow => yaml.load(read(rel)) as Workflow;
/** js-yaml reads a bare `on:` key as the boolean `true`. */
const triggersOf = (wf: Workflow): Record<string, unknown> =>
    (wf.on ?? wf.true ?? {}) as Record<string, unknown>;
const gateOf = (job: Job): Step | undefined =>
    job.steps.find((s) => (s.name ?? '').startsWith('Gate: Trivy scan of the tei-embed image'));

const chosen = EMBED_CANDIDATES.find((c) => c.id === 'multilingual-e5-small');

describe('deploy/tei-embed/Dockerfile — the upstream digest, upgraded, and nothing else', () => {
    const ops = instructions(read(DOCKERFILE));

    it('has exactly one FROM and one RUN (the scan is not vacuous)', () => {
        expect(ops.map((o) => o.op)).toEqual(['FROM', 'RUN']);
    });

    it('builds FROM the upstream CPU release by tag AND the digest the benchmark ran', () => {
        const [ref, digest] = ops[0].args.split('@');
        expect(ref).toBe(`${UPSTREAM_REPO}:cpu-1.9.4`);
        expect(TEI_CPU_IMAGE).toBe(`${UPSTREAM_REPO}@${digest}`);
    });

    it('updates, upgrades and leaves no package lists behind, in one layer', () => {
        const commands = ops[1].args.split('&&').map((c) => c.trim().replace(/\s+/g, ' '));
        expect(commands).toEqual([
            'apt-get update',
            'DEBIAN_FRONTEND=noninteractive apt-get -y upgrade',
            'apt-get clean',
            'rm -rf /var/lib/apt/lists/*',
        ]);
    });
});

describe('deploy/tei-embed/smoke.sh — the model production serves, run as production runs it', () => {
    const src = read(SMOKE);
    const assigned = (name: string): string | undefined =>
        new RegExp(`^${name}="([^"]*)"$`, 'm').exec(src)?.[1];

    it('serves D-L4-3\'s embedder at the commit the benchmark pins', () => {
        expect(chosen?.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(assigned('MODEL_ID')).toBe(chosen?.model);
        expect(assigned('MODEL_REVISION')).toBe(chosen?.revision);
        expect(assigned('DIMENSIONS') ?? /^DIMENSIONS=(\d+)$/m.exec(src)?.[1]).toBe('384');
    });

    it('starts the image with the production limits and hardening', () => {
        const run = src.slice(src.indexOf('docker run -d'), src.indexOf('healthy=0'));
        const flags = run.split(/\s+/).filter((t) => t.startsWith('--'));
        expect(flags).toEqual(expect.arrayContaining([
            '--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus',
        ]));
        expect(run.split(/\s+/)).toEqual(expect.arrayContaining([
            'ALL', 'no-new-privileges:true', '2560m', '1.0',
        ]));
    });
});

describe('the publish workflow — dispatch and weekly only, gated before it pushes', () => {
    const wf = loadWorkflow(PUBLISH);
    const job = wf.jobs['build-scan-push'];

    it('is triggered by a person or the weekly schedule, never by a push or a pull request', () => {
        expect(Object.keys(triggersOf(wf)).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });

    it('holds read access to the code and write access to packages, nothing more', () => {
        expect(wf.permissions).toEqual({ contents: 'read', packages: 'write' });
    });

    it('publishes from main only', () => {
        expect(job.if).toBe("github.ref == 'refs/heads/main'");
    });

    it('builds without pushing, smoke-tests, gates, and only then pushes', () => {
        const names = job.steps.map((s) => s.name ?? s.uses ?? '');
        const at = (prefix: string) => names.findIndex((n) => n.startsWith(prefix));
        expect(at('Build the tei-embed image')).toBeGreaterThan(-1);
        expect(job.steps[at('Build the tei-embed image')].with?.push).toBe(false);
        expect(at('Smoke-test the tei-embed image')).toBeGreaterThan(at('Build the tei-embed image'));
        expect(at('Gate: Trivy scan')).toBeGreaterThan(at('Smoke-test the tei-embed image'));
        expect(at('Push the scanned image')).toBeGreaterThan(at('Gate: Trivy scan'));
    });

    it('builds from deploy/tei-embed/ and pushes to our package', () => {
        const build = job.steps.find((s) => (s.name ?? '').startsWith('Build the tei-embed image'));
        expect(build?.with?.context).toBe('deploy/tei-embed');
        expect(build?.with?.file).toBe(DOCKERFILE);
        expect(`ghcr.io/${(yaml.load(read(PUBLISH)) as { env: Record<string, string> }).env.IMAGE_NAME}`).toBe(OURS);
    });
});

describe('the gate is the same in CI and in the publish', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml');
    const ciJob = ci.jobs['tei-embed-image'];
    const publishJob = loadWorkflow(PUBLISH).jobs['build-scan-push'];

    it('CI builds the same Dockerfile and runs the same smoke test', () => {
        const runs = ciJob.steps.map((s) => s.run ?? '').join('\n');
        expect(runs.split(/\s+/)).toEqual(expect.arrayContaining([DOCKERFILE, 'deploy/tei-embed']));
        expect(ciJob.steps.some((s) => (s.run ?? '').startsWith(SMOKE))).toBe(true);
    });

    it.each([
        ['ci.yml', () => gateOf(ciJob)],
        ['tei-embed-image.yml', () => gateOf(publishJob)],
    ])('%s blocks on CRITICAL,HIGH with fixes, with the repository\'s exemptions', (_, gate) => {
        const w = gate()?.with ?? {};
        expect(w['exit-code']).toBe('1');
        expect(w.severity).toBe('CRITICAL,HIGH');
        expect(w['ignore-unfixed']).toBe(true);
        expect(w['vuln-type']).toBe('os,library');
        expect(w.trivyignores).toBe('.trivyignore');
    });

    it('CI runs it whenever deploy/tei-embed/ changes, and never in the merge queue', () => {
        expect(ciJob.if).toBe("${{ github.event_name != 'merge_group' && needs.changes.outputs.tei_embed == 'true' }}");
        const filter = ci.jobs.changes.steps.find((s) => s.uses?.startsWith('dorny/paths-filter'));
        const filters = yaml.load(String(filter?.with?.filters)) as Record<string, string[]>;
        expect(filters.tei_embed).toEqual(expect.arrayContaining(['deploy/tei-embed/**', PUBLISH]));
    });
});

describe('production never runs the unpatched upstream TEI image', () => {
    const composeFiles = repoRelativeFiles().filter((f) => /^deploy\/docker-compose.*\.ya?ml$/.test(f));
    type Svc = { image?: string };
    const services = composeFiles.flatMap((rel) =>
        Object.entries((yaml.load(read(rel)) as { services: Record<string, Svc> }).services).map(
            ([name, svc]) => ({ rel, name, image: String(svc.image ?? '') }),
        ),
    );

    it('reads every deploy compose file (the scan is not vacuous)', () => {
        expect(composeFiles).toContain('deploy/docker-compose.prod.yml');
        expect(services.length).toBeGreaterThan(8);
    });

    it('no deploy compose service runs the upstream image', () => {
        expect(services.filter((s) => s.image.startsWith(UPSTREAM_REPO)).map((s) => `${s.rel}: ${s.name}`)).toEqual([]);
    });

    it('a tei-embed service, wherever it appears, runs our image by digest', () => {
        const bad = services
            .filter((s) => s.name === 'tei-embed')
            .filter((s) => !new RegExp(`^${OURS.replace(/[.]/g, '\\.')}(:[^@]+)?@sha256:[0-9a-f]{64}$`).test(s.image));
        expect(bad.map((s) => `${s.rel}: ${s.image}`)).toEqual([]);
    });
});
