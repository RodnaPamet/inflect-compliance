/**
 * The image publish never cancels a run in progress (#4280).
 *
 * `.github/workflows/ghcr-publish.yml` is the only deploy path: it pushes
 * `:latest`, and the production VM's Watchtower rolls whatever lands there.
 * It used `cancel-in-progress: true`. A publish takes about 21 minutes, and on
 * 2026-10-25 merges landed minutes apart, so every push cancelled the publish
 * still running. 54 of 56 runs after the 04:28 UTC success ended `cancelled`,
 * and production stayed on that image for 13 hours while CI and Release were
 * green.
 *
 * With `false`, GitHub finishes the running publish and keeps at most one
 * pending run per group, the newest. So every publish that starts completes,
 * and the newest commit is always published next.
 *
 * Parsed as YAML rather than read as text, so a comment mentioning
 * `cancel-in-progress: false` cannot satisfy it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const WORKFLOW = path.join(__dirname, '../../.github/workflows/ghcr-publish.yml');

interface PublishWorkflow {
    on?: Record<string, unknown>;
    true?: Record<string, unknown>;
    concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
}

const publish = yaml.load(fs.readFileSync(WORKFLOW, 'utf8')) as PublishWorkflow;
// `on:` is YAML 1.1's `true`, so js-yaml may resolve the key to a boolean.
const triggers = publish.on ?? publish.true ?? {};

describe('the image publish never starves (#4280)', () => {
    it('runs on pushes to main, so the case it guards exists', () => {
        // Positive control: if the publish stopped triggering on main, the
        // concurrency rule below would be about a workflow that never races.
        expect(triggers).toHaveProperty('push');
    });

    it('serialises publishes in one group per ref', () => {
        expect(publish.concurrency?.group).toBe('ghcr-publish-${{ github.ref }}');
    });

    it('lets a running publish finish', () => {
        // Strictly `false`: an absent key defaults to false in GitHub, but an
        // absent key is also what a careless edit leaves, so the decision is
        // written down.
        expect(publish.concurrency?.['cancel-in-progress']).toBe(false);
    });
});
