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

    it('a code the library drops and later re-adds is revived, not created twice (#5113)', async () => {
        // A.2 was deprecated by the hash-v2 import above. Re-adding it used to
        // `create` a second (frameworkId, code) row and fail on the unique key,
        // every sync.
        const fw = await prisma.framework.findFirstOrThrow({ where: { key: KEY } });
        const before = await prisma.frameworkRequirement.findFirstOrThrow({ where: { frameworkId: fw.id, code: 'A.2' } });
        expect(before.deprecatedAt).not.toBeNull();

        const result = await importLibrary(
            prisma,
            makeLib({
                contentHash: 'hash-v4',
                nodes: [
                    { refId: 'A.1', name: 'Req One', category: 'Cat', assessable: true },
                    { refId: 'A.2', name: 'Req Two, again', category: 'Cat', assessable: true },
                    { refId: 'A.3', name: 'Req Three', category: 'Cat', assessable: true },
                ],
            }),
        );

        expect(result.action).toBe('updated');
        const after = await prisma.frameworkRequirement.findFirstOrThrow({ where: { frameworkId: fw.id, code: 'A.2' } });
        expect(after.id).toBe(before.id);
        expect(after.deprecatedAt).toBeNull();
        expect(after.title).toBe('Req Two, again');
        expect((await prisma.framework.findFirstOrThrow({ where: { key: KEY } })).contentHash).toBe('hash-v4');
    });

    it('an import that fails half way leaves the old hash, so the next sync repairs it (#5113)', async () => {
        // A client whose requirement writes fail, as a crash or a dropped
        // connection would make them.
        const failing = new Proxy(prisma, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (prop !== 'frameworkRequirement') return value;
                return new Proxy(value as object, {
                    get(delegate, method, r) {
                        if (method === 'upsert' || method === 'create' || method === 'update') {
                            return () => Promise.reject(new Error('connection lost'));
                        }
                        return Reflect.get(delegate, method, r);
                    },
                });
            },
        }) as typeof prisma;
        const v5 = makeLib({
            contentHash: 'hash-v5',
            nodes: [
                { refId: 'A.1', name: 'Req One', category: 'Cat', assessable: true },
                { refId: 'A.4', name: 'Req Four', category: 'Cat', assessable: true },
            ],
        });

        await expect(importLibrary(failing, v5)).rejects.toThrow('connection lost');
        expect((await prisma.framework.findFirstOrThrow({ where: { key: KEY } })).contentHash).toBe('hash-v4');

        // The next sync does the work instead of skipping it.
        const retry = await importLibrary(prisma, v5);
        expect(retry.action).toBe('updated');
        const fw = await prisma.framework.findFirstOrThrow({ where: { key: KEY } });
        expect(fw.contentHash).toBe('hash-v5');
        expect(await prisma.frameworkRequirement.count({ where: { frameworkId: fw.id, code: 'A.4', deprecatedAt: null } })).toBe(1);
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
