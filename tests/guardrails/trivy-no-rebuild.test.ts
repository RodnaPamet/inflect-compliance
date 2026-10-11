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
        expect(scanners.map((f) => f.name)).toContain('laya-image.yml');
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
