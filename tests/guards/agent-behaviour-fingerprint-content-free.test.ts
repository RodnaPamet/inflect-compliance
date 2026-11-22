/**
 * The behaviour fingerprint reads BEHAVIOUR, never CONTENT (Morpheus roadmap
 * Phase 1, hardening G10: "the column allowlist is the guard that keeps this a
 * behaviour detector and not a content reader").
 *
 * Two halves, and each is useless without the other:
 *
 *   1. THE ALLOWLIST IS CONTENT-FREE. Every column `FINGERPRINT_SOURCE_COLUMNS`
 *      names exists on its model and is an identifier, a count, a timestamp, a
 *      boolean or an enum — judged from the Prisma datamodel, not from the
 *      column's name — and is not in the encrypted-fields manifest. A free-text
 *      String cannot be allowlisted however it is named.
 *   2. THE LEDGER READ STAYS INSIDE THE ALLOWLIST. The one file that reads the
 *      ledger (`agent-behaviour-fingerprint-ledger.ts`) names, in code, no
 *      scalar column of the source tables outside the list. Comments are
 *      blanked first, so the file may explain itself.
 *
 * Both halves are mutation-proved below against in-memory variants, so a
 * detector that went blind would fail here rather than pass silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';

import { FINGERPRINT_SOURCE_COLUMNS } from '@/lib/agentic/behaviour-fingerprint';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { allCallExpressionsOf, codeOf } from '../helpers/source-blocks';

const LEDGER_FILE = path.resolve(__dirname, '../../src/app-layer/usecases/agent-behaviour-fingerprint-ledger.ts');

type DmmfField = (typeof Prisma.dmmf.datamodel.models)[number]['fields'][number];

function modelFields(model: string): readonly DmmfField[] {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
    if (!m) throw new Error(`model ${model} is not in the datamodel`);
    return m.fields;
}

/** Why a column could carry content, or null when it cannot. */
function contentRisk(model: string, column: string): string | null {
    const field = modelFields(model).find((f) => f.name === column);
    if (!field) return `${model}.${column} does not exist`;
    if (field.kind !== 'scalar' && field.kind !== 'enum') return `${model}.${column} is a ${field.kind}, not a column`;
    if ((ENCRYPTED_FIELDS[model] ?? []).includes(column)) return `${model}.${column} is an encrypted field`;
    if (field.kind === 'enum') return null;
    if (['Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Boolean'].includes(field.type)) return null;
    // A String is admitted only as an identifier. Judged on the name AND the
    // absence of a list type: `toolNames String[]` is not an id.
    if (field.type === 'String' && !field.isList && (column === 'id' || /Id$/.test(column))) return null;
    return `${model}.${column} is a ${field.type}${field.isList ? '[]' : ''} that is not an identifier`;
}

const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

/**
 * Scalar columns each table's query names outside that table's allowlist.
 *
 * Judged PER CALL: `createdAt` is allowed on AgentProposal and not on
 * AgentBehaviourWindow, and a whole-file word scan cannot tell which table a
 * word belongs to. What the code does with a query's RESULT is bounded by the
 * query's own shape — reading an unselected field off a `groupBy` row is a
 * type error — so the calls are the whole surface.
 */
function unlistedColumnsIn(src: string, allow: Record<string, readonly string[]>): string[] {
    const out: string[] = [];
    for (const [model, allowed] of Object.entries(allow)) {
        for (const call of allCallExpressionsOf(src, `db\\.${delegateOf(model)}\\.\\w+`)) {
            for (const f of modelFields(model)) {
                if (f.kind !== 'scalar' && f.kind !== 'enum') continue;
                if (allowed.includes(f.name)) continue;
                if (new RegExp(`\\b${f.name}\\b`).test(call)) out.push(`${model}.${f.name}`);
            }
        }
    }
    return [...new Set(out)].sort();
}

/** Every Prisma delegate the code reaches through `db.` */
function delegatesIn(code: string): string[] {
    return [...new Set([...code.matchAll(/\bdb\.(\w+)\./g)].map((m) => m[1]))].sort();
}

describe('the fingerprint column allowlist is content-free', () => {
    const pairs = Object.entries(FINGERPRINT_SOURCE_COLUMNS).flatMap(([m, cols]) => cols.map((c) => [m, c] as const));

    it('names at least one column of each source table', () => {
        expect(pairs.length).toBeGreaterThan(0);
        for (const cols of Object.values(FINGERPRINT_SOURCE_COLUMNS)) expect(cols.length).toBeGreaterThan(0);
    });

    it.each(pairs)('%s.%s is an identifier, a count, a time or an enum', (model, column) => {
        expect(contentRisk(model, column)).toBeNull();
    });

    it('refuses a content column, whatever its name (mutation)', () => {
        expect(contentRisk('AiDecisionLog', 'outputSummary')).toMatch(/not an identifier/);
        expect(contentRisk('AgentProposal', 'payloadJson')).toMatch(/encrypted field/);
        expect(contentRisk('AgentProposal', 'rationale')).not.toBeNull();
        // A list of tool names is not an identifier of the row, whatever the
        // datamodel reports for its list-ness.
        expect(contentRisk('AgentBehaviourWindow', 'toolNames')).toMatch(/not an identifier/);
        expect(contentRisk('AiDecisionLog', 'guardVerdict')).toMatch(/not an identifier/);
    });
});

describe('the ledger read names no column outside the allowlist', () => {
    const src = fs.readFileSync(LEDGER_FILE, 'utf8');
    const code = codeOf(src);
    const allowedDelegates = Object.keys(FINGERPRINT_SOURCE_COLUMNS).map(delegateOf).sort();

    it('reads every source table it is allowed, and no other table', () => {
        expect(delegatesIn(code)).toEqual(allowedDelegates);
        for (const d of allowedDelegates) {
            expect(allCallExpressionsOf(src, `db\\.${d}\\.\\w+`)).toHaveLength(1);
        }
    });

    it('names no other column of those tables', () => {
        expect(unlistedColumnsIn(src, FINGERPRINT_SOURCE_COLUMNS)).toEqual([]);
    });

    it('would refuse a content column added to a read (mutation)', () => {
        const mutated = src.replace(
            '_sum: { tokensIn: true, tokensOut: true },',
            '_sum: { tokensIn: true, tokensOut: true }, _max: { outputSummary: true },',
        );
        expect(mutated).not.toBe(src);
        expect(unlistedColumnsIn(mutated, FINGERPRINT_SOURCE_COLUMNS)).toEqual(['AiDecisionLog.outputSummary']);
    });

    it('would refuse a column allowed on ANOTHER table (mutation)', () => {
        const mutated = src.replace(
            "by: ['agentId'],\n            where: { tenantId, agentId: { in: ids }, createdAt",
            "by: ['agentId', 'guardVerdict'],\n            where: { tenantId, agentId: { in: ids }, createdAt",
        );
        expect(mutated).not.toBe(src);
        expect(unlistedColumnsIn(mutated, FINGERPRINT_SOURCE_COLUMNS)).toEqual(['AiDecisionLog.guardVerdict']);
    });

    it('would refuse a read of a fourth table (mutation)', () => {
        const mutated = codeOf(src.replace('db.aiDecisionLog.groupBy(', 'db.workflowStep.groupBy('));
        expect(delegatesIn(mutated)).not.toEqual(allowedDelegates);
    });
});
