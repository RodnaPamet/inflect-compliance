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
const REPO_ROOT = path.resolve(__dirname, '../../..');

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

/**
 * Run with a working directory and REPO-RELATIVE paths — which is what the
 * scanner is actually given in production: `git diff --cached --name-only`
 * emits repo-relative paths, and lint-staged passes them through.
 *
 * The absolute-path form below is convenient for pattern cases and wrong for
 * path-skip cases, because a skip anchored at the repository root (#5631)
 * cannot match `/tmp/inflect-secret-scan-xxxx/...`.
 */
function runIn(cwd: string, ...files: string[]) {
    const result = spawnSync('bash', [SCRIPT, ...files], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
    });
    return {
        status: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

function runWithEnv(env: Readonly<Record<string, string>>, ...files: string[]) {
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

    it('skips the path-allowlisted fixture directory, at the repo root', () => {
        // Driven with cwd + a RELATIVE path, which is the shape the hook gets
        // from `git diff --cached --name-only`. It used to pass an absolute
        // tmpdir path and rely on the skip matching mid-path — the behaviour
        // #5631 removed, because that same mid-path match made `coverage/`
        // skip five source files.
        const dir = path.join(tmpDir, 'tests', 'fixtures', 'secrets');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'token.txt'),
            `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`,
        );
        const r = runIn(tmpDir, 'tests/fixtures/secrets/token.txt');
        expect(r.status).toBe(0);
    });

    it('does NOT skip a fixture directory of the same name nested deeper (#5631)', () => {
        // The anchoring property, from the side that matters: an exemption is
        // for ONE known location, not for every directory that happens to be
        // named like it. Without this the fix above is only a rename.
        const dir = path.join(tmpDir, 'src', 'feature', 'tests', 'fixtures', 'secrets');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'token.txt'),
            `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`,
        );
        const r = runIn(tmpDir, 'src/feature/tests/fixtures/secrets/token.txt');
        expect(r.status).toBe(1);
    });

    it('still skips a NESTED lockfile, which is any-depth by design (#5631)', () => {
        // The other half of the split: these names recur legitimately, so they
        // stay matched at any depth. `site/package-lock.json` is a real path.
        const dir = path.join(tmpDir, 'site');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'package-lock.json'),
            `{"token":"ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"}`,
        );
        const r = runIn(tmpDir, 'site/package-lock.json');
        expect(r.status).toBe(0);
    });

    it('gives the SAME verdict for an absolute path as for the repo-relative one', () => {
        // The two invocation shapes, which disagree in production: lint-staged's
        // `"*"` task passes ABSOLUTE paths, while the script's own listing
        // (`git diff --cached --name-only`) is relative. Anchoring the skips
        // (#5631) without normalising broke the absolute form, and the first
        // thing it stopped skipping was THIS file — the pre-commit hook flagged
        // its own deliberate fixtures and refused the commit. That is how it was
        // found, and this is the assertion that would have found it first.
        const rel = 'tests/unit/security/detect-secrets.test.ts';
        expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
        expect(runIn(REPO_ROOT, rel).status).toBe(0);
        expect(run(path.join(REPO_ROOT, rel)).status).toBe(0);
    });

    it('scans a source file under a directory named coverage — the #5631 defect', () => {
        const dir = path.join(tmpDir, 'src', 'app', 'coverage');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'route.ts'),
            `const T = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";`,
        );
        const r = runIn(tmpDir, 'src/app/coverage/route.ts');
        expect(r.status).toBe(1);
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
