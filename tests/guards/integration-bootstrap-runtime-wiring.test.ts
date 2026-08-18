/**
 * H1 — provider-fleet runtime ignition ratchet.
 *
 * `src/app-layer/integrations/bootstrap.ts` registers all 13 providers as
 * top-level side effects, but nothing imported it at runtime — so the registry
 * was empty in the running web + worker (dropdown empty, automation-runner
 * resolved no provider). This locks in:
 *   1. Both runtime entry points import the side-effecting bootstrap.
 *   2. Importing bootstrap actually populates the registry with all 13 ids.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EXPECTED_PROVIDER_IDS = [
    'github',
    'aws-posture',
    'okta',
    'google-workspace',
    'entra-id',
    'active-directory',
    'azure-posture',
    'gcp-posture',
    'bamboohr',
    'workday',
    'personnel',
    'device',
    'training',
].sort();

describe('integration provider fleet — runtime wiring', () => {
    it('both runtime entry points import the side-effecting bootstrap', () => {
        const web = read('src/instrumentation.ts');
        const worker = read('scripts/worker.ts');
        expect(web).toMatch(/integrations\/bootstrap/);
        expect(worker).toMatch(/integrations\/bootstrap/);
    });

    it('importing bootstrap populates the registry with all 13 provider ids', () => {
        // Import the real registry + bootstrap side effect (no mocks) and assert
        // every provider actually registered.
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('@/app-layer/integrations/bootstrap');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { registry } = require('@/app-layer/integrations/registry');
            const ids = registry.listProviders().map((p: { id: string }) => p.id).sort();
            expect(ids).toEqual(EXPECTED_PROVIDER_IDS);
        });
    });
});
