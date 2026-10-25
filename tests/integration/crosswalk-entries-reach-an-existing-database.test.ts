/**
 * A crosswalk entry that named a heading reaches a database that imported its
 * set while it did, once the heading becomes a leaf.
 *
 * ═══ WHY ═══
 *
 * Until version 2 of the ISO 27701 library, its clause 6 was marked
 * non-assessable. `library-importer.ts` writes a requirement row only for an
 * assessable node, so every crosswalk entry naming it was dropped at import:
 * A.5.1, A.5.24 and A.5.26 into clause 6, and clause 6 out to GDPR Articles 33
 * and 34, which is the whole breach-notification path from ISO 27001 to GDPR.
 *
 * Making the clause assessable is half the fix. A database that already
 * imported `iso27701-to-gdpr` holds the set with those two entries missing,
 * and the importer skips a set whose content hash matches the stored one. The
 * set's entries did not change, so without its version bump that database
 * would never import it again and the two entries would never arrive. This
 * runs that database through the upgrade, with the bump and without it.
 *
 * The files are written from the shipped ones, so the "after" state is the
 * shipped data and the "before" state differs only where the history says it
 * did: clause 6 non-assessable and both sets at version 1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { REPO_ROOT } from '../helpers/repo-files';
import { parseLibraryFile } from '@/app-layer/libraries';
import { syncAllLibraries } from '@/app-layer/usecases/library-sync';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SHIPPED = path.join(REPO_ROOT, 'src/data/libraries');
const LIBRARIES = ['iso27001-2022.yaml', 'iso27701-2019.yaml', 'gdpr.yaml'];
const SETS = ['iso27001-to-iso27701.yaml', 'iso27701-to-gdpr.yaml'];
const CLAUSE = '6';

type Doc = Record<string, unknown>;
const readYaml = (file: string): Doc => yaml.load(fs.readFileSync(file, 'utf8')) as Doc;

/** The ISO 27701 library as version 1 shipped it: clause 6 a heading. */
function iso27701AtVersion1(): Doc {
    const stored = parseLibraryFile(path.join(SHIPPED, 'iso27701-2019.yaml'));
    const nodes = stored.objects.framework.requirement_nodes.map((n) =>
        n.ref_id === CLAUSE ? { ...n, assessable: false } : n,
    );
    const { text_hash: _textHash, ...rest } = stored;
    return { ...rest, version: 1, objects: { ...stored.objects, framework: { ...stored.objects.framework, requirement_nodes: nodes } } };
}

/**
 * Write a library directory and its `mappings/` beside it. `libraries` and
 * `sets` override a shipped file by name; anything not named is copied as it
 * ships.
 */
function writeTree(root: string, overrides: { libraries?: Record<string, Doc>; sets?: Record<string, Doc> }) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'mappings'), { recursive: true });
    for (const f of LIBRARIES) {
        const doc = overrides.libraries?.[f];
        if (doc) fs.writeFileSync(path.join(root, f), yaml.dump(doc));
        else fs.copyFileSync(path.join(SHIPPED, f), path.join(root, f));
    }
    for (const f of SETS) {
        const doc = overrides.sets?.[f];
        if (doc) fs.writeFileSync(path.join(root, 'mappings', f), yaml.dump(doc));
        else fs.copyFileSync(path.join(SHIPPED, 'mappings', f), path.join(root, 'mappings', f));
    }
    return { librariesDir: root, mappingsDir: path.join(root, 'mappings') };
}

/** A shipped set as it was at version 1: the same entries, the old version. */
const setAtVersion1 = (f: string): Doc => ({ ...readYaml(path.join(SHIPPED, 'mappings', f)), version: 1 });

/** Mapping rows whose source is ISO 27701 clause 6 and whose target is a GDPR article. */
async function clause6ToGdpr(): Promise<string[]> {
    const rows = await prisma.requirementMapping.findMany({
        where: {
            sourceRequirement: { code: CLAUSE, framework: { key: 'ISO27701-2019' } },
            targetRequirement: { framework: { key: 'GDPR' } },
        },
        select: { targetRequirement: { select: { code: true } } },
    });
    return rows.map((r) => r.targetRequirement.code).sort();
}

