/**
 * A source scan's population must be the one **git** defines.
 *
 * THE BUG THIS COMES FROM
 * ───────────────────────
 * `tests/guardrails/prisma-schema-folder-coverage.test.ts` walked the repo
 * root with `fs.readdirSync` and skipped `['node_modules', '.next']`. It did
 * not skip `.claude/` (`.gitignore:136`), and `.claude/worktrees/<id>/` holds
 * a FULL checkout of the repo. With any worktree present the guard read the
 * worktree's copy of ITSELF and its own helper and reported them:
 *
 *     2 file(s) read the legacy prisma/schema.prisma path directly:
 *       - .claude/worktrees/<id>/tests/guardrails/prisma-schema-folder-coverage.test.ts
 *       - .claude/worktrees/<id>/tests/helpers/prisma-schema.ts
 *
 * CI has no worktrees, so it was green there and red only for whoever used
 * them — the worst place for a failure to live. It cost a local hour and
 * never appeared where anyone would fix it.
 *
 * THE CLASS
 * ─────────
 * A guard whose population is a hand-written skip list has that list as its
 * denominator, and nothing checks the list against reality. Across the 212
 * tree-walking files under `tests/guards` + `tests/guardrails` there are five
 * distinct skip-list shapes; the divergence is the tell that nobody maintains
 * them. `git ls-files --cached --others --exclude-standard` needs no list at
 * all — it IS the answer to "what is part of this repo", and it tracks
 * `.gitignore` for free.
 *
 * WHAT THIS FILE HOLDS
 * ────────────────────
 *   1. The behavioural contract of `tests/helpers/repo-files.ts`: an ignored
 *      file is excluded, an untracked-but-not-ignored file is included. Both
 *      halves are proved on a throwaway git repo built by the test, with the
 *      inclusions asserted alongside the exclusion so neither can pass
 *      because the command returned nothing.
 *   2. A structural ratchet: no guard hands the repo root to a directory
 *      read. The detector is mutation-proved in this same file against
 *      synthetic sources, so an empty result is evidence rather than silence.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { REPO_ROOT, listGitFiles, repoFiles, repoRelativeFiles } from '../helpers/repo-files';

describe('repo file population — what a source scan is allowed to see', () => {
    it('excludes what .gitignore excludes, and still sees an untracked file (proved on a throwaway repo)', () => {
        // A throwaway repo rather than plants inside THIS one, on purpose.
        // A transient file in the real tree is visible to every suite
        // running in parallel: the first draft of this test planted one at
        // the repo root and the prisma-schema guardrail — in a different
        // Jest worker — died with ENOENT between listing the file and
        // reading it. The property under test is about git's rules, not
        // about this repo, so it can be proved somewhere harmless.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-files-'));
        try {
            execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
            // Point `core.excludesFile` at an empty file. A local setting
            // overrides the global one, so a contributor whose personal
            // ignore file happens to list `*.ts` cannot turn this test's
            // controls into false negatives.
            fs.writeFileSync(path.join(tmp, 'empty-excludes'), '');
            execFileSync('git', ['config', 'core.excludesFile', path.join(tmp, 'empty-excludes')], {
                cwd: tmp,
                stdio: 'ignore',
            });
            fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored-tree/\n');

            fs.mkdirSync(path.join(tmp, 'ignored-tree', 'nested'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'ignored-tree', 'nested', 'copy.ts'), '// x\n');
            fs.mkdirSync(path.join(tmp, 'untracked-tree'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'untracked-tree', 'fresh.ts'), '// x\n');
            fs.writeFileSync(path.join(tmp, 'tracked.ts'), '// x\n');
            execFileSync('git', ['add', 'tracked.ts'], { cwd: tmp, stdio: 'ignore' });

            const listed = listGitFiles(tmp);

            // POSITIVE CONTROLS — both halves of the population are present,
            // so the exclusion asserted last means "git left it out", not
            // "the command returned nothing".
            expect(listed).toContain('tracked.ts');
            expect(listed).toContain('untracked-tree/fresh.ts');
            // …and the ignored tree is gone. This is the `.claude/worktrees/`
            // case in miniature: a gitignored directory holding a copy of
            // files the scan would otherwise report on.
            expect(listed).not.toContain('ignored-tree/nested/copy.ts');
            expect(listed.filter((f) => f.startsWith('ignored-tree/'))).toEqual([]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('is wired to THIS repo and yields no path under a directory git ignores', () => {
        // Cheap standing check over the whole list. `node_modules/` is the
        // one ignored tree guaranteed to exist while these tests run — if a
        // future change swapped `--exclude-standard` for a hand list, ~200k
        // paths would appear here.
        const leaked = repoRelativeFiles().filter(
            (rel) => rel.startsWith('node_modules/') || rel.startsWith('.claude/'),
        );
        expect(leaked).toEqual([]);
        // …and the list is not empty, so the assertion above is not vacuous.
        expect(repoRelativeFiles().length).toBeGreaterThan(1000);
    });

    it('narrows by subtree on path segments, not on a bare string prefix', () => {
        // `src/app` must not drag in `src/app-layer/`.
        const appLayer = repoFiles({ under: 'src/app', extensions: ['.ts'] }).filter(
            (abs) => abs.includes(`${path.sep}app-layer${path.sep}`),
        );
        expect(appLayer).toEqual([]);
        expect(repoFiles({ under: 'src/app-layer' }).length).toBeGreaterThan(0);
    });
});

// ─── Structural ratchet: nobody re-seeds a walk at the repo root ─────

/**
 * Identifiers that hold the repo root inside one source file: the local
 * `path.resolve(__dirname, '../..')` idiom, plus `REPO_ROOT` when it is
 * imported from the shared helper.
 */
