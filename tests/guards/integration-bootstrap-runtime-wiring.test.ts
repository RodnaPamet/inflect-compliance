/**
 * H1 — provider-fleet runtime ignition ratchet.
 *
 * `src/app-layer/integrations/bootstrap.ts` registers every provider as
 * top-level side effects, but nothing imported it at runtime — so the registry
 * was empty in the running web + worker (dropdown empty, automation-runner
 * resolved no provider). This locks in:
 *   1. Both runtime entry points import the side-effecting bootstrap.
 *   2. Importing bootstrap actually populates the registry with all of them.
 *
 * The count is DERIVED from the list rather than written next to it. A number
 * maintained beside its own source is the shape that merges silently wrong:
 * two branches each adding a provider both bump 12 → 13, the identical lines
 * do not conflict, git keeps one copy, and both PRs are green while the prose
 * is off by one with no suspicious diff for a reviewer to catch. It happened
 * on this very line, between the Workday and ServiceNow branches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

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
    // Added by #2548 as an internal fixture and since promoted, and
    // still listed here: this ratchet is about what the RUNTIME registry holds,
    // and the fixture is registered because the HRIS sync resolves providers
    // through it. A provider that is registered and absent from this list is
    // the drift the file exists to catch, whatever the provider is for.
    'orangehrm',
    'personnel',
    'device',
    'training',
    'servicenow',
].sort();

describe('integration provider fleet — runtime wiring', () => {
    it('both runtime entry points import the side-effecting bootstrap', () => {
        const web = read('src/instrumentation.ts');
        const worker = read('scripts/worker.ts');
        expect(web).toMatch(/integrations\/bootstrap/);
        expect(worker).toMatch(/integrations\/bootstrap/);
    });

    it(`importing bootstrap populates the registry with all ${EXPECTED_PROVIDER_IDS.length} provider ids`, () => {
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
