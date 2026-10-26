/**
 * A crosswalk entry removed from its file stops being a mapping in a database
 * that already imported it, and comes back if the entry does.
 *
 * ═══ WHY ═══
 *
 * `importMappingSet` upserted every entry and deleted nothing, so an entry
 * taken out of a mapping-set file stayed an active `RequirementMapping` in
 * every database that had imported it, for good: gap analysis, traceability
 * and inherited coverage kept reading a relationship the file had withdrawn.
 *
 * The importer now RETIRES such a row (`validTo = now`) instead of deleting
 * it, because `RequirementMapping` already carries a validity window that
 * every read applies through `activeMappingWindow`, and a retired row keeps
 * its history. This runs the real importer against Postgres and reads back
 * through the same repository and usecase the product reads through.
 */
import { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import {
    computeMappingSetHash,
    importMappingSet,
    parseMappingSetString,
} from '@/app-layer/services/mapping-set-importer';
import { RequirementMappingRepository } from '@/app-layer/repositories/RequirementMappingRepository';
import { listAvailableMappingSets } from '@/app-layer/usecases/gap-analysis';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SOURCE = 'RETIRE-TEST-SRC';
const TARGET = 'RETIRE-TEST-TGT';

/** The test crosswalk at a version, naming the given pairs. */
function setYaml(version: number, pairs: Array<[string, string]>): string {
    const entries = pairs
        .map(([s, t]) => `  - source_ref: ${s}\n    target_ref: ${t}\n    strength: RELATED`)
        .join('\n');
    return [
        'urn: urn:inflect:mappingset:retire-test',
        'name: Retirement test',
        `version: ${version}`,
        `source_framework_ref: ${SOURCE}`,
        `target_framework_ref: ${TARGET}`,
        'mapping_entries:',
        entries,
        '',
    ].join('\n');
}

async function importVersion(version: number, pairs: Array<[string, string]>) {
    const stored = parseMappingSetString(setYaml(version, pairs));
    return importMappingSet(prisma, stored, computeMappingSetHash(stored));
}

describeFn('a crosswalk entry removed from its file is retired, and revived if it returns', () => {
    let sourceId: string;
    let targetId: string;

    /** The (source code, target code) pairs the product reads as active, sorted. */
    async function activePairs(): Promise<string[]> {
        const rows = await RequirementMappingRepository.findByFrameworkPair(prisma, {
            sourceFrameworkId: sourceId,
            targetFrameworkId: targetId,
        });
        return rows.map((r) => `${r.sourceRequirement.code}->${r.targetRequirement.code}`).sort();
    }

    async function advertisedCount(): Promise<number | undefined> {
        const sets = await listAvailableMappingSets(prisma);
        return sets.find((s) => s.sourceFramework.key === SOURCE)?.mappingCount;
    }

    async function row(sourceCode: string, targetCode: string) {
        return prisma.requirementMapping.findFirstOrThrow({
            where: {
                sourceRequirement: { code: sourceCode, frameworkId: sourceId },
                targetRequirement: { code: targetCode, frameworkId: targetId },
            },
            select: { id: true, validTo: true, validFrom: true },
        });
    }

    beforeAll(async () => {
        await resetDatabase(prisma);
        const source = await prisma.framework.create({
            data: { key: SOURCE, name: 'Retirement source', version: '1', kind: 'INDUSTRY_STANDARD' },
        });
        const target = await prisma.framework.create({
            data: { key: TARGET, name: 'Retirement target', version: '1', kind: 'INDUSTRY_STANDARD' },
        });
        sourceId = source.id;
        targetId = target.id;
        await prisma.frameworkRequirement.createMany({
            data: [
                { frameworkId: sourceId, code: 'S1', title: 'Source one' },
                { frameworkId: sourceId, code: 'S2', title: 'Source two' },
                { frameworkId: targetId, code: 'T1', title: 'Target one' },
                { frameworkId: targetId, code: 'T2', title: 'Target two' },
            ],
        });
    });

    afterAll(async () => {
        await resetDatabase(prisma);
        await prisma.$disconnect();
    });

    it('imports both entries of version 1 as active mappings', async () => {
        const result = await importVersion(1, [['S1', 'T1'], ['S2', 'T2']]);
        expect(result).toMatchObject({ created: 2, retired: 0, errors: [] });
        expect(await activePairs()).toEqual(['S1->T1', 'S2->T2']);
        expect(await advertisedCount()).toBe(2);
    });

    it('retires the entry version 2 removed, keeping its row', async () => {
        const before = await row('S2', 'T2');
        const result = await importVersion(2, [['S1', 'T1']]);

        expect(result).toMatchObject({ updated: 1, retired: 1, errors: [] });
        expect(await activePairs()).toEqual(['S1->T1']);
        expect(await advertisedCount()).toBe(1);

        const after = await row('S2', 'T2');
        expect(after.id).toBe(before.id);
        expect(after.validTo).toBeInstanceOf(Date);
        expect((await row('S1', 'T1')).validTo).toBeNull();
    });

    it('retires nothing more on a re-import of the same file', async () => {
        const retiredAt = (await row('S2', 'T2')).validTo;
        const result = await importVersion(2, [['S1', 'T1']]);

        expect(result.skippedDuplicate).toBe(true);
        expect((await row('S2', 'T2')).validTo).toEqual(retiredAt);
    });

    it('revives the row when version 3 names the entry again', async () => {
        const before = await row('S2', 'T2');
        const result = await importVersion(3, [['S1', 'T1'], ['S2', 'T2']]);

        expect(result).toMatchObject({ created: 0, updated: 2, retired: 0, errors: [] });
        expect(await activePairs()).toEqual(['S1->T1', 'S2->T2']);
        expect(await advertisedCount()).toBe(2);

        const after = await row('S2', 'T2');
        expect(after.id).toBe(before.id);
        expect(after.validTo).toBeNull();
        expect(after.validFrom).toEqual(before.validFrom);
    });
});
