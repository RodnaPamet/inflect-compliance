#!/usr/bin/env node
/**
 * The APPROVAL-GATE PREFLIGHT — proof that the human decision actually exists.
 *
 * WHY THIS SCRIPT EXISTS AT ALL
 * ─────────────────────────────
 * `.github/workflows/ghcr-publish.yml` gates the `:latest` push — the tag
 * Watchtower polls every 60 seconds on the production VM — behind a job that
 * declares `environment: production-rollout`. That YAML line is the whole
 * mechanism, and on its own it is WORTHLESS:
 *
 *   · GitHub CREATES an environment the first time a workflow references one
 *     that does not exist, with ZERO protection rules;
 *   · a job whose environment has no protection rules does not wait for
 *     anybody — it starts immediately, exactly as if the line were absent;
 *   · a reviewer reading the diff sees `environment: production-rollout` and
 *     reasonably concludes a human is now in the path.
 *
 * So the gate lives in a REPOSITORY SETTING that no file in this repository
 * can create, and the workflow that depends on it cannot see it. That is the
 * failure shape #2246 is about: a change that looks like a gate and is one
 * only if somebody, elsewhere, clicked something. `docs/deploy-approval-gate.md`
 * writes the setting down; this script refuses to move the rolling tag until
 * the setting is observably there.
 *
 * WHAT IT CHECKS
 * ──────────────
 * The JSON body of `GET /repos/{owner}/{repo}/environments/{name}` must carry
 * a `protection_rules` entry of type `required_reviewers` with at least one
 * reviewer. Exit 0 if so, exit 1 otherwise.
 *
 * A `wait_timer` rule does NOT count and is rejected explicitly. A delay is
 * not a decision: it postpones an unreviewed image reaching production rather
 * than putting anyone in front of it, and an environment carrying only a wait
 * timer is the easiest way to end up believing you have an approval gate.
 *
 * THREE OUTCOMES, AND ONLY ONE OF THEM IS "CONFIGURED"
 * ────────────────────────────────────────────────────
 *   1. `required_reviewers` present with reviewers  → exit 0, the gate is real.
 *   2. `protection_rules` readable and it is NOT there → exit 1, the gate is
 *      provably absent. This job did not wait for a human, so the rolling tag
 *      must not move.
 *   3. The payload is missing, unreadable, or not the shape this understands
 *      → exit 1, UNKNOWN. A probe that failed is not a probe that passed, and
 *      it is certainly not evidence of a reviewer. Failing closed here costs
 *      a red job on `main` and leaves `:latest` where it was; failing open
 *      costs an unreviewed image on production within the minute.
 *
 * Every exit-1 path prints the remedy, because the person reading it is the
 * person who has to apply a setting in a web UI this process cannot reach.
 *
 * Run:  node scripts/assert-approval-gate.mjs <environment.json> <name>
 */

import { readFileSync } from 'node:fs';

/** The one protection rule that is a human decision. */
const REQUIRED_REVIEWERS = 'required_reviewers';
/** Explicitly NOT a substitute for one. */
const WAIT_TIMER = 'wait_timer';

const UNKNOWN_IS_NOT_CONFIGURED = [
    '',
    'A probe that could not complete is UNKNOWN, not "configured". This script',
    'refuses to move the rolling :latest tag on an unknown, because the failure',
    'directions are not symmetric: a red job here leaves production running the',
    'image it was already running, and Watchtower (60s poll) rolls nothing.',
];

function remedy(environmentName) {
    return [
        '',
        'Fix (a human must do this once, in the repository settings — no file in',
        'this repo can create it):',
        '',
        `  1. Settings → Environments → New environment → name it exactly "${environmentName}".`,
        '  2. Tick "Required reviewers" and add at least one person or team.',
        '  3. Save. Re-run this job (Actions → the failed run → Re-run failed jobs).',
        '',
        'The workflow job is also granted `actions: read`, which is what lets',
        'GITHUB_TOKEN read the environment back. If the API call itself is failing',
        'with 403/404 while the environment exists, check that permission first.',
        '',
        'Background: docs/deploy-approval-gate.md',
    ];
}

