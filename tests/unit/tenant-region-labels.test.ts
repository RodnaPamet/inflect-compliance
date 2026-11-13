/**
 * Every `TenantRegion` value has a name a person can read, in every locale,
 * and a place in `src/lib/regions.ts` (#5288).
 *
 * The privacy page prints the region through
 * `admin.privacy.residency.regionName.<value>` and falls back to the raw enum
 * identifier when the key is missing, so a value added without a label shows
 * a customer `EUROPE_WEST1` as their residency commitment.
 */
import { TenantRegion } from '@prisma/client';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';
import { OPERATIONALLY_PROVISIONED_REGIONS, PLANNED_REGIONS } from '@/lib/regions';

const VALUES = Object.values(TenantRegion);
const names = (m: unknown): Record<string, string> =>
    (m as { admin: { privacy: { residency: { regionName: Record<string, string> } } } }).admin.privacy.residency
        .regionName;

describe('TenantRegion labels', () => {
    it('declares the europe-west1 value', () => {
        expect(VALUES).toContain('EUROPE_WEST1');
    });

    it.each([
        ['en', en],
        ['bg', bg],
    ])('every value has a %s name', (_locale, messages) => {
        const missing = VALUES.filter((v) => !names(messages)[v]);
        expect(missing).toEqual([]);
    });

    it('labels europe-west1 as Belgium, not Ireland', () => {
        expect(names(en).EUROPE_WEST1).toBe('European Union (Belgium)');
    });

    it('every value is provisioned or has a plan', () => {
        const unplaced = VALUES.filter(
            (v) => !OPERATIONALLY_PROVISIONED_REGIONS.includes(v) && !(v in PLANNED_REGIONS),
        );
        expect(unplaced).toEqual([]);
    });
});
