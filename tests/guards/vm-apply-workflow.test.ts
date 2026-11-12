/**
 * The VM apply workflow changes production only by a named action from a fixed
 * list, preflights before it writes, and prints nothing but shape.
 *
 * `.github/workflows/vm-apply.yml` runs `deploy/vm-apply/vm.sh` — which runs
 * `deploy/apply.sh` in one of its modes, or `deploy/vm-apply/remote.sh` as root
 * on the VM — so that a Claude session can apply a repo-canonical change to the
 * production VM without holding a credential (owner decision, 2026-11-12). It
 * holds the identity the `VM check` workflow holds, which is root on the VM,
 * and its logs are public because the repository is. None of the properties
 * below is visible from a green run:
 *
 *   - only a person can start it, from main, behind the `production` reviewer,
 *     with no key or secret;
 *   - its one input is a choice of named actions, never a command, a path, a
 *     host or a compose argument;
 *   - every action that writes runs its preflight first, in the same run;
 *   - the OrangeHRM lab is removed with `rm --stop`, never `down`, and the
 *     hostnames it may stop serving are literals in the script;
 *   - nothing it relays from the VM reaches the log except its shape.
 *
 * Parsed as YAML and as code lines, and the output filters are RUN on a stream
 * carrying secret-shaped lines, so each assertion is on a value or a
 * behaviour, not on a substring of a whole file.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string; if?: string };
type Input = { type?: string; options?: string[] };
type Workflow = {
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; environment?: string; 'timeout-minutes'?: number; steps: Step[] }>;
};
const wf = yaml.load(read('.github/workflows/vm-apply.yml')) as Workflow;
const job = wf.jobs['vm-apply'];
const steps = job.steps;
const inputs = wf.on.workflow_dispatch.inputs;
const choices = [...(inputs.action?.options ?? [])];

const VM_SH = 'deploy/vm-apply/vm.sh';
const REMOTE_SH = 'deploy/vm-apply/remote.sh';
const APPLY_SH = 'deploy/apply.sh';
const SCRIPTS = [VM_SH, REMOTE_SH];

/** Code lines: comments and blank lines dropped. */
const code = (rel: string) =>
    read(rel)
        .split('\n')
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

/** Code lines with `\` continuations joined, so one command is one line. */
const commands = (rel: string) =>
    code(rel)
        .join('\n')
        .replace(/\\\n\s*/g, ' ')
        .split('\n');

/** Lines that RUN something: apply.sh's message emitters dropped. */
const executable = (rel: string) => commands(rel).filter((l) => !/^\s*(err|log|warn)\s+"/.test(l));

/** A shell function's source, from `name() {` to the closing `}` in column 0. */
function shellFunction(rel: string, name: string): string {
    const lines = read(rel).split('\n');
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
    if (start < 0) throw new Error(`${rel} defines no ${name}()`);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    if (end < 0) throw new Error(`${rel}: ${name}() is not closed in column 0`);
    return lines.slice(start, end + 1).join('\n');
}

/** vm.sh's dispatch: `action) body ;;` for each action. */
function dispatch(): Map<string, string> {
    const out = new Map<string, string>();
    for (const l of code(VM_SH)) {
        const m = /^\s*([a-z][a-z-]*)\)\s+(.+?)\s*;;\s*$/.exec(l);
        if (m) out.set(m[1], m[2]);
    }
    return out;
}

