/**
 * `buildDiffJson` names a person column and records no value of it (#5950
 * part 2). The integration suite `tests/integration/audit-diff-person-columns`
 * drives the real extension; these are the cases a database makes awkward.
 */
import { buildDiffJson } from '@/lib/prisma';
import { PERSON_COLUMNS } from '@/lib/security/person-columns';

describe('the manifest entries these cases stand on', () => {
    it('User and VendorContact list their address columns', () => {
        expect(PERSON_COLUMNS.User).toEqual(expect.arrayContaining(['email', 'emailHash', 'name']));
        expect(PERSON_COLUMNS.VendorContact).toEqual(expect.arrayContaining(['email', 'emailHash']));
    });
});

describe('a person column is named, never recorded (#5950)', () => {
    it('a PII column whose prior row was read DECRYPTED keeps that plaintext out of `before`', () => {
        // `User.email` is `@map`'d to its ciphertext; the extension sees
        // ciphertext in `data` and `result`, and the decrypted value in the
        // prior row read through the extended client.
        const diff = buildDiffJson(
            'update',
            { email: 'v2:cipher', emailHash: 'a'.repeat(64) },
            { email: 'v2:cipher', emailHash: 'a'.repeat(64) },
            { email: 'alice@example.test', emailHash: 'b'.repeat(64) },
            'User',
        );
        expect(JSON.stringify(diff)).not.toContain('alice@example.test');
        expect(JSON.stringify(diff)).not.toContain('a'.repeat(64));
        expect(diff?.withheldFields).toEqual(['email', 'emailHash']);
        expect(diff?.after).toEqual({});
        expect(diff?.before).toEqual({});
    });

    it('an upsert with no prior row (an insert) names the columns and records no value', () => {
        const diff = buildDiffJson(
            'upsert',
            { email: 'bob@vendor.test', title: 'CFO' },
            { email: 'bob@vendor.test', title: 'CFO' },
            null,
            'VendorContact',
        );
        expect(diff?.changedFields).toEqual(['email', 'title']);
        expect(diff?.withheldFields).toEqual(['email']);
        expect(diff?.after).toEqual({ title: 'CFO' });
        expect(JSON.stringify(diff)).not.toContain('bob@vendor.test');
    });

    it('a person column whose value did not move is not reported at all', () => {
        const diff = buildDiffJson(
            'update',
            { fullName: 'Same Name', jobTitle: 'Lead' },
            { fullName: 'Same Name', jobTitle: 'Lead' },
            { fullName: 'Same Name', jobTitle: 'Analyst' },
            'Employee',
        );
        expect(diff?.changedFields).toEqual(['jobTitle']);
        expect(diff).not.toHaveProperty('withheldFields');
    });

    it('the same field name on a model with no person columns keeps its value', () => {
        // `name` is a person on User and a thing on Control: the manifest is
        // per model, never a flat set of field names.
        const diff = buildDiffJson('update', { name: 'Access control' }, { name: 'Access control' }, { name: 'Old' }, 'Control');
        expect(diff?.after).toEqual({ name: 'Access control' });
        expect(diff?.before).toEqual({ name: 'Old' });
        expect(diff).not.toHaveProperty('withheldFields');
    });

    it('without a model the four-argument call keeps its behaviour', () => {
        const diff = buildDiffJson('update', { name: 'x' }, { name: 'x' }, undefined);
        expect(diff?.after).toEqual({ name: 'x' });
    });
});
