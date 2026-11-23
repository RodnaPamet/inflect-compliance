/**
 * WHEN THE MANAGED AGENTS ENGINE IS SELECTED, AND WHEN IT IS NOT (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165; turned on in Step 5d, #4167).
 *
 * Exactly one combination of the gate's inputs selects it: a workspace that
 * chose `MANAGED_AGENTS`, the operator's `AGENT_MANAGED_AGENTS` switch on, and
 * `DRIVER_IMPLEMENTED['managed-agents']` true. Every combination is enumerated,
 * so a branch that lets the engine through for another fails by name.
 *
 * The expectations are written against the FLAG, not a literal, because the
 * flag is flipped in a commit of its own and reverting that commit is the
 * rollback: this file must hold, and be meaningful, on both sides of it. The
 * positive and negative halves are each asserted, so neither side passes by
 * reaching nothing.
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
import { profileEngineRequestFor, runsProfiles } from '@/lib/agentic/agent-profile';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const asking = (driver: string): WorkflowDefinition =>
    ({ key: 'k', name: 'n', description: 'd', driver, steps: [] }) as unknown as WorkflowDefinition;
const BUILT = DRIVER_IMPLEMENTED['managed-agents'];

describe('the Managed Agents engine is selected by exactly one combination', () => {
    it('is declared, classified as a reasoning engine that runs profiles, and records its own mode', () => {
        expect(AGENT_DRIVERS).toContain('managed-agents');
        expect(isReasoningEngine('managed-agents')).toBe(true);
        expect(runsProfiles('managed-agents')).toBe(true);
        expect(recordedModeOf('managed-agents')).toBe('MANAGED_AGENTS');
    });

    it('resolves to it only for a workspace that chose it, with its switch on, in a build that has it', () => {
        const settings = [null, undefined, '', 'JUNK', ...STORED_DRIVER_MODES];
        const bools = [true, false];
        const selectedBy: string[] = [];
        let combinations = 0;
        for (const tenantSetting of settings) {
            for (const envEnabled of bools) {
                for (const toolRunnerEnvEnabled of bools) {
                    for (const managedAgentsEnvEnabled of bools) {
                        combinations += 1;
                        const { driver } = resolveAgentDriver({ envEnabled, toolRunnerEnvEnabled, managedAgentsEnvEnabled, tenantSetting });
                        if (driver === 'managed-agents') {
                            selectedBy.push(`${String(tenantSetting)}|${envEnabled}|${toolRunnerEnvEnabled}|${managedAgentsEnvEnabled}`);
                        }
                    }
                }
            }
        }
        expect(combinations).toBe(settings.length * 8);
        // The other two switches say nothing about this engine: four
        // combinations, all of them the workspace's choice with its own switch.
        const expected = BUILT
            ? ['true|true', 'true|false', 'false|true', 'false|false'].map((ft) => `MANAGED_AGENTS|${ft}|true`)
            : [];
        expect(selectedBy.sort()).toEqual(expected.sort());
    });

    it('a workspace that chose it reads why it is not in force, and never another engine', () => {
        expect(resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, managedAgentsEnvEnabled: false, tenantSetting: 'MANAGED_AGENTS' }))
            .toEqual({ driver: 'static', reason: 'ENV_DISABLED' });
        expect(resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, managedAgentsEnvEnabled: true, tenantSetting: 'MANAGED_AGENTS' }))
            .toEqual(BUILT ? { driver: 'managed-agents', reason: null } : { driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' });
    });

    it('a definition that asks for it gets it only where it is permitted', () => {
        for (const permitted of ['static', 'flue', 'tool-runner'] as const) {
            expect(selectRunDriver(asking('managed-agents'), permitted).driver).toBe('static');
        }
        expect(selectRunDriver(asking('managed-agents'), 'managed-agents').driver).toBe('managed-agents');
        // And one asking for the Tool Runner never lands on it.
        expect(selectRunDriver(asking('tool-runner'), 'managed-agents').driver).toBe('static');
    });

    it('a profile asks for it only in a workspace that chose it (Step 5d)', () => {
        expect(profileEngineRequestFor('MANAGED_AGENTS')).toBe('managed-agents');
        for (const mode of [null, undefined, '', 'JUNK', 'STATIC', 'FLUE', 'TOOL_RUNNER']) {
            expect(profileEngineRequestFor(mode)).toBe('tool-runner');
        }
    });

    it('a stored value reads as itself, in the settings column and in a run\'s recorded engine', () => {
        expect(coerceStoredDriverMode('MANAGED_AGENTS')).toBe('MANAGED_AGENTS');
        expect(coerceRecordedRunDriver('MANAGED_AGENTS')).toBe('MANAGED_AGENTS');
    });

    it('is writable since Step 5d: the writer\'s list holds it', () => {
        expect(AGENT_DRIVER_MODES as readonly string[]).toContain('MANAGED_AGENTS');
        expect(STORED_DRIVER_MODES as readonly string[]).toContain('MANAGED_AGENTS');
    });
});
