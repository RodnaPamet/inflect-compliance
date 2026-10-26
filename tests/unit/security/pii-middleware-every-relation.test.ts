/**
 * Every relation into a PII-managed model comes back decrypted.
 *
 * The nested walk used to recognise relations by a hand-kept list of nine
 * NAMES. Three of the nine were relations nowhere in the schema, and 29 real
 * relations into a managed model were missing (`AccessReview.reviewer`,
 * `createdBy`, `approvedBy`, `decidedBy`, …). A read through any of them
 * returned ciphertext: access-review reminders were queued to a `v1:…`
 * address, and evidence PDFs printed one.
 *
 * The population here is read from Prisma's own data model, so it is not a
 * second hand-kept list: a relation added to the schema is tested the day it
 * exists. For each one, a row of the PARENT model carries the relation with
 * ciphertext in every managed field of the target, and the middleware must
 * hand back plaintext.
 */
import { Prisma } from '@prisma/client';

import { piiEncryptionMiddleware, _getPiiFieldMap } from '@/lib/security/pii-middleware';
import { encryptField } from '@/lib/security/encryption';

interface ManagedRelation {
    parent: string;
    field: string;
    target: string;
    isList: boolean;
}

const MANAGED_RELATIONS: ManagedRelation[] = Prisma.dmmf.datamodel.models.flatMap((m) =>
    m.fields
        .filter((f) => f.kind === 'object' && _getPiiFieldMap(f.type) !== undefined)
        .map((f) => ({ parent: m.name, field: f.name, target: f.type, isList: f.isList })),
);

const label = (r: ManagedRelation) => `${r.parent}.${r.field} → ${r.target}${r.isList ? '[]' : ''}`;

describe('the population', () => {
    it('is read from the schema and holds the relations the old name list missed', () => {
        const names = MANAGED_RELATIONS.map((r) => `${r.parent}.${r.field}`);
        // Positive controls: an empty population would make every case below vacuous.
        expect(names).toEqual(
            expect.arrayContaining([
                'AccessReview.reviewer',
                'AccessReview.createdBy',
                'AccessReview.closedBy',
                'TenantMembership.user',
                'User.identityLinks',
            ]),
        );
    });
});

describe.each(MANAGED_RELATIONS.map((r) => [label(r), r] as const))('%s', (_name, relation) => {
    it('decrypts every managed field of the related row', async () => {
        const specs = _getPiiFieldMap(relation.target)!;
        const expected: Record<string, string> = {};
        const related: Record<string, unknown> = { id: 'related-1' };
        for (const spec of specs) {
            const plaintext = `${relation.target}.${spec.plain}@example.com`;
            expected[spec.plain] = plaintext;
            if (spec.mapped) {
                // The schema field IS the encrypted column.
                related[spec.plain] = encryptField(plaintext);
            } else {
                // Legacy dual-write: a stale plaintext column beside the encrypted one.
                related[spec.plain] = 'stale';
                related[spec.encrypted] = encryptField(plaintext);
            }
        }

        const row = { id: 'parent-1', [relation.field]: relation.isList ? [related] : related };
        const received = (await piiEncryptionMiddleware(
            { model: relation.parent, action: 'findFirst', args: {} },
            async () => row,
        )) as Record<string, unknown>;

        const value = received[relation.field];
        const read = (relation.isList ? (value as unknown[])[0] : value) as Record<string, unknown>;
        for (const [field, plaintext] of Object.entries(expected)) {
            expect(read[field]).toBe(plaintext);
        }
    });
});
