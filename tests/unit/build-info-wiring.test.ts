/**
 * The health probes can name the live build only if the image carries it
 * (#4477). Two halves put it there, and either one missing leaves both probes
 * reporting `dev` with every test of the routes still green:
 *
 *   - the Dockerfile's runner stage declares `ARG BUILD_SHA` and sets
 *     `ENV BUILD_SHA=$BUILD_SHA`;
 *   - every image build in the publish workflow passes
 *     `BUILD_SHA=${{ github.sha }}`.
 *
 * The routes' own tests (`health-route`, `readyz-route`) cover what they do
 * with the value.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The instructions of the Dockerfile's LAST stage, which is the image that runs. */
function runnerStage(dockerfile: string): string[] {
    const lines = dockerfile
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    const starts = lines.flatMap((l, i) => (/^FROM\s/i.test(l) ? [i] : []));
    return lines.slice(starts[starts.length - 1]);
}

interface Step {
    readonly name?: string;
    readonly uses?: string;
    readonly with?: Record<string, unknown>;
}

describe('the published image carries the commit it was built from (#4477)', () => {
    it("the Dockerfile's last stage declares BUILD_SHA and sets it in the environment", () => {
        const stage = runnerStage(read('Dockerfile'));
        expect(/^FROM\s+\S+\s+AS\s+runner$/i.test(stage[0])).toBe(true);

        const arg = stage.findIndex((l) => /^ARG\s+BUILD_SHA$/.test(l));
        const env = stage.findIndex((l) => /^ENV\s+BUILD_SHA=\$\{?BUILD_SHA\}?$/.test(l));
        expect(arg).toBeGreaterThan(0);
        expect(env).toBeGreaterThan(arg);
    });

    it('every image build in the publish workflow passes the commit', () => {
        const workflow = yaml.load(read('.github/workflows/ghcr-publish.yml')) as {
            jobs: Record<string, { steps?: Step[] }>;
        };
        const builds = Object.values(workflow.jobs)
            .flatMap((job) => job.steps ?? [])
            .filter((step) => step.uses?.startsWith('docker/build-push-action@'));
        // The publish job builds once, and once more without the cache on a
        // cache flake. A build that stopped passing the argument ships `dev`.
        expect(builds.length).toBeGreaterThanOrEqual(1);

        const withoutCommit = builds
            .filter((step) => {
                const args = String(step.with?.['build-args'] ?? '').split('\n').map((l) => l.trim());
                return !args.includes('BUILD_SHA=${{ github.sha }}');
            })
            .map((step) => step.name ?? step.uses);
        expect(withoutCommit).toEqual([]);
    });
});
