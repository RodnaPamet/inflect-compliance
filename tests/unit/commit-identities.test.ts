/**
 * No commit may carry an email GitHub could credit to a stranger —
 * `scripts/lib/commit-identities.js` (the rule) and
 * `scripts/check-commit-identities.mjs` (the range check CI runs).
 *
 * RUN: npx jest tests/unit/commit-identities.test.ts
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
    classifyEmail,
    parseCoAuthors,
    findIdentityProblems,
    parseGitLog,
} = require('../../scripts/lib/commit-identities.js');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-commit-identities.mjs');

describe('classifyEmail', () => {
    it.each([
        // The addresses this repository's history actually carries.
        '36240848+h0mele55@users.noreply.github.com',
        '49699333+dependabot[bot]@users.noreply.github.com',
        'noreply@github.com',
        'noreply@anthropic.com',
        'semantic-release-bot@martynus.net',
        'someone@gmail.com',
        'first.last@sub.example.co.uk',
        'x@xn--80akhbyknj4f.xn--p1ai',
    ])('passes %s', (email) => {
        expect(classifyEmail(email)).toEqual({ ok: true });
    });

    it.each([
        // The two on main that credit a stranger, and the other placeholders found beside them.
        ['x@y', 'single-label'],
        ['user@users-Mac-mini.local', '.local'],
        ['user@192.168.1.13', 'IP address'],
        ['root@localhost', 'single-label'],
        ['me@host.localdomain', '.localdomain'],
        ['a@b.internal', '.internal'],
        ['a@box.lan', '.lan'],
        ['a@b.test', '.test'],
        ['a@b.invalid', '.invalid'],
        ['a@router.home.arpa', '.arpa'],
        ['user@example.com', 'documentation domain'],
        ['user@mail.example.org', 'documentation domain'],
        ['a@[::1]', 'IP address'],
        ['a@[10.0.0.1]', 'IP address'],
        ['', 'empty'],
        ['nobody', 'mailbox@domain'],
        ['@github.com', 'mailbox@domain'],
        ['user@', 'mailbox@domain'],
        ['a@b@c.com', 'more than one @'],
        ['a b@c.com', 'whitespace'],
        ['a@-bad-.com', 'not a valid DNS name'],
        ['a@b..com', 'not a valid DNS name'],
    ])('rejects %s', (email, reason) => {
        const v = classifyEmail(email);
        expect(v.ok).toBe(false);
        expect(v.reason).toContain(reason);
    });

    it('judges the domain case-insensitively and ignores a trailing root dot', () => {
        expect(classifyEmail('X@Y').ok).toBe(false);
        expect(classifyEmail('a@HOST.LOCAL').ok).toBe(false);
        expect(classifyEmail('a@github.com.')).toEqual({ ok: true });
    });
});

describe('parseCoAuthors', () => {
    it('reads every Co-authored-by trailer, in any case', () => {
        const msg = [
            'fix: something (#1)',
            '',
            'Body.',
            '',
            'Co-authored-by: h0mele55 <x@y>',
            'co-authored-by: Claude <noreply@anthropic.com>',
            'CO-AUTHORED-BY:   Spaced Name   <a@b.com>  ',
        ].join('\n');
        expect(parseCoAuthors(msg)).toEqual([
            { name: 'h0mele55', email: 'x@y' },
            { name: 'Claude', email: 'noreply@anthropic.com' },
            { name: 'Spaced Name', email: 'a@b.com' },
        ]);
    });

    it('returns nothing for a line GitHub cannot link (no <email>) or a mention mid-line', () => {
        expect(parseCoAuthors('Co-authored-by: x@y')).toEqual([]);
        expect(parseCoAuthors('see the Co-authored-by: A <a@b> trailer')).toEqual([]);
        expect(parseCoAuthors('')).toEqual([]);
    });
});

describe('findIdentityProblems', () => {
    const commit = (over: Record<string, string> = {}) => ({
        sha: 'b0a20c27b0000000000000000000000000000000',
        authorName: 'h0mele55',
        authorEmail: '36240848+h0mele55@users.noreply.github.com',
        committerName: 'GitHub',
        committerEmail: 'noreply@github.com',
        message: 'test(guardrails): contended JSON files (#3290) (#3294)\n',
        ...over,
    });

    it('finds nothing on a clean commit', () => {
        expect(findIdentityProblems([commit()])).toEqual([]);
    });

    it('reproduces the incident: a squash whose trailer is x@y', () => {
        const problems = findIdentityProblems([
            commit({ message: 'test(guardrails): contended JSON files (#3290) (#3294)\n\nCo-authored-by: h0mele55 <x@y>\n' }),
        ]);
        expect(problems).toEqual([
            expect.objectContaining({
                role: 'co-author',
                name: 'h0mele55',
                email: 'x@y',
                subject: 'test(guardrails): contended JSON files (#3290) (#3294)',
            }),
        ]);
    });

    it('checks the author and the committer as well as the trailers', () => {
        const problems = findIdentityProblems([
            commit({ authorEmail: 'user@users-Mac-mini.local', committerEmail: 'user@192.168.1.13' }),
        ]);
        expect(problems.map((p: { role: string }) => p.role)).toEqual(['author', 'committer']);
    });
});

describe('parseGitLog', () => {
    it('splits records and fields, keeping a multi-line body whole', () => {
        const raw =
            ['aaa', 'A', 'a@b.com', 'C', 'c@d.com', 'subject\n\nbody line\n'].join('\x1f') + '\x1e\n' +
            ['bbb', 'B', 'x@y', 'C', 'c@d.com', 'two\n'].join('\x1f') + '\x1e\n';
        expect(parseGitLog(raw)).toEqual([
            { sha: 'aaa', authorName: 'A', authorEmail: 'a@b.com', committerName: 'C', committerEmail: 'c@d.com', message: 'subject\n\nbody line\n' },
            { sha: 'bbb', authorName: 'B', authorEmail: 'x@y', committerName: 'C', committerEmail: 'c@d.com', message: 'two\n' },
        ]);
        expect(parseGitLog('')).toEqual([]);
    });
});

describe('check-commit-identities.mjs over a real repository', () => {
    let dir: string;

    const git = (args: string[], env: Record<string, string> = {}) => {
        const r = spawnSync('git', args, {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
        });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
    };
    const commitAs = (email: string, message: string) =>
        git(['commit', '--allow-empty', '-q', '-m', message], {
            GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: email,
        });
    /** Runs the check, returning its exit status, stdout and the job summary it wrote. */
    const run = (base: string, head: string) => {
        const summaryPath = path.join(dir, 'summary.md');
        const r = spawnSync(process.execPath, [SCRIPT, base, head], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
        });
        const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
        return { status: r.status, stdout: r.stdout, summary };
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-identities-'));
        git(['init', '-q', '-b', 'main']);
        // The base itself carries a bad identity: history before the range is
        // not this check's business, and must not fail it.
        commitAs('user@users-Mac-mini.local', 'base');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('passes a range whose identities are all claimable only by their owner', () => {
        const base = git(['rev-parse', 'HEAD']);
        commitAs('36240848+h0mele55@users.noreply.github.com', 'feat: one\n\nCo-authored-by: Claude <noreply@anthropic.com>');
        const r = run(base, 'HEAD');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('1 commit(s)');
        expect(r.summary).toContain('All identities on 1 commit(s) pass');
    });

    it('fails the range that would carry x@y onto main, and names the commit', () => {
        const base = git(['rev-parse', 'HEAD']);
        commitAs('dev@gmail.com', 'test: contended JSON files\n\nCo-authored-by: h0mele55 <x@y>');
        const r = run(base, 'HEAD');
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/::error title=Unclaimable co-author email::[0-9a-f]{9} "test: contended JSON files" — co-author h0mele55 <x@y>: .*single-label/);
        expect(r.summary).toContain('| co-author | h0mele55 <x@y> |');
    });

    it('fails on a placeholder author email, which squash-merge would turn into a trailer', () => {
        const base = git(['rev-parse', 'HEAD']);
        commitAs('user@192.168.1.13', 'chore: from a laptop');
        const r = run(base, 'HEAD');
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('Unclaimable author email');
        expect(r.stdout).toContain('Unclaimable committer email');
    });

    it('exits 2 on a range git cannot read, rather than passing it', () => {
        expect(run('0000000000000000000000000000000000000000', 'HEAD').status).toBe(2);
        expect(spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' }).status).toBe(2);
    });
});
