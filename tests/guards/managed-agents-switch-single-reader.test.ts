/**
 * THE MANAGED AGENTS SWITCH HAS ONE READER (#5964, owner decisions 2026-11-25).
 *
 * `AGENT_MANAGED_AGENTS` is no longer the switch: it is the operator's
 * override of a switch each WORKSPACE decides, and unset it leaves the answer
 * to `TenantSecuritySettings.managedAgentsEnabled`. A surface that read the
 * variable by itself would report a workspace whose owner turned the engine on
 * as off (the variable is unset in production), or let a workspace whose owner
 * turned it off keep running. So the variable is read in exactly one place,
 * `managedAgentsDecisionFor`'s module, and every reader asks that function.
 *
 * What is asserted, over every tracked `src/` file, as CODE (comments blanked):
 *   - only `src/env.ts` (its schema and `runtimeEnv`) and
 *     `src/lib/agentic/agent-switches-policy.ts` read the variable, in any
 *     spelling (`env.X`, `process.env.X`, `env['X']`);
 *   - only the policy module reads the column, apart from its one writer;
 *   - the surfaces the decision gates each ask it: the run gate, the engine
 *     setting, the integrations surface and the run paths.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

const SOURCES = repoRelativeFiles()
    .filter((f) => f.startsWith('src/') && /\.(ts|tsx|js|mjs)$/.test(f))
    .map((file) => ({ file, code: codeOf(readFileSync(path.join(ROOT, file), 'utf8')) }));

/** A read of the variable itself, never one of its `_HOSTED_*` siblings. */
const VARIABLE_READ = /\benv\s*(?:\.\s*AGENT_MANAGED_AGENTS\b(?!_)|\[\s*['"`]AGENT_MANAGED_AGENTS['"`]\s*\])/;
/** A read of the workspace's column: a `select` or a property read off a row. */
const COLUMN_NAME = /\bmanagedAgentsEnabled\b/;

describe('AGENT_MANAGED_AGENTS is read in one place', () => {
    it('the scan has a population, and the variable is declared where env variables are', () => {
        expect(SOURCES.length).toBeGreaterThan(1000);
        expect(SOURCES.filter((s) => VARIABLE_READ.test(s.code)).map((s) => s.file)).toContain('src/env.ts');
    });

    it('no file but the env module and the decision\'s own module reads it', () => {
        const readers = SOURCES.filter((s) => VARIABLE_READ.test(s.code)).map((s) => s.file).sort();
        expect(readers).toEqual(['src/env.ts', 'src/lib/agentic/agent-switches-policy.ts']);
    });

    it('the workspace\'s column is named only by its reader and its writer', () => {
        const namers = SOURCES.filter((s) => COLUMN_NAME.test(s.code)).map((s) => s.file).sort();
        expect(namers).toEqual([
            'src/app-layer/usecases/managed-agents-switch.ts',
            'src/lib/agentic/agent-switches-policy.ts',
        ]);
    });
});

describe('every surface the switch gates asks the decision', () => {
    // The decision is reached by name (`managedAgentsDecisionFor`,
    // `managedAgentsOnFor`) or through the refusal helper that calls it
    // (`assertManagedAgentsOn`, `src/lib/agentic/managed-agents-switch.ts`).
    const ASKS = /\b(?:managedAgentsDecisionFor|managedAgentsOnFor|assertManagedAgentsOn)\s*\(/;
    const askers = SOURCES.filter((s) => ASKS.test(s.code)).map((s) => s.file);

    it.each([
        ['the run gate', 'src/lib/agentic/agent-driver-policy.ts'],
        ['the engine setting and its page', 'src/app-layer/usecases/agent-driver-setting.ts'],
        ['the integrations surface: list, save and Test', 'src/app-layer/usecases/integrations.ts'],
        ['admission of a new profile run', 'src/app-layer/usecases/agent-profile-runs.ts'],
        ['the worker and a person\'s resume', 'src/app-layer/usecases/workflow-runs.ts'],
        ['the switch\'s own section', 'src/app-layer/usecases/managed-agents-switch.ts'],
    ])('%s', (_surface, file) => {
        expect(askers).toContain(file);
    });
});
