/**
 * The VM check workflow reaches production read-only, from a fixed list, and
 * prints nothing but names, states and counts.
 *
 * `.github/workflows/vm-check.yml` runs `deploy/vm-check/remote.sh` as root on
 * the production VM, so that Claude's sessions can look at production without
 * holding a key (owner decision, 2026-11-10). It holds the same way in as the
 * `Scanner VM` and `VM capacity` workflows (Workload Identity Federation, the
 * `production` environment's reviewer on every run), and its logs are public,
 * because the repository is. Three things must stay true, and none of them is
 * visible from a green run:
 *
 *   - only a person can start it, behind that reviewer, with no key or secret;
 *   - it runs a check from a fixed list, never a command, because the identity
 *     it holds is root on the VM and a free-text input would make every push a
 *     way to run anything on production;
 *   - the scripts change nothing and print no log line, row or credential.
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
type Input = { type?: string; options?: string[] };
const wf = yaml.load(read('.github/workflows/vm-check.yml')) as {
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    permissions: Record<string, string>;
    jobs: Record<string, { environment?: string; 'timeout-minutes'?: number; steps: Step[] }>;
};
const job = wf.jobs['vm-check'];
const steps = job.steps;
const inputs = wf.on.workflow_dispatch.inputs;

/** Code lines: comments and blank lines dropped. */
const code = (rel: string) =>
    read(rel)
        .split('\n')
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

const SCRIPTS = ['deploy/vm-check/remote.sh', 'deploy/vm-check/vm.sh'];

describe('the VM check workflow', () => {
    it('runs only when a person dispatches it', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    });

    it('runs in the production environment, whose reviewer approves each run, with a time limit', () => {
        expect(Object.keys(wf.jobs)).toEqual(['vm-check']);
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

    it('takes one input, and it is a choice, never free text', () => {
        expect(Object.keys(inputs)).toEqual(['check']);
        expect(inputs.check.type).toBe('choice');
        expect((inputs.check.options ?? []).length).toBeGreaterThan(0);
    });

    it('passes the check through the environment, never into a script line', () => {
        // `${{ inputs.x }}` inside `run:` is pasted into the shell before it
        // runs, so an input becomes code. Through `env:` it stays a value.
        expect(steps.filter((s) => (s.run ?? '').includes('${{')).map((s) => s.name)).toEqual([]);
        expect(steps.filter((s) => s.run).map((s) => s.run)).toEqual(['deploy/vm-check/vm.sh "$CHECK"']);
    });
});

describe('the check list is the same in all three places', () => {
    const choices = [...(inputs.check.options ?? [])].sort();

    it('vm.sh accepts exactly the workflow’s choices', () => {
        const accept = code('deploy/vm-check/vm.sh').find((l) => /^\s*[a-z-]+(\s*\|\s*[a-z-]+)*\)\s*;;\s*$/.test(l));
        expect(accept).toBeDefined();
        const listed = (accept ?? '').replace(/\)\s*;;\s*$/, '').split('|').map((s) => s.trim());
        expect(listed.sort()).toEqual(choices);
    });

    it('remote.sh has exactly one branch per choice, and refuses anything else', () => {
        const branches = code('deploy/vm-check/remote.sh')
            .map((l) => /^([a-z][a-z-]*|\*)\)\s*$/.exec(l)?.[1])
            .filter((b): b is string => b !== undefined);
        expect(branches.filter((b) => b !== '*').sort()).toEqual(choices);
        expect(branches[branches.length - 1]).toBe('*');
    });
});

describe('the scripts it runs', () => {
    const remote = code('deploy/vm-check/remote.sh');

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

    it('remote.sh calls docker only to list, inspect named fields, read logs and exec', () => {
        const calls = remote.flatMap((l) => l.match(/\bdocker\s+[a-z]+/g) ?? []);
        expect([...new Set(calls.map((c) => c.split(/\s+/)[1]))].sort()).toEqual(['exec', 'inspect', 'logs', 'ps']);
    });

    it('every docker inspect and docker ps names the fields it prints', () => {
        expect(remote.filter((l) => /\bdocker\s+inspect\b/.test(l) && !/docker inspect -f '\{\{\.[A-Za-z.]+\}\}'/.test(l))).toEqual([]);
        const inspected = remote.flatMap((l) => [...l.matchAll(/docker inspect -f '\{\{(\.[A-Za-z.]+)\}\}'/g)].map((m) => m[1]));
        expect([...new Set(inspected)].sort()).toEqual(['.Image', '.State.StartedAt']);
        expect(remote.filter((l) => /\bdocker\s+ps\b/.test(l) && !/--format '|-qf /.test(l))).toEqual([]);
    });

    it('every docker logs read is piped into a filter, never printed', () => {
        const reads = remote.filter((l) => /\bdocker\s+logs\b/.test(l));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.filter((l) => !/\bdocker logs\b[^|]*2>&1 \| grep -[EF] /.test(l))).toEqual([]);
        expect(reads.filter((l) => !/^\s*[a-z]+="\$\(docker logs /.test(l))).toEqual([]);
    });

    it('docker exec runs only the read-only query and the bcrypt probe', () => {
        const execs = remote.filter((l) => /\bdocker\s+exec\b/.test(l));
        expect(execs).toHaveLength(2);
        const psql = execs.filter((l) => l.includes('need postgres'));
        expect(psql).toHaveLength(1);
        expect(psql[0]).toContain("PGOPTIONS='-c default_transaction_read_only=on'");
        expect(execs.filter((l) => l.includes('need app'))).toHaveLength(1);
    });

    it('the query reads and never writes', () => {
        const sql = read('deploy/vm-check/remote.sh').split("<<'SQL'")[1]?.split(/^SQL$/m)[0] ?? '';
        expect(sql).toMatch(/^\s*SELECT\b/);
        expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i);
    });

    it('remote.sh writes no file on the VM', () => {
        // Redirects to stderr and /dev/null only; the report goes to stdout.
        const writes = remote.flatMap((l) =>
            (l.match(/\d?>>?\s*\S+/g) ?? []).filter((r) => !/>&[12];?\)?"?$|>\s*\/dev\/null;?$/.test(r)),
        );
        expect(writes).toEqual([]);
    });

    it('vm.sh touches nothing on the VM but its own stage directory', () => {
        const calls = code('deploy/vm-check/vm.sh').filter((l) => /^\s*ssh_vm\s/.test(l));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter((l) => !l.includes('vm-check-stage'))).toEqual([]);
    });
});
