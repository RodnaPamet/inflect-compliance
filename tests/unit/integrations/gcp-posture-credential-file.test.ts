/**
 * The GCP posture provider's CREDENTIAL-FILE path —
 * `src/app-layer/integrations/providers/gcp-posture-provider.ts::runCheck`.
 *
 * Steampipe's GCP plugin reads `GOOGLE_APPLICATION_CREDENTIALS`, a FILE path,
 * so this is the one posture provider that has to materialise a secret on
 * disk. Every other suite injects the `exec` seam, which short-circuits the
 * whole branch — so the security properties of the only code path that ever
 * runs in production were untested:
 *
 *   • the key file is created mode 0600 inside a fresh mkdtemp directory
 *     (a predictable path or a group-readable mode is a local-privilege
 *     credential disclosure on a shared collector host);
 *   • the key travels to the child as a PATH in env, never as argv content;
 *   • the file is unlinked afterwards on EVERY exit, including when the
 *     collector fails — a leftover key survives the process;
 *   • the mkdtemp DIRECTORY is removed too, on every exit — unlinking only
 *     the file leaks one empty inode per scheduled run;
 *   • an unlink failure must not turn a completed check into a thrown error.
 *
 * Both `node:fs/promises` and `node:child_process` are mocked so no real file
 * is written and no real CLI is spawned.
 */
const mkdtempMock = jest.fn();
const writeFileMock = jest.fn();
const unlinkMock = jest.fn();
const rmMock = jest.fn();
jest.mock('node:fs/promises', () => ({
    mkdtemp: (...a: unknown[]) => mkdtempMock(...a),
    writeFile: (...a: unknown[]) => writeFileMock(...a),
    unlink: (...a: unknown[]) => unlinkMock(...a),
    rm: (...a: unknown[]) => rmMock(...a),
}));

const execFileMock = jest.fn();
jest.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { tmpdir } from 'node:os';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import type { CheckInput } from '@/app-layer/integrations/types';
import {
    powerpipeBenchmarkJson,
    powerpipeControl,
} from '../../helpers/powerpipe-benchmark-fixture';

type Cb = (err: unknown, stdout?: string, stderr?: string) => void;

const TMP_DIR = `${tmpdir()}/gcp-posture-testdir`;
const CRED_PATH = `${TMP_DIR}/sa.json`;

const SA_KEY = JSON.stringify({
    type: 'service_account',
    project_id: 'my-project',
    client_email: 'posture-reader@my-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIabcdef0123456789\n-----END PRIVATE KEY-----', // pragma: allowlist secret — synthetic PEM header, no key material
});

/** A passing control in the REAL wire shape, from the source-cited module. */
const OK_JSON = powerpipeBenchmarkJson('gcp_compliance.benchmark.soc_2', {
    controls: [powerpipeControl('gcp_compliance.control.iam_ok', 'ok', { title: 'IAM' })],
});

function cliResult(opts: { stdout?: string; stderr?: string; err?: unknown }) {
    execFileMock.mockImplementationOnce(
        (_file: string, _args: string[], _o: unknown, cb: Cb) => {
            cb(opts.err ?? null, opts.stdout, opts.stderr);
        },
    );
}

function checkInput(connectionConfig: Record<string, unknown>): CheckInput {
    return {
        automationKey: 'gcp-posture.soc2',
        parsed: { provider: 'gcp-posture', checkType: 'soc2', raw: 'gcp-posture.soc2' },
        tenantId: 'tenant-1',
        connectionConfig,
        triggeredBy: 'scheduled',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mkdtempMock.mockResolvedValue(TMP_DIR);
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
});

