/**
 * `.zap/assert-no-high-risk.mjs` — the HIGH+ gate that runs after every
 * OWASP ZAP scan (nightly baseline + weekly full).
 *
 * The load-bearing behaviour, and the reason this gate exists at all:
 * `.zap/rules.tsv` is a pluginId allowlist, and an `IGNORE` line silences
 * that rule at EVERY risk level. That is correct for the Medium-and-below
 * framework false-positives it was built for, and wrong for a High — one
 * line in a TSV would otherwise turn an injection finding green. So the
 * gate reads the report's `ignoredAlerts` as well as its live `alerts`.
 *
 * Driven through the real CLI (spawn + exit code), because the exit code
 * is what the workflow consumes.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../.zap/assert-no-high-risk.mjs');

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-high-gate-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ZapAlert {
    pluginid: string;
    alert: string;
    riskcode?: string;
    riskdesc?: string;
    instances?: { uri: string }[];
}

let seq = 0;
/** Write a ZAP-shaped report and run the gate over it. */
function runGate(site: { alerts?: ZapAlert[]; ignoredAlerts?: ZapAlert[] } | null) {
    const file = path.join(tmpDir, `report-${seq++}.json`);
    fs.writeFileSync(
        file,
        JSON.stringify({
            '@programName': 'ZAP',
            site: site ? [{ '@name': 'http://localhost:3006', ...site }] : [],
        }),
    );
    return runGateOnPath(file);
}

function runGateOnPath(file: string) {
    const res = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf-8' });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const medium: ZapAlert = {
    pluginid: '10055',
    alert: 'CSP: Wildcard Directive',
    riskcode: '2',
    riskdesc: 'Medium (High)',
};
const high: ZapAlert = {
    pluginid: '40018',
    alert: 'SQL Injection',
    riskcode: '3',
    riskdesc: 'High (Medium)',
    instances: [{ uri: 'http://localhost:3006/api/t/acme/risks' }],
};

describe('ZAP HIGH+ gate', () => {
    it('passes a report whose only alerts are Medium and below', () => {
        const { status, out } = runGate({ alerts: [], ignoredAlerts: [medium] });
        expect(status).toBe(0);
        // A pass says what it checked, so green is evidence the gate ran
        // rather than an ambiguous silence.
        expect(out).toContain('PASSED');
    });

    it('fails on a High alert and names it', () => {
        const { status, out } = runGate({ alerts: [high] });
        expect(status).toBe(1);
        expect(out).toContain('40018');
        expect(out).toContain('SQL Injection');
        expect(out).toContain('http://localhost:3006/api/t/acme/risks');
    });

    it('fails on a High that .zap/rules.tsv has ALLOWLISTED', () => {
        // The whole point: an IGNORE entry moves the alert into
        // `ignoredAlerts`, and that must NOT clear a High.
        const { status, out } = runGate({ alerts: [], ignoredAlerts: [high] });
        expect(status).toBe(1);
        expect(out).toContain('ALLOWLISTED');
    });

    it('classifies by riskdesc when riskcode is absent', () => {
        const { status } = runGate({
            alerts: [{ pluginid: '90019', alert: 'Server Side Code Injection', riskdesc: 'High (Medium)' }],
        });
        expect(status).toBe(1);
    });

    it('fails when the report is missing — an absent scan is not a clean scan', () => {
        const { status, out } = runGateOnPath(path.join(tmpDir, 'does-not-exist.json'));
        expect(status).toBe(1);
        expect(out).toContain('could not read');
    });

    it('fails when the report records no scanned site', () => {
        const { status, out } = runGate(null);
        expect(status).toBe(1);
        expect(out).toContain('no scanned site');
    });
});
