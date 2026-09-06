/**
 * Single-Prisma-major pin.
 *
 * The `claude/implement-login-O64VA` branch stranded on Prisma 5 while `main`
 * moved to Prisma 7 — a major skew that turned a stale branch into an
 * expensive, high-risk reconcile (see docs/branch-divergence-o64va-analysis.md).
 * This ratchet keeps the whole Prisma family on ONE major so a divergent line
 * can't silently pin a different one, and so an accidental caret-bump across a
 * major boundary fails CI at PR time instead of surfacing as runtime drift.
 *
 * Every `@prisma/*` package + the `prisma` CLI must resolve to `PINNED_MAJOR`.
 * Upgrading is a deliberate, documented act: bump `PINNED_MAJOR` here in the
 * SAME PR that bumps package.json, and follow docs/prisma-upgrade-path.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The one Prisma major the whole repo is on. Bump deliberately + document. */
const PINNED_MAJOR = 7;

/** Every Prisma-family package that must share the major. */
const PRISMA_PACKAGES = ['prisma', '@prisma/client', '@prisma/adapter-pg'] as const;

function readJson(rel: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
}

/** Parse the leading major out of a semver range (`^7.8.0`, `7.8.0`, `~7.1`). */
function majorOf(range: string): number | null {
    const m = range.match(/(\d+)\./);
    return m ? Number(m[1]) : null;
}

describe('Prisma major pin — one major across the repo', () => {
    const pkg = readJson('package.json') as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    it.each(PRISMA_PACKAGES)('%s is declared and pinned to major %s', (name) => {
        const range = deps[name];
        expect(range).toBeDefined();
        expect(majorOf(range!)).toBe(PINNED_MAJOR);
    });

    it('the whole Prisma family agrees on a single major (no split-major skew)', () => {
        const majors = PRISMA_PACKAGES
            .map((n) => deps[n])
            .filter(Boolean)
            .map((r) => majorOf(r!));
        // Every declared package resolves to the SAME major.
        expect(new Set(majors)).toEqual(new Set([PINNED_MAJOR]));
    });

    it('the installed prisma engine matches the pinned major (lockfile ↔ installed)', () => {
        // Resolve, rather than joining `node_modules` onto the repo root. The
        // join was a literal string concatenation with no upward walk, so in a
        // `.claude/worktrees/<id>/` checkout — which has no `node_modules` of
        // its own and resolves upward to the primary clone — it named a path
        // that never exists.
        //
        // That mattered MORE here than in the two sites that went red, because
        // this one went GREEN. The `existsSync` guard below it turned the
        // wrong path into a silent skip, so the only assertion in this file
        // that reads what is actually INSTALLED stopped running for every
        // worktree user while reporting a pass. A check that did not run looks
        // exactly like one that passed.
        //
        // The skip is kept — a fresh clone before `npm install` genuinely has
        // nothing to read — but it is now keyed on Node failing to resolve the
        // package, which is the real "not installed" condition, instead of on
        // a guessed directory being absent.
        let installedPath: string;
        try {
            installedPath = require.resolve('prisma/package.json', { paths: [REPO_ROOT] });
        } catch {
            return; // genuinely not installed (fresh clone, no `npm install`) — skip
        }
        const installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8')) as { version?: string };
        expect(installed.version).toBeDefined();
        expect(majorOf(installed.version!)).toBe(PINNED_MAJOR);
    });
});
