/**
 * The committed prover boundary must cover every host the policy composes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A GUARD AND NOT JUST THE PROVER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `npm run openshell:prove` is the real check and it needs a 14 MB binary with
 * an embedded SMT solver, which is not vendored and not available in CI. So the
 * prover answers the hard question locally, and this answers the cheap one
 * everywhere: does the operator's boundary still mention everything the code
 * would ask for?
 *
 * That split is deliberate. If the boundary were generated from the policy, the
 * proof would be close to vacuous — a widened allowlist would widen the
 * boundary in the same commit and nothing could ever fail. The boundary is
 * hand-maintained so that widening access requires TWO edits, one of them to a
 * file whose only purpose is to be reviewed. This guard is what makes the
 * second edit mandatory rather than polite.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WILDCARD CARVE-OUT IS A FINDING, NOT AN EXEMPTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `*.amazonaws.com` is deliberately NOT in the boundary, because the prover
 * cannot decide a policy that mixes a wildcard with an exact host the wildcard
 * covers:
 *
 *     candidate policy has overlapping exact and wildcard endpoints with
 *     different implicit destination IP modes
 *
 * So AWS is unprovable as composed, and the carve-out records that rather than
 * hiding it. The list below is keyed on the host and carries the reason, in the
 * same shape as every other exempt map in this repository — and the test that
 * no entry is stale is what stops it outliving the problem.
 *
 * @module guards/openshell-prover-boundary-covers-the-policy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    COLLECTOR_RUN_AS_USER,
    COLLECTOR_SCRATCH_DIR,
    collectorSandboxPolicy,
} from '@/lib/agentic/openshell/collector-policy';

import { REPO_ROOT } from '../helpers/repo-files';

const BOUNDARY_PATH = 'deploy/openshell/prover-boundary.yaml';

/** One benchmark per provider — the same three `openshell:prove` runs. */
const BENCHMARKS = [
    'aws_compliance.benchmark.soc_2',
    'azure_compliance.benchmark.soc_2',
    'gcp_compliance.benchmark.cis_v300',
] as const;

/**
 * Hosts the boundary may omit, each with why the prover cannot take it.
 *
 * Adding an entry is a reviewed act: it says somebody established that the
 * prover genuinely cannot decide this host, not merely that the check was
 * inconvenient.
 */
const UNPROVABLE_HOSTS: Readonly<Record<string, string>> = {
    // EMPTY since #4569. `*.amazonaws.com` was the only entry, and the carve-out
    // outlived its reason: the AWS policy now names 135 explicit hosts and the
    // prover decides it — `within_boundary`, not `unsupported`. The assertion
    // below is what made that visible rather than leaving a note that reads as
    // still-current.
};

const boundaryText = (): string => fs.readFileSync(path.join(REPO_ROOT, BOUNDARY_PATH), 'utf8');

/** `- host: x` entries, which is the only shape the generated file writes. */
const boundaryHosts = (text: string): readonly string[] =>
    text
        .split('\n')
        .map((l) => /^\s*-\s*host:\s*(\S+)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]);

/** Every host the code would compose, across all three providers. */
const composedHosts = (): readonly string[] =>
    BENCHMARKS.flatMap((id) => collectorSandboxPolicy(id).networkPolicies.map((e) => e.host));

describe('the prover boundary covers the policy the code composes', () => {
    it('reads the boundary at all, and it is the version the prover takes', () => {
        // DENOMINATOR. Every assertion below is satisfied by an empty file or a
        // renamed path, and a boundary that silently became unreadable would
        // make this suite green while `openshell:prove` could not run.
        const text = boundaryText();
        expect(text.length).toBeGreaterThan(1000);
        const lines = text.split('\n').map((l) => l.trim());
        // `version: 1` and not 2. The gateway's schema is 2 and the prover
        // rejects it outright, so this single line is load-bearing.
        expect(lines.filter((l) => /^version:\s*1$/.test(l)).length).toBe(1);
        expect(lines.filter((l) => /^version:\s*2$/.test(l))).toEqual([]);
    });

    it('names every composed host, or records why the prover cannot take it', () => {
        const inBoundary = new Set(boundaryHosts(boundaryText()));
        const missing = composedHosts()
            .filter((h) => !inBoundary.has(h))
            .filter((h) => !(h in UNPROVABLE_HOSTS));
        expect(missing).toEqual([]);
    });

    it('finds a real population on both sides (neither scan is vacuous)', () => {
        // A regex that stopped matching would empty the boundary set and make
        // the assertion above pass by comparing nothing to nothing.
        expect(boundaryHosts(boundaryText()).length).toBeGreaterThanOrEqual(40);
        expect(composedHosts().length).toBeGreaterThanOrEqual(40);
    });

    it('carries no stale carve-out', () => {
        // The convention every exempt map here follows: an entry for a host the
        // code no longer composes fails, so a carve-out cannot outlive the
        // policy that needed it.
        const composed = new Set(composedHosts());
        const stale = Object.keys(UNPROVABLE_HOSTS).filter((h) => !composed.has(h));
        expect(stale).toEqual([]);
        // And an entry that is ALSO in the boundary excuses nothing.
        const inBoundary = new Set(boundaryHosts(boundaryText()));
        expect(Object.keys(UNPROVABLE_HOSTS).filter((h) => inBoundary.has(h))).toEqual([]);
    });

    it('every carve-out carries a real reason', () => {
        for (const [host, reason] of Object.entries(UNPROVABLE_HOSTS)) {
            expect(reason.trim().length).toBeGreaterThan(60);
            expect(`${host} ${reason}`).not.toMatch(/\bTODO\b/);
        }
    });

    it('the boundary still states the three limits that are not about hosts', () => {
        // Network coverage is the part that drifts, so it gets the list check
        // above. These three are the ones whose ABSENCE would quietly stop the
        // proof constraining anything: a boundary with no process, landlock or
        // filesystem section still answers `within_boundary` for a candidate
        // that has them.
        const text = boundaryText();
        const lines = text.split('\n').map((l) => l.trim());
        expect(lines.filter((l) => l === `run_as_user: '${COLLECTOR_RUN_AS_USER}'`).length).toBe(1);
        expect(lines.filter((l) => l === 'compatibility: hard_requirement').length).toBe(1);
        expect(lines.filter((l) => l === `- ${COLLECTOR_SCRATCH_DIR}`).length).toBe(1);
    });
});