export function repoRootBindings(src: string): string[] {
    const ids = new Set<string>();
    const localRoot =
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:resolve|join)\(\s*__dirname\s*,\s*(?:'\.\.\/\.\.'|"\.\.\/\.\."|'\.\.'\s*,\s*'\.\.'|"\.\."\s*,\s*"\.\.")\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = localRoot.exec(src)) !== null) ids.add(m[1]);
    if (/import\s*\{[^}]*\bREPO_ROOT\b[^}]*\}\s*from\s*['"][^'"]*repo-files['"]/.test(src)) {
        ids.add('REPO_ROOT');
    }
    // One level of aliasing (`const ROOT = REPO_ROOT;`) — enough to stop a
    // rename from blinding the check, without pretending to be a resolver.
    for (const id of [...ids]) {
        const alias = new RegExp(
            `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${id}\\s*;`,
            'g',
        );
        let a: RegExpExecArray | null;
        while ((a = alias.exec(src)) !== null) ids.add(a[1]);
    }
    return [...ids];
}

/** Keywords that look like a call but are not one. */
const NOT_A_CALL = new Set([
    'if', 'for', 'while', 'switch', 'return', 'typeof', 'await',
    'catch', 'expect', 'describe', 'it', 'test',
]);

/**
 * Report every place `file` hands the repo root to a directory read —
 * either straight to `readdirSync`, or to a locally-defined function (the
 * `walk(REPO_ROOT)` seed shape).
 *
 * Files that never call `readdirSync` are not walkers and are skipped, so
 * `path.join(REPO_ROOT, 'some/file')` stays legal.
 */
