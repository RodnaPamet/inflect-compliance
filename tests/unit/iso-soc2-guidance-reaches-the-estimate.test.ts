/**
 * The ISO 27001 → SOC 2 guidance reaches the readiness estimate (#5174).
 *
 * `usecases/mapping.ts` matches a SOC 2 requirement by `soc2Codes.includes(req.code)`,
 * and the requirements it lists are the ASSESSABLE SOC 2 nodes. When the ISO
 * library's edges named the CC1..CC9 headings, 'CC6' never equalled 'CC6.1' and
 * every Common Criterion showed no related ISO control.
 */
import { getFrameworkMappings, getSOC2Requirements } from '@/app-layer/libraries/framework-provider';

describe('ISO 27001 → SOC 2 guidance mappings', () => {
    const mappings = getFrameworkMappings();
    const listed = new Set(getSOC2Requirements().map((r) => r.code));

    it('every SOC 2 code a mapping names is one the estimate lists', () => {
        const unlisted = mappings.flatMap((m) =>
            m.soc2Codes.filter((c) => !listed.has(c)).map((c) => `${m.isoControlId} -> ${c}`),
        );
        expect(listed.size).toBeGreaterThan(10);
        expect(unlisted).toEqual([]);
    });

    it('gives every Common Criterion in the catalogue at least one ISO control', () => {
        const covered = new Set(mappings.flatMap((m) => m.soc2Codes));
        const ccWithout = [...listed].filter((c) => c.startsWith('CC') && !covered.has(c));
        // CC2.1, CC6.5 and CC6.6 had no ISO edge after #5174; A.8.15/A.8.16,
        // A.7.14/A.8.10 and A.8.20/A.8.22 now reach them.
        expect(ccWithout).toEqual([]);
    });

    it('maps access control to the access criteria it supports', () => {
        const a515 = mappings.find((m) => m.isoControlId === 'A.5.15');
        expect(a515?.soc2Codes).toEqual(expect.arrayContaining(['CC6.1', 'CC6.3']));
    });
});
