/**
 * deploy/swap-app-service-account.sh proves the app came back, or says it did
 * not (#5308).
 *
 * The readiness step used to curl http://127.0.0.1:3000/api/readyz on the VM
 * HOST. The app container only `expose`s 3000 to the compose network
 * (deploy/docker-compose.prod.yml), so that probe could never succeed — and
 * when the loop ran out the script carried on and ended with "done" whatever
 * state the app was in. The step meant to prove production returned after the
 * VM stop/start proved nothing.
 *
 * Runs the real script with `gcloud`, `curl` and `sleep` stubbed on PATH. The
 * stub `gcloud` refuses a host-side curl to 127.0.0.1:3000 the way the real VM
 * does (connection refused), and succeeds at everything else.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../deploy/swap-app-service-account.sh');

interface Run {
    status: number | null;
    out: string;
    curlCalls: string[];
}

function run(appReady: boolean): Run {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-sa-'));
    const curlLog = path.join(bin, 'curl.log');
    try {
        const write = (name: string, body: string) => {
            const f = path.join(bin, name);
            fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
            fs.chmodSync(f, 0o755);
        };
        write('gcloud', 'case "$*" in *127.0.0.1:3000*) exit 7 ;; esac\nexit 0');
        write('curl', `echo "$*" >> ${JSON.stringify(curlLog)}\n[ "$APP_READY" = 1 ] && exit 0\nexit 22`);
        write('sleep', 'exit 0');
        const res = spawnSync('bash', [SCRIPT, '--apply'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                APP_READY: appReady ? '1' : '0',
            },
        });
        const curlCalls = fs.existsSync(curlLog)
            ? fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
            : [];
        return { status: res.status, out: `${res.stdout}${res.stderr}`, curlCalls };
    } finally {
        fs.rmSync(bin, { recursive: true, force: true });
    }
}

describe('swap-app-service-account.sh readiness', () => {
    it('exits non-zero with the rollback text when the app never answers', () => {
        const r = run(false);
        expect(r.status).not.toBe(0);
        expect(r.out).not.toContain('readyz answers');
        expect(r.out).not.toMatch(/^\s*done\./m);
        expect(r.out).toContain('--service-account=880736019978-compute@developer.gserviceaccount.com');
    });

    it('probes readyz through the published origin, and goes on once it answers', () => {
        const r = run(true);
        expect(r.status).toBe(0);
        expect(r.out).toContain('readyz answers');
        expect(r.curlCalls.length).toBeGreaterThan(0);
        expect(r.curlCalls[0]).toContain('https://app.inflect.bg/api/readyz');
    });
});
