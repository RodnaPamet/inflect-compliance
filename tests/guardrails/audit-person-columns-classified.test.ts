/**
 * Every schema column named like an e-mail or a name is classified (#5950
 * part 2, owner decision 2026-11-25).
 *
 * The Prisma audit extension records the values of the columns an update or
 * upsert changed, into an immutable, hash-chained row whose `detailsJson`
 * streams to the tenant's SIEM. A person's name or address written there can
 * never be erased. `PERSON_COLUMNS` (src/lib/security/person-columns.ts) is
 * what tells the extension to record such a column by name only.
 *
 * A list nobody is made to extend goes stale the day a model is added, so this
 * fails while any `String` / `Json` column whose name matches `/mail|name/i` is
 * in neither `PERSON_COLUMNS` nor `NOT_PERSON_COLUMNS` (with a reason), and
 * while either list names a column the schema no longer has.
 *
 * The population is a name pattern, so it is an approximation in both
 * directions: it asks about `Tool.toolName`, which is never a person, and it
 * cannot see a person column named otherwise (`VendorContact.phone` is listed
 * voluntarily). It errs towards asking.
 */
import { parseSchemaModels, type SchemaModel } from '../helpers/prisma-schema-models';
import { NOT_PERSON_COLUMNS, PERSON_COLUMNS } from '@/lib/security/person-columns';

type ModelShape = Pick<SchemaModel, 'name' | 'fields'>;

const PERSON_SHAPED_NAME = /mail|name/i;
const TEXT_TYPES = new Set(['String', 'Json']);

/** `Model.field` for every column whose name looks like an address or a name. */
function personShapedColumns(models: readonly ModelShape[]): string[] {
    const out: string[] = [];
    for (const m of models) {
        for (const f of m.fields) {
            if (TEXT_TYPES.has(f.type) && PERSON_SHAPED_NAME.test(f.name)) out.push(`${m.name}.${f.name}`);
        }
    }
    return out;
}

function personColumnKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [model, fields] of Object.entries(PERSON_COLUMNS)) {
        for (const f of fields) keys.add(`${model}.${f}`);
    }
    return keys;
}

/** The columns of `models` that are person-shaped and classified in neither list. */
function unclassified(models: readonly ModelShape[]): string[] {
    const person = personColumnKeys();
    return personShapedColumns(models).filter((c) => !person.has(c) && !(c in NOT_PERSON_COLUMNS));
}

describe('person-shaped schema columns are classified for the audit diff (#5950)', () => {
    const models = parseSchemaModels();

    it('the population is the real schema, not an empty one', () => {
        // Employee.fullName is the column this exists for; if the parser stops
        // seeing it, every assertion below passes over nothing.
        expect(personShapedColumns(models)).toEqual(
            expect.arrayContaining(['Employee.fullName', 'Employee.workEmail', 'ConnectedIdentityAccount.email']),
        );
    });

    it('every such column is a person column, or not-a-person with a reason', () => {
        expect(unclassified(models)).toEqual([]);
    });

    it('fails on a planted, unclassified column', () => {
        const planted: ModelShape = {
            name: 'Employee',
            fields: [
                ...models.find((m) => m.name === 'Employee')!.fields,
                { name: 'fooEmail', type: 'String', isList: false, isOptional: true, dbColumn: 'fooEmail' },
            ],
        };
        expect(unclassified([planted])).toEqual(['Employee.fooEmail']);
    });

    it('every listed column exists in the schema (no stale entries)', () => {
        const present = new Set<string>();
        for (const m of models) for (const f of m.fields) present.add(`${m.name}.${f.name}`);
        const stale = [...personColumnKeys(), ...Object.keys(NOT_PERSON_COLUMNS)].filter((c) => !present.has(c));
        expect(stale).toEqual([]);
    });

    it('no column is classified both ways', () => {
        const person = personColumnKeys();
        expect(Object.keys(NOT_PERSON_COLUMNS).filter((c) => person.has(c))).toEqual([]);
    });

    it('every not-a-person entry carries a written reason', () => {
        const empty = Object.entries(NOT_PERSON_COLUMNS).filter(([, reason]) => reason.trim().length < 10);
        expect(empty).toEqual([]);
    });

    it('the workspace sender settings are configuration, by owner decision (2026-11-25)', () => {
        for (const c of [
            'TenantNotificationSettings.defaultFromName',
            'TenantNotificationSettings.defaultFromEmail',
            'TenantNotificationSettings.complianceMailbox',
        ]) {
            expect(NOT_PERSON_COLUMNS[c]).toMatch(/configuration/);
        }
    });
});