function fail(lines) {
    for (const line of lines) {
        process.stderr.write(`${line}\n`);
    }
    process.exit(1);
}

function main() {
    const payloadPath = process.argv[2];
    const environmentName = process.argv[3] ?? '(unnamed)';

    if (!payloadPath) {
        fail([
            '::error::assert-approval-gate: no payload path given.',
            'usage: node scripts/assert-approval-gate.mjs <environment.json> <environment-name>',
        ]);
    }

    let raw;
    try {
        raw = readFileSync(payloadPath, 'utf8');
    } catch (err) {
        fail([
            `::error::assert-approval-gate: cannot read ${payloadPath} (${err.message}).`,
            ...UNKNOWN_IS_NOT_CONFIGURED,
            ...remedy(environmentName),
        ]);
        return;
    }

    let env;
    try {
        env = JSON.parse(raw);
    } catch (err) {
        fail([
            `::error::assert-approval-gate: ${payloadPath} is not JSON (${err.message}).`,
            ...UNKNOWN_IS_NOT_CONFIGURED,
            ...remedy(environmentName),
        ]);
        return;
    }

    // `protection_rules: []` is a real answer — "this environment protects
    // nothing". A payload with no `protection_rules` key is NOT that answer;
    // it is a shape this script does not understand, and the two get
    // different messages even though both exit 1.
    const rules = env === null || typeof env !== 'object' ? undefined : env.protection_rules;
    if (!Array.isArray(rules)) {
        fail([
            `::error::assert-approval-gate: the payload for environment "${environmentName}" has no`,
            '`protection_rules` array, so whether a reviewer is required could not be determined.',
            ...UNKNOWN_IS_NOT_CONFIGURED,
            ...remedy(environmentName),
        ]);
        return;
    }

    const reviewerRules = rules.filter(
        (rule) => rule !== null && typeof rule === 'object' && rule.type === REQUIRED_REVIEWERS,
    );
    const reviewers = reviewerRules.flatMap((rule) =>
        Array.isArray(rule.reviewers) ? rule.reviewers : [],
    );

    if (reviewers.length === 0) {
        const kinds = rules
            .map((rule) => (rule !== null && typeof rule === 'object' ? String(rule.type) : '?'))
            .join(', ');
        const waitTimerOnly = rules.some(
            (rule) => rule !== null && typeof rule === 'object' && rule.type === WAIT_TIMER,
        );
        fail([
            `::error::the "${environmentName}" environment does not require a reviewer, so this job`,
            'did NOT wait for a human. Refusing to move the rolling :latest tag.',
            `  protection rules present: [${kinds || 'none'}]`,
            ...(waitTimerOnly
                ? [
                      '  a `wait_timer` is NOT an approval: it delays an unreviewed image reaching',
                      '  production, it does not put anyone in front of it.',
                  ]
                : []),
            ...(reviewerRules.length > 0
                ? ['  a `required_reviewers` rule is present but its reviewer list is EMPTY.']
                : []),
            ...remedy(environmentName),
        ]);
        return;
    }

    const who = reviewers
        .map((reviewer) => {
            const target = reviewer?.reviewer ?? {};
            return `${reviewer?.type ?? 'Reviewer'}: ${target.login ?? target.name ?? target.slug ?? '?'}`;
        })
        .join(', ');
    const selfReview = reviewerRules.some((rule) => rule.prevent_self_review === true);

    process.stdout.write(
        [
            `approval gate confirmed on environment "${environmentName}"`,
            `  required reviewers (${reviewers.length}): ${who}`,
            `  prevent_self_review: ${selfReview ? 'on' : 'off'}`,
            selfReview
                ? ''
                : '  note: self-review is permitted. On a one-maintainer repo that is still a\n' +
                  '        deliberate click, but it is not two pairs of eyes — see docs/deploy-approval-gate.md.',
            '',
        ]
            .filter((line) => line !== '')
            .join('\n') + '\n',
    );
}

main();