describe('the VM apply workflow', () => {
    it('runs only when a person dispatches it, and only from main', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
        expect(Object.keys(wf.jobs)).toEqual(['vm-apply']);
        // What it pushes is the checkout, and the VM is repo-canonical: what
        // reaches production is what merged.
        expect(job.if).toBe("github.ref == 'refs/heads/main'");
    });

    it('runs in the production environment, whose reviewer approves each run, with a time limit', () => {
        expect(job.environment).toBe('production');
        expect(job['timeout-minutes']).toBeGreaterThan(0);
    });

    it('holds an OIDC token and read access to the code, and nothing else', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    });

    it('runs one at a time, in a group of its own, never cancelling a run in flight', () => {
        expect(wf.concurrency).toEqual({ group: 'vm-apply', 'cancel-in-progress': false });
    });

    it('authenticates to GCP by Workload Identity Federation, never with a key', () => {
        const auth = steps.filter((s) => s.uses?.startsWith('google-github-actions/auth@'));
        expect(auth).toHaveLength(1);
        expect(Object.keys(auth[0].with ?? {}).sort()).toEqual(['service_account', 'workload_identity_provider']);
    });

    it('uses exactly the actions VM check uses, at the same pins', () => {
        const uses = (w: { jobs: Record<string, { steps: Step[] }> }) =>
            Object.values(w.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter((u): u is string => !!u)).sort();
        const check = yaml.load(read('.github/workflows/vm-check.yml')) as { jobs: Record<string, { steps: Step[] }> };
        expect(uses(wf)).toEqual(uses(check));
    });

    it('reads no secret', () => {
        expect(steps.filter((s) => JSON.stringify(s).includes('secrets.')).map((s) => s.name)).toEqual([]);
    });

    it('takes one input, and it is a choice, never free text', () => {
        expect(Object.keys(inputs)).toEqual(['action']);
        expect(inputs.action.type).toBe('choice');
        expect(choices.length).toBeGreaterThan(0);
    });

    it('passes the action through the environment, never into a script line', () => {
        // `${{ inputs.x }}` inside `run:` is pasted into the shell before it
        // runs, so an input becomes code. Through `env:` it stays a value.
        expect(steps.filter((s) => (s.run ?? '').includes('${{')).map((s) => s.name)).toEqual([]);
        expect(steps.filter((s) => s.run).map((s) => s.run)).toEqual(['deploy/vm-apply/vm.sh "$ACTION"']);
    });
});

describe('the action list is the same in the workflow and the script', () => {
    it('vm.sh accepts exactly the workflow’s choices', () => {
        const accept = code(VM_SH).filter((l) => /^\s*[a-z-]+(\s*\|\s*[a-z-]+)*\)\s*;;\s*$/.test(l));
        expect(accept).toHaveLength(1);
        const listed = accept[0].replace(/\)\s*;;\s*$/, '').split('|').map((s) => s.trim());
        expect(listed.sort()).toEqual([...choices].sort());
    });

    it('vm.sh carries out each choice, and nothing else', () => {
        expect([...dispatch().keys()].sort()).toEqual([...choices].sort());
    });
});

describe('every write is preceded by its preflight, in the same run', () => {
    const REMOTE_ACTIONS = ['retire-lab-containers', 'recreate-legacy-mcp-proving'];
    const isPreflight = (a: string) => a === 'preflight' || a.endsWith('-preflight');

    it('a preflight action never writes', () => {
        const d = dispatch();
        const bodies = choices.filter(isPreflight).map((a) => d.get(a) ?? '');
        expect(bodies.length).toBeGreaterThan(0);
        expect(bodies.filter((b) => !/^preflight(\s|$)/.test(b))).toEqual([]);
    });

    it('each apply.sh write runs the same mode as a preflight action, through preflight_then_write', () => {
        const d = dispatch();
        const writes = choices.filter((a) => !isPreflight(a) && !REMOTE_ACTIONS.includes(a));
        expect(writes.length).toBeGreaterThan(0);
        const paired = writes.map((a) => {
            const body = d.get(a) ?? '';
            const mode = body.replace(/^preflight_then_write\s*/, '');
            const sibling = a === 'apply' ? 'preflight' : `${a.replace(/-apply$/, '')}-preflight`;
            return { a, writes: body.startsWith('preflight_then_write'), sameMode: d.get(sibling) === `preflight ${mode}`.trim() };
        });
        expect(paired.filter((p) => !p.writes || !p.sameMode)).toEqual([]);
    });

    it('preflight_then_write runs the preflight, and writes only if it passed', () => {
        const body = shellFunction(VM_SH, 'preflight_then_write').split('\n').slice(1, -1).map((l) => l.trim());
        expect(body).toEqual(['env "$@" "$APPLY"', 'env "$@" CONFIRM=1 "$APPLY"']);
        // `set -e` is what makes "only if it passed" true.
        expect(code(VM_SH).filter((l) => l === 'set -euo pipefail')).toHaveLength(1);
        // And CONFIRM=1 is set nowhere else.
        expect(code(VM_SH).filter((l) => l.includes('CONFIRM=1'))).toHaveLength(1);
    });

    it('vm.sh reaches apply.sh only through the two helpers', () => {
        expect(code(VM_SH).filter((l) => l.includes('"$APPLY"'))).toHaveLength(3);
    });

    it('the two remote actions run remote.sh, which has a branch for each and refuses anything else', () => {
        const d = dispatch();
        expect(REMOTE_ACTIONS.map((a) => d.get(a))).toEqual(['on_vm', 'on_vm']);
        const branches = code(REMOTE_SH)
            .map((l) => /^([a-z][a-z-]*|\*)\)\s*$/.exec(l)?.[1])
            .filter((b): b is string => b !== undefined);
        expect(branches.filter((b) => b !== '*').sort()).toEqual([...REMOTE_ACTIONS].sort());
        expect(branches[branches.length - 1]).toBe('*');
    });

    it('the proving overlay is validated before it is installed', () => {
        const lines = commands(REMOTE_SH);
        const validate = lines.findIndex((l) => /compose -f docker-compose\.prod\.yml -f "\$NEW" config -q/.test(l));
        const install = lines.findIndex((l) => /^\s*mv "\$NEW" "\$OVERLAY"/.test(l));
        expect(validate).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(validate);
    });
});

