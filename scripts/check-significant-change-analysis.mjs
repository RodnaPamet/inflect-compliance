#!/usr/bin/env node
/**
 * A SIGNIFICANT change carries its rollback plan and risk assessment (#4437).
 *
 * `docs/change-management-policy.md` classes a schema migration, a
 * security-affecting middleware change, a dependency major bump or a
 * cross-tenant backfill as SIGNIFICANT, and requires the PR description to
 * carry a rollback plan and a risk assessment. Until now enforcement was
 * human review, and the policy said why:
 *
 *   "it needs PR-metadata access that the current structural ratchets (file
 *    scanners) do not have, so it is intentionally not retrofitted here"
 *
 * True of the ratchets, and not of a workflow step — `branch-freshness.yml`
 * already reads `github.event.pull_request`. So this is the #4426 shape again:
 * the check a jest guard structurally cannot make, made from a step that is
 * not jest.
 *
 * WHAT IT REQUIRES, WHICH IS NOT WHAT THE POLICY'S FOLLOW-UP DESCRIBED. That
 * sentence imagined a gate on a missing `Sign-off:` line. The owner waiver of
 * 2026-08-18 then made `Sign-off:` optional for assistant-driven PRs while
 * keeping the analysis mandatory:
 *
 *   "The rollback plan and the risk assessment are still written into the PR —
 *    the waiver covers the wait for a countersignature, not the analysis"
 *
 * A gate on `Sign-off:` would therefore block the PRs the waiver exists to
 * unblock and leave the mandatory half unchecked. This requires the ANALYSIS
 * and never the countersignature.
 *
 * The case that produced it: #4436 shipped a migration with neither section
 * and nothing noticed. It was found by reading the policy against the diff
 * afterwards.
 *
 * Usage:
 *   node scripts/check-significant-change-analysis.mjs <body-file> <files-file> [--title "<pr title>"]
 *   node scripts/check-significant-change-analysis.mjs --self-test
 */
import { readFileSync } from 'node:fs';

/**
 * Paths whose change makes a PR SIGNIFICANT.
 *
 * `prisma/` and not `prisma/schema/`: the policy's follow-up sentence named
 * the narrower path, and #4436 touched only `prisma/migrations/` while being
 * squarely SIGNIFICANT by the policy's own table. A migration is the
 * irreversible case — the policy's doctrine is that migrations are
 * non-rollback — so the directory that holds them cannot be the one left out.
 */
const SIGNIFICANT_PATHS = [/^prisma\//, /^src\/middleware\.ts$/];

/** A `!`-bang conventional commit declares a breaking change. */
const BANG_TITLE = /^[a-z]+(\([^)]*\))?!:/;

export function isSignificant({ files, title }) {
    const byPath = (files ?? []).filter((f) => SIGNIFICANT_PATHS.some((re) => re.test(f)));
    const byTitle = BANG_TITLE.test(String(title ?? '').trim());
    return { significant: byPath.length > 0 || byTitle, byPath, byTitle };
}

/**
 * Headings, not bare words. `/rollback/i` would match "no rollback needed" in
 * passing prose, which is the failure mode this script exists to prevent —
 * a check that a mention satisfies is not a check (#4356).
 */
const ROLLBACK_HEADING = /^\s{0,3}#{1,6}\s*.*\brollback\s+plan\b/im;
const RISK_HEADING = /^\s{0,3}#{1,6}\s*.*\brisk\s+assessment\b/im;

export function missingSections(body) {
    const b = String(body ?? '');
    const missing = [];
    if (!ROLLBACK_HEADING.test(b)) missing.push('a "Rollback plan" heading');
    if (!RISK_HEADING.test(b)) missing.push('a "Risk assessment" heading');
    return missing;
}

