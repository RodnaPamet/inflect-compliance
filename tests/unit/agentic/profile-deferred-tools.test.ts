/**
 * A profile version's DEFERRED TOOLS, the parts with no database (Step 2f of
 * `docs/claude-tool-runner-design.md`, "1. Which calls can be deferred",
 * #5530).
 *
 *   1. A stored list is read back strictly: unsorted, duplicated, a tool the
 *      version lacks, a read tool, or one a sub-agent names is NOTHING, never
 *      "no deferrals" and never different waits.
 *   2. Which engines park a run on a deferred call: classified for every
 *      driver. In deploy 1 none does.
 *   3. Admission refuses a version naming deferred tools on an engine that
 *      does not park on them, by name, before the run row exists.
 */
jest.mock('@/env', () => ({ env: {} }));

import { AGENT_DRIVERS } from '@/lib/agentic/agent-driver';
import { parseStoredDeferredToolNames, runsDeferrals } from '@/lib/agentic/agent-profile';
import { assertEngineRunsProfiles } from '@/app-layer/usecases/agent-profile-runs';
import type { ProfileRunSpec } from '@/lib/agentic/workflow-types';

const VERSION = { toolNames: ['list_risks', 'propose_finding', 'propose_risks'] };

describe('1. a stored deferred-tool list is read back strictly', () => {
    it('reads back a sorted subset of the version\'s propose tools', () => {
        expect(parseStoredDeferredToolNames([], VERSION)).toEqual([]);
        expect(parseStoredDeferredToolNames(['propose_finding', 'propose_risks'], VERSION)).toEqual([
            'propose_finding',
            'propose_risks',
        ]);
    });

    it('is nothing for a list this build would not have written', () => {
        expect(parseStoredDeferredToolNames(['propose_risks', 'propose_finding'], VERSION)).toBeNull();
        expect(parseStoredDeferredToolNames(['propose_risks', 'propose_risks'], VERSION)).toBeNull();
        expect(parseStoredDeferredToolNames(['propose_controls'], VERSION)).toBeNull();
        expect(parseStoredDeferredToolNames(['list_risks'], VERSION)).toBeNull();
        const subagents = [{ name: 'r', instructions: 'x', toolNames: ['propose_risks'], skillRefs: [], maxTurns: 2 }];
        expect(parseStoredDeferredToolNames(['propose_risks'], { ...VERSION, subagents })).toBeNull();
    });
});

describe('2. which engines park on a deferred call', () => {
    it('is classified for every driver, and the built-in and Flue engines park on none', () => {
        expect(AGENT_DRIVERS.map((d) => [d, typeof runsDeferrals(d)])).toEqual(AGENT_DRIVERS.map((d) => [d, 'boolean']));
        expect(runsDeferrals('static')).toBe(false);
        expect(runsDeferrals('flue')).toBe(false);
    });
});

describe('3. admission refuses a version with deferred tools on an engine that does not park on them', () => {
    const profile = (deferredToolNames?: readonly string[]): ProfileRunSpec =>
        ({
            profileId: 'p',
            agentId: 'a',
            versionId: 'v',
            version: 1,
            instructions: 'x',
            instructionsHash: 'h',
            toolNames: VERSION.toolNames,
            skillRefs: [],
            modelTier: 'balanced',
            effort: 'medium',
            maxTurns: 4,
            outputKind: 'ANSWER_AND_PROPOSALS',
            allowedTriggers: ['ASK'],
            ...(deferredToolNames ? { deferredToolNames } : {}),
        }) as ProfileRunSpec;

    it('refuses by name on every engine whose entry is false, and admits a version that defers nothing', () => {
        // Deploy 1: the Tool Runner runs profiles but parks on no deferred
        // call yet, so a version naming one is refused by name, never run as
        // though its calls did not wait.
        expect(runsDeferrals('tool-runner')).toBe(false);
        expect(() => assertEngineRunsProfiles('tool-runner', profile(['propose_risks']))).toThrow(
            /PROFILE_DEFERRALS_NOT_RUNNABLE/,
        );
        expect(() => assertEngineRunsProfiles('tool-runner', profile())).not.toThrow();
        expect(() => assertEngineRunsProfiles('tool-runner', profile([]))).not.toThrow();
    });
});
