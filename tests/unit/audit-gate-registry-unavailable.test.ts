/**
 * An unreachable registry must never be read as "no advisories" (#2306).
 *
 * `npm audit` exits non-zero both when it finds advisories and when it cannot
 * reach the registry, and in the second case it writes an `{ "error": … }`
 * object to STDOUT — the same channel as a report, and valid JSON. The gate
 * used to parse that as a report, find zero advisories in it, and conclude that
 * every allowlist entry matched nothing:
 *
 *     STALE  GHSA-w3rx-r6r6-pgpr  image-size — no longer reported. Delete this entry…
 *
 * It failed closed, but by accident — the stale-entry check caught it, not any
 * check about the registry — and it told the reader to delete two HIGH-severity
 * exemptions that were entirely valid. Observed three times in CI on
 * 2026-09-04 (`npm error audit endpoint returned an error`).
 *
 * These tests drive the REAL script with a stub `npm` on PATH, because the
 * defect lived in how the script interprets npm's output, not in any function
 * it exports.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(REPO_ROOT, 'scripts', 'audit-gate.mjs');

/** The two advisories `security/audit-allowlist.json` exempts. */
const ALLOWLISTED = ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'] as const;

function reportWith(advisories: ReadonlyArray<{ id: string; pkg: string; severity: string }>) {
    // npm groups by PACKAGE, with one `via` entry per advisory — two advisories
    // against image-size share a single key. Building one entry per advisory
    // would silently drop all but the last, which is a fixture that disagrees
    // with the tool it stands in for.
    const vulnerabilities: Record<string, { name: string; severity: string; via: unknown[] }> = {};
    for (const a of advisories) {
        const entry = (vulnerabilities[a.pkg] ??= { name: a.pkg, severity: a.severity, via: [] });
        entry.via.push({
            source: entry.via.length + 1,
            severity: a.severity,
            title: 't',
            url: `https://github.com/advisories/${a.id}`,
        });
    }
    return JSON.stringify({ vulnerabilities, metadata: { vulnerabilities: { total: advisories.length } } });
}

/** Run the real gate with a stub `npm` that emits `script`. */
function runGate(script: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'auditgate-'));
    try {
        const npm = path.join(dir, 'npm');
        writeFileSync(npm, script);
        chmodSync(npm, 0o755);
        try {
            const out = execFileSync('node', [GATE], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                env: { ...process.env, ...extraEnv, PATH: `${dir}:${process.env.PATH ?? ''}` },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { code: 0, out };
        } catch (err) {
            const e = err as { status?: number; stdout?: string; stderr?: string };
            return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const emits = (body: string, exit = 1) => `#!/bin/sh\ncat <<'PAYLOAD'\n${body}\nPAYLOAD\nexit ${exit}\n`;

jest.setTimeout(120_000);

describe('audit gate: an unreachable registry is not a clean result', () => {
    it('fails, and blames the registry rather than the allowlist', () => {
        const { code, out } = runGate(emits('{ "error": { "code": "E503", "summary": "Service Unavailable" } }'));

        // Fail CLOSED — an audit that could not run is not a pass.
        expect(code).toBe(1);
        // ...and say why. The old message named the exemptions instead.
        expect(out).toContain('the audit could not be run');
        expect(out).not.toContain('STALE');
        // The instruction that made the old failure dangerous must not appear.
        expect(out).toContain('Do NOT edit security/audit-allowlist.json');
    });

    it('does not report a payload with no report keys as a clean audit', () => {
        // Not an `error` object either — just not a report. `vulnerabilities: {}`
        // is what a genuinely clean audit emits, so an ABSENT key is never clean.
        const { code, out } = runGate(emits('{ "audited": false }'));
        expect(code).toBe(1);
        expect(out).toContain('the audit could not be run');
        expect(out).not.toContain('STALE');
    });

    it('gives up within the job budget when npm hangs, instead of being cancelled', () => {
        // The first version of this fix retried three times with no per-attempt
        // bound. A failing `npm audit` does not fail fast — one took ~5 minutes
        // on CI — so the retries blew the `security` job's 12-minute budget and
        // the run was CANCELLED mid-retry. That is worse than the bug: a
        // cancelled job says "The operation was canceled" and nothing about the
        // registry.
        //
        // A stub that hangs stands in for that. The gate must kill it and
        // report, not wait.
        // The per-attempt bound is injectable purely so this runs in seconds; at
        // its real 180s it is the same code path.
        const started = Date.now();
        const { code, out } = runGate('#!/bin/sh\nsleep 600\n', { AUDIT_ATTEMPT_TIMEOUT_MS: '1500' });
        const elapsedMs = Date.now() - started;

        expect(code).toBe(1);
        expect(out).toContain('the audit could not be run');
        expect(out).toContain('timed out');
        // Two bounded attempts plus backoff — NOT two unbounded ones. The stub
        // sleeps for 10 minutes, so anything near that means nothing killed it.
        expect(elapsedMs).toBeLessThan(30_000);
    }, 60_000);

    it('retries, and passes once the registry answers', () => {
        // Errors on the first call, then returns a real report carrying both
        // allowlisted advisories. The gate must recover rather than fail on the
        // first miss. One failure, not two: the retry budget is deliberately
        // small (see AUDIT_ATTEMPTS) because a failing `npm audit` is slow and
        // the job it runs in is time-boxed.
        const counter = path.join(mkdtempSync(path.join(tmpdir(), 'auditcount-')), 'n');
        const report = reportWith(ALLOWLISTED.map((id) => ({ id, pkg: 'image-size', severity: 'high' })));
        const { code, out } = runGate(
            `#!/bin/sh\nn=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n` +
                `if [ $n -lt 2 ]; then echo '{ "error": { "code": "E503" } }'; exit 1; fi\n` +
                `cat <<'PAYLOAD'\n${report}\nPAYLOAD\nexit 1\n`,
        );

        expect(code).toBe(0);
        expect(out).toContain('PASSED');
    });
});

describe('audit gate: the checks that must NOT have been weakened', () => {
    it('still reports a genuinely stale exemption when the audit really ran', () => {
        // A real, clean report — `vulnerabilities: {}` present. Here the entries
        // genuinely match nothing and STALE is the correct diagnosis.
        const { code, out } = runGate(emits('{"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0}}}', 0));

        expect(code).toBe(1);
        expect(out).toContain('STALE');
        for (const id of ALLOWLISTED) expect(out).toContain(id);
    });

    it('still blocks an advisory nobody allowlisted', () => {
        const report = reportWith([
            ...ALLOWLISTED.map((id) => ({ id, pkg: 'image-size', severity: 'high' })),
            { id: 'GHSA-aaaa-bbbb-cccc', pkg: 'some-dep', severity: 'critical' },
        ]);
        const { code, out } = runGate(emits(report));

        expect(code).toBe(1);
        expect(out).toContain('UNLISTED');
        expect(out).toContain('GHSA-aaaa-bbbb-cccc');
    });
});
