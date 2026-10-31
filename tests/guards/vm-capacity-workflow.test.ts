/**
 * The VM capacity snapshot reaches production read-only, and prints nothing
 * but names and numbers.
 *
 * `.github/workflows/vm-capacity.yml` runs `deploy/capacity/remote.sh` as root
 * on the production VM (the AI roadmap's capacity budget, step C0). It holds
 * the same way in as the `Scanner VM` workflow — Workload Identity Federation,
 * the `production` environment's reviewer on every run — and its logs are
 * public, because the repository is. So two things must stay true, and neither
 * is visible from a green run:
 *
 *   - the workflow can only be started by a person, behind that reviewer, with
 *     no key and no secret;
 *   - the scripts change nothing on the VM and never print a credential: no
 *     environment or compose file, and no container environment, command line
 *     or label, which is where a credential in a Compose file would surface.
 *
 * Parsed as YAML and as code lines, so each assertion is on a value, not on a
 * substring of the whole file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string; if?: string };
const wf = yaml.load(read('.github/workflows/vm-capacity.yml')) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { environment?: string; 'timeout-minutes'?: number; steps: Step[] }>;
};
const job = wf.jobs['vm-capacity'];
const steps = job.steps;

describe('the VM capacity workflow', () => {
    it('runs only when a person dispatches it', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    });

    it('runs in the production environment, whose reviewer approves each run, with a time limit', () => {
        expect(Object.keys(wf.jobs)).toEqual(['vm-capacity']);
        expect(job.environment).toBe('production');
        expect(job['timeout-minutes']).toBeGreaterThan(0);
    });

    it('holds an OIDC token and read access to the code, and nothing else', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    });

    it('authenticates to GCP by Workload Identity Federation, never with a key', () => {
        const auth = steps.filter((s) => s.uses?.startsWith('google-github-actions/auth@'));
        expect(auth).toHaveLength(1);
        expect(Object.keys(auth[0].with ?? {}).sort()).toEqual(['service_account', 'workload_identity_provider']);
    });

    it('reads no secret', () => {
        expect(steps.filter((s) => JSON.stringify(s).includes('secrets.')).map((s) => s.name)).toEqual([]);
    });

    it('passes its inputs through the environment, never into a script line', () => {
        // `${{ inputs.x }}` inside `run:` is pasted into the shell before it
        // runs, so an input becomes code. Through `env:` it stays a value, and
        // vm.sh checks both are whole numbers.
        expect(steps.filter((s) => (s.run ?? '').includes('${{')).map((s) => s.name)).toEqual([]);
        const runs = steps.filter((s) => s.run).map((s) => s.run);
        expect(runs).toEqual(['deploy/capacity/vm.sh "$SAMPLES" "$INTERVAL_SECONDS"']);
    });
});

/** Code lines: comments and blank lines dropped. */
const code = (rel: string) =>
    read(rel)
        .split('\n')
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

const SCRIPTS = ['deploy/capacity/remote.sh', 'deploy/capacity/vm.sh'];

/** The `docker inspect` fields remote.sh may print, and no others. */
const INSPECT_FIELDS = ['.Name', '.State.StartedAt', '.RestartCount', '.HostConfig.Memory', '.HostConfig.NanoCpus'];

describe('the scripts it runs', () => {
    it.each(SCRIPTS)('%s is executable', (rel) => {
        expect(fs.statSync(path.join(REPO_ROOT, rel)).mode & 0o111).not.toBe(0);
    });

    it.each(SCRIPTS)('%s never traces its commands', (rel) => {
        expect(code(rel).filter((l) => /set\s+-[a-z]*x|set\s+-o\s+xtrace/.test(l))).toEqual([]);
    });

    it.each(SCRIPTS)('%s never prints an environment or compose file', (rel) => {
        expect(
            code(rel).filter((l) => /\b(cat|less|more|head|tail|grep)\b[^|]*(\.env\b|\.ya?ml\b|\/opt\/inflect)/.test(l)),
        ).toEqual([]);
    });

    it('remote.sh calls docker only to list, inspect named fields and sample stats', () => {
        const calls = code('deploy/capacity/remote.sh').flatMap((l) => l.match(/\bdocker\s+\S+/g) ?? []);
        expect(calls.length).toBeGreaterThan(0);
        expect([...new Set(calls.map((c) => c.split(/\s+/)[1]))].sort()).toEqual(['inspect', 'ps', 'stats']);
    });

    it('every docker inspect names one allowed field, so no environment, command or label is read', () => {
        const lines = code('deploy/capacity/remote.sh').filter((l) => /\bdocker\s+inspect\b/.test(l));
        expect(lines.length).toBe(INSPECT_FIELDS.length);
        const fields = lines.map((l) => /docker inspect -f '\{\{([^}]+)\}\}'/.exec(l)?.[1] ?? `UNNAMED: ${l.trim()}`);
        expect(fields.sort()).toEqual([...INSPECT_FIELDS].sort());
    });

    it('docker ps and docker stats print only the fields they name', () => {
        const lines = code('deploy/capacity/remote.sh').filter((l) => /\bdocker\s+(ps|stats)\b/.test(l));
        expect(lines.filter((l) => !/--format '/.test(l))).toEqual([]);
    });

    it('remote.sh writes no file on the VM', () => {
        // Redirects to stderr and /dev/null only; the report goes to stdout.
        const writes = code('deploy/capacity/remote.sh').flatMap((l) =>
            (l.match(/\d?>>?\s*\S+/g) ?? []).filter((r) => !/>&2;?$|>\s*\/dev\/null;?$/.test(r)),
        );
        expect(writes).toEqual([]);
    });

    it('vm.sh touches nothing on the VM but its own stage directory', () => {
        const remote = code('deploy/capacity/vm.sh').filter((l) => /^\s*ssh_vm\s/.test(l));
        expect(remote.length).toBeGreaterThan(0);
        expect(remote.filter((l) => !l.includes('vm-capacity-stage'))).toEqual([]);
    });
});
