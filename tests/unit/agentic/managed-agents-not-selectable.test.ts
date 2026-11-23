/**
 * THE MANAGED AGENTS ENGINE IS BUILT AND CANNOT RUN (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165).
 *
 * `DRIVER_IMPLEMENTED['managed-agents']` is false, so no input selects the
 * engine; and `MANAGED_AGENTS` is a READ_ONLY mode, so a stored value reads as
 * itself while no writer accepts it (the writer half is held by
 * `tests/unit/agent-driver-mode-rollout.test.ts`). Every combination of the
 * gate's inputs is enumerated here, so a branch that lets the engine through
 * for one of them fails by name.
 */
import {
    AGENT_DRIVERS,
    AGENT_DRIVER_MODES,
    DRIVER_IMPLEMENTED,
    STORED_DRIVER_MODES,
    coerceRecordedRunDriver,
    coerceStoredDriverMode,
    isReasoningEngine,
    recordedModeOf,
    resolveAgentDriver,
} from '@/lib/agentic/agent-driver';
import { selectRunDriver } from '@/lib/agentic/drivers';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const asking = (driver: string): WorkflowDefinition =>
    ({ key: 'k', name: 'n', description: 'd', driver, steps: [] }) as unknown as WorkflowDefinition;

describe('the Managed Agents engine cannot be selected (Step 5b)', () => {
    it('is declared, classified as a reasoning engine, and not implemented', () => {
        expect(AGENT_DRIVERS).toContain('managed-agents');
        expect(isReasoningEngine('managed-agents')).toBe(true);
        expect(DRIVER_IMPLEMENTED['managed-agents']).toBe(false);
        expect(recordedModeOf('managed-agents')).toBe('MANAGED_AGENTS');
    });

    it('no combination of the gate\'s inputs resolves to it', () => {
        const settings = [null, undefined, '', 'JUNK', ...STORED_DRIVER_MODES];
        const bools = [true, false];
        const resolved = new Set<string>();
        let combinations = 0;
        for (const tenantSetting of settings) {
            for (const envEnabled of bools) {
                for (const toolRunnerEnvEnabled of bools) {
                    for (const managedAgentsEnvEnabled of bools) {
                        combinations += 1;
                        resolved.add(resolveAgentDriver({ envEnabled, toolRunnerEnvEnabled, managedAgentsEnvEnabled, tenantSetting }).driver);
                    }
                }
            }
        }
        // Positive control: the enumeration reaches the engines that ARE selectable.
        expect(combinations).toBe(settings.length * 8);
        expect([...resolved].sort()).toEqual(['flue', 'static', 'tool-runner']);
    });

    it('a stored MANAGED_AGENTS with its switch on is static, and says why', () => {
        expect(resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, managedAgentsEnvEnabled: true, tenantSetting: 'MANAGED_AGENTS' }))
            .toEqual({ driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' });
        expect(resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, tenantSetting: 'MANAGED_AGENTS' }))
            .toEqual({ driver: 'static', reason: 'ENV_DISABLED' });
    });

    it('a definition that asks for it gets the static engine for every driver the gate can permit', () => {
        for (const permitted of ['static', 'flue', 'tool-runner'] as const) {
            expect(selectRunDriver(asking('managed-agents'), permitted).driver).toBe('static');
        }
    });

    it('a stored value reads as itself, in the settings column and in a run\'s recorded engine', () => {
        expect(coerceStoredDriverMode('MANAGED_AGENTS')).toBe('MANAGED_AGENTS');
        expect(coerceRecordedRunDriver('MANAGED_AGENTS')).toBe('MANAGED_AGENTS');
    });

    it('no writer\'s list holds it', () => {
        expect(AGENT_DRIVER_MODES as readonly string[]).not.toContain('MANAGED_AGENTS');
        expect(STORED_DRIVER_MODES as readonly string[]).toContain('MANAGED_AGENTS');
    });
});
