import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import { ensureFlueRuntime } from '@/lib/agentic/flue/runtime-start';

/**
 * THE BOOT HANDS `ANTHROPIC_WORKSPACE_ID` TO THE EXTERNAL ROUTE.
 *
 * `external-provider-sends-workspace-header.test.ts` proves that a provider
 * BUILT with a workspace id puts `anthropic-workspace-id` on the wire. This
 * proves the other half: that the process-wide boot — the only production
 * caller of `buildFlueProviders` — reads the id from configuration and passes
 * it, so a deployment with an organisation-level key is not refused HTTP 400 on
 * every Flue run.
 *
 * A file of its own because the boot is memoised for the life of the module
 * registry (see `runtime-boots-once.test.ts`): the configuration has to be in
 * place before the one `ensureFlueRuntime()` this file is allowed.
 *
 * `@/env` maps to `tests/mocks/env.ts` in this project, which reads
 * `process.env` on every access, so setting the variables here is setting the
 * configuration the boot sees. Registering a provider opens no socket, so the
 * boot needs no network.
 */
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_WORKSPACE_ID'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-test';  // pragma: allowlist secret -- synthetic key, the boot registers a route and never calls it
    process.env.ANTHROPIC_MODEL = 'claude-x';
    process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01BOOTWORKSPACE';
});

afterAll(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('ensureFlueRuntime and ANTHROPIC_WORKSPACE_ID', () => {
    it('registers the external model carrying the configured workspace header', async () => {
        const providers = await ensureFlueRuntime();
        const external = providers.find((p) => p.id === FLUE_PROVIDER_IDS.external);
        if (!external) throw new Error('the boot registered no external provider for a configured key');

        const [model] = external.getModels();
        expect(model.id).toBe('claude-x');
        expect(model.headers).toEqual({ 'anthropic-workspace-id': 'wrkspc_01BOOTWORKSPACE' });
    });
});
