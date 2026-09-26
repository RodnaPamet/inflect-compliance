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
    // #2859 slice two. Registered even though `supportedChecks` is empty and it
    // routes no automationKey: `upsertIntegrationConnection` and
    // `testConnectionCredentials` both reject a provider the registry does not
    // know, so without this the admin screen it was written for cannot create
    // or test one. It sat written-but-unregistered until the proving run tried
    // to use it — which is the second direction this file now covers.
    'mcp-server',
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

    // ── THE OTHER DIRECTION ──────────────────────────────────────────────
    //
    // Everything above starts from the REGISTRY and checks the list agrees. That
    // is blind, structurally, to a provider that is never registered at all: it
    // never enters the registry, so the set match above is perfectly happy while
    // the class is unreachable in production. `McpServerProvider` lived in that
    // blind spot — fully implemented, unit-tested by direct construction (which
    // bypasses the registry and so stayed green), and rejected at runtime with
    // "Unknown provider: mcp-server".
    //
    // So this starts from the SOURCE FILES instead. The population is derived,
    // never listed, and there is no exemption set: every provider class in the
    // tree is registered, and a new one is red until it is wired.
    it('every provider class in the tree is registered in bootstrap', () => {
        const dir = path.join(ROOT, 'src/app-layer/integrations');
        const files = fs
            .readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter((f) => f.endsWith('.ts'))
            .map((f) => path.join(dir, f));

        // Comments are masked at the read seam, so a class or a registration
        // that is commented out counts as neither present nor wired.
        const declared = new Set<string>();
        for (const f of files) {
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            for (const m of code.matchAll(/export class ([A-Za-z0-9_]+Provider)\b/g)) {
                declared.add(m[1]);
            }
        }

        // Positive control: the scan must actually be finding classes. A silent
        // zero here would make the assertion below vacuously true.
        expect(declared.size).toBeGreaterThan(10);

        const bootstrap = read('src/app-layer/integrations/bootstrap.ts');
        const unregistered = [...declared]
            .filter((cls) => !new RegExp(`registry\\.register\\(new ${cls}\\(\\)\\)`).test(bootstrap))
            .sort();

        expect(unregistered).toEqual([]);
    });
});
