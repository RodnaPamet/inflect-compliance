/**
 * Unit tests for `scripts/detect-secrets.sh` (Epic C.2).
 *
 * Drives the script as a subprocess with explicit file arguments —
 * exactly the lint-staged invocation shape — so the same code path
 * the pre-commit hook uses gets exercised here. Each case writes a
 * tiny fixture under a tmp dir, runs the script, and asserts on
 * exit-code + which pattern matched.
 *
 * Adding a new pattern? Add a positive case below, plus a negative
 * (false-positive) case for the most likely benign neighbour.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/detect-secrets.sh');

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflect-secret-scan-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(name: string, body: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, body);
    return p;
}

function run(...files: string[]) {
    return runWithEnv({}, ...files);
}

function runWithEnv(env: NodeJS.ProcessEnv, ...files: string[]) {
    const result = spawnSync('bash', [SCRIPT, ...files], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return {
        status: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

// ─── Negative cases ─────────────────────────────────────────────────

describe('detect-secrets — clean files', () => {
    it('exits 0 on benign source', () => {
        const f = fixture(
            'clean.ts',
            `const greeting = "hello world";
const cfg = { user: "alice", port: 5432 };`,
        );
        const r = run(f);
        expect(r.status).toBe(0);
    });

    it('exits 0 with no files (empty staged set)', () => {
        const r = run();
        expect(r.status).toBe(0);
    });
});

// ─── Positive cases (one per pattern class) ─────────────────────────

describe('detect-secrets — secret classes', () => {
    it('flags AWS access key IDs', () => {
        const f = fixture(
            'aws.ts',
            `const accessKey = "AKIAIOSFODNN7EXAMPLE";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/AWS Access Key ID/);
    });

    it('flags AWS named secret-key assignments', () => {
        const f = fixture(
            'aws.ts',
            `const aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/AWS Secret Access Key/);
    });

    it('flags GitHub tokens (classic)', () => {
        const f = fixture(
            'gh.ts',
            `const TOKEN = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/GitHub Token/);
    });

    it('flags Slack webhook URLs', () => {
        const f = fixture(
            'slack.ts',
            `const HOOK = "https://hooks.slack.com/services/T01234567/B98765432/abcdefghijklmnopqrstuvwx";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Slack Webhook URL/);
    });

    it('flags Anthropic API keys', () => {
        const f = fixture(
            'ant.ts',
            `const ANTHROPIC = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Anthropic API Key/);
        // Must NOT also fire OpenAI (regression — the OpenAI pattern
        // was previously permissive enough to swallow `sk-ant-…`).
        expect(r.stdout).not.toMatch(/OpenAI API Key/);
    });

    it('flags OpenAI proj keys but ignores Anthropic shapes', () => {
        const f = fixture(
            'openai.ts',
            `const k = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/OpenAI API Key/);
    });

    it('flags Google AIza-prefixed API keys', () => {
        // AIza + 35 additional chars (the documented Google API key shape).
        const f = fixture(
            'google.ts',
            `const KEY = "AIzaSyA0123456789ABCDEFGHIJKLMNOPQRSTUV";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Google API Key/);
    });

    it('flags Stripe live secret keys', () => {
        const f = fixture(
            'stripe.ts',
            `const STRIPE = "sk_live_51HabCdEfGhIjKlMnOpQrStUv";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Stripe Live Secret Key/);
    });

    it('flags PEM private keys', () => {
        const f = fixture(
            'pem.ts',
            "const PEM = `-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----`;",
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/PEM Private Key/);
    });

    it('flags hardcoded password assignments', () => {
        const f = fixture(
            'pw.ts',
            `const cfg = { password: "SuperSecretPassword12345!" };`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Hardcoded Password Assignment/);
    });

    it('flags JWT in-source literals', () => {
        // Three base64url segments, each ≥8 chars after the `eyJ` prefix.
        const f = fixture(
            'jwt.ts',
            `const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.QPxYzAbC123-_456";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/JWT/);
    });

    it('flags npm tokens', () => {
        const f = fixture(
            'npm.ts',
            `const NPM = "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aB";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/NPM Token/);
    });
});

// ─── Lengths are characters, not bytes ──────────────────────────────

// The CI guardrail (tests/guardrails/no-secrets.test.ts) reads the same
// patterns as JavaScript regexes, which count characters. Under a POSIX or C
// locale `grep -P` counts bytes, so a masked placeholder of eight '•' (three
// bytes each) read as 24 and cleared the 16-character floor: the hook refused
// what CI accepts, and blocked every merge of main that carried one.
describe('detect-secrets — lengths are characters, not bytes', () => {
    const POSIX = { LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' };

    it('passes a masked placeholder under a POSIX locale', () => {
        const f = fixture('masked.ts', `const cfg = { clientSecret: '••••••••' };`);
        const r = runWithEnv(POSIX, f);
        expect(r.status).toBe(0);
    });

    it('still flags a 16-character secret under a POSIX locale', () => {
        const f = fixture('ascii.ts', `const cfg = { clientSecret: 'abcdefghijklmnop' };`);
        const r = runWithEnv(POSIX, f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Hardcoded Password Assignment/);
    });

    it('still flags a non-ASCII secret of 16 characters or more', () => {
        const f = fixture('cyrillic.ts', `const cfg = { password: 'парола-парола-парола' };`);
        const r = runWithEnv(POSIX, f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/Hardcoded Password Assignment/);
    });
});

// ─── Allowlist + skip behaviour ─────────────────────────────────────

describe('detect-secrets — allowlist + path skips', () => {
    it('respects an inline `# pragma: allowlist secret` marker', () => {
        const f = fixture(
            'allow.ts',
            `const SAMPLE = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"; // pragma: allowlist secret`,
        );
        const r = run(f);
        expect(r.status).toBe(0);
    });

    it('skips path-allowlisted directories by name', () => {
        // Build the structure inside the temp dir so nothing else matches.
        const dir = path.join(tmpDir, 'tests', 'fixtures', 'secrets');
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'token.txt');
        fs.writeFileSync(
            f,
            `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`,
        );
        const r = run(f);
        // Path skip uses substring match on `tests/fixtures/secrets/`.
        expect(r.status).toBe(0);
    });

    it('produces actionable guidance when a real secret is found', () => {
        const f = fixture(
            'aws.ts',
            `const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        // The "How to proceed" footer must be present so a developer
        // who hits the hook for the first time can self-serve.
        expect(r.stdout).toMatch(/How to proceed/);
        expect(r.stdout).toMatch(/pragma: allowlist secret/);
        expect(r.stdout).toMatch(/git commit --no-verify/);
    });

    it('exits with the file:line so the developer knows where to look', () => {
        const f = fixture(
            'multi.ts',
            `const greeting = "hi";
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";`,
        );
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/multi\.ts:2/);
    });
});
