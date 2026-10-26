/**
 * The flue project's `globalSetup` refuses a Node too old to run it, by name.
 *
 * Under Node < 24.9 every flue suite used to fail at load with "Must use import
 * to load ES Module: …/dedent/dist/dedent.mjs", which named neither the project
 * nor the cause. The gate's message is the fix, so the boundary is pinned here,
 * and so is the wiring: a gate the project never runs fixes nothing.
 */
import flueNodeGate, { FLUE_MIN_NODE, flueNodeRefusal } from '../setup/flue-node-gate';

// jest.config.js is CommonJS.
const jestConfig = require('../../jest.config.js');

describe('flueNodeRefusal', () => {
    it.each(['22.22.0', '23.11.0', '24.0.0', '24.8.9'])('refuses Node %s, naming the version it needs', (v) => {
        const refusal = flueNodeRefusal(v);
        expect(refusal).toContain('Node 24.9 or later');
        expect(refusal).toContain(`this is Node ${v}`);
    });

    it.each(['24.9.0', '24.22.1', '25.0.0', '26.1.0'])('lets Node %s run', (v) => {
        expect(flueNodeRefusal(v)).toBeNull();
    });

    it('agrees with the version the repository pins', () => {
        expect(FLUE_MIN_NODE[0]).toBe(24);
    });
});

describe('the gate itself', () => {
    it('resolves on the Node running this suite when it is new enough, and throws the refusal otherwise', async () => {
        const refusal = flueNodeRefusal(process.versions.node);
        if (refusal) await expect(flueNodeGate()).rejects.toThrow(refusal);
        else await expect(flueNodeGate()).resolves.toBeUndefined();
    });
});

describe('the wiring', () => {
    it('is the flue project\'s globalSetup, and no other project\'s', async () => {
        const config = typeof jestConfig === 'function' ? await jestConfig() : jestConfig;
        const projects: Array<{ displayName?: string; globalSetup?: string }> = config.projects ?? [];
        const flue = projects.find((p) => p.displayName === 'flue');
        expect(flue?.globalSetup).toBe('<rootDir>/tests/setup/flue-node-gate.js');
        for (const p of projects.filter((q) => q.displayName !== 'flue')) {
            expect(p.globalSetup).not.toBe('<rootDir>/tests/setup/flue-node-gate.js');
        }
    });
});
