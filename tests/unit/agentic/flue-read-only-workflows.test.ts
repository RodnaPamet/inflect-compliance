/**
 * A FLUE WORKFLOW WITH NO PROPOSE STEP DECLARES `readOnly` (#3775, owner
 * decision 2026-10-19).
 *
 * On the static engine a definition's steps are what runs, so "no PROPOSE step"
 * means nothing is proposed. On the Flue engine the steps are a hint: the model
 * chooses its own calls from everything its agent is granted, propose tools
 * included, unless the definition sets `readOnly`, which makes
 * `flueToolsFor(…, { readOnly })` offer the read surface alone
 * (`flue-tools-adapter.test.ts` proves the withholding, and
 * `flue-run-with-no-tools-says-so.test.ts` that the executor passes the flag).
 * Three shipped definitions said "read-only" in their header and description
 * and were offered every propose tool their agent held.
 *
 * The population is the REGISTRY, so a new definition is in scope the moment
 * it is registered. A definition that is meant to propose on Flue says so with
 * a PROPOSE step; nothing else exempts it.
 */
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

const defs = listWorkflowDefinitions();
const flue = defs.filter((d) => d.driver === 'flue');
const proposes = (d: (typeof defs)[number]) => d.steps.some((s) => s.kind === 'PROPOSE');

describe('every Flue workflow with no PROPOSE step declares readOnly', () => {
    it('reads a real population: the Flue definitions the registry holds', () => {
        // Denominator first: an empty filter would pass the next assertion.
        expect(flue.map((d) => d.key)).toEqual(
            expect.arrayContaining(['posture-review', 'access-posture', 'discovered-agent-review', 'audit-narrative']),
        );
    });

    it('none is left offering the propose surface', () => {
        const missing = flue.filter((d) => !proposes(d) && d.readOnly !== true).map((d) => d.key);
        expect(missing).toEqual([]);
    });

    it('no definition declares readOnly beside a PROPOSE step, which would withhold what it is for', () => {
        const contradictory = defs.filter((d) => d.readOnly === true && proposes(d)).map((d) => d.key);
        expect(contradictory).toEqual([]);
    });
});
