/**
 * Which of a framework's requirements a workspace has taken on
 * (`usecases/framework/pack-scope.ts`). Narrowed only for a framework with
 * more than one pack AND a workspace that recorded a choice; every other case
 * keeps every requirement in scope, as every surface counted before.
 */
import {
    partitionByScope,
    resolveRequirementScope,
    summariseScope,
} from '@/app-layer/usecases/framework/pack-scope';
import type { PrismaTx } from '@/lib/db-context';

type Cited = { code: string; frameworkId: string };
const chosenPack = (key: string, templates: Cited[][]) => ({
    pack: {
        key,
        templateLinks: templates.map((reqs) => ({
            template: { requirementLinks: reqs.map((requirement) => ({ requirement })) },
        })),
    },
});

function tdb(packCount: number, chosen: ReturnType<typeof chosenPack>[]) {
    const db = {
        frameworkPack: { count: jest.fn().mockResolvedValue(packCount) },
        tenantFrameworkPack: { findMany: jest.fn().mockResolvedValue(chosen) },
    };
    return { db, tx: db as unknown as PrismaTx };
}

describe('resolveRequirementScope', () => {
    it('never narrows a single-pack framework, and does not read the choice', async () => {
        const { db, tx } = tdb(1, [chosenPack('ISO27001_2022_BASE', [[{ code: 'A.5.1', frameworkId: 'fw' }]])]);
        await expect(resolveRequirementScope(tx, 't1', 'fw')).resolves.toEqual({ kind: 'ALL' });
        expect(db.frameworkPack.count).toHaveBeenCalledWith({ where: { frameworkId: 'fw' } });
        expect(db.tenantFrameworkPack.findMany).not.toHaveBeenCalled();
    });

    it('does not narrow a multi-pack framework the workspace recorded no choice for', async () => {
        const { db, tx } = tdb(8, []);
        await expect(resolveRequirementScope(tx, 't1', 'fw')).resolves.toEqual({ kind: 'ALL' });
        const args = db.tenantFrameworkPack.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 't1', frameworkId: 'fw' });
        expect(args.take).toBe(8);
    });

    it('scopes to the codes the chosen packs cite, only from this framework', async () => {
        const { tx } = tdb(8, [
            chosenPack('EU_UAS_OPEN_A3', [
                [{ code: 'UAS.CORE.1', frameworkId: 'fw' }],
                [{ code: 'UAS.A3.1', frameworkId: 'fw' }, { code: 'A.5.1', frameworkId: 'fw-iso' }],
            ]),
            chosenPack('EU_UAS_OPEN_A2', [
                [{ code: 'UAS.CORE.1', frameworkId: 'fw' }],
                [{ code: 'UAS.A2.1', frameworkId: 'fw' }],
            ]),
        ]);
        const scope = await resolveRequirementScope(tx, 't1', 'fw');
        expect(scope.kind).toBe('CHOSEN_PACKS');
        if (scope.kind !== 'CHOSEN_PACKS') return;
        expect(scope.packKeys).toEqual(['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);
        expect([...scope.codes].sort()).toEqual(['UAS.A2.1', 'UAS.A3.1', 'UAS.CORE.1']);
        expect(summariseScope(scope)).toEqual({ kind: 'CHOSEN_PACKS', packKeys: ['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3'] });
    });
});

describe('partitionByScope', () => {
    const reqs = [{ code: 'UAS.CORE.1' }, { code: 'UAS.LUC.1' }, { code: 'UAS.A2.1' }];

    it('keeps every requirement in scope for ALL', () => {
        expect(partitionByScope({ kind: 'ALL' }, reqs)).toEqual({ inScope: reqs, outOfScope: [] });
        expect(summariseScope({ kind: 'ALL' })).toEqual({ kind: 'ALL' });
    });

    it('splits by code and keeps the input order on each side', () => {
        const scope = { kind: 'CHOSEN_PACKS' as const, packKeys: ['EU_UAS_OPEN_A2'], codes: new Set(['UAS.A2.1', 'UAS.CORE.1']) };
        expect(partitionByScope(scope, reqs)).toEqual({
            inScope: [{ code: 'UAS.CORE.1' }, { code: 'UAS.A2.1' }],
            outOfScope: [{ code: 'UAS.LUC.1' }],
        });
    });
});