export function rootSeededWalks(rel: string, src: string): string[] {
    // A CALL, not a mention. `tests/helpers/repo-files.ts` — the fix for this
    // whole class — names `fs.readdirSync` in its header comment explaining
    // what it replaces, and an `includes('readdirSync')` gate flagged the
    // remedy as the disease. Requiring the open paren keeps the check on
    // code and off prose, and keeps this ratchet free of an allowlist.
    if (!/(?:^|[^\w.])(?:fs\.)?readdirSync\s*\(/m.test(src)) return [];
    const roots = repoRootBindings(src);
    if (roots.length === 0) return [];

    const hits: string[] = [];
    for (const root of roots) {
        if (new RegExp(`readdirSync\\(\\s*${root}\\b`).test(src)) {
            hits.push(`${rel} — readdirSync(${root})`);
        }
        const seed = new RegExp(
            `(?<![.\\w$])([A-Za-z_$][\\w$]*)\\(\\s*${root}\\s*\\)`,
            'g',
        );
        let m: RegExpExecArray | null;
        while ((m = seed.exec(src)) !== null) {
            const fn = m[1];
            if (NOT_A_CALL.has(fn) || roots.includes(fn)) continue;
            // Only a function DEFINED in this file — an imported helper that
            // takes the root (like `repoFiles`) is the fix, not the bug.
            if (!new RegExp(`(?:const|let|var|function)\\s+${fn}\\b`).test(src)) continue;
            hits.push(`${rel} — ${fn}(${root})`);
        }
    }
    return hits;
}

describe('no guard walks the repo root', () => {
    it('detects both shapes of the bug (mutation proof — the scan below is not blind)', () => {
        const direct = `
            import * as fs from 'fs';
            import * as path from 'path';
            const REPO = path.resolve(__dirname, '../..');
            for (const e of fs.readdirSync(REPO)) { void e; }
        `;
        const seeded = `
            import * as fs from 'fs';
            import * as path from 'path';
            const REPO_ROOT2 = path.resolve(__dirname, '../..');
            const walk = (dir: string) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(dir, e.name));
                }
            };
            walk(REPO_ROOT2);
        `;
        const aliased = `
            import * as path from 'path';
            import * as fs from 'fs';
            import { REPO_ROOT } from '../helpers/repo-files';
            const ROOT = REPO_ROOT;
            const walk = (dir: string) => { fs.readdirSync(dir); };
            walk(ROOT);
        `;
        const clean = `
            import * as fs from 'fs';
            import * as path from 'path';
            import { REPO_ROOT, repoFiles } from '../helpers/repo-files';
            const src = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
            const walk = (dir: string) => { fs.readdirSync(dir); };
            walk(path.join(REPO_ROOT, 'src'));
            void repoFiles({ under: 'src' });
            void src;
        `;

        // Prose about `fs.readdirSync` is not a walk — the helper that fixes
        // this class describes the pattern it replaces, and must not be
        // flagged for saying the word.
        const proseOnly = `
            import * as path from 'path';
            /** Guards walk the tree with \`fs.readdirSync\` and a skip list. */
            const REPO = path.resolve(__dirname, '../..');
            const listGitFiles = (cwd: string) => cwd;
            listGitFiles(REPO);
        `;

        expect(rootSeededWalks('synthetic-direct.ts', direct)).toHaveLength(1);
        expect(rootSeededWalks('synthetic-prose.ts', proseOnly)).toEqual([]);
        expect(rootSeededWalks('synthetic-seeded.ts', seeded)).toHaveLength(1);
        expect(rootSeededWalks('synthetic-aliased.ts', aliased)).not.toHaveLength(0);
        expect(rootSeededWalks('synthetic-clean.ts', clean)).toEqual([]);
    });

    it('no file under tests/ hands the repo root to a directory read', () => {
        // No allowlist, by design. An exempted entry would be the same
        // hand-maintained denominator this ratchet exists to remove — the fix
        // is `repoFiles()` from `tests/helpers/repo-files.ts`, which needs no
        // exemption.
        const hits: string[] = [];
        for (const abs of repoFiles({ under: 'tests', extensions: ['.ts', '.tsx'] })) {
            const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
            // Self-skip, not an exemption: the synthetic sources in the
            // mutation proof above are the very shapes this scan looks for,
            // and they live in this file's own text.
            if (rel === 'tests/guardrails/source-scan-population.test.ts') continue;
            hits.push(...rootSeededWalks(rel, fs.readFileSync(abs, 'utf-8')));
        }

        if (hits.length > 0) {
            throw new Error(
                `${hits.length} source scan(s) walk the repo root directly:\n` +
                    hits.map((h) => `  - ${h}`).join('\n') +
                    '\n\nThe repo root holds gitignored trees — `.claude/worktrees/<id>/` is a ' +
                    'FULL checkout of the repo, so a walk that reaches it scans a copy of the ' +
                    'repo and reports the copy. Use `repoFiles()` from ' +
                    '`tests/helpers/repo-files.ts`, whose population comes from git.',
            );
        }
    });
});
