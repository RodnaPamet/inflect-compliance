/**
 * Deterministic-install ratchet.
 *
 * Locks in the strict, reproducible install model so a future "make
 * the build pass" shortcut cannot quietly reintroduce a
 * non-deterministic install:
 *
 *   1. Every install path (Dockerfile + CI workflows) uses `npm ci`,
 *      never `npm install`. `npm ci` installs EXACTLY the
 *      `package-lock.json` tree and fails fast if the lockfile is out
 *      of sync with `package.json`. `npm install` can mutate the
 *      lockfile and re-resolve semver ranges to fresh versions — so
 *      two CI runs of the same commit are no longer guaranteed
 *      identical, and a corrupt lockfile is silently "repaired"
 *      instead of surfaced.
 *
 *   2. `package.json` declares an `engines` policy (node + npm) so the
 *      supported runtime is explicit, not tribal knowledge.
 *
 *   3. The Node major version is pinned CONSISTENTLY across `.nvmrc`,
 *      `engines.node`, and every workflow's `node-version` — local,
 *      CI, and release environments all install on the same runtime.
 *
 * Companion ratchet: `no-legacy-peer-deps.test.ts` (strict peer
 * resolution). Together they make the whole install surface
 * trustworthy. See `docs/dependency-policy.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Dockerfile(s) + every CI workflow — the dependency-install surface. */
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

/**
 * Strip the comment portion of a line (a `#` at line-start or
 * preceded by whitespace — covers Dockerfile + YAML comments and
 * trailing `RUN ... # note` comments) so a prose mention of
 * `npm install` inside a comment is never mistaken for a command.
 */
const stripComment = (line: string) => line.replace(/(^|\s)#.*$/, '');

/** `npm install` and its aliases (`npm i`, `npm add`) — the verbs we ban. */
const NPM_INSTALL = /\bnpm\s+(install|i|add)\b/;

/**
 * The one legitimate exception: installing a GLOBAL CLI at an EXACT
 * pinned version, e.g. `npm install -g npm@12.0.1`.
 *
 * The rule above exists because `npm install` can mutate `package.json` /
 * `package-lock.json` and drift from the lockfile. A `-g` install cannot:
 * it writes outside the project entirely, touching no lockfile. And an
 * exact `name@x.y.z` pin is deterministic by construction — the property
 * this guard is protecting.
 *
 * The pin is required, not optional: `npm i -g npm@latest` still fails,
 * because that reintroduces exactly the non-determinism the rule bans.
 * (The runner stage upgrades the base image's bundled npm this way to
 * clear CVEs in its vendored `tar` / `brace-expansion`, which no
 * application dependency bump can reach.)
 */
const PINNED_GLOBAL_INSTALL =
    /\bnpm\s+(install|i|add)\s+(-g|--global)\s+[@\w./-]+@\d+\.\d+\.\d+\b/;

describe('deterministic install model', () => {
    it('every install path uses `npm ci`, never `npm install`', () => {
        const offenders: string[] = [];
        for (const rel of installPathFiles()) {
            read(rel)
                .split('\n')
                .forEach((line, i) => {
                    const code = stripComment(line);
                    if (NPM_INSTALL.test(code) && !PINNED_GLOBAL_INSTALL.test(code)) {
                        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
                    }
                });
        }
        expect(offenders).toEqual([]);
    });

    it('an UNPINNED global install is still rejected', () => {
        // The carve-out must not become a blanket escape hatch: only an
        // exact pin qualifies, because that is what makes it deterministic.
        expect(PINNED_GLOBAL_INSTALL.test('RUN npm install -g npm@latest')).toBe(false);
        expect(PINNED_GLOBAL_INSTALL.test('RUN npm i -g prisma')).toBe(false);
        expect(PINNED_GLOBAL_INSTALL.test('RUN npm install -g npm@12.0.1')).toBe(true);
        // …and a project-local install is never exempt, pinned or not.
        expect(PINNED_GLOBAL_INSTALL.test('RUN npm install prisma@7.8.0')).toBe(false);
    });

    it('the install surface actually invokes `npm ci` (guard is not vacuous)', () => {
        const usesCi = installPathFiles().some((rel) =>
            /\bnpm\s+ci\b/.test(read(rel)),
        );
        expect(usesCi).toBe(true);
    });

    it('package.json declares an engines policy (node + npm)', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.engines).toBeDefined();
        expect(typeof pkg.engines.node).toBe('string');
        expect(typeof pkg.engines.npm).toBe('string');
        // The supported runtime is Node 24 across all environments.
        // (Bumped from 22 → 24 in cleanup-5-node-24-bump to retire the
        // four npm-CLI-bundled CVEs that lived in `.trivyignore` —
        // picomatch DoS / method injection, brace-expansion DoS,
        // ip-address XSS. Node 24 ships an npm CLI whose transitive
        // lockfile carries the patched versions of all four.)
        expect(pkg.engines.node).toContain('24');
    });

    it('the Node version is pinned consistently (.nvmrc / engines / workflows)', () => {
        // .nvmrc is the source of truth for version-manager users.
        const nvmrc = read('.nvmrc').trim();
        const nvmMajor = nvmrc.split('.')[0];
        expect(nvmMajor).toBe('24');

        // engines.node must admit that major.
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.engines.node).toContain(nvmMajor);

        // Every workflow `node-version:` must agree — either the literal
        // major, or ci.yml's `${{ env.NODE_VERSION }}` indirection.
        const offenders: string[] = [];
        for (const rel of installPathFiles()) {
            if (!rel.startsWith('.github/workflows/')) continue;
            read(rel)
                .split('\n')
                .forEach((line, i) => {
                    const m = stripComment(line).match(
                        /\bnode-version:\s*(.+?)\s*$/,
                    );
                    if (!m) return;
                    // Value may be '22' / "22" or a GitHub Actions
                    // expression `${{ env.NODE_VERSION }}`.
                    const v = m[1].replace(/['"]/g, '');
                    const ok =
                        v.includes('NODE_VERSION') ||
                        v.split('.')[0] === nvmMajor;
                    if (!ok) offenders.push(`${rel}:${i + 1}  node-version: ${v}`);
                });
        }
        expect(offenders).toEqual([]);
    });
});