if (process.argv.includes('--self-test')) {
    const T = [
        ['a migration is significant', isSignificant({ files: ['prisma/migrations/x/migration.sql'] }).significant, true],
        ['a schema edit is significant', isSignificant({ files: ['prisma/schema/agentic.prisma'] }).significant, true],
        ['middleware is significant', isSignificant({ files: ['src/middleware.ts'] }).significant, true],
        ['a bang title is significant', isSignificant({ files: ['README.md'], title: 'feat!: drop v1' }).significant, true],
        ['a scoped bang title too', isSignificant({ files: [], title: 'fix(api)!: rename' }).significant, true],
        // The discriminator. A classifier answering `true` for everything would
        // pass every row above and gate nothing it was not meant to.
        ['a doc change is NOT significant', isSignificant({ files: ['docs/x.md'], title: 'docs: tidy' }).significant, false],
        ['a test change is NOT significant', isSignificant({ files: ['tests/guards/x.test.ts'] }).significant, false],
        ['a plain feat is NOT significant', isSignificant({ files: ['src/app/page.tsx'], title: 'feat: add' }).significant, false],
        // `prisma/` must not be matched mid-path, or `docs/prisma/notes.md` gates.
        ['prisma under another dir is NOT significant', isSignificant({ files: ['docs/prisma/notes.md'] }).significant, false],

        ['both headings present → nothing missing', missingSections('## Rollback plan\nx\n## Risk assessment\ny').length, 0],
        ['heading at h3 counts', missingSections('### Risk assessment\n### Rollback plan').length, 0],
        ['a heading with a prefix counts', missingSections('## 1. Risk assessment\n## 2. Rollback plan').length, 0],
        ['only one heading → one missing', missingSections('## Rollback plan\nx').length, 1],
        ['neither → two missing', missingSections('just some prose').length, 2],
        // Prose mentions must NOT satisfy it: the #4356 defect, in a new place.
        ['a passing MENTION does not satisfy', missingSections('No rollback plan is needed and the risk assessment is trivial.').length, 2],
    ];
    const failed = T.filter(([, a, e]) => a !== e);
    for (const [l, a, e] of failed) console.error(`self-test FAILED: ${l} — expected ${e}, got ${a}`);
    console.log(`self-test: ${T.length - failed.length}/${T.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

const [bodyFile, filesFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const titleIx = process.argv.indexOf('--title');
const title = titleIx >= 0 ? process.argv[titleIx + 1] : '';

if (!bodyFile || !filesFile) {
    console.error('usage: check-significant-change-analysis.mjs <body-file> <files-file> [--title "<t>"]');
    process.exit(2);
}

// An unreadable input FAILS. A check that cannot read its subject has not
// passed — it has not run, and absence reads as success otherwise.
let body, files;
try {
    body = readFileSync(bodyFile, 'utf8');
    files = readFileSync(filesFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
} catch (err) {
    console.error(`::error title=Change-class gate could not run::${err.message}`);
    process.exit(1);
}

const { significant, byPath, byTitle } = isSignificant({ files, title });
console.log(`Changed files: ${files.length}`);
if (!significant) {
    console.log('Change class: STANDARD or below — no rollback analysis required by policy.');
    process.exit(0);
}

console.log('Change class: SIGNIFICANT');
if (byPath.length) console.log(`  by path: ${byPath.slice(0, 10).join(', ')}${byPath.length > 10 ? ` (+${byPath.length - 10})` : ''}`);
if (byTitle) console.log('  by title: a `!`-bang conventional commit declares a breaking change');

const missing = missingSections(body);
if (missing.length === 0) {
    console.log('OK: the description carries both a rollback plan and a risk assessment.');
    process.exit(0);
}

console.error(
    `::error title=SIGNIFICANT change without its analysis::This PR is SIGNIFICANT per ` +
        `docs/change-management-policy.md and its description is missing ${missing.join(' and ')}. ` +
        `Add them as headings. A \`Sign-off:\` line is NOT required — the 2026-08-18 owner waiver ` +
        `covers the wait for a countersignature, but not the analysis behind it. The policy's ` +
        `forward-fix doctrine is the shape for the rollback plan: migrations are non-rollback, so ` +
        `answer "if I revert the app image without reverting the migration, does the app still work?"`,
);
process.exit(1);