describe('nothing in the runner’s environment steers apply.sh', () => {
    it('vm.sh sets or clears every variable apply.sh reads', () => {
        // Derived from apply.sh, so a new knob there fails here until vm.sh
        // decides it.
        const knobs = [...new Set([...read(APPLY_SH).matchAll(/\$\{([A-Z_]+):-/g)].map((m) => m[1]))];
        expect(knobs.length).toBeGreaterThan(5);
        const vm = commands(VM_SH);
        const unset = vm.filter((l) => /^unset\s/.test(l)).flatMap((l) => l.replace(/^unset\s+/, '').split(/\s+/));
        const assigned = vm.flatMap((l) => [...l.matchAll(/(?:^|\s)([A-Z_]+)=/g)].map((m) => m[1]));
        expect(knobs.filter((k) => !unset.includes(k) && !assigned.includes(k)).sort()).toEqual([]);
    });

    it('vm.sh always runs apply.sh in its public-log mode', () => {
        expect(code(VM_SH).filter((l) => /^export APPLY_PUBLIC_LOG=1(\s|$)/.test(l))).toHaveLength(1);
        expect(code(VM_SH).filter((l) => /APPLY_PUBLIC_LOG=(?!1)/.test(l))).toEqual([]);
    });
});

describe('the OrangeHRM lab', () => {
    const LAB_VHOSTS = ['hrm-mcp.34-140-180-255.sslip.io', 'orangehrm-lab.34-140-180-255.sslip.io'];

    it('the hostnames production may stop serving are literals in vm.sh, and no other value reaches CADDY_RETIRE_HOSTS', () => {
        const assignments = code(VM_SH).filter((l) => l.startsWith('LAB_VHOSTS='));
        expect(assignments).toEqual([`LAB_VHOSTS="${LAB_VHOSTS.join(' ')}"`]);
        const retire = code(VM_SH).flatMap((l) => [...l.matchAll(/CADDY_RETIRE_HOSTS=[^\s]*/g)].map((m) => m[0]));
        expect([...new Set(retire)]).toEqual(['CADDY_RETIRE_HOSTS=$LAB_VHOSTS"']);
    });

    it('the repo Caddyfile no longer serves either of them', () => {
        expect(code('deploy/caddy/Caddyfile').filter((l) => LAB_VHOSTS.some((h) => l.includes(h)))).toEqual([]);
    });

    it('its containers are removed with rm --stop, naming the three services, and never with down', () => {
        const services = code(REMOTE_SH).filter((l) => /^\s*LAB_SERVICES=/.test(l)).map((l) => l.trim());
        expect(services).toEqual(['LAB_SERVICES=(orangehrm-mcp orangehrm orangehrm-db)']);
        const rm = commands(REMOTE_SH).filter((l) => /\bcompose\b.*\brm\b/.test(l));
        expect(rm).toHaveLength(1);
        expect(rm[0]).toContain('rm --stop --force "${LAB_SERVICES[@]}"');
        // `down` removes the project's networks, inflect_default first, which
        // every production container is on.
        for (const rel of [...SCRIPTS, APPLY_SH]) {
            expect(executable(rel).filter((l) => /(^|[\s;&|])down([\s;&|]|$)/.test(l))).toEqual([]);
        }
    });

    it('no volume is removed', () => {
        for (const rel of [...SCRIPTS, APPLY_SH]) {
            expect(
                executable(rel).filter((l) =>
                    /\bvolume\s+(rm|prune)\b|\bsystem\s+prune\b|\brm\b[^|;&]*\s(-v|--volumes)\b|\bdocker rm\b[^|;&]*\s-[a-z]*v/.test(l),
                ),
            ).toEqual([]);
        }
    });
});

describe('the scripts it runs print shape, never content', () => {
    it.each(SCRIPTS)('%s is executable', (rel) => {
        expect(fs.statSync(path.join(REPO_ROOT, rel)).mode & 0o111).not.toBe(0);
    });

    it.each([...SCRIPTS, APPLY_SH])('%s never traces its commands', (rel) => {
        expect(code(rel).filter((l) => /set\s+-[a-z]*x|set\s+-o\s+xtrace/.test(l))).toEqual([]);
    });

    it.each([...SCRIPTS, APPLY_SH])('%s never prints or diffs a live compose or env file', (rel) => {
        // Reading a live file for a hash, a key's presence or a count is fine;
        // displaying it is not. The live compose file carries inline
        // credentials, and the env files are nothing but credentials.
        // A display command, then — before any pipe — a live file.
        const displays =
            /\b(cat|less|more|head|tail|diff|sed|awk|strings|xxd|od|base64)\b[^|]*(\.env\b|\.ya?ml\b|\/opt\/inflect|REMOTE_COMPOSE|COMPOSE_BASENAME|\$OVERLAY|\$NEW\b|\$\{?BACKUP)/;
        expect(executable(rel).filter((l) => displays.test(l))).toEqual([]);
        // grep against those files answers yes/no or a count, never a line.
        expect(
            executable(rel).filter((l) => /\bgrep\b/.test(l) && /\.env\b/.test(l) && !/\bgrep\s+-[a-zA-Z]*[qc]/.test(l)),
        ).toEqual([]);
        // `docker compose config` without -q prints the RESOLVED file, every
        // interpolated secret included.
        expect(executable(rel).filter((l) => /\bconfig\b/.test(l) && /\bcompose\b/.test(l) && !/\bconfig\s+(-q|--quiet)\b/.test(l))).toEqual([]);
    });

    it('apply.sh relays every VM compose command through show', () => {
        const relayed = executable(APPLY_SH).filter((l) => /\bssh_vm\b/.test(l) && /docker compose/.test(l));
        expect(relayed.length).toBeGreaterThanOrEqual(5);
        expect(relayed.filter((l) => !/\| show compose\b/.test(l))).toEqual([]);
    });

    it('apply.sh’s show is a pass-through only when the log is not public', () => {
        const body = shellFunction(APPLY_SH, 'show').split('\n').map((l) => l.trim());
        expect(body[1]).toBe('if [ "$PUBLIC_LOG" != "1" ]; then cat; return; fi');
        expect(code(APPLY_SH).filter((l) => l.startsWith('PUBLIC_LOG='))).toEqual(['PUBLIC_LOG="${APPLY_PUBLIC_LOG:-0}"']);
    });

    it('remote.sh pipes every compose command into shape', () => {
        const calls = commands(REMOTE_SH).filter((l) => /^\s*compose\s/.test(l));
        expect(calls.length).toBe(3);
        expect(calls.filter((l) => !/2>&1 \| shape\b/.test(l))).toEqual([]);
    });

    it('remote.sh calls docker only to list, inspect named fields, remove containers and run compose', () => {
        const remote = code(REMOTE_SH);
        const verbs = [...new Set(remote.flatMap((l) => l.match(/\bdocker\s+[a-z]+/g) ?? []).map((c) => c.split(/\s+/)[1]))];
        expect(verbs.sort()).toEqual(['compose', 'inspect', 'ps', 'rm', 'volume']);
        const inspected = remote.flatMap((l) => [...l.matchAll(/docker inspect -f '\{\{(\.[A-Za-z.]+)\}\}'/g)].map((m) => m[1]));
        expect(remote.filter((l) => /\bdocker\s+inspect\b/.test(l)).length).toBeGreaterThan(0);
        expect(remote.filter((l) => /\bdocker\s+inspect\b/.test(l) && !/docker inspect -f '\{\{\.[A-Za-z.]+\}\}'/.test(l))).toEqual([]);
        expect([...new Set(inspected)].sort()).toEqual(['.HostConfig.Memory', '.HostConfig.NanoCpus', '.State.Health.Status', '.State.Status']);
        expect(remote.filter((l) => /\bdocker\s+(volume\s+ls|ps)\b/.test(l) && !/--format '\{\{\.Name\}\}'|-aq\b/.test(l))).toEqual([]);
    });

    it('vm.sh touches nothing on the VM but its own stage directory', () => {
        const calls = code(VM_SH).filter((l) => /^\s*ssh_vm\s/.test(l));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter((l) => !l.includes('vm-apply-stage'))).toEqual([]);
    });
});

/**
 * The filters, RUN. A stream carrying the shapes compose uses to quote what it
 * read from an env file goes in; nothing secret-shaped may come out, and the
 * lines an operator needs must.
 */
describe('the output filters withhold what they do not recognise', () => {
    const SECRET = 'sekret';
    const stream = [
        'DRY-RUN MODE -  Container inflect-app-1  Recreate',
        ' Container inflect-redis-1  Recreated',
        'Network inflect_default  Creating',
        `WARN[0000] The "PW=${SECRET}" variable is not set. Defaulting to a blank string.`,
        `failed to read .env.prod: line 3: unexpected character "${SECRET}" in variable name`,
        'error while interpolating services.app.environment: required variable DATA_ENCRYPTION_KEY is missing a value',
        `services.app.environment.DATABASE_URL=postgres://u:${SECRET}@db/x`,
        `Container inflect-app-1 PASSWORD=${SECRET}`,
        `ERROR: (gcloud.compute.ssh) [/usr/bin/ssh] exited with ${SECRET}`,
        '',
    ].join('\n');

    const run = (script: string, input: string) => execFileSync('bash', ['-c', script], { input, encoding: 'utf8' });

    it('apply.sh, in its public-log mode', () => {
        const fns = ['shape_compose', 'shape_diagnostics', 'shape_none', 'show'].map((n) => shellFunction(APPLY_SH, n)).join('\n');
        const out = run(`${fns}\nPUBLIC_LOG=1\nshow compose; show none <<<"${SECRET}"`, stream);
        expect(out.split('\n').filter((l) => l.includes(SECRET))).toEqual([]);
        const kept = out.split('\n').map((l) => l.trim());
        expect(kept.filter((l) => l === 'Container inflect-app-1 Recreate' || l === 'Container inflect-redis-1 Recreated')).toHaveLength(2);
        expect(kept.filter((l) => l === 'required variable DATA_ENCRYPTION_KEY')).toHaveLength(1);
        expect(kept.filter((l) => /^\[\d+ line\(s\) withheld/.test(l))).toHaveLength(2);
        // And at a terminal it is a pass-through: the operator reads it all.
        const interactive = run(`${fns}\nPUBLIC_LOG=0\nshow compose`, stream);
        expect(interactive).toBe(stream);
    });

    it('remote.sh', () => {
        const out = run(`${shellFunction(REMOTE_SH, 'shape')}\nshape`, stream);
        expect(out.split('\n').filter((l) => l.includes(SECRET))).toEqual([]);
        expect(out.split('\n').map((l) => l.trim()).filter((l) => l === 'Network inflect_default Creating')).toHaveLength(1);
    });
});
