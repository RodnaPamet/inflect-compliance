/**
 * infra/scripts/pg-dump-to-s3.sh names its output for what it is (#5308).
 *
 * The script runs `pg_dump --format=custom`, which writes pg_dump's own
 * archive format (compressed internally) and is restored with `pg_restore`.
 * It named the file `.sql.gz`, so an operator handed one during a restore
 * would reach for `gunzip | psql`, which fails. The object key is what that
 * operator sees, so the key is what is checked.
 *
 * Runs the real script with `pg_dump`, `aws` and `gpg` stubbed on PATH.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../infra/scripts/pg-dump-to-s3.sh');

function run(extraEnv: Record<string, string>): { status: number | null; out: string; awsCalls: string[] } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dump-s3-'));
    const awsLog = path.join(bin, 'aws.log');
    try {
        const write = (name: string, body: string) => {
            const f = path.join(bin, name);
            fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
            fs.chmodSync(f, 0o755);
        };
        // pg_dump: 4 KiB to --file=<path>, or to stdout when there is none.
        write('pg_dump', [
            'out=""',
            'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}" ;; esac; done',
            'if [ -n "$out" ]; then head -c 4096 /dev/zero > "$out"; else head -c 4096 /dev/zero; fi',
        ].join('\n'));
        write('gpg', [
            'out=""; prev=""',
            'for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done',
            'cat > "$out"',
        ].join('\n'));
        write('aws', `echo "$*" >> ${JSON.stringify(awsLog)}\nexit 0`);
        const res = spawnSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                PG_HOST: '127.0.0.1',
                PG_USER: 'u',
                PG_PASSWORD: 'p', // pragma: allowlist secret
                S3_BUCKET: 'bucket',
                ...extraEnv,
            },
        });
        const awsCalls = fs.existsSync(awsLog)
            ? fs.readFileSync(awsLog, 'utf8').split('\n').filter(Boolean)
            : [];
        return { status: res.status, out: `${res.stdout}${res.stderr}`, awsCalls };
    } finally {
        fs.rmSync(bin, { recursive: true, force: true });
    }
}

const uploadOf = (calls: string[]) => calls.find((c) => c.startsWith('s3 cp ')) ?? '';

describe('pg-dump-to-s3.sh object naming', () => {
    it('names a custom-format dump .dump, never .sql.gz', () => {
        const r = run({});
        expect(r.status).toBe(0);
        const upload = uploadOf(r.awsCalls);
        expect(upload).toMatch(/\.dump s3:\/\/bucket\/pg-backups\/inflect_compliance\/\S+\.dump /);
        expect(upload).not.toContain('.sql');
        expect(upload).not.toContain('.gz');
    });

    it('appends .gpg when the dump is encrypted', () => {
        const r = run({ GPG_RECIPIENT: 'ops@example.com' });
        expect(r.status).toBe(0);
        const upload = uploadOf(r.awsCalls);
        expect(upload).toMatch(/\S+\.dump\.gpg s3:\/\/bucket\/\S+\.dump\.gpg /);
    });
});
