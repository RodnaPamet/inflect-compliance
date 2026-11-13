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

    it('reaches every Common Criterion but the three no ISO edge names', () => {
        const covered = new Set(mappings.flatMap((m) => m.soc2Codes));
        const ccWithout = [...listed].filter((c) => c.startsWith('CC') && !covered.has(c));
        // CC2.1 (quality information), CC6.5 (asset and media disposal) and
        // CC6.6 (boundary protection) have no ISO guidance edge: #5174
        // re-pointed the existing edges and added none. Every other Common
        // Criterion in the catalogue is reached.
        expect(ccWithout.sort()).toEqual(['CC2.1', 'CC6.5', 'CC6.6']);
    });

    it('maps access control to the access criteria it supports', () => {
        const a515 = mappings.find((m) => m.isoControlId === 'A.5.15');
        expect(a515?.soc2Codes).toEqual(expect.arrayContaining(['CC6.1', 'CC6.3']));
    });
});
