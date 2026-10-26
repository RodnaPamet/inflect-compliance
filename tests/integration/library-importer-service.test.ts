/**
 * Integration coverage for `src/app-layer/services/library-importer.ts`.
 *
 * DB-backed (real Framework/FrameworkRequirement — a GLOBAL catalogue,
 * no tenantId/RLS). Uses a synthetic LoadedLibrary so we control the
 * content hash + node set and can drive every branch deterministically:
 *
 *   - first import → action 'created', requirements created, history seeded.
 *   - unchanged re-import (same hash, no force) → action 'skipped'.
 *   - force=true on unchanged → update path (action 'updated').
 *   - content-changed re-import (new hash) → update path with adds +
 *     deprecations (changed node set, deprecateMissing default true).
 *   - deprecateMissing=false skips the deprecation branch.
 *   - mapKindToPrisma fallback (unknown kind → ISO_STANDARD).
 */
import { PrismaClient, FrameworkKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { importLibrary } from '@/app-layer/services/library-importer';
import type { LoadedLibrary } from '@/app-layer/libraries';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const KEY = `LIBTEST-${randomUUID().slice(0, 8)}`;

interface NodeSpec { refId: string; name: string; assessable?: boolean; category?: string; section?: string; description?: string }

function makeLib(over: { contentHash?: string; kind?: string; nodes?: NodeSpec[] } = {}): LoadedLibrary {
    const nodeSpecs: NodeSpec[] = over.nodes ?? [
        { refId: 'A.1', name: 'Req One', category: 'Cat', section: 'Sec', description: 'd1', assessable: true },
        { refId: 'A.2', name: 'Req Two', category: 'Cat', assessable: true },
        { refId: 'GROUP', name: 'Non-assessable group', assessable: false },
    ];
    const nodes = nodeSpecs.map((n) => ({
        urn: `urn:n:${KEY}:${n.refId}`,
        refId: n.refId,
        name: n.name,
        description: n.description,
        category: n.category,
        section: n.section,
        assessable: n.assessable ?? true,
        depth: 1,
        childUrns: [],
    }));
    return {
        urn: `urn:lib:${KEY}`,
        locale: 'en',
        refId: KEY,
        name: 'Lib Test',
        description: 'desc',
        version: 1,
        kind: (over.kind ?? 'ISO_STANDARD') as FrameworkKind,
        dependencies: [],
        contentHash: over.contentHash ?? 'hash-v1',
        mappings: [],
        framework: {
            urn: `urn:fw:${KEY}`,
            refId: KEY,
            name: 'Lib Test',
            nodes,
            nodesByUrn: new Map(),
            nodesByRefId: new Map(),
            rootNodes: [],
        },
    } as unknown as LoadedLibrary;
}

describeFn('library-importer service (real DB, synthetic library)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    async function wipe() {
        for (const key of [KEY, `${KEY}-unk`]) {
            const fw = await prisma.framework.findFirst({ where: { key } });
            if (fw) {
                await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: fw.id } });
                await prisma.framework.delete({ where: { id: fw.id } });
            }
        }
    }

    it('first import → created with only assessable requirements + history', async () => {
        const result = await importLibrary(prisma, makeLib());
        expect(result.action).toBe('created');
        expect(result.requirementsCreated).toBe(2); // GROUP is non-assessable
        const fw = await prisma.framework.findFirstOrThrow({ where: { key: KEY } });
        expect(fw.contentHash).toBe('hash-v1');
        expect(fw.metadataJson).toContain('versionHistory');
    });

    it('unchanged re-import → skipped', async () => {
        const result = await importLibrary(prisma, makeLib());
        expect(result.action).toBe('skipped');
        expect(result.requirementsCreated).toBe(0);
    });

    it('force=true on unchanged → update path', async () => {
        const result = await importLibrary(prisma, makeLib(), { force: true });
        expect(result.action).toBe('updated');
    });

    it('content change → update with adds + deprecations (deprecateMissing default)', async () => {
        // Drop A.2, add A.3 → A.2 deprecated, A.3 created.
        const result = await importLibrary(
            prisma,
            makeLib({
                contentHash: 'hash-v2',
                nodes: [
                    { refId: 'A.1', name: 'Req One', category: 'Cat', assessable: true },
                    { refId: 'A.3', name: 'Req Three', category: 'Cat', assessable: true },
                ],
            }),
        );
        expect(result.action).toBe('updated');
        expect(result.requirementsCreated).toBeGreaterThanOrEqual(1);
        expect(result.requirementsDeprecated).toBeGreaterThanOrEqual(1);
    });

    it('deprecateMissing=false skips the deprecation branch', async () => {
        const result = await importLibrary(
            prisma,
            makeLib({
                contentHash: 'hash-v3',
                nodes: [{ refId: 'A.1', name: 'Req One', category: 'Cat', assessable: true }],
            }),
            { deprecateMissing: false },
        );
        expect(result.action).toBe('updated');
        expect(result.requirementsDeprecated).toBe(0);
    });

    it('mapKindToPrisma falls back to ISO_STANDARD for an unknown kind', async () => {
        const lib = makeLib({ kind: 'TOTALLY_UNKNOWN' });
        // fresh key so it inserts
        const mutated = { ...lib, refId: `${KEY}-unk`, urn: `${lib.urn}:unk`, contentHash: 'unk' } as LoadedLibrary;
        const result = await importLibrary(prisma, mutated);
        expect(result.action).toBe('created');
        const fw = await prisma.framework.findFirstOrThrow({ where: { key: `${KEY}-unk` } });
        expect(fw.kind).toBe('ISO_STANDARD');
    });
});
