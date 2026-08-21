/**
 * The repo's file population, as **git** defines it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Source-scanning guards walk the tree with `fs.readdirSync` and decide what
 * to skip from a hand-written array — usually `['node_modules', '.next']`.
 * That array is a hand-maintained denominator, and nothing checks it against
 * reality. It drifted:
 *
 *   - `.claude/` has been in `.gitignore` since the repo adopted Claude Code,
 *     and `.claude/worktrees/<id>/` holds a FULL checkout of the repo. A walk
 *     that does not skip it reads the guard's own copy of itself and reports
 *     it as a violation:
 *
 *         2 file(s) read the legacy prisma/schema.prisma path directly:
 *           - .claude/worktrees/<id>/tests/guardrails/prisma-schema-folder-coverage.test.ts
 *           - .claude/worktrees/<id>/tests/helpers/prisma-schema.ts
 *
 *     Both are copies of files that are fine in the real tree.
 *
 *   - CI has no worktrees, so the failure is GREEN there and red only for
 *     whoever uses them. That is the worst place for a failure to live: it
 *     costs a local hour and never appears where anyone would fix it.
 *
 *   - The lists also disagree with each other. Across the 212 tree-walking
 *     files under `tests/guards` + `tests/guardrails` there are five distinct
 *     skip-list shapes (none / `node_modules` / `node_modules,.next` /
 *     `node_modules,.next,dist` / `build`). Divergence is the tell: nobody is
 *     maintaining them, they are copy-paste sediment.
 *
 * Asking git removes the denominator entirely. `git ls-files -co
 * --exclude-standard` is exactly "every file git considers part of this
 * repo": tracked files PLUS untracked files that are not ignored. Ignored
 * trees — `node_modules/`, `.next/`, `.claude/`, `dist/`, `prisma/generated/`,
 * every future addition to `.gitignore` — fall out for free, and a brand-new
 * file a contributor has not `git add`-ed yet is still scanned, so a guard
 * cannot go green locally on work CI would fail.
 *
 * PRACTICALITY. Measured on this repo: 5,991 paths in 93 ms, once per Jest
 * worker process (the result is cached at module scope). A `fs` walk of the
 * same tree is not meaningfully cheaper — it has to stat every entry it then
 * throws away.
 *
 * FAILURE MODE ON PURPOSE. If git is unavailable, or the directory is not a
 * work tree, this THROWS rather than falling back to a hand-written skip
 * list. A silent fallback would restore the exact failure this module exists
 * to remove — a guard quietly scanning a different population than the one it
 * claims to. Every environment that runs these tests has git: CI uses
 * `actions/checkout`, which leaves a real work tree behind.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** Absolute path of the repo (or linked worktree) these tests belong to. */
export const REPO_ROOT = path.resolve(__dirname, '../..');

let cachedRelPaths: readonly string[] | null = null;

/**
 * Ask git for the file list of ONE work tree. Uncached, and parameterised on
 * `cwd` so the contract test can prove the ignore semantics against a
 * throwaway repo instead of planting files in this one — a transient file
 * inside the real tree is visible to every other suite running in parallel,
 * and shows up there as an ENOENT between "listed" and "read".
 */
export function listGitFiles(cwd: string): string[] {
    let stdout: string;
    try {
        stdout = execFileSync(
            'git',
            [
                'ls-files',
                '--cached', // tracked
                '--others', // …plus untracked
                '--exclude-standard', // …minus everything .gitignore excludes
                '-z',
            ],
            {
                cwd,
                encoding: 'utf-8',
                // The repo is ~6k paths (~250 KB of NUL-separated names); the
                // default 1 MB buffer is already enough, but a generated tree
                // could push past it and a truncated list is a silently
                // shrunken denominator — the thing this module exists to
                // prevent. Give it room it will never need.
                maxBuffer: 64 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
            `repo-files: could not ask git for the file list at ${cwd}.\n` +
                `${detail}\n\n` +
                'This helper deliberately has no fallback: a hand-written skip list is the ' +
                'failure it exists to remove. Run these tests from a real git work tree ' +
                '(CI uses actions/checkout, which leaves one).',
        );
    }

    return stdout.split('\0').filter(Boolean).sort();
}

/**
 * Repo-relative POSIX paths of every file git considers part of the repo.
 *
 * Tracked + untracked-but-not-ignored, i.e. what a `git status` would be
 * willing to talk about. Sorted, so callers that build error messages from
 * it get stable output.
 */
export function repoRelativeFiles(): readonly string[] {
    if (cachedRelPaths !== null) return cachedRelPaths;
    cachedRelPaths = listGitFiles(REPO_ROOT);
    return cachedRelPaths;
}

export interface RepoFilesOptions {
    /**
     * Restrict to one subtree, as a repo-relative path (`'src'`,
     * `'src/app/api'`). Matching is on path SEGMENTS, so `'src/app'` never
     * matches `src/app-layer/…`.
     */
    under?: string;
    /**
     * Restrict to these extensions, leading dot included (`['.ts', '.tsx']`).
     */
    extensions?: readonly string[];
}

/**
 * Absolute paths of the repo's files, optionally narrowed to a subtree
 * and/or a set of extensions.
 *
 * The replacement for a hand-rolled `walk(dir)` that skipped
 * `node_modules` / `.next`. Prefer this in any guard that scans source
 * text.
 */
export function repoFiles(opts: RepoFilesOptions = {}): string[] {
    const { under, extensions } = opts;
    const prefix = under ? under.replace(/\\/g, '/').replace(/\/+$/, '') + '/' : null;

    return repoRelativeFiles()
        .filter((rel) => (prefix === null ? true : rel.startsWith(prefix)))
        .filter((rel) =>
            extensions === undefined
                ? true
                : extensions.some((ext) => rel.endsWith(ext)),
        )
        .map((rel) => path.join(REPO_ROOT, rel));
}

/** Repo-relative POSIX form of an absolute path, for error messages. */
export function repoRelative(absPath: string): string {
    return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}