describe('GcpPostureProvider.runCheck — service-account key file', () => {
    it('writes the key to a FRESH temp directory, mode 0600', async () => {
        cliResult({ stdout: OK_JSON });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', projectId: 'my-project', serviceAccountJson: SA_KEY }),
        );

        expect(res.status).toBe('PASSED');
        // mkdtemp, not a fixed path: a predictable name is a symlink-swap
        // target on a shared collector host.
        expect(mkdtempMock).toHaveBeenCalledTimes(1);
        expect(mkdtempMock.mock.calls[0][0]).toBe(`${tmpdir()}/gcp-posture-`);
        // 0600 — owner-only. Group/other read is a credential disclosure.
        expect(writeFileMock).toHaveBeenCalledWith(CRED_PATH, SA_KEY, { mode: 0o600 });
    });

    it('hands the child a PATH in env — the key itself never touches argv', async () => {
        cliResult({ stdout: OK_JSON });

        await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', projectId: 'my-project', serviceAccountJson: SA_KEY }),
        );

        const [file, args, opts] = execFileMock.mock.calls[0];
        expect(file).toBe('powerpipe');
        expect(args).toEqual([
            'benchmark',
            'run',
            'gcp_compliance.benchmark.soc_2',
            '--output',
            'json',
        ]);
        expect(opts.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(CRED_PATH);
        expect(opts.env.CLOUDSDK_CORE_PROJECT).toBe('my-project');
        // argv is world-readable via /proc.
        expect(JSON.stringify(args)).not.toContain('PRIVATE KEY');
        expect(JSON.stringify(args)).not.toContain('service_account');
    });

    it('unlinks the key file after a successful run', async () => {
        cliResult({ stdout: OK_JSON });
        await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );
        expect(unlinkMock).toHaveBeenCalledWith(CRED_PATH);
    });

    it('unlinks the key file even when the collector exits non-zero', async () => {
        // The `finally` is the whole point: a failed run must not leave a
        // usable service-account key on the collector host.
        cliResult({ err: Object.assign(new Error('exited'), { code: 1 }), stderr: 'denied' });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector exited non-zero.');
        expect(unlinkMock).toHaveBeenCalledWith(CRED_PATH);
    });

    it('unlinks the key file even when the CLI is not installed', async () => {
        cliResult({ err: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(res.summary).toBe('Powerpipe CLI not installed on the collector host.');
        expect(unlinkMock).toHaveBeenCalledWith(CRED_PATH);
    });

    it('does not fail the check when the cleanup unlink rejects', async () => {
        // Best-effort cleanup: a stale-NFS / EPERM unlink must not convert a
        // completed collection into a thrown error the executor records as a
        // crash.
        cliResult({ stdout: OK_JSON });
        unlinkMock.mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

        await expect(
            new GcpPostureProvider().runCheck(
                checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
            ),
        ).resolves.toMatchObject({ status: 'PASSED' });
    });

    it('removes the mkdtemp DIRECTORY, not just the key file', async () => {
        // Only the file was ever unlinked, so every scheduled run left one
        // empty `gcp-posture-*` directory behind for the life of the
        // container — an unbounded inode leak on a cron path.
        cliResult({ stdout: OK_JSON });

        await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(rmMock).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
    });

    it('removes the directory even when the collector exits non-zero', async () => {
        cliResult({ err: Object.assign(new Error('exited'), { code: 1 }), stderr: 'denied' });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(res.status).toBe('ERROR');
        expect(rmMock).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
    });

    it('unlinks the key BEFORE removing the directory', async () => {
        // Order is the security property: if `rm` fails the secret must
        // already be gone, so the key's removal never depends on the
        // directory's. An `rm`-only cleanup would invert that.
        cliResult({ stdout: OK_JSON });
        const order: string[] = [];
        unlinkMock.mockImplementation(async () => { order.push('unlink'); });
        rmMock.mockImplementation(async () => { order.push('rm'); });

        await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(order).toEqual(['unlink', 'rm']);
    });

    it('does not fail the check when the directory removal rejects', async () => {
        cliResult({ stdout: OK_JSON });
        rmMock.mockRejectedValue(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));

        await expect(
            new GcpPostureProvider().runCheck(
                checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
            ),
        ).resolves.toMatchObject({ status: 'PASSED' });
    });

    it('scrubs the service-account key out of the surfaced stderr', async () => {
        cliResult({
            err: Object.assign(new Error('exited'), { code: 1 }),
            stderr: `auth failed with key ${SA_KEY}`,
        });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', serviceAccountJson: SA_KEY }),
        );

        expect(res.errorMessage).not.toContain('PRIVATE KEY');
        expect(res.errorMessage).not.toContain('gserviceaccount.com');
        expect(res.errorMessage).toContain('[REDACTED]');
    });

    it('writes NO credential file when the connection carries no key', async () => {
        // A key-less GCP connection (e.g. workload identity on the collector)
        // must not create — or try to unlink — a temp file.
        cliResult({ stdout: OK_JSON });

        const res = await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'soc2', projectId: 'my-project' }),
        );

        expect(res.status).toBe('PASSED');
        expect(mkdtempMock).not.toHaveBeenCalled();
        expect(writeFileMock).not.toHaveBeenCalled();
        expect(unlinkMock).not.toHaveBeenCalled();
        expect(rmMock).not.toHaveBeenCalled();
        expect(execFileMock.mock.calls[0][2].env).not.toHaveProperty(
            'GOOGLE_APPLICATION_CREDENTIALS',
        );
    });

    it('resolves the CIS benchmark from config on the real CLI path', async () => {
        cliResult({ stdout: OK_JSON });
        await new GcpPostureProvider().runCheck(
            checkInput({ benchmark: 'cis', serviceAccountJson: SA_KEY }),
        );
        expect(execFileMock.mock.calls[0][1][2]).toBe('gcp_compliance.benchmark.cis_v200');
    });
});
