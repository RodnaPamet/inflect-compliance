/**
 * No `--legacy-peer-deps` ratchet.
 *
 * `--legacy-peer-deps` disables npm's peer-dependency validation —
 * it installs whatever and silently masks incompatible package
 * combinations. It had been on every install step (Dockerfile, CI
 * workflows), hiding three genuine peer mismatches accumulated
 * through the Next 14 -> 16 / React 18 -> 19 migrations:
 *
 *   - `@visx/*@3.x` peers `react ^16 || ^17 || ^18` (the repo runs
 *     react 19);
 *   - `eslint-config-next@16` peers `eslint >=9` (the repo was on
 *     eslint 8 — now bumped to 9);
 *   - `next-auth@4` peers `next ^12 || ^13 || ^14` and `nodemailer
 *     ^6` (the repo runs next 16 / nodemailer 8).
 *
 * All three are now resolved explicitly: eslint bumped to 9, and a
 * targeted `overrides` block in package.json pins the visx and
 * next-auth peers to the real tree. The blanket flag is gone, so
 * peer resolution is strict again — a NEW incompatible dependency
 * now fails the install instead of being silently absorbed.
 *
 * This ratchet fails CI if the flag re-enters any install path, so
 * a future "make the install pass" shortcut cannot quietly restore
 * the blanket bypass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Dockerfile(s), every CI workflow, and npm config — the install surface. */
function installPathFiles(): string[] {
    // Population from git, not from a `readdirSync` of the repo root.
    // The root holds gitignored trees — `.claude/worktrees/<id>/` is a
    // FULL checkout of the repo — and a walk that reaches into one scans
    // a copy of the repo instead of the repo. See
    // `tests/helpers/repo-files.ts`.
    return repoRelativeFiles().filter(
        (rel) =>
            /^Dockerfile[^/]*$/.test(rel) ||
            /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel),
    );
}

describe('no --legacy-peer-deps in install paths', () => {
    it('Dockerfiles and CI workflows never pass --legacy-peer-deps', () => {
        const offenders = installPathFiles().filter((rel) =>
            read(rel).includes('legacy-peer-deps'),
        );
        expect(offenders).toEqual([]);
    });

    it('no .npmrc silently re-enables legacy-peer-deps', () => {
        const npmrc = path.join(REPO_ROOT, '.npmrc');
        if (!fs.existsSync(npmrc)) return; // absent — strict is the npm default
        expect(fs.readFileSync(npmrc, 'utf8')).not.toMatch(
            /legacy-peer-deps\s*=\s*true/,
        );
    });

    it('the masked peer conflicts stay resolved via explicit overrides', () => {
        // If these are deleted, strict `npm install` ERESOLVE-fails in
        // CI — but the ratchet states the contract up front.
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.overrides).toBeDefined();
        expect(
            Object.keys(pkg.overrides).some((k) => k.startsWith('@visx/')),
        ).toBe(true);
        expect(pkg.overrides['next-auth']).toBeDefined();
    });
});
