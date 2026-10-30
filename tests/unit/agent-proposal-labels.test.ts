/**
 * Every proposal KIND and every payload FIELD a reviewer can be shown has a
 * label, in both catalogues — and the field list is exactly the payload
 * schemas' keys, so a schema that gains a field fails here until somebody
 * names it, rather than rendering its stored name on the review queue.
 *
 * A stored payload is the PARSED output of its kind's schema
 * (`createAgentProposal` writes `schema.safeParse(...).data`), which is what
 * makes the schemas' keys the whole population.
 */
import { AgentProposalKind } from '@prisma/client';

import {
    CreateControlSchema,
    CreateFindingSchema,
    CreatePolicySchema,
    CreateRiskSchema,
    UpdateControlSchema,
    UpdateFindingSchema,
    UpdateRiskSchema,
} from '@/lib/schemas';
import { ExternalWriteProposalPayloadSchema } from '@/lib/agentic/external-write-proposal';
import {
    PROPOSAL_FIELD_NAMES,
    PROPOSAL_KINDS,
    proposalFieldLabelKey,
    proposalKindLabelKey,
} from '@/lib/agentic/proposal-labels';

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

/** The object keys of a zod schema, through any refinement or pipe wrapping it. */
function keysOf(schema: unknown): string[] {
    let node = schema as Record<string, unknown> | undefined;
    for (let depth = 0; depth < 10 && node; depth++) {
        const shape = (node as { shape?: Record<string, unknown> }).shape;
        if (shape && typeof shape === 'object') return Object.keys(shape);
        const def = ((node as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
            (node as { def?: Record<string, unknown> }).def ??
            (node as { _def?: Record<string, unknown> })._def) as Record<string, unknown> | undefined;
        node = (def?.in ?? def?.schema ?? def?.innerType) as Record<string, unknown> | undefined;
    }
    throw new Error('not an object schema');
}

const PAYLOAD_SCHEMAS = {
    CreateRiskSchema,
    UpdateRiskSchema,
    CreateControlSchema,
    UpdateControlSchema,
    CreatePolicySchema,
    CreateFindingSchema,
    UpdateFindingSchema,
    ExternalWriteProposalPayloadSchema,
};

describe('proposal labels', () => {
    it('the kind list is the AgentProposalKind enum', () => {
        expect([...PROPOSAL_KINDS].sort()).toEqual(Object.values(AgentProposalKind).sort());
    });

    it('the field list is exactly the payload schemas’ keys', () => {
        const schemaKeys = new Set(Object.values(PAYLOAD_SCHEMAS).flatMap(keysOf));
        // The population is real: every schema contributed.
        for (const [name, schema] of Object.entries(PAYLOAD_SCHEMAS)) {
            expect({ name, keys: keysOf(schema).length > 0 }).toEqual({ name, keys: true });
        }
        const listed = new Set<string>(PROPOSAL_FIELD_NAMES);
        expect({ unnamed: [...schemaKeys].filter((k) => !listed.has(k)).sort() }).toEqual({ unnamed: [] });
        expect({ stale: [...listed].filter((k) => !schemaKeys.has(k)).sort() }).toEqual({ stale: [] });
        expect(listed.size).toBe(PROPOSAL_FIELD_NAMES.length);
    });

    it.each([
        ['en', en],
        ['bg', bg],
    ] as const)('every label resolves to a non-empty string in %s', (_locale, messages) => {
        const missing: string[] = [];
        for (const kind of PROPOSAL_KINDS) {
            const key = proposalKindLabelKey(kind)!;
            const v = lookup(messages, key);
            if (typeof v !== 'string' || v.trim() === '') missing.push(key);
        }
        for (const field of PROPOSAL_FIELD_NAMES) {
            const key = proposalFieldLabelKey(field)!;
            const v = lookup(messages, key);
            if (typeof v !== 'string' || v.trim() === '') missing.push(key);
        }
        expect(missing).toEqual([]);
    });

    it('a name not on the list has no key, so it is shown as stored', () => {
        expect(proposalKindLabelKey('SOMETHING_NEW')).toBeNull();
        expect(proposalFieldLabelKey('legacyColumn')).toBeNull();
        // A prototype key is not a field name.
        expect(proposalFieldLabelKey('constructor')).toBeNull();
    });
});
