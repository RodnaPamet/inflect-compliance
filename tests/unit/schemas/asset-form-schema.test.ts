/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — new-asset form Zod schema (previously ~0%).
 *
 * Exercises defaults, the AssetType enum, the status enum, and the
 * shared CIA scale (int / min(1) / max(5)) across the three
 * confidentiality/integrity/availability fields.
 */
import { NewAssetFormSchema, ASSET_TYPE_VALUES } from '@/lib/schemas/asset-form';

describe('ASSET_TYPE_VALUES', () => {
    it('contains the expected set of asset types', () => {
        expect(ASSET_TYPE_VALUES).toContain('INFORMATION');
        expect(ASSET_TYPE_VALUES).toContain('OTHER');
        // LITERAL ON PURPOSE — do not derive. ASSET_TYPE_VALUES is the closed
        // vocabulary backing `z.enum(...)`, a filter facet and a dropdown; the
        // two `toContain`s above pin only 2 of the 10, so this count is what
        // makes an eleventh asset type a decision instead of an append.
        expect(ASSET_TYPE_VALUES).toHaveLength(10);
    });
});

describe('NewAssetFormSchema', () => {
    const minimalValid = {
        name: 'Server',
        type: 'SYSTEM' as const,
        confidentiality: 3,
        integrity: 3,
        availability: 3,
    };

    it('applies defaults for a minimal valid input', () => {
        const r = NewAssetFormSchema.parse(minimalValid);
        expect(r.name).toBe('Server');
        expect(r.type).toBe('SYSTEM');
        expect(r.status).toBe('ACTIVE'); // default
        expect(r.classification).toBe('');
        expect(r.ownerUserId).toBe('');
        expect(r.location).toBe('');
        expect(r.dataResidency).toBe('');
    });

    it('trims the name', () => {
        const r = NewAssetFormSchema.parse({ ...minimalValid, name: '  Box  ' });
        expect(r.name).toBe('Box');
    });

    it('parses a fully-populated valid input', () => {
        const r = NewAssetFormSchema.parse({
            name: 'DB',
            type: 'DATA_STORE',
            status: 'RETIRED',
            classification: 'Confidential',
            ownerUserId: 'usr_1',
            location: 'eu-west-1',
            dataResidency: 'EU',
            confidentiality: 5,
            integrity: 1,
            availability: 4,
        });
        expect(r.status).toBe('RETIRED');
        expect(r.confidentiality).toBe(5);
        expect(r.integrity).toBe(1);
    });

    // name required / min(1)
    it('rejects a missing name', () => {
        expect(
            NewAssetFormSchema.safeParse({
                type: 'SYSTEM',
                confidentiality: 1,
                integrity: 1,
                availability: 1,
            } as any).success,
        ).toBe(false);
    });

    it('rejects an empty name after trim', () => {
        expect(NewAssetFormSchema.safeParse({ ...minimalValid, name: '   ' }).success).toBe(
            false,
        );
    });

    // name max(255)
    it('rejects an over-long name', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, name: 'a'.repeat(256) }).success,
        ).toBe(false);
    });

    // type enum branch
    it('rejects an unknown asset type', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, type: 'ROBOT' as any }).success,
        ).toBe(false);
    });

    // status enum branch
    it('rejects an invalid status', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, status: 'PENDING' as any })
                .success,
        ).toBe(false);
    });

    // CIA int() branch
    it('rejects a non-integer CIA value', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, confidentiality: 3.5 }).success,
        ).toBe(false);
    });

    // CIA min(1) branch
    it('rejects a CIA value below 1', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, integrity: 0 }).success,
        ).toBe(false);
    });

    // CIA max(5) branch
    it('rejects a CIA value above 5', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, availability: 6 }).success,
        ).toBe(false);
    });

    // CIA wrong type branch
    it('rejects a non-numeric CIA value', () => {
        expect(
            NewAssetFormSchema.safeParse({ ...minimalValid, confidentiality: 'high' as any })
                .success,
        ).toBe(false);
    });
});
