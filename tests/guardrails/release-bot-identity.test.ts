/**
 * Structural ratchet — the release bot's push identity.
 *
 * THE FAILURE THIS PREVENTS
 * ------------------------
 * `@semantic-release/git` pushes the `chore(release)` commit directly
 * to `main`. `secrets.GITHUB_TOKEN` cannot do that once `main` carries
 * a ruleset with required status checks: the freshly-pushed release
 * commit has no passing checks yet, so the push is declined with
 * `GH006: Protected branch update failed`.
 *
 * It fails SILENTLY from the merge author's point of view — the PR
 * merged fine; it is the separate Release run that goes red. This repo
 * lost three merges to exactly that on 2026-06-29 before anyone
 * noticed. And the blast radius is larger than a stale version number:
 * `.releaserc.json` syncs `infra/helm/inflect/Chart.yaml` via
 * @semantic-release/exec, so once releases stop, the chart drifts and
 * tests/guards/helm-chart-foundation.test.ts fails on EVERY later PR.
 *
 * GitHub Actions is not an installable app and so cannot be named in a
 * ruleset's bypass list — the API rejects it with "Actor GitHub Actions
 * integration must be part of the ruleset source or owner
 * organization". A dedicated GitHub App can be, which is why the
 * release step mints an installation token.
 *
 * WHAT THIS GUARD LOCKS
 * ---------------------
 *   1. The app-token step exists, is gated on `vars.RELEASE_APP_ID`,
 *      and feeds the semantic-release step.
 *   2. The token expression keeps its fallback in ONE expression —
 *      splitting it across steps reintroduces the silent-freeze mode.
 *   3. The unconfigured case is annotated, not silent.
 *   4. The PREMISES stay true: @semantic-release/git still pushes to
 *      main, and the release commit message still carries `[skip ci]`.
 *      The second is load-bearing *because* of the identity switch —
 *      GITHUB_TOKEN pushes never trigger workflows, but an App token
 *      does, so `[skip ci]` is now the only thing stopping the release
 *      commit from kicking off a full CI + deploy cycle.
 *
 * If @semantic-release/git is ever dropped, the bypass requirement
 * evaporates and this guard should be deleted in the same diff — which
 * is why premise (4) is asserted rather than assumed.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const RELEASE_YML = path.join(ROOT, '.github/workflows/release.yml');
const RELEASERC = path.join(ROOT, '.releaserc.json');

const RELEASE = fs.readFileSync(RELEASE_YML, 'utf8');
const RELEASERC_RAW = fs.readFileSync(RELEASERC, 'utf8');
const RELEASERC_JSON = JSON.parse(RELEASERC_RAW) as {
    plugins: Array<string | [string, Record<string, unknown>]>;
};

/** Plugin name for an entry that may be a bare string or [name, config]. */
function pluginName(entry: string | [string, Record<string, unknown>]): string {
    return Array.isArray(entry) ? entry[0] : entry;
}

function pluginConfig(
    entry: string | [string, Record<string, unknown>],
): Record<string, unknown> {
    return Array.isArray(entry) ? entry[1] : {};
}

