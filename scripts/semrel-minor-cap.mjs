/**
 * semantic-release `analyzeCommits` plugin — minor-version cap wrapper.
 *
 * Delegates the normal conventional-commit release-type decision to
 * @semantic-release/commit-analyzer, then applies {@link capMinor} so
 * the minor component never rolls into four digits (the release that
 * would be `X.1000.0` becomes `(X+1).0.0` instead). See
 * scripts/lib/minor-cap.mjs for the full rationale and the COSMETIC-
 * major caveat.
 *
 * That rollover is the ONLY source of a major bump, and this file is
 * where that is guaranteed. `.releaserc.json` maps breaking changes to
 * `minor`, which is the declaration; the demotion below is the
 * enforcement, because the config CANNOT reach every path to a major.
 * commit-analyzer falls back to its own defaults whenever no custom
 * rule matches, and one of those defaults keys on a field no custom
 * rule mentions — see the comment on the demotion for the measured
 * bypass. So the invariant lives here, in one place, stated once.
 *
 * Wired as the SOLE `analyzeCommits` plugin in `.releaserc.json` — it
 * REPLACES the bare `@semantic-release/commit-analyzer` entry (whose
 * preset + releaseRules config it receives verbatim as `pluginConfig`
 * and forwards inward). Keeping it the only analyzeCommits provider
 * means there is a single release-type decision; there is no
 * max-merge across two analyzeCommits plugins to reason about.
 *
 * commit-analyzer is ESM-only (`"type": "module"`), so this wrapper is
 * `.mjs` and uses a static `import`.
 */
import { analyzeCommits as baseAnalyzeCommits } from '@semantic-release/commit-analyzer';
import { capMinor } from './lib/minor-cap.mjs';

/**
 * @param {object} pluginConfig commit-analyzer config (preset, releaseRules …)
 * @param {object} context semantic-release context (commits, lastRelease, logger …)
 * @returns {Promise<string|null>} release type, minor→major-promoted at the cap.
 */
export async function analyzeCommits(pluginConfig, context) {
    const rawType = await baseAnalyzeCommits(pluginConfig, context);
    const lastVersion = context?.lastRelease?.version ?? '';

    // BACKSTOP. The `breaking` rule in .releaserc.json is the declaration; this
    // is the enforcement, and it catches what the config provably cannot reach.
    //
    // commit-analyzer consults its DEFAULT rules whenever no CUSTOM rule matched
    // (index.js:57-66). Exactly two defaults yield `major`. Default rule 0,
    // {breaking:true}, is fully SHADOWED — the custom rule has the identical
    // predicate, so it always matches first and the defaults are never read.
    // Default rule 17 is NOT shadowed: lib/default-release-rules.js:24 is
    // {tag:'Breaking', release:'major'}, keyed on `commit.tag`, and no custom
    // rule mentions `tag`. conventional-commits-parser sets that field from an
    // ordinary body via `fieldPattern: /^-(.*?)-$/`, so
    //
    //     chore: tidy up\n\n-tag-\nBreaking
    //
    // matched nothing custom, fell through, and returned `major`. Measured
    // against the shipped config at 3.1.3: next version 4.0.0, odometer
    // bypassed. A future commit-analyzer release may add more such rules; this
    // demotion is an invariant rather than an enumeration of today's defaults.
    //
    // ORDER IS LOAD-BEARING: demote BEFORE capMinor, never after. capMinor
    // passes an existing `major` straight through, so demoting afterwards would
    // undo the odometer's own promotion — and semver.inc('3.999.4', 'minor') is
    // '3.1000.0', a four-digit minor. The cap would be defeated by its own guard.
    const demoted = rawType === 'major' ? 'minor' : rawType;
    if (demoted !== rawType) {
        context?.logger?.log?.(
            `minor-cap: demoting release type ${rawType}→${demoted} — the major is not ` +
                'commit-derived here. commit-analyzer reached one of its own default rules ' +
                "({tag:'Breaking'} is not shadowed by the `breaking` rule in .releaserc.json); " +
                'only the odometer below may roll the major.',
        );
    }

    const finalType = capMinor(demoted, lastVersion);

    if (finalType !== demoted) {
        context?.logger?.log?.(
            `minor-cap: promoting release type ${demoted}→${finalType} — ` +
                `last release ${lastVersion || '(none)'} would push the minor past 999, ` +
                'rolling the major instead. The major is an odometer digit here, not a ' +
                'compatibility claim: the rollover is what moved it, whether or not this ' +
                'release happens to contain a breaking change.',
        );
    }
    return finalType;
}
