/**
 * GAP-05 — Structural ratchet for CI security gate strictness.
 * (Tightened 2026-05-12: high+ → moderate+.)
 *
 * The audit's GAP-05 finding noted that npm audit and Trivy gates
 * had been lowered (high → critical, CRITICAL,HIGH → CRITICAL) as a
 * temporary workaround to unblock CI while the Next.js 14 line
 * carried unfixable HIGH advisories. The Next 14 → 15.5 migration
 * cleared those advisories; the migration commit restored both gates
 * to their original strictness.
 *
 * 2026-05-12 the npm-audit gate was raised one further notch from
 * `--audit-level=high` to `--audit-level=moderate`. Moderate-severity
 * CVEs in production deps (postcss XSS, hono middleware bypass,
 * protobufjs decoding bugs) are the exact failure mode this gate
 * exists to prevent.
 *
 * This guardrail asserts the gates STAY restored AND ratchets only
 * in the strictness direction:
 *
 *   • npm audit production-deps gate is `moderate` OR `low` (or
 *     `info` — anything tighter than `high`). The regression class
 *     this catches: a future PR dropping back to `high`, `critical`,
 *     or removing the gate entirely.
 *
 *   • Trivy gate declares CRITICAL,HIGH (or tighter). A future PR
 *     that downgrades to `CRITICAL` alone reintroduces the
 *     lowered-gate posture GAP-05 closed.
 *
 * A written rationale + an upgrade plan tied to a specific advisory
 * must accompany any future lowering, NOT a workaround.
 */

import * as fs from 'fs';
import * as path from 'path';