describe('release bot identity — the app token', () => {
    it('mints an installation token with actions/create-github-app-token', () => {
        expect(RELEASE).toMatch(/uses:\s*actions\/create-github-app-token@v\d/);
    });

    it('the token step is gated on RELEASE_APP_ID so an unconfigured repo still runs', () => {
        expect(RELEASE).toMatch(/if:\s*vars\.RELEASE_APP_ID\s*!=\s*''/);
    });

    it('the token step reads the private key from a secret, never a variable', () => {
        expect(RELEASE).toMatch(/private-key:\s*\$\{\{\s*secrets\.RELEASE_APP_PRIVATE_KEY\s*\}\}/);
        // A private key in `vars` would be world-readable to anyone with
        // repo read access. Never.
        expect(RELEASE).not.toMatch(/private-key:\s*\$\{\{\s*vars\./);
    });

    it('semantic-release consumes the app token, falling back in ONE expression', () => {
        // Both halves must live in the same `${{ }}`. Splitting them into
        // two steps (or two env keys chosen by an `if:`) is how this
        // silently regresses to GITHUB_TOKEN.
        expect(RELEASE).toMatch(
            /GITHUB_TOKEN:\s*\$\{\{\s*steps\.release-token\.outputs\.token\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/,
        );
    });

    it('the semantic-release step no longer takes a bare GITHUB_TOKEN', () => {
        expect(RELEASE).not.toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m);
    });

    it('the unconfigured case is annotated rather than silent', () => {
        expect(RELEASE).toMatch(/::warning/);
        expect(RELEASE).toMatch(/RELEASE_APP_ID is unset/);
    });

    it('checkout does not persist credentials (semantic-release supplies its own)', () => {
        expect(RELEASE).toMatch(/persist-credentials:\s*false/);
    });

    it('the docblock records WHY a dedicated identity is needed', () => {
        expect(RELEASE).toMatch(/GH006/);
    });
});

describe('release bot identity — the premises stay true', () => {
    it('@semantic-release/git is still configured (it is what pushes to main)', () => {
        // If this goes away, nothing pushes to main, the bypass is
        // unnecessary, and this whole guard should be deleted.
        const names = RELEASERC_JSON.plugins.map(pluginName);
        expect(names).toContain('@semantic-release/git');
    });

    it('the release commit message still carries [skip ci]', () => {
        // Load-bearing BECAUSE of the identity switch: a GITHUB_TOKEN
        // push never triggers workflows, but an App-token push does.
        // `[skip ci]` is now the only thing preventing the release
        // commit from starting a full CI + deploy cycle.
        const git = RELEASERC_JSON.plugins.find((p) => pluginName(p) === '@semantic-release/git');
        expect(git).toBeDefined();
        const message = pluginConfig(git!).message;
        expect(typeof message).toBe('string');
        expect(message as string).toContain('[skip ci]');
    });

    // REPLACED 2026-09-02 (#2226). This asserted the pushed assets still
    // include `infra/helm/inflect/Chart.yaml`, because a release that bumped
    // package.json without the chart left them out of step and failed every
    // subsequent PR at the helm-chart structural guard.
    //
    // Both sides of that premise are gone: `infra/helm/` described a
    // Kubernetes deployment that was never provisioned and was removed, and
    // so was the guard that went red. Keeping the assertion would have
    // required the release bot to commit a file that no longer exists.
    //
    // This guard is named "the premises stay true" and it did its job — the
    // asset list could not change silently. What replaces it is the invariant
    // that actually still holds: every asset named must be a file that
    // exists, which is the general form of the bug the old assertion caught
    // as a special case.
    it('every pushed asset is a file that exists', () => {
        const git = RELEASERC_JSON.plugins.find((p) => pluginName(p) === '@semantic-release/git');
        expect(git).toBeDefined();
        const assets = pluginConfig(git!).assets as string[] | undefined;
        expect(assets).toBeDefined();
        expect(assets!.length).toBeGreaterThan(0);
        for (const asset of assets!) {
            expect({ asset, exists: fs.existsSync(path.join(ROOT, asset)) })
                .toEqual({ asset, exists: true });
        }
    });

    // The paired half: nothing may run a prepare step against a path the
    // release does not carry. `@semantic-release/exec` ran
    // `scripts/sync-chart-version.mjs`, whose own comment says it exits
    // non-zero when its regex misses — so once the chart was deleted it would
    // have failed the PREPARE phase of every release, taking the pipeline
    // dark on the next push to main. CI would not have caught that: the diff
    // was green.
    it('no prepare step targets a script that no longer exists', () => {
        const exec = RELEASERC_JSON.plugins.filter((p) => pluginName(p) === '@semantic-release/exec');
        for (const e of exec) {
            const cmd = String(pluginConfig(e).prepareCmd ?? '');
            const script = /(?:^|\s)(scripts\/[\w./-]+)/.exec(cmd)?.[1];
            if (!script) continue;
            expect({ script, exists: fs.existsSync(path.join(ROOT, script)) })
                .toEqual({ script, exists: true });
        }
    });
});
