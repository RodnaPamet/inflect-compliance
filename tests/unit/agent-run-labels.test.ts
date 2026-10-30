/**
 * Every run status, step status and proposal status the run pages show has a
 * label in both catalogues, and each list is exactly its generated enum — so a
 * value added to an enum fails here until somebody names it, rather than
 * rendering its stored code on the run detail page (#4532).
 */
import { SuggestionItemStatus, WorkflowRunStatus, WorkflowStepStatus } from '@prisma/client';

import {
    PROPOSAL_STATUSES,
    RUN_STATUSES,
    STEP_STATUSES,
    proposalStatusLabelKey,
    runStatusLabelKey,
    stepStatusLabelKey,
} from '@/lib/agentic/run-labels';

const en = require('../../messages/en.json') as Record<string, unknown>;
const bg = require('../../messages/bg.json') as Record<string, unknown>;

function lookup(messages: Record<string, unknown>, dotted: string): unknown {
    return `agents.${dotted}`
        .split('.')
        .reduce<unknown>(
            (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
            messages,
        );
}

const CASES = [
    { name: 'run status', list: RUN_STATUSES, values: Object.values(WorkflowRunStatus), key: runStatusLabelKey },
    { name: 'step status', list: STEP_STATUSES, values: Object.values(WorkflowStepStatus), key: stepStatusLabelKey },
    {
        name: 'proposal status',
        list: PROPOSAL_STATUSES,
        values: Object.values(SuggestionItemStatus),
        key: proposalStatusLabelKey,
    },
] as const;

describe.each(CASES)('$name labels', ({ list, values, key }) => {
    it('the list is exactly the generated enum', () => {
        expect([...list].sort()).toEqual([...values].sort());
    });

    it('every value has a label in both catalogues', () => {
        for (const value of list) {
            const k = key(value);
            expect({ value, k: typeof k }).toEqual({ value, k: 'string' });
            expect({ value, en: typeof lookup(en, k!), bg: typeof lookup(bg, k!) }).toEqual({
                value,
                en: 'string',
                bg: 'string',
            });
        }
    });

    it('a value not on the list has no key, so it is shown as stored', () => {
        expect(key('NOT_A_STATUS')).toBeNull();
        // Not resolved off the prototype.
        expect(key('toString')).toBeNull();
    });
});
