/**
 * Structural ratchet — the Trivy image scan must NOT rebuild the image.
 *
 * The `docker` job builds the image once and exports it as a tarball
 * artifact; the `trivy` job downloads that artifact and `docker load`s
 * it. A previous shape rebuilt the image inside `trivy` via
 * `docker/build-push-action` (~7.5 min wasted per run, since each job
 * runs on a fresh runner with no shared daemon and the GHA layer cache
 * barely helps the final assemble+load).
 *
 * This test fails CI if a future change reintroduces the in-job
 * rebuild, or breaks the artifact handoff.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const CI_YML = path.resolve(__dirname, '../../.github/workflows/ci.yml');

/**
 * Slice out a single top-level job block (2-space-indented `  <name>:`
 * header through the line before the next 2-space-indented header).
 */
function jobBlock(yaml: string, jobName: string): string {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => l === `  ${jobName}:`);
    if (start === -1) throw new Error(`job "${jobName}" not found in ci.yml`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        // Next top-level job header: exactly two spaces of indent then a key.
        if (/^ {2}\S/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
}

describe('trivy job reuses the docker artifact (no rebuild)', () => {
    const yaml = fs.readFileSync(CI_YML, 'utf-8');
    const trivy = jobBlock(yaml, 'trivy');
    const docker = jobBlock(yaml, 'docker');

    it('trivy does NOT rebuild the image (no docker/build-push-action)', () => {
        expect(trivy).not.toMatch(/docker\/build-push-action/);
        // The buildx setup only existed to support the rebuild.
        expect(trivy).not.toMatch(/docker\/setup-buildx-action/);
    });

    it('trivy downloads the image artifact and loads it', () => {
        expect(trivy).toMatch(/actions\/download-artifact/);
        expect(trivy).toMatch(/docker load --input/);
    });

    it('docker job exports the image tarball as an artifact', () => {
        expect(docker).toMatch(/outputs:\s*type=docker,dest=/);
        expect(docker).toMatch(/actions\/upload-artifact/);
        // The artifact name the two jobs agree on.
        expect(docker).toMatch(/name:\s*docker-image-\$\{\{\s*github\.sha\s*\}\}/);
        // `load: true` must NOT come back — that was the old handoff that
        // dies with the job (fresh runner, no shared daemon).
        expect(docker).not.toMatch(/^\s*load:\s*true/m);
    });

    it('the artifact name is identical in both jobs (handoff matches)', () => {
        const dl = trivy.match(/name:\s*(docker-image-\$\{\{\s*github\.sha\s*\}\})/);
        const up = docker.match(/name:\s*(docker-image-\$\{\{\s*github\.sha\s*\}\})/);
        expect(dl?.[1]).toBeDefined();
        expect(dl?.[1]).toBe(up?.[1]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SAME RULE, ACROSS EVERY WORKFLOW THAT SCANS AND PUBLISHES (#3427)
//
// The block above is scoped to `ci.yml` — it reads that file's `docker` and
// `trivy` jobs by name. So the rule it enforces ("whatever Trivy scanned is what
// ships") was checked in exactly one of the three workflows that build images,
// and the one that got it wrong was outside the population.
//
// `laya-image.yml` scanned a locally-loaded image and then PUBLISHED A SECOND
// BUILD, under a step named "Push, now that it has been scanned". With no layer
// cache in that workflow the second build re-resolved every dependency, and
// `laya[serve]` pins only itself — its torch bound is `torch>=2.0.0`. A release
// landing in the gap would have put unscanned packages in the registry under the
// digest the run summary told an operator to pin.
//
// WHY `push: true` IS BANNED OUTRIGHT in a Trivy-bearing workflow rather than
// merely ordered after the scan. Two shapes are possible and both are wrong:
// push-then-scan gates nothing, because the artefact is in the registry before
// the scan has an opinion; and scan-then-build-and-push scans a different
// artefact. `docker tag` + `docker push` of the scanned reference is the only
// shape where the bytes are provably the same ones, and it is what
// `ghcr-publish.yml` already does.
// ═══════════════════════════════════════════════════════════════════════════
describe('every workflow that scans with Trivy publishes the scanned bytes', () => {
    const WF_DIR = path.resolve(__dirname, '../../.github/workflows');
    const files = fs
        .readdirSync(WF_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => ({ name: f, src: fs.readFileSync(path.join(WF_DIR, f), 'utf-8') }));

    const scanners = files.filter((f) => /aquasecurity\/trivy-action/.test(f.src));

    it('finds the Trivy-bearing workflows at all', () => {
        // The denominator. A rename of the action, or a readdir that yields
        // nothing, would make every assertion below pass over an empty set —
        // which is how the laya workflow sat outside the ci.yml-scoped block
        // above without anything noticing.
        expect(files.length).toBeGreaterThanOrEqual(8);
        expect(scanners.length).toBeGreaterThanOrEqual(2);
        // `laya-image.yml` was here until 2026-10-14 and was deleted with the
        // Laya estate. `ghcr-publish.yml` is asserted instead rather than
        // dropping the membership check altogether: an assertion over a set with
        // no named member is satisfied by any set, including an empty one.
        expect(scanners.map((f) => f.name)).toContain('ghcr-publish.yml');
        expect(scanners.map((f) => f.name)).toContain('ci.yml');
    });

    it.each(scanners.map((f) => [f.name] as const))(
        '%s does not publish via build-push-action push: true',
        (name) => {
            const src = scanners.find((f) => f.name === name)!.src;
            // Comments are stripped so a `#` line DESCRIBING the old shape — this
            // file is full of them now — cannot fail the assertion. A scar is not
            // a wound.
            const code = src
                .split('\n')
                .filter((l) => !/^\s*#/.test(l))
                .join('\n');
            expect(code).not.toMatch(/^\s*push:\s*true\s*$/m);
        },
    );

    it('a workflow that both scans and pushes does so by tagging the scanned image', () => {
        const publishers = scanners.filter((f) =>
            /docker push/.test(f.src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')),
        );
        // ci.yml scans but never pushes (the publish lives in ghcr-publish.yml),
        // so the publishing subset is smaller than the scanning one — assert the
        // subset is non-empty rather than assuming every scanner publishes.
        expect(publishers.length).toBeGreaterThanOrEqual(1);
        for (const p of publishers) {
            // The pushed reference must be produced by `docker tag` from
            // something, not built afresh.
            expect(p.src).toMatch(/docker tag/);
        }
    });

    it('the detector would catch the shape that shipped (regression proof)', () => {
        // Without this, the assertions above are equally consistent with a regex
        // that matches nothing — and the whole point of this block is that the
        // ci.yml-scoped one above looked fine while a sibling workflow was
        // broken.
        const bad = [
            'jobs:',
            '  publish:',
            '    steps:',
            '      - uses: aquasecurity/trivy-action@v0.36.0',
            '      - uses: docker/build-push-action@v7',
            '        with:',
            '          push: true',
        ].join('\n');
        const code = bad.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(code).toMatch(/^\s*push:\s*true\s*$/m);

        // And the fixed shape is NOT caught.
        const good = [
            '      - uses: aquasecurity/trivy-action@v0.36.0',
            '      - name: Push the scanned image',
            '        run: |',
            '          docker tag "$SCANNED" "$TARGET"',
            '          docker push "$TARGET"',
        ].join('\n');
        expect(good).not.toMatch(/^\s*push:\s*true\s*$/m);
        expect(good).toMatch(/docker tag/);
    });
});

/**
 * Every Trivy invocation bounds its OWN scan.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * Trivy aborts itself at an internal 5-minute default and exits 1. On a
 * security gate that is the worst direction to fail in: the build goes red
 * with `context deadline exceeded` and no CVE, which reads exactly like a
 * finding — and the cheapest response is to re-run until a faster runner
 * makes it green, which proves only that the runner was faster.
 *
 * A fix for this was written on 2026-08-20, with a careful comment arguing
 * precisely the above — and it was applied to the SARIF report step, not to
 * the GATE the comment describes. The gate is the only invocation carrying
 * `exit-code: "1"`, so it is the only one that can fail the build, and it
 * kept the 5m default for a further month. It then timed out twice
 * (530757861, and 792f9549c at 10:01:00 -> 10:06:00), both times with no CVE
 * involved.
 *
 * ── WHY A JOB-LEVEL `timeout-minutes` DOES NOT COUNT ────────────────────────
 *
 * That bounds the step from OUTSIDE and cancels it. Trivy's own `timeout`
 * bounds the scan from INSIDE. The job had 15 minutes while the scan died at
 * five: the outer bound was never reached and could not have helped. So this
 * asserts the `with:` input specifically, not any timeout anywhere nearby.
 */
describe('every trivy-action invocation sets its own scan timeout', () => {
    const yaml = fs.readFileSync(CI_YML, 'utf-8');

    /**
     * Each `uses: aquasecurity/trivy-action@...` step, as the text from its
     * `uses:` line up to the next step (`- name:`) or the end of the job.
     *
     * Text-sliced rather than YAML-parsed so the assertion reports the step's
     * own `with:` block and cannot be satisfied by a `timeout` belonging to a
     * neighbour — which is the exact confusion that produced the defect.
     */
    function trivySteps(): string[] {
        const lines = yaml.split('\n');
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (!/uses:\s*aquasecurity\/trivy-action@/.test(lines[i])) continue;
            let end = lines.length;
            for (let j = i + 1; j < lines.length; j++) {
                if (/^\s*- name:/.test(lines[j]) || /^ {2}\S/.test(lines[j])) { end = j; break; }
            }
            out.push(lines.slice(i, end).join('\n'));
        }
        return out;
    }

    const steps = trivySteps();

    it('found a real population of trivy steps', () => {
        // Both assertions below are satisfied by zero steps. This is what
        // makes them mean something.
        expect(steps.length).toBeGreaterThanOrEqual(2);
    });

    it('every one of them passes an explicit timeout', () => {
        const missing = steps.filter((s) => !/^\s*timeout:\s*["']?\d+m/m.test(s));
        expect({ total: steps.length, missing: missing.length }).toEqual({
            total: steps.length,
            missing: 0,
        });
    });

    it('the GATE — the one that can fail the build — is among them', () => {
        // Named directly. The population check above is satisfied by two
        // report-only steps, and it is specifically the `exit-code: "1"`
        // invocation whose timeout turns a slow runner into a false CVE.
        const gates = steps.filter((s) => /exit-code:\s*["']?1/.test(s));
        // Asserted as a COUNT over a computed array rather than a loop of
        // `expect(binding)`: a needle applied to a loop variable is one the
        // assertion-reach analyser cannot follow, which would put this site
        // in the un-analysable set it also ratchets.
        const gatesMissingTimeout = gates.filter(
            (g) => !/^\s*timeout:\s*["']?\d+m/m.test(g),
        );
        expect({ gates: gates.length, missingTimeout: gatesMissingTimeout.length }).toEqual({
            gates: gates.length,
            missingTimeout: 0,
        });
        expect(gates.length).toBeGreaterThanOrEqual(1);
    });

    it('the detector would SEE a missing timeout', () => {
        // The positive control: the assertions above are satisfied by a regex
        // that always matches, and this is the difference between "checked
        // and clean" and "never looked".
        const planted = [
            '        uses: aquasecurity/trivy-action@v0.36.0',
            '        with:',
            '          image-ref: "x"',
            '          exit-code: "1"',
        ].join('\n');
        expect(/^\s*timeout:\s*["']?\d+m/m.test(planted)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Every image build names the Dockerfile it builds (#3418)
// ═══════════════════════════════════════════════════════════════════════════
//
// `docker/build-push-action` defaults `file:` to `./Dockerfile`. `ci.yml`'s
// `Docker Build` job relied on that default, and `deploy/**` was in the path
// filter gating it — so a pull request changing ONLY `deploy/laya/Dockerfile`
// ran that job for 19m51s, went GREEN, and had opened the ROOT Dockerfile. The
// pull request's whole purpose was fixing a Dockerfile that had no successful
// build path at all.
//
// A reviewer seeing a green check named `Docker Build` on a Dockerfile fix has
// every reason to read it as "the Dockerfile builds". An absent check is at
// least visibly ABSENT; that one was reached, green, and aimed one level off,
// which is worse because it reads as evidence.
//
// WHY THE KEY AND NOT JUST THE FILTER. The filter was narrowed too
// (`!deploy/laya/**`), and that half was asserted here until 2026-10-14, when
// the directory, its job and the exclusion were deleted with the Laya estate —
// see the note at the removed test. The `file:` key assertion is the half that
// SURVIVES a deletion, and the distinction is the point: a filter says WHEN a
// job runs, this defect was about WHAT it built. The second Dockerfile in this
// repository is what exposed it; the third will not announce itself, and there
// is no second one at the moment.
//
// WHY THIS LIVES HERE rather than in its own file: `no-epic-named-ratchets`
// holds a DOWNWARD ratchet on the guard-file count, and its comment says that
// renaming a guard to dodge the denominator would be gaming the measure. Adding
// a file to assert a property of the workflows this file already parses would
// push that count the wrong way for no gain.

interface BuildStep {
    readonly file: string;
    readonly job: string;
    readonly step: string;
    readonly fileKey: string | null;
}

/**
 * Every `docker/build-push-action` step, from the PARSED document.
 *
 * Parsed rather than scanned, and the first draft is why: it matched `uses:` at
 * line start, missed `- uses:` written inline, and so its own synthetic
 * fixtures matched nothing while three assertions "passed" over an empty set.
 * A structural question wants a parser.
 */
export function dockerBuildSteps(text: string, file: string): readonly BuildStep[] {
    const doc = yaml.load(text) as {
        jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    } | null;
    const out: BuildStep[] = [];
    for (const [job, body] of Object.entries(doc?.jobs ?? {})) {
        for (const step of body?.steps ?? []) {
            const uses = typeof step.uses === 'string' ? step.uses : '';
            if (!uses.startsWith('docker/build-push-action@')) continue;
            const withBlock = (step.with ?? {}) as Record<string, unknown>;
            out.push({
                file,
                job,
                step: typeof step.name === 'string' ? step.name : uses,
                fileKey: typeof withBlock.file === 'string' ? withBlock.file : null,
            });
        }
    }
    return out;
}

describe('every image build names the Dockerfile it builds (#3418)', () => {
    const WF = path.resolve(__dirname, '../../.github/workflows');
    const files = fs.readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));

    it('finds the workflow population at all', () => {
        // The denominator beside the result: an empty scan passes everything
        // below over nothing.
        expect(files.length).toBeGreaterThanOrEqual(3);
        expect(files).toContain('ci.yml');
    });

    it('every build-push-action step sets `file:` explicitly', () => {
        const steps = files.flatMap((f) =>
            dockerBuildSteps(fs.readFileSync(path.join(WF, f), 'utf-8'), f),
        );
        // There must BE builds to check.
        expect(steps.length).toBeGreaterThanOrEqual(4);
        expect(
            steps
                .filter((s) => s.fileKey === null)
                .map((s) => `${s.file} job \`${s.job}\` step \`${s.step}\` has no \`file:\``),
        ).toEqual([]);
    });

    // REMOVED 2026-10-14: `ci.yml's container filter excludes deploy/laya, which
    // has its own job`. The directory, the job and the exclusion were all
    // deleted when the owner retired the Laya estate, so the assertion had no
    // subject left. It is recorded here rather than silently dropped because
    // this is a guard file and a vanished assertion is the thing guards exist to
    // prevent.
    //
    // The property it protected — a negation must FOLLOW the pattern it narrows,
    // or `paths-filter` excludes nothing — has no live instance now. The
    // `container` filter carries no negations at all. If one returns, that
    // ordering rule returns with it.
    //
    // What does NOT go away is the `file:` key assertion above, and the comment
    // block at the top says why: a filter says WHEN a job runs, and the #3418
    // defect was about WHAT it built. That half still has a live subject (the
    // root Dockerfile) and still fires.

    describe('detector proof — synthetic documents, so a clean run means something', () => {
        const wrap = (steps: string): string => `jobs:\n  build:\n    steps:\n${steps}`;

        it('flags a step relying on the default', () => {
            const found = dockerBuildSteps(
                wrap(
                    '      - name: Build\n'
                        + '        uses: docker/build-push-action@v7\n'
                        + '        with:\n'
                        + '          context: .\n',
                ),
                'synthetic',
            );
            expect(found).toHaveLength(1);
            expect(found[0].fileKey).toBeNull();
        });

        it('accepts a step that names its file', () => {
            const found = dockerBuildSteps(
                wrap(
                    '      - uses: docker/build-push-action@v7\n'
                        + '        with:\n'
                        + '          file: deploy/example/Dockerfile\n',
                ),
                'synthetic',
            );
            expect(found[0].fileKey).toBe('deploy/example/Dockerfile');
        });

        it('a commented-out file: key does NOT satisfy it', () => {
            const found = dockerBuildSteps(
                wrap(
                    '      - uses: docker/build-push-action@v7\n'
                        + '        with:\n'
                        + '          # file: Dockerfile  <- we should add this\n'
                        + '          context: .\n',
                ),
                'synthetic',
            );
            expect(found[0].fileKey).toBeNull();
        });

        it('does not let one step satisfy the next', () => {
            const found = dockerBuildSteps(
                wrap(
                    '      - uses: docker/build-push-action@v7\n'
                        + '        with:\n'
                        + '          file: Dockerfile\n'
                        + '      - uses: docker/build-push-action@v7\n'
                        + '        with:\n'
                        + '          context: .\n',
                ),
                'synthetic',
            );
            expect(found).toHaveLength(2);
            expect(found[0].fileKey).toBe('Dockerfile');
            expect(found[1].fileKey).toBeNull();
        });
    });
});