const droppedEntries = (r: Awaited<ReturnType<typeof syncAllLibraries>>) =>
    r.mappingSets.results.flatMap((s) => s.errors.map((e) => `${s.sourceFrameworkRef}: ${e.message}`));

describeFn('a crosswalk entry naming a former heading reaches a database that already holds its set', () => {
    let tmp: string;
    let v1: Awaited<ReturnType<typeof syncAllLibraries>>;
    let withoutBump: Awaited<ReturnType<typeof syncAllLibraries>>;
    let shipped: Awaited<ReturnType<typeof syncAllLibraries>>;
    const rowsAfter: Record<string, string[]> = {};
    let syncStartedAt: Date;

    beforeAll(async () => {
        await resetDatabase(prisma);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosswalk-existing-db-'));
        const versionOneSets = Object.fromEntries(SETS.map((f) => [f, setAtVersion1(f)]));

        // 1. The database as version 1 left it.
        syncStartedAt = new Date();
        v1 = await syncAllLibraries(prisma, writeTree(path.join(tmp, 'v1'), {
            libraries: { 'iso27701-2019.yaml': iso27701AtVersion1() },
            sets: versionOneSets,
        }));
        rowsAfter.v1 = await clause6ToGdpr();

        // 2. The library fix alone: clause 6 is a leaf, the sets keep version 1.
        withoutBump = await syncAllLibraries(prisma, writeTree(path.join(tmp, 'no-bump'), { sets: versionOneSets }));
        rowsAfter.withoutBump = await clause6ToGdpr();

        // 3. What ships.
        shipped = await syncAllLibraries(prisma, writeTree(path.join(tmp, 'shipped'), {}));
        rowsAfter.shipped = await clause6ToGdpr();
    });

    afterAll(async () => {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        await prisma.$disconnect();
    });

    it('version 1 drops every entry naming clause 6, and only those', () => {
        expect(v1.results.every((r) => r.action === 'created')).toBe(true);
        expect(v1.mappingSets.results).toHaveLength(SETS.length);
        const dropped = droppedEntries(v1);
        expect(dropped.length).toBeGreaterThan(0);
        expect(dropped.every((m) => /requirement "6" not found/.test(m))).toBe(true);
        expect(rowsAfter.v1).toEqual([]);
    });

    it('making the clause a leaf adds it, and tells tenants of nothing but one new requirement', async () => {
        const iso = withoutBump.results.find((r) => r.frameworkKey === 'ISO27701-2019');
        expect(iso?.action).toBe('updated');
        const rows = await prisma.frameworkRequirement.findMany({
            where: { framework: { key: 'ISO27701-2019' }, code: CLAUSE },
            select: { code: true },
        });
        expect(rows.map((r) => r.code)).toEqual([CLAUSE]);

        const diff = await prisma.frameworkVersionDiff.findFirstOrThrow({
            where: { frameworkKey: 'ISO27701-2019', fromVersion: '1', toVersion: '2', createdAt: { gte: syncStartedAt } },
        });
        expect(JSON.parse(diff.addedCodesJson)).toEqual([CLAUSE]);
        expect(JSON.parse(diff.changedCodesJson)).toEqual([]);
        expect(JSON.parse(diff.removedCodesJson)).toEqual([]);
    });

    it('without the version bump, a set whose entries did not change is skipped and its entries never arrive', () => {
        expect(withoutBump.mappingSets.results.every((r) => r.skippedDuplicate)).toBe(true);
        expect(rowsAfter.withoutBump).toEqual([]);
    });

    it('with it, both sets import again and every entry resolves', () => {
        expect(shipped.mappingSets.results).toHaveLength(SETS.length);
        expect(shipped.mappingSets.results.every((r) => !r.skippedDuplicate)).toBe(true);
        expect(droppedEntries(shipped)).toEqual([]);
        expect(rowsAfter.shipped).toEqual(['Art.33', 'Art.34']);
    });
});