import { braceBlockAfter, codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('GAP-05 ratchet — CI security gate strictness', () => {
    const ci = readRepoFile('.github/workflows/ci.yml');
    /**
     * The SECOND file carrying a blocking Trivy image gate, added 2026-09-13.
     *
     * `.github/workflows/ghcr-publish.yml` pushes `:latest` to GHCR for
     * Watchtower to roll into production, and until that date it scanned
     * nothing at all. It now carries its own gate, so the path that publishes
     * the image is the path that scans it — and this file had to learn about
     * it deliberately, because a second gate that nothing pins is a second
     * gate that can be quietly lowered, and the one sitting in front of
     * production is the worse of the two to lose.
     *
     * WHAT THIS FILE DOES NOT SEE, and where that lives instead. These are
     * TEXT assertions over the whole file: they pin the severity set and
     * `exit-code`, and nothing else. An adversarial review applied three
     * weakenings to the shipped `ghcr-publish.yml` — `continue-on-error: true`
     * on the gate, an `if:` on the gate, and re-pointing `image-ref` at the
     * previously published `ghcr.io/...:latest` — and measured 20 passed / 20
     * total on each. Every one leaves this file's needles satisfied while the
     * gate stops gating. They are pinned by
     * `tests/guardrails/publish-scans-before-push.test.ts`, which parses the
     * YAML rather than matching it, so do not read a green run here as "the
     * publish gate is intact".
     *
     * Read as its own binding rather than folded into an `it.each` over both
     * paths, and that is not a style choice. A parameterised
     * `readRepoFile(rel)` is a read the Class D analyser
     * (`tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts`) cannot
     * resolve, so the ci.yml severity assertion below — whose needle has TWO
     * satisfying positions in ci.yml and is therefore a COUNTED ambiguous
     * site — silently left the counted population for the skip bucket. With
     * DRIFT_ALLOWANCE at 0 that reads as unspent slack and fails the ratchet.
     * Two literal reads keep the existing site analysed and add none: each
     * needle below occurs exactly once in ghcr-publish.yml.
     *
     * The ORDER of that workflow's steps — scan before push, which is what
     * makes its gate a gate at all — is a different property and lives in
     * `tests/guardrails/publish-scans-before-push.test.ts`.
     */
    const publish = readRepoFile('.github/workflows/ghcr-publish.yml');

    it('npm audit gate blocks on MODERATE+ severity (production deps)', () => {
        // 2026-08-08: the gate moved from a bare `npm audit` line in the
        // workflow to `scripts/audit-gate.mjs`, which runs the same audit
        // and subtracts advisories with no fixed version (recorded in
        // security/audit-allowlist.json).
        //
        // That move broke what this test could honestly assert. The
        // workflow still CONTAINS the string
        // `npm audit --omit=dev --audit-level=moderate` — but only inside
        // the comment explaining the step. Matching the YAML would have
        // gone green against prose while the real gate lived elsewhere,
        // which is the precise failure this file exists to prevent. So
        // assert against the SCRIPT that actually runs.
        expect(ci).toMatch(/run: node scripts\/audit-gate\.mjs/);

        const gate = codeOf(readRepoFile('scripts/audit-gate.mjs'));
        // The blocking set is the severity floor. `moderate` present ⇒ the
        // gate is at least as strict as it was; dropping it would let
        // moderate findings through, which is the 2026-05-12 regression.
        expect(gate).toMatch(/BLOCKING\s*=\s*new Set\(\[[^\]]*'moderate'[^\]]*\]\)/);
        expect(gate).toMatch(/'high'/);
        expect(gate).toMatch(/'critical'/);
        // It audits the PRODUCTION tree, not the whole tree.
        expect(gate).toMatch(/'--omit=dev'/);
        // And it must still be capable of failing ON FINDINGS: a wrapper that
        // only ever logs would satisfy every assertion above.
        //
        // Bound to the findings branch, not to the file. The script has a
        // SECOND `process.exit(1)` — the registry-unavailable path added for
        // #2306 — and a whole-file needle would be satisfied by that one alone,
        // so the exit that actually blocks a vulnerable dependency could be
        // deleted with this assertion still green.
        expect(braceBlockAfter(gate, String.raw`if \(failures\.length > 0\)`)).toMatch(/process\.exit\(1\)/);

        // The all-deps informational scan (without `--omit=dev`)
        // legitimately stays at `critical` to limit dev-only noise — it is
        // not an audit-blocker, so it is untouched by the rules above.
        expect(ci).not.toMatch(/npm audit --omit=dev --audit-level=high\b/);
        expect(ci).not.toMatch(/npm audit --omit=dev --audit-level=critical\b/);
    });

    it('every audit exemption carries a reason, reachability and a live review date', () => {
        // An exemption without an expiry is a permanent hole with extra
        // steps. The gate script enforces this at run time; this asserts
        // the file is well-formed even when the advisory has been fixed
        // upstream and the script no longer reaches that branch.
        const raw = readRepoFile('security/audit-allowlist.json');
        const list = JSON.parse(raw) as {
            allow: Array<Record<string, string>>;
        };
        const today = new Date().toISOString().slice(0, 10);
        const bad: string[] = [];
        for (const e of list.allow ?? []) {
            if (!e.advisory) bad.push('entry with no advisory id');
            if ((e.reason ?? '').length < 40) bad.push(`${e.advisory}: reason too thin`);
            if ((e.reachability ?? '').length < 40) bad.push(`${e.advisory}: no reachability assessment`);
            if (!e.upgradePlan) bad.push(`${e.advisory}: no upgrade plan`);
            if (!e.reviewBy) bad.push(`${e.advisory}: no reviewBy`);
            else if (e.reviewBy < today) bad.push(`${e.advisory}: reviewBy ${e.reviewBy} has passed`);
        }
        expect(bad).toEqual([]);
    });

    it('Trivy scan gate blocks on CRITICAL,HIGH, not CRITICAL-only', () => {
        // The Trivy gate must declare both severities. Match the
        // YAML key on its own line so the SARIF-upload step (which
        // legitimately scans all severities) doesn't accidentally
        // pass this assertion.
        expect(ci).toMatch(/severity:\s*["']CRITICAL,HIGH["']/);
        // Regression: a future PR that downgrades to severity:
        // "CRITICAL" alone reintroduces the lowered-gate posture
        // GAP-05 closed.
        // We allow `severity: "CRITICAL,HIGH,MEDIUM"` (the SARIF
        // upload uses this) but NOT `severity: "CRITICAL"` alone.
        const lines = ci.split('\n');
        const blockingGate = lines.find(
            l => l.match(/severity:/) && l.match(/\bCRITICAL\b/) && !l.match(/HIGH/),
        );
        expect(blockingGate).toBeUndefined();
    });

    it('the PUBLISH workflow Trivy gate blocks on CRITICAL,HIGH too', () => {
        // Same rule, second gate. This is the one in front of production:
        // ci.yml's verdict can be absent, because its `trivy` job is declared
        // `needs: [docker]` and `docker` is `needs: [build, changes]` — so ANY
        // failure or skip upstream deletes the verdict and a skipped dependent
        // is not a failure. (Measured on CI run 34722259790: `build` failed at
        // 23:01:48, `Docker Build` completed `skipped`, `Trivy Image Scan`
        // completed `skipped` at 23:01:49, and the run went red for the build,
        // never for the missing scan.) This gate is in series with the push
        // itself, so nothing in another job can delete it.
        expect(publish).toMatch(/severity:\s*["']CRITICAL,HIGH["']/);
        const publishLines = publish.split('\n');
        const loweredGate = publishLines.find(
            l => l.match(/severity:/) && l.match(/\bCRITICAL\b/) && !l.match(/HIGH/),
        );
        expect(loweredGate).toBeUndefined();
    });

    it('both Trivy gates can actually fail their job', () => {
        // `severity: "CRITICAL,HIGH"` with `exit-code: "0"` is a REPORT, not
        // a gate — it names both severities and blocks neither, so every
        // assertion above would pass on a workflow that enforces nothing.
        // ci.yml carries a second, deliberately non-blocking trivy-action
        // step for the SARIF upload, so this asserts at least one blocking
        // declaration rather than the absence of a non-blocking one.
        expect(ci).toMatch(/exit-code:\s*["']1["']/);
        expect(publish).toMatch(/exit-code:\s*["']1["']/);
    });

    it('the workflow that publishes :latest carries its own image scan', () => {
        // The 2026-09-12 failure this closes: ghcr-publish.yml pushed
        // `:latest` with no scan of any kind, and the only Trivy in the repo
        // lived in a ci.yml job that SKIPPED because an upstream `build` job
        // failed (NOT because Docker Build was killed at its timeout — that
        // job never started). A skipped dependent is not a failure, so nothing
        // went red while Watchtower, which polls every 60 SECONDS, rolled the
        // unscanned image into production at 22:37:20 — within a minute of
        // `:latest` moving, and 24 minutes before CI reached the point of not
        // scanning it.
        //
        // Asserted on the `uses:` line rather than on the word "trivy",
        // which by now appears several times in that file's comments —
        // prose explaining a gate is not a gate.
        expect(publish).toMatch(/uses:\s*aquasecurity\/trivy-action@/);
    });

    it('removed the documentation comment that explained the temporary lowering', () => {
        // The pre-migration ci.yml carried explicit comments naming
        // the lowering as temporary "until Next upgrade lands". Those
        // comments are now factually incorrect — the migration landed.
        // Regression: re-introducing the comment is the precursor to
        // re-introducing the lower gate.
        expect(ci).not.toMatch(/Lowered gate from CRITICAL,HIGH/);
        expect(ci).not.toMatch(/Gate was lowered from high → critical/);
    });
});

describe('GAP-05 ratchet — Next.js version pin', () => {
    it('package.json pins next to a 15.x or higher stable, no caret, no beta', () => {
        const pkg = JSON.parse(readRepoFile('package.json')) as {
            dependencies?: Record<string, string>;
        };
        const version = pkg.dependencies?.['next'];
        expect(version).toBeDefined();
        // Regression: the pre-migration pin was `^14.2.0` which auto-
        // resolved to `14.2.35`. The Next 14 line carries unfixable
        // HIGH advisories that GAP-05 closed by moving to 15.5.x.
        expect(version).not.toMatch(/^[\^~]?14\./);
        // Must be 15.x or higher; reject any beta / rc / canary suffix.
        expect(version).toMatch(/^(15|16|17|18)\.\d+\.\d+$/);
        expect(version).not.toMatch(/beta|alpha|rc|next|canary/i);
        // Pin shape: no caret/tilde — silent drift blocked by lockfile.
        expect(version).not.toMatch(/^[\^~]/);
    });
});
