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
 *   - only a person can start it, behind the `production` reviewer, with no
 *     key or secret, and an unmodified dispatch runs only from main (a branch
 *     can edit this file, so the environment's branch policy is the boundary:
 *     docs/deployment.md, "Named changes without a key");
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
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
const IAP_SH = 'deploy/lib/iap.sh';
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
    const REMOTE_ACTIONS = ['retire-lab-containers', 'recreate-legacy-mcp-proving', 'retire-capacity-recorder'];
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

    it('the remote actions run remote.sh, which has a branch for each and refuses anything else', () => {
        const d = dispatch();
        expect(REMOTE_ACTIONS.map((a) => d.get(a))).toEqual(['on_vm', 'on_vm', 'on_vm']);
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
        // apply.sh and the IAP helper it sources (deploy/lib/iap.sh).
        const knobs = [...new Set([APPLY_SH, IAP_SH].flatMap((rel) => [...read(rel).matchAll(/\$\{([A-Z_]+):-/g)].map((m) => m[1])))];
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
        // Every way bash can set it — indented, appended, exported, declared,
        // read — not only a line that starts with the assignment.
        const sets = /\bLAB_VHOSTS(\[[^\]]*\])?\+?=|\b(read|declare|typeset|local|export|readonly|mapfile|readarray)\b[^#]*\bLAB_VHOSTS\b|printf\s+-v\s*LAB_VHOSTS\b/;
        const assignments = code(VM_SH).filter((l) => sets.test(l));
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

describe('the capacity recorder is retired through the same path it was installed by', () => {
    /** remote.sh's `retire-capacity-recorder)` branch, to its `;;`. */
    const branch = () => {
        const lines = code(REMOTE_SH);
        const start = lines.findIndex((l) => l === 'retire-capacity-recorder)');
        const end = lines.findIndex((l, i) => i > start && l.trim() === ';;');
        if (start < 0 || end < 0) throw new Error('remote.sh has no retire-capacity-recorder branch');
        return lines.slice(start + 1, end).map((l) => l.trim());
    };

    it('removes exactly the files apply.sh pushes for it, and its data directory', () => {
        // The pushed set, read from apply.sh, so the two cannot disagree.
        const pushed = read(APPLY_SH)
            .split('\n')
            .map((l) => /^\s*"\$\{SCRIPT_DIR\}\/capacity\/recorder\/[^:]+:(\/[^"]+)"\s*$/.exec(l)?.[1])
            .filter((p): p is string => p !== undefined);
        expect(pushed.length).toBe(3);
        const unit = branch().filter((l) => l.startsWith('UNIT='));
        expect(unit).toEqual(['UNIT=inflect-capacity-record']);
        const files = branch().filter((l) => l.startsWith('FILES=('));
        expect(files).toHaveLength(1);
        const listed = [...files[0].slice('FILES=('.length, -1).matchAll(/"([^"]+)"|(\S+)/g)].map((m) =>
            (m[1] ?? m[2]).replace('$UNIT', 'inflect-capacity-record'),
        );
        expect(listed.sort()).toEqual([...pushed].sort());
        expect(branch().filter((l) => /^rm\s/.test(l))).toEqual(['rm -f "${FILES[@]}"', 'rm -rf "$rows_dir"']);
        expect(branch().filter((l) => l.startsWith('rows_dir='))).toEqual(['rows_dir=/var/lib/inflect-capacity']);
    });

    it('stops and disables the timer, reloads systemd, and fails if anything is left', () => {
        const b = branch();
        expect(b.filter((l) => l.startsWith('systemctl disable --now "$UNIT.timer"'))).toHaveLength(1);
        expect(b.filter((l) => l === 'systemctl daemon-reload')).toHaveLength(1);
        expect(b[b.length - 1].startsWith('[ "$left" -eq 0 ] && [ ! -e "$rows_dir" ] ||')).toBe(true);
        // It touches no container.
        expect(b.filter((l) => /\bdocker\b/.test(l))).toEqual([]);
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
        // `docker compose` is spelled once, inside the `compose` helper, so
        // every compose command goes through the helper's name below.
        const DEFINITION = 'compose() { docker compose --env-file .env --env-file .env.prod "$@"; }';
        const lines = commands(REMOTE_SH);
        expect(lines.filter((l) => /\bdocker\s+compose\b/.test(l)).map((l) => l.trim())).toEqual([DEFINITION]);
        // A call is the word `compose` anywhere in a command — after `if`, `!`,
        // `&&`, `$(` or nothing — outside a quoted string (an echo naming the
        // word is not a call).
        const unquoted = (l: string) => l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
        const calls = lines.filter((l) => l.trim() !== DEFINITION && /(^|[\s;&|(!{])compose\s/.test(unquoted(l)));
        expect(calls.length).toBe(3);
        expect(calls.filter((l) => !/\bcompose\s[^|]*2>&1 \| shape\b/.test(l))).toEqual([]);
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
        const calls = code(VM_SH).filter((l) => /^\s*ssh_vm(_once)?\s/.test(l));
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

/**
 * A runner has no gcloud ssh key, so its first `gcloud compute ssh` makes one,
 * and ssh-keygen prints its banner and randomart on STDOUT — into whatever the
 * first `$(ssh_vm …)` captures. apply.sh is RUN here against a fake VM (a
 * directory) through a fake `gcloud` that behaves that way, from an empty HOME.
 */
describe('apply.sh on a runner with no ssh key', () => {
    it('makes the key with a throwaway ssh whose stdout is discarded, before any mode reaches the VM', () => {
        const body = shellFunction(APPLY_SH, 'ssh_key_ready').split('\n').map((l) => l.trim());
        expect(body.filter((l) => /^ssh_vm\b/.test(l))).toEqual(['ssh_vm true >/dev/null']);
        const lines = code(APPLY_SH);
        const call = lines.findIndex((l) => l.trim() === 'ssh_key_ready');
        expect(lines.filter((l) => l.trim() === 'ssh_key_ready')).toHaveLength(1);
        expect(lines[call - 1].trim()).toBe('if [ "${DRY_RUN:-0}" != "1" ]; then');
        // Before the first mode, and before any top-level read of the VM.
        const firstMode = lines.findIndex((l) => /^if \[ "\$\{(CADDY_ONLY|HOST_CONFIG_ONLY|ROLLBACK):-0\}" = "1" \]/.test(l));
        const firstTopLevelSsh = lines.findIndex((l) => /^[A-Z_]+="\$\(ssh_vm\s|^ssh_vm\s|^if ! ssh_vm\s/.test(l));
        expect(call).toBeGreaterThan(-1);
        expect(call).toBeLessThan(firstMode);
        expect(call).toBeLessThan(firstTopLevelSsh);
    });

    const ROLLBACK_ENV = { ROLLBACK: '1', APPLY_PUBLIC_LOG: '1' };
    const BANNER = ['Generating public/private rsa key pair.', '+---[RSA 3072]----+', '|   .o+=.  E      |'];

    /** A fake VM with these compose backups (timestamp → content) and live content. */
    function fakeVm(backups: Record<string, string>, live: string) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-apply-rollback-'));
        const bin = path.join(root, 'bin');
        const vm = path.join(root, 'vm');
        const home = path.join(root, 'home');
        for (const d of [bin, vm, home]) fs.mkdirSync(d);
        const exe = (name: string, src: string) => fs.writeFileSync(path.join(bin, name), src, { mode: 0o755 });
        exe(
            'gcloud',
            [
                '#!/usr/bin/env bash',
                'cmd=""; while [ $# -gt 0 ]; do [ "$1" = "--command" ] && { cmd="$2"; shift; }; shift; done',
                'if [ ! -f "$HOME/.ssh/google_compute_engine" ]; then',
                '  mkdir -p "$HOME/.ssh" && : > "$HOME/.ssh/google_compute_engine"',
                ...BANNER.map((l) => `  echo '${l}'`),
                'fi',
                'exec bash -c "$cmd"',
                '',
            ].join('\n'),
        );
        exe('sudo', '#!/usr/bin/env bash\nexec "$@"\n');
        exe('docker', '#!/usr/bin/env bash\nexit 0\n');
        fs.writeFileSync(path.join(vm, 'docker-compose.prod.yml'), live);
        for (const [ts, content] of Object.entries(backups)) {
            fs.writeFileSync(path.join(vm, `docker-compose.prod.yml.bak.${ts}`), content);
        }
        const run = () => {
            try {
                const out = execFileSync('bash', [path.join(REPO_ROOT, APPLY_SH)], {
                    env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, HOME: home, REMOTE_DIR: vm, ...ROLLBACK_ENV },
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                return { status: 0, out };
            } catch (e) {
                const x = e as { status: number; stdout: string; stderr: string };
                return { status: x.status, out: `${x.stdout}${x.stderr}` };
            }
        };
        return { run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    }

    it('rollback-preflight names the newest backup that differs from the live file, skipping identical newer ones', () => {
        // The C1 apply backed up the pre-C1 file; a retried apply then backed
        // up the C1 file itself, which is the live file.
        const vm = fakeVm({ '20261101-000000': 'older\n', '20261112-090000': 'pre-C1\n', '20261112-100000': 'C1\n', '20261112-110000': 'C1\n' }, 'C1\n');
        try {
            const r = vm.run();
            expect(r.status).toBe(0);
            const named = r.out.split('\n').filter((l) => / backup {2}docker-compose\.prod\.yml\.bak\./.test(l));
            expect(named).toHaveLength(1);
            expect(named[0]).toContain('docker-compose.prod.yml.bak.20261112-090000 ');
            expect(r.out).toContain('skipped 2 newer backup(s)');
            // ssh-keygen's banner reached no captured value, and no log line.
            expect(r.out.split('\n').filter((l) => BANNER.some((b) => l.includes(b)))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('refuses when every backup is the live file', () => {
        const vm = fakeVm({ '20261112-100000': 'C1\n', '20261112-110000': 'C1\n' }, 'C1\n');
        try {
            const r = vm.run();
            expect(r.status).toBe(2);
            expect(r.out).toContain('every backup (2) IS the live file');
        } finally {
            vm.cleanup();
        }
    });
});

/**
 * A dropped IAP connection is retried, and never read as an answer
 * (owner decision 2026-11-14).
 *
 * ssh exits 255 when its CONNECTION fails; a remote command's status is
 * relayed as itself. Two VM apply runs read a dropped connection as a verdict:
 * 43604116595 refused an unchanged, already-validated Caddyfile as "caddy
 * rejected it", and 43605285337 reported an existing unit file as "absent".
 * apply.sh is RUN here in its CADDY_ONLY and HOST_CONFIG_ONLY preflights
 * against a fake VM (a directory, and a fake caddy container) through a fake
 * `gcloud` that drops chosen calls: before the command runs, or after it ran
 * and only the answer was lost.
 */
describe('apply.sh over an IAP connection that drops', () => {
    type Drop = { match: string; times: number | 'always'; when?: 'before' | 'after' };

    function fakeVm(opts: { drop?: Drop; caddyRejects?: boolean } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-apply-iap-'));
        const bin = path.join(root, 'bin');
        const vm = path.join(root, 'vm');
        const container = path.join(root, 'container');
        const home = path.join(root, 'home');
        for (const d of [bin, vm, container, home, path.join(home, '.ssh'), path.join(vm, 'caddy'), path.join(container, 'etc/caddy'), path.join(container, 'tmp')]) {
            fs.mkdirSync(d, { recursive: true });
        }
        fs.writeFileSync(path.join(home, '.ssh/google_compute_engine'), '');
        const caddyfile = read('deploy/caddy/Caddyfile');
        fs.writeFileSync(path.join(vm, 'caddy/Caddyfile'), caddyfile);
        fs.writeFileSync(path.join(container, 'etc/caddy/Caddyfile'), caddyfile);
        const calls = path.join(root, 'calls');
        const exe = (name: string, src: string) => fs.writeFileSync(path.join(bin, name), src, { mode: 0o755 });
        exe(
            'gcloud',
            [
                '#!/usr/bin/env bash',
                'kind="$2"; cmd=""; args=(); skip=0',
                'for a in "$@"; do',
                '  if [ $skip = 1 ]; then skip=0; continue; fi',
                '  case "$a" in --zone|--command) skip=1 ;; --*|compute|ssh|scp) ;; *) args+=("$a") ;; esac',
                'done',
                'while [ $# -gt 0 ]; do [ "$1" = "--command" ] && { cmd="$2"; shift; }; shift; done',
                'if [ "$kind" = scp ]; then line="scp ${args[*]}"; else line="ssh $(printf %s "$cmd" | tr "\\n" " ")"; fi',
                'printf "%s\\n" "$line" >> "$FAKE_CALLS"',
                'run() {',
                '  if [ "$kind" = scp ]; then n=${#args[@]}; dest="${args[$((n-1))]}"; cp "${args[@]:0:$((n-1))}" "${dest#*:}"; else bash -c "$cmd"; fi',
                '}',
                'if [ -n "${FAKE_DROP_MATCH:-}" ] && printf "%s" "$line" | grep -qE -- "$FAKE_DROP_MATCH"; then',
                '  n=$(cat "$FAKE_DROP_COUNT" 2>/dev/null || echo 0)',
                '  if [ "$FAKE_DROPS" = always ] || [ "$n" -lt "$FAKE_DROPS" ]; then',
                '    echo $((n + 1)) > "$FAKE_DROP_COUNT"',
                '    if [ "$FAKE_DROP_WHEN" = after ]; then run >/dev/null 2>&1; fi',
                '    echo "ERROR: (gcloud.compute.$kind) [/usr/bin/$kind] exited with return code [255]." >&2',
                '    exit 255',
                '  fi',
                'fi',
                'run',
                '',
            ].join('\n'),
        );
        exe('sudo', '#!/usr/bin/env bash\ncase "$*" in "test -x /opt/google-cloud-ops-agent/"*) exit 0 ;; esac\ncase "$1" in /opt/google-cloud-ops-agent/*) echo "Valid configuration"; exit 0 ;; esac\nexec "$@"\n');
        // The caddy container: `docker cp` into it, `docker exec` runs there.
        exe(
            'docker',
            [
                '#!/usr/bin/env bash',
                'name() { [ "$1" = inflect-caddy-1 ] || { echo "Error response from daemon: No such container: $1" >&2; exit 1; }; }',
                'case "$1" in',
                '  cp) name "${3%%:*}"; exec cp "$2" "$FAKE_CONTAINER${3#*:}" ;;',
                '  exec) name "$2"; shift 2; [ "$1" = rm ] && exec rm -f "$FAKE_CONTAINER${!#}"; exec "$@" ;;',
                'esac',
                'exit 0',
                '',
            ].join('\n'),
        );
        exe(
            'caddy',
            [
                '#!/usr/bin/env bash',
                'sub="$1"; shift; cfg=""',
                'while [ $# -gt 0 ]; do [ "$1" = --config ] && { cfg="$2"; shift; }; shift; done',
                'f="$FAKE_CONTAINER$cfg"',
                'case "$sub" in',
                '  validate)',
                '    [ -f "$f" ] || { echo "Error: open $cfg: no such file or directory"; exit 1; }',
                '    if [ -n "${FAKE_CADDY_REJECTS:-}" ]; then echo "Error: adapting config using caddyfile: $cfg:3: unrecognized directive: bogus"; exit 1; fi',
                '    echo "Valid configuration" ;;',
                '  adapt) grep -oE "[a-z0-9.-]+\\.(bg|io)" "$f" | sort -u | sed "s/.*/\\"&\\"/" ;;',
                'esac',
                '',
            ].join('\n'),
        );
        const run = (mode: Record<string, string>, script?: string) => {
            const env: Record<string, string> = {
                NODE_ENV: 'test',
                PATH: `${bin}:/usr/bin:/bin`,
                HOME: home,
                REMOTE_DIR: vm,
                APPLY_PUBLIC_LOG: '1',
                IAP_BACKOFF_SECONDS: '0',
                FAKE_CALLS: calls,
                FAKE_CONTAINER: container,
                FAKE_DROP_COUNT: path.join(root, 'drops'),
                ...mode,
            };
            if (opts.drop) {
                env.FAKE_DROP_MATCH = opts.drop.match;
                env.FAKE_DROPS = String(opts.drop.times);
                env.FAKE_DROP_WHEN = opts.drop.when ?? 'before';
            }
            if (opts.caddyRejects) env.FAKE_CADDY_REJECTS = '1';
            // stdout AND stderr whatever the status: the retry notes are on stderr.
            const argv = script === undefined ? [path.join(REPO_ROOT, APPLY_SH)] : ['-c', script];
            const p = spawnSync('bash', argv, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            const status = p.status;
            const out = `${p.stdout}${p.stderr}`;
            const lines = out.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[apply\]( ERROR:)?\s*/, '').trim());
            const made = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
            return { status, lines, calls: made };
        };
        return { run, vm, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    }

    const CADDY = { CADDY_ONLY: '1' };
    const VALIDATE = 'caddy validate';
    const startsWith = (lines: string[], prefix: string) => lines.filter((l) => l.startsWith(prefix));

    it('with no drop, the Caddyfile preflight passes (the control for every case below)', () => {
        const vm = fakeVm();
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(0);
            expect(startsWith(r.lines, 'unchanged ')).toHaveLength(1);
            expect(startsWith(r.lines, 'config OK')).toHaveLength(1);
            expect(startsWith(r.lines, 'PREFLIGHT ONLY')).toHaveLength(1);
            expect(startsWith(r.lines, '[iap]')).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it.each(['before', 'after'] as const)('a validation whose connection drops once (%s it ran) is retried, and passes', (when) => {
        const vm = fakeVm({ drop: { match: VALIDATE, times: 1, when } });
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(0);
            expect(r.calls.filter((c) => c.includes(VALIDATE))).toHaveLength(2);
            expect(startsWith(r.lines, '[iap] ssh to the VM failed (exit 255), attempt 1 of 3')).toHaveLength(1);
            expect(startsWith(r.lines, 'config OK')).toHaveLength(1);
            expect(r.lines.filter((l) => l.includes('caddy rejected it'))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('a hash read whose connection drops once is retried, and reads the real hash', () => {
        const vm = fakeVm({ drop: { match: 'sha256sum', times: 1 } });
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(0);
            expect(startsWith(r.lines, 'unchanged ')).toHaveLength(1);
            expect(startsWith(r.lines, 'WOULD CREATE')).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('a move whose answer is lost is not repeated into a failure: place_staged is idempotent', () => {
        // The move ran, the connection dropped before its answer: the retry
        // finds no staged file, and the target already holds the pushed bytes.
        const vm = fakeVm({ drop: { match: 'sudo mv ', times: 1, when: 'after' } });
        try {
            const staged = path.join(vm.vm, 'staged');
            const target = path.join(vm.vm, 'target');
            fs.writeFileSync(staged, 'pushed\n');
            fs.writeFileSync(target, 'old\n');
            const want = execFileSync('sha256sum', [staged], { encoding: 'utf8' }).split(' ')[0];
            // A one-line function is its own line; place_staged closes in column 0.
            const oneLine = (n: string) => read(APPLY_SH).split('\n').filter((l) => l.startsWith(`${n}() {`) && l.trimEnd().endsWith('}'));
            const fns = [...['first_sha', 'err', 'ssh_vm'].flatMap(oneLine), shellFunction(APPLY_SH, 'place_staged')].join('\n');
            const script = [
                'set -euo pipefail',
                'VM_NAME=vm VM_ZONE=z QUIET_FLAG=--quiet',
                `. '${path.join(REPO_ROOT, IAP_SH)}'`,
                fns,
                `place_staged '${staged}' '${target}' '${want}' && echo PLACED`,
            ].join('\n');
            const r = vm.run({}, script);
            expect(r.status).toBe(0);
            expect(r.calls.filter((c) => c.includes('sudo mv '))).toHaveLength(2);
            expect(r.lines.filter((l) => l === 'PLACED')).toHaveLength(1);
            expect(fs.readFileSync(target, 'utf8')).toBe('pushed\n');
            expect(fs.existsSync(staged)).toBe(false);
        } finally {
            vm.cleanup();
        }
    });

    it('a copy that fails once is retried', () => {
        const vm = fakeVm({ drop: { match: '^scp .*Caddyfile\\.validate', times: 1 } });
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(0);
            expect(r.calls.filter((c) => /^scp .*Caddyfile\.validate/.test(c))).toHaveLength(2);
            expect(startsWith(r.lines, '[iap] scp to the VM failed (exit 255), attempt 1 of 3')).toHaveLength(1);
        } finally {
            vm.cleanup();
        }
    });

    it('a validation that never connects stops the run as unreachable, never as "caddy rejected it"', () => {
        const vm = fakeVm({ drop: { match: VALIDATE, times: 'always' } });
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(1);
            expect(r.calls.filter((c) => c.includes(VALIDATE))).toHaveLength(3);
            expect(startsWith(r.lines, '[iap] ERROR: could not reach the VM over IAP (ssh exit 255 after 3 attempts).')).toHaveLength(1);
            expect(r.lines.filter((l) => /rejected|NOT valid|config OK|PREFLIGHT ONLY/.test(l))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('a hash read that never connects stops the run, never reporting the file absent (run 43605285337)', () => {
        const vm = fakeVm({ drop: { match: 'sha256sum', times: 'always' } });
        try {
            for (const mode of [CADDY, { HOST_CONFIG_ONLY: '1' }]) {
                const r = vm.run(mode);
                expect(r.status).toBe(1);
                expect(startsWith(r.lines, '[iap] ERROR: could not reach the VM over IAP (ssh exit 255 after 3 attempts).')).toHaveLength(1);
                expect(r.lines.filter((l) => /WOULD CREATE|absent|WOULD CHANGE|unchanged /.test(l))).toEqual([]);
            }
        } finally {
            vm.cleanup();
        }
    });

    it('caddy rejecting the file is a verdict: not retried, and reported as a rejection', () => {
        const vm = fakeVm({ caddyRejects: true });
        try {
            const r = vm.run(CADDY);
            expect(r.status).toBe(1);
            expect(r.calls.filter((c) => c.includes(VALIDATE))).toHaveLength(1);
            expect(startsWith(r.lines, 'the repo Caddyfile is NOT valid — caddy rejected it.')).toHaveLength(1);
            expect(r.lines.filter((l) => l.includes('unrecognized directive'))).toHaveLength(1);
            expect(startsWith(r.lines, '[iap]')).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('a validation that fails before caddy runs is not retried, and is not reported as a rejection', () => {
        // docker cp exits 1 when the container is gone: a real remote failure,
        // so no retry — and no `caddy-validate-exit` line, so no verdict.
        const vm = fakeVm();
        try {
            const r = vm.run({ ...CADDY, CADDY_CONTAINER: 'no-such-container' });
            expect(r.status).toBe(1);
            expect(r.calls.filter((c) => c.includes(VALIDATE))).toHaveLength(1);
            expect(startsWith(r.lines, 'caddy validate did not run in no-such-container (exit 1). This is NOT a')).toHaveLength(1);
            expect(r.lines.filter((l) => /rejected|NOT valid/.test(l))).toEqual([]);
            expect(startsWith(r.lines, '[iap]')).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });
});

describe('check-drift.sh over an IAP connection that never connects', () => {
    it('exits 2, UNKNOWN, and reports no drift', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-iap-'));
        try {
            const bin = path.join(root, 'bin');
            fs.mkdirSync(bin);
            fs.writeFileSync(path.join(bin, 'gcloud'), '#!/usr/bin/env bash\necho x >> "$FAKE_CALLS"\nexit 255\n', { mode: 0o755 });
            let status = 0;
            let out = '';
            try {
                execFileSync('bash', [path.join(REPO_ROOT, 'deploy/check-drift.sh')], {
                    env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, HOME: root, IAP_BACKOFF_SECONDS: '0', FAKE_CALLS: path.join(root, 'calls') },
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch (e) {
                const x = e as { status: number; stdout: string; stderr: string };
                status = x.status;
                out = `${x.stdout}${x.stderr}`;
            }
            expect(status).toBe(2);
            expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
            expect(out.split('\n').filter((l) => l.startsWith('[iap] ERROR: could not reach the VM over IAP (ssh exit 255 after 3 attempts).'))).toHaveLength(1);
            expect(out.split('\n').filter((l) => /DRIFT|in sync/.test(l))).toEqual([]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('every call to the VM goes through deploy/lib/iap.sh', () => {
    const DEPLOY_SCRIPTS = [APPLY_SH, 'deploy/check-drift.sh', VM_SH, 'deploy/vm-check/vm.sh', 'deploy/capacity/vm.sh', 'deploy/harness-scanner/vm.sh'];

    it.each(DEPLOY_SCRIPTS)('%s sources it and runs gcloud ssh/scp only inside iap_retry or iap_once', (rel) => {
        const lines = executable(rel).filter((l) => !/^\s*(ROLLBACK|echo)\b/.test(l) && !/^\s*\[ -n "\$f" \] && err /.test(l));
        expect(lines.filter((l) => /^\. "\$\{?(SCRIPT_DIR|HERE)\}?\/(\.\.\/)?lib\/iap\.sh"$/.test(l.trim()))).toHaveLength(1);
        const gcloud = lines.filter((l) => /\bgcloud compute (ssh|scp)\b/.test(l));
        expect(gcloud.length).toBeGreaterThan(0);
        expect(gcloud.filter((l) => !/\biap_(retry|once)\b/.test(l))).toEqual([]);
    });

    it('a remote.sh action that writes is attempted once, never retried', () => {
        for (const rel of [VM_SH, 'deploy/harness-scanner/vm.sh']) {
            const runs = code(rel).filter((l) => /remote\.sh/.test(l) && /sudo bash/.test(l));
            expect(runs).toHaveLength(1);
            expect(runs[0].trim().startsWith('ssh_vm_once ')).toBe(true);
        }
    });
});
