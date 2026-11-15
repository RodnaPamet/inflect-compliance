/**
 * The production VM's env files: which file a service reads, which file is a
 * secret, and which template is public (#5308, owner decisions 2026-11-14).
 *
 *   - The pipelock overlay reads `/opt/inflect/.env.pipelock`, never
 *     `.env.prod`, so `deploy/apply.sh` must refuse to act on the overlay while
 *     that file is absent: compose's answer to a missing `env_file:` is an
 *     error about a path, and the quickest way past it is to point the overlay
 *     back at `.env.prod`.
 *   - `deploy/check-drift.sh` must report `.env.pipelock` as a credential
 *     whenever it is readable beyond root, BY NAME. Its content test reads
 *     variable names, and a bearer key under a name it does not recognise
 *     scores TIDY. The public templates stay public.
 *   - `deploy/.env.prod.example` must hold only values the env schema accepts:
 *     it said `RATE_LIMIT_MODE=redis`, which fails validation at module load.
 *
 * Both scripts are RUN here, against a fake VM (a directory) through a fake
 * `gcloud` that runs each `--command` locally, so each assertion is on what
 * the script does rather than on its text.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** A fake VM directory, a fake gcloud/sudo/docker on PATH, and a way to run a script. */
function fakeVm(files: Record<string, { content: string; mode: number }>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-env-files-'));
    const bin = path.join(root, 'bin');
    const vm = path.join(root, 'vm');
    const home = path.join(root, 'home');
    for (const d of [bin, vm, home]) fs.mkdirSync(d);
    const exe = (name: string, src: string) => fs.writeFileSync(path.join(bin, name), src, { mode: 0o755 });
    // Runs the `--command` of an ssh locally, with stdin passed through (the
    // drift check feeds its classifier on stdin). An scp has no `--command`
    // and copies nothing.
    exe(
        'gcloud',
        [
            '#!/usr/bin/env bash',
            'cmd=""; while [ $# -gt 0 ]; do [ "$1" = "--command" ] && { cmd="$2"; shift; }; shift; done',
            'exec bash -c "$cmd"',
            '',
        ].join('\n'),
    );
    exe('sudo', '#!/usr/bin/env bash\nexec "$@"\n');
    exe('docker', '#!/usr/bin/env bash\nexit 0\n');
    for (const [name, { content, mode }] of Object.entries(files)) {
        const p = path.join(vm, name);
        fs.writeFileSync(p, content);
        fs.chmodSync(p, mode);
    }
    const run = (script: string, env: Record<string, string>) => {
        try {
            const out = execFileSync('bash', [path.join(REPO_ROOT, script)], {
                env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, HOME: home, REMOTE_DIR: vm, ...env },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { status: 0, out };
        } catch (e) {
            const x = e as { status: number; stdout: string; stderr: string };
            return { status: x.status, out: `${x.stdout}${x.stderr}` };
        }
    };
    return { vm, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Output lines with ANSI colour codes removed and trimmed. */
const lines = (out: string) =>
    out
        .split('\n')
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());

const HOST_ENV = {
    '.env': { content: 'POSTGRES_PASSWORD=x\n', mode: 0o600 },
    '.env.prod': { content: 'REDIS_PASSWORD=x\nDATA_ENCRYPTION_KEY=x\n', mode: 0o600 },
};

describe('apply.sh refuses the pipelock overlay without its own env file', () => {
    const OVERLAY_ENV = {
        COMPOSE_BASENAME: 'docker-compose.pipelock.yml',
        I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE: '1',
        APPLY_PUBLIC_LOG: '1',
    };
    const ENV_CHECK = 'checking the host env files carry the three interpolation variables (key names only)';

    it('refuses (exit 2) before reading any other env file when .env.pipelock is absent', () => {
        const vm = fakeVm(HOST_ENV);
        try {
            const r = vm.run('deploy/apply.sh', OVERLAY_ENV);
            expect(r.status).toBe(2);
            const out = lines(r.out);
            expect(out.filter((l) => l === `[apply] ERROR: refusing: ${vm.vm}/.env.pipelock does not exist on inflect-compliance.`)).toHaveLength(1);
            expect(out.filter((l) => l.endsWith(ENV_CHECK))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('passes the check, and goes on to the host env files, when .env.pipelock is present', () => {
        const vm = fakeVm({ ...HOST_ENV, '.env.pipelock': { content: 'X=1\n', mode: 0o600 } });
        try {
            const out = lines(vm.run('deploy/apply.sh', OVERLAY_ENV).out);
            const ok = out.findIndex((l) => /^\[apply\]\s+OK\s+\.env\.pipelock is present$/.test(l));
            const next = out.findIndex((l) => l.endsWith(ENV_CHECK));
            expect(ok).toBeGreaterThan(-1);
            expect(next).toBeGreaterThan(ok);
            expect(out.filter((l) => l.includes('refusing:'))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });

    it('asks nothing about .env.pipelock when the canonical file is applied', () => {
        const vm = fakeVm(HOST_ENV);
        try {
            const out = lines(vm.run('deploy/apply.sh', { APPLY_PUBLIC_LOG: '1' }).out);
            expect(out.filter((l) => l.includes('.env.pipelock'))).toEqual([]);
            expect(out.filter((l) => l.endsWith(ENV_CHECK))).toHaveLength(1);
        } finally {
            vm.cleanup();
        }
    });
});

describe('check-drift.sh: .env.pipelock is a secret by name, its template is public', () => {
    /** The paths check-drift lists under "CREDENTIAL readable beyond root". */
    function reportedCredentials(out: string[]): string[] {
        const start = out.findIndex((l) => l.startsWith('[drift] CREDENTIAL readable beyond root under '));
        if (start < 0) return [];
        const listed: string[] = [];
        for (let i = start + 1; i < out.length; i++) {
            const l = out[i].replace(/^\[drift\]\s*/, '');
            if (l === '') break;
            listed.push(path.basename(l));
        }
        return listed;
    }

    it('reports a world-readable .env.pipelock whose variable names look harmless, and neither public template', () => {
        const vm = fakeVm({
            // No PASSWORD/SECRET/_KEY/TOKEN name in it: the content test alone
            // scores this TIDY.
            '.env.pipelock': { content: 'UPSTREAM=http://app:3000/api/mcp\nBEARER=iflk_example\n', mode: 0o644 },
            '.env.pipelock.example': { content: read('deploy/.env.pipelock.example'), mode: 0o644 },
            '.env.prod.example': { content: read('deploy/.env.prod.example'), mode: 0o644 },
        });
        try {
            const r = vm.run('deploy/check-drift.sh', {});
            expect(r.status).toBe(1);
            expect(reportedCredentials(lines(r.out))).toEqual(['.env.pipelock']);
        } finally {
            vm.cleanup();
        }
    });

    it('reports nothing when .env.pipelock is root-only', () => {
        const vm = fakeVm({ '.env.pipelock': { content: 'BEARER=iflk_example\n', mode: 0o600 } });
        try {
            expect(reportedCredentials(lines(vm.run('deploy/check-drift.sh', {}).out))).toEqual([]);
        } finally {
            vm.cleanup();
        }
    });
});

describe('deploy/.env.prod.example holds only values the env schema accepts', () => {
    /** `KEY: z.enum([...])` declarations in src/env.ts, as key → allowed values. */
    const enums = new Map(
        Array.from(read('src/env.ts').matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*z\s*\.enum\(\[([^\]]*)\]\)/gm), (m) => [
            m[1],
            Array.from(m[2].matchAll(/["']([^"']*)["']/g), (v) => v[1]),
        ]),
    );
    const assignments = read('deploy/.env.prod.example')
        .split('\n')
        .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ key: m[1], value: m[2].trim() }));

    it('the schema read finds RATE_LIMIT_MODE among the enums (the check is not vacuous)', () => {
        expect(enums.get('RATE_LIMIT_MODE')?.sort()).toEqual(['memory', 'upstash']);
        expect(assignments.filter((a) => a.key === 'RATE_LIMIT_MODE')).toHaveLength(1);
    });

    it('every enum-typed variable the template sets is one of the schema\'s values', () => {
        const bad = assignments
            .filter((a) => enums.has(a.key) && !enums.get(a.key)!.includes(a.value))
            .map((a) => `${a.key}=${a.value}`);
        expect(bad).toEqual([]);
    });

    it('sets RATE_LIMIT_MODE=memory (owner decision, 2026-11-14)', () => {
        expect(assignments.filter((a) => a.key === 'RATE_LIMIT_MODE').map((a) => a.value)).toEqual(['memory']);
    });
});
