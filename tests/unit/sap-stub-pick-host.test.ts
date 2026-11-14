/**
 * deploy/sap-stub/pick-host.sh names a remedy that works (#5308).
 *
 * With two RFC1918 interfaces and no host-only one, the script refuses to
 * pick. Its message used to say "pass --host explicitly", but nothing accepts
 * a --host flag: run-stub.sh reads HOST from the environment and
 * make-dev-cert.sh takes the address as its first argument. A developer who
 * followed the message ran pick-host.sh again and hit the same refusal.
 *
 * Runs the real script with a stub `ip` on PATH.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../deploy/sap-stub/pick-host.sh');

function runWithInterfaces(ipOutput: string): { status: number | null; stdout: string; stderr: string } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-host-'));
    try {
        const fakeIp = path.join(bin, 'ip');
        fs.writeFileSync(fakeIp, `#!/bin/sh\ncat <<'EOF'\n${ipOutput}\nEOF\n`);
        fs.chmodSync(fakeIp, 0o755);
        const res = spawnSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    } finally {
        fs.rmSync(bin, { recursive: true, force: true });
    }
}

// `ip -4 -o addr show scope global` lines: index, ifname, family, addr/len, ...
const TWO_LANS = [
    '2: enp0s31f6    inet 10.0.0.5/24 brd 10.0.0.255 scope global enp0s31f6',
    '3: wlp2s0    inet 192.168.1.20/24 brd 192.168.1.255 scope global wlp2s0',
].join('\n');

describe('pick-host.sh', () => {
    it('refuses to choose between two LAN addresses, naming the inputs that exist', () => {
        const res = runWithInterfaces(TWO_LANS);
        expect(res.status).toBe(1);
        expect(res.stdout).toBe('');
        expect(res.stderr).toContain('HOST=<address> ./run-stub.sh');
        expect(res.stderr).toContain('./make-dev-cert.sh <address>');
        expect(res.stderr).not.toContain('--host');
        expect(res.stderr).toContain('10.0.0.5');
        expect(res.stderr).toContain('192.168.1.20');
    });

    it('prints the single LAN address when there is only one', () => {
        const res = runWithInterfaces(TWO_LANS.split('\n')[0]);
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('10.0.0.5');
    });
});
