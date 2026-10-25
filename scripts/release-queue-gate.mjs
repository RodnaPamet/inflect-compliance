#!/usr/bin/env node
/**
 * Decide whether this Release run cuts a release, and tell the workflow.
 *
 * Counts the coverage floors in the checked-out tree, reads the merge queue
 * for the branch, applies `decideRelease` from `./lib/release-queue-gate.js`
 * (which carries the measurements and the rule), and writes
 * `release=true|false` to `$GITHUB_OUTPUT`. The workflow skips semantic-release
 * only on an explicit `false`.
 *
 * It never fails the run. Anything that goes wrong is a warning and a
 * release, because a release held by a broken gate is a release nobody asked
 * to hold.
 *
 * Environment (all supplied by GitHub Actions):
 *   GITHUB_EVENT_NAME, GITHUB_EVENT_PATH  the trigger, and the pushed commits
 *   GITHUB_REPOSITORY, GITHUB_REF_NAME    which queue to read
 *   GITHUB_GRAPHQL_URL                    the API endpoint
 *   GH_TOKEN                              read access to the repository
 *
 * Usage: node scripts/release-queue-gate.mjs   (from the repository root)
 */
import fs from 'node:fs';

import floorsLib from './lib/coverage-floors.js';
import gate from './lib/release-queue-gate.js';

const { decideRelease } = gate;
const { FLOOR_KEYS, countCoverage, raisedFloors, readFloors } = floorsLib;

const READ_TIMEOUT_MS = 15_000;
const PAGE = 100;

/** @returns {Promise<{prNumbers: number[], total: number} | null>} null when unreadable. */
async function readMergeQueue() {
    const [owner, name] = (process.env.GITHUB_REPOSITORY ?? 'RodnaPamet/inflect-compliance').split('/');
    const branch = process.env.GITHUB_REF_NAME || 'main';
    const query = `
      query($owner:String!, $name:String!, $branch:String!) {
        repository(owner:$owner, name:$name) {
          mergeQueue(branch:$branch) {
            entries(first:${PAGE}) { totalCount nodes { pullRequest { number } } }
          }
        }
      }`;
    try {
        const res = await fetch(process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${process.env.GH_TOKEN ?? ''}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ query, variables: { owner, name, branch } }),
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body.errors) return null;
        const entries = body?.data?.repository?.mergeQueue?.entries;
        if (!entries || !Array.isArray(entries.nodes) || typeof entries.totalCount !== 'number') return null;
        const prNumbers = entries.nodes.map((n) => n?.pullRequest?.number);
        // An entry we cannot name is still an entry; refuse to read it as absent.
        if (prNumbers.some((n) => typeof n !== 'number')) return null;
        return { prNumbers, total: entries.totalCount };
    } catch {
        return null;
    }
}

/** Each floor a release would raise in the tree at `root`, or null when they cannot be counted. */
function floorsBehind(root) {
    try {
        const floors = readFloors(root);
        const next = raisedFloors(floors, countCoverage(root));
        return FLOOR_KEYS.filter((k) => next[k] !== floors[k]);
    } catch {
        return null;
    }
}

function pushedCommitMessages() {
    try {
        const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
        return Array.isArray(event.commits) ? event.commits.map((c) => String(c?.message ?? '')) : [];
    } catch {
        return [];
    }
}

function report(release, reason) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `### ${release ? 'Releasing' : 'Release held'}\n\n${reason}\n\n`,
        );
    }
    console.log(`[release-queue-gate] release=${release}: ${reason}`);
}

try {
    const eventName = process.env.GITHUB_EVENT_NAME || 'push';
    const behind = eventName === 'push' ? floorsBehind(process.cwd()) : [];
    const queue = eventName === 'push' ? await readMergeQueue() : null;
    const decision = decideRelease({
        eventName,
        queue,
        pushedCommitMessages: pushedCommitMessages(),
        floorsBehind: behind,
    });
    if (behind === null) {
        console.log('::warning title=Coverage floors uncountable::The release gate could not count the coverage floors, so this push releases without waiting for the merge queue.');
    }
    if (eventName === 'push' && queue === null) {
        console.log('::warning title=Merge queue unreadable::The release gate could not read the merge queue, so this push releases without waiting for it.');
    }
    report(decision.release, decision.reason);
} catch (err) {
    console.log(`::warning title=Release gate failed::${err instanceof Error ? err.message : String(err)}`);
    report(true, 'the gate failed, so this run releases, as every push did before the gate');
}
