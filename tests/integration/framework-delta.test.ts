/**
 * Integration coverage: the framework-version delta-gap engine end-to-end (real
 * DB, real RLS). Proves:
 *   - a recorded version diff propagates ONLY to tenants with the framework
 *     installed (tenant A installed, tenant B not);
 *   - the installed tenant gets a personalised delta (new gaps = added reqs);
 *   - a CHANGED requirement flags that tenant's mapped control → NEEDS_REVIEW;
 *   - finding materialisation is explicit + idempotent + source-tagged.
 */
import { PrismaClient, FrameworkKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    recordFrameworkVersionDiff,
    propagateFrameworkDelta,
    materializeDeltaFindings,
} from '@/app-layer/usecases/framework-delta';
import { importLibrary } from '@/app-layer/services/library-importer';
import type { LoadedLibrary } from '@/app-layer/libraries';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `fd-${randomUUID().slice(0, 8)}`;
const TENANT_A = `fda-${SUITE}`; // installs the framework
const TENANT_B = `fdb-${SUITE}`; // does NOT
const FW_KEY = `fd-fw-${SUITE}`;
const USER_A = `u-${TENANT_A}`;

const ctxA = () => makeRequestContext('ADMIN', { tenantId: TENANT_A, tenantSlug: TENANT_A, userId: USER_A });
let frameworkId = '';
let reqExistingId = '';
let controlAId = '';
let diffId = '';

describeFn('Framework delta-gap engine (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.tenant.upsert({ where: { id: t }, update: {}, create: { id: t, name: t, slug: t } });
        }
        await prisma.user.upsert({ where: { id: USER_A }, update: {}, create: { id: USER_A, email: `${TENANT_A}@x.test`, emailHash: hashForLookup(`${TENANT_A}@x.test`) } });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT_A, userId: USER_A } },
            update: {}, create: { tenantId: TENANT_A, userId: USER_A, role: 'ADMIN', status: 'ACTIVE' },
        });

        // Framework with three requirements (EXISTING1 changed, NEW1/NEW2 added).
        const fw = await prisma.framework.create({ data: { key: FW_KEY, version: '2', name: 'FD Test FW', kind: 'ISO_STANDARD' } });
        frameworkId = fw.id;
        const reqExisting = await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code: 'EXISTING1', title: 'Existing', section: 'S', sortOrder: 0 } });
        reqExistingId = reqExisting.id;
        for (const code of ['NEW1', 'NEW2']) {
            await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code, title: code, section: 'S', sortOrder: 1 } });
        }

        // Tenant A "installs" the framework: an IMPLEMENTED control linked to EXISTING1.
        const control = await prisma.control.create({ data: { tenantId: TENANT_A, name: 'Control for EXISTING1', status: 'IMPLEMENTED' } });
        controlAId = control.id;
        await prisma.controlRequirementLink.create({ data: { tenantId: TENANT_A, controlId: control.id, requirementId: reqExisting.id } });
    });

    afterAll(async () => {
        await prisma.tenantFrameworkDelta.deleteMany({ where: { frameworkKey: FW_KEY } }).catch(() => {});
        await prisma.frameworkVersionDiff.deleteMany({ where: { frameworkKey: FW_KEY } }).catch(() => {});
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.finding.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.controlRequirementLink.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.control.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.notification.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantMembership.deleteMany({ where: { tenantId: t } }).catch(() => {});
        }
        await prisma.user.deleteMany({ where: { id: USER_A } }).catch(() => {});
        if (frameworkId) {
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } }).catch(() => {});
            await prisma.framework.delete({ where: { id: frameworkId } }).catch(() => {});
        }
        for (const t of [TENANT_A, TENANT_B]) await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('records a version diff and propagates only to the installed tenant', async () => {
        const rec = await recordFrameworkVersionDiff({
            frameworkKey: FW_KEY, fromVersion: '1', toVersion: '2',
            addedCodes: ['NEW1', 'NEW2'], changedCodes: ['EXISTING1'], removedCodes: [],
            changelog: 'test',
        });
        diffId = rec.diffId;

        const result = await propagateFrameworkDelta(diffId);
        expect(result.tenantsAffected).toBe(1); // only tenant A is installed

        // Tenant A got a personalised delta.
        const deltaA = await prisma.tenantFrameworkDelta.findFirst({ where: { tenantId: TENANT_A, diffId } });
        expect(deltaA).toBeTruthy();
        expect(deltaA!.newGapCount).toBe(2); // NEW1, NEW2
        expect(deltaA!.flaggedControlCount).toBe(1); // the EXISTING1 control

        // Tenant B (not installed) got NOTHING.
        const deltaB = await prisma.tenantFrameworkDelta.findFirst({ where: { tenantId: TENANT_B, diffId } });
        expect(deltaB).toBeNull();
    });

    it('flags the changed requirement\'s mapped control for re-review', async () => {
        const control = await prisma.control.findUnique({ where: { id: controlAId } });
        expect(control!.status).toBe('NEEDS_REVIEW');
    });

    it('notifies the installed tenant\'s members', async () => {
        const notes = await prisma.notification.count({ where: { tenantId: TENANT_A, title: { contains: FW_KEY } } });
        expect(notes).toBeGreaterThanOrEqual(1);
    });

    it('links the notification inside the tenant\'s workspace (#4128)', async () => {
        // A bare `/framework-updates` 404'd from the bell; the slug here is the id.
        const links = await prisma.notification.findMany({
            where: { tenantId: TENANT_A, title: { contains: FW_KEY } },
            select: { linkUrl: true },
            take: 10,
        });
        expect(links.length).toBeGreaterThanOrEqual(1);
        expect(new Set(links.map((n) => n.linkUrl))).toEqual(new Set([`/t/${TENANT_A}/framework-updates`]));
    });

    it('materialises findings for the new gaps — explicit, source-tagged, idempotent', async () => {
        const delta = await prisma.tenantFrameworkDelta.findFirst({ where: { tenantId: TENANT_A, diffId } });
        const first = await materializeDeltaFindings(ctxA(), delta!.id);
        expect(first.created).toBe(2); // NEW1, NEW2

        const findings = await prisma.finding.findMany({ where: { tenantId: TENANT_A, sourceKind: 'FRAMEWORK_UPDATE' } });
        expect(findings.length).toBe(2);
        expect(findings.every((f) => f.sourceRef?.startsWith(`${FW_KEY}:2:`))).toBe(true);

        // Idempotent — a second run creates nothing.
        const second = await materializeDeltaFindings(ctxA(), delta!.id);
        expect(second.created).toBe(0);
    });
});

// ─── Importer wiring: a library UPDATE auto-propagates the delta ──────────

const SUITE2 = `fdw-${randomUUID().slice(0, 8)}`;
const TENANT_W = `fdw-t-${SUITE2}`;
const FW_KEY_W = `fdw-fw-${SUITE2}`;

interface NodeSpec { refId: string; name: string; description?: string }
function makeLib(version: number, contentHash: string, nodes: NodeSpec[]): LoadedLibrary {
    return {
        urn: `urn:lib:${FW_KEY_W}`, locale: 'en', refId: FW_KEY_W, name: 'FDW Test FW',
        description: 'desc', version, kind: 'ISO_STANDARD' as FrameworkKind, dependencies: [],
        contentHash, mappings: [],
        framework: {
            urn: `urn:fw:${FW_KEY_W}`, refId: FW_KEY_W, name: 'FDW Test FW',
            nodes: nodes.map((n) => ({
                urn: `urn:n:${FW_KEY_W}:${n.refId}`, refId: n.refId, name: n.name,
                description: n.description, category: 'Cat', section: 'Sec',
                assessable: true, depth: 1, childUrns: [],
            })),
            nodesByUrn: new Map(), nodesByRefId: new Map(), rootNodes: [],
        },
    } as unknown as LoadedLibrary;
}

describeFn('Framework delta — importLibrary auto-propagates on a version update', () => {
    let controlWId = '';

    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT_W }, update: {}, create: { id: TENANT_W, name: TENANT_W, slug: TENANT_W } });
    });

    afterAll(async () => {
        await prisma.tenantFrameworkDelta.deleteMany({ where: { frameworkKey: FW_KEY_W } }).catch(() => {});
        await prisma.frameworkVersionDiff.deleteMany({ where: { frameworkKey: FW_KEY_W } }).catch(() => {});
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT_W } }).catch(() => {});
        await prisma.control.deleteMany({ where: { tenantId: TENANT_W } }).catch(() => {});
        await prisma.notification.deleteMany({ where: { tenantId: TENANT_W } }).catch(() => {});
        const fw = await prisma.framework.findFirst({ where: { key: FW_KEY_W } });
        if (fw) {
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: fw.id } }).catch(() => {});
            await prisma.framework.delete({ where: { id: fw.id } }).catch(() => {});
        }
        await prisma.tenant.deleteMany({ where: { id: TENANT_W } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('v1 create seeds no delta; v2 update fans a delta out to the installed tenant', async () => {
        // v1: framework created with A.1, A.2 — no prior version, so no propagation.
        const v1 = await importLibrary(prisma, makeLib(1, 'fdw-hash-1', [
            { refId: 'A.1', name: 'One', description: 'orig' },
            { refId: 'A.2', name: 'Two', description: 'orig' },
        ]));
        expect(v1.action).toBe('created');

        // Tenant W installs the framework: a control linked to A.1.
        const reqA1 = await prisma.frameworkRequirement.findFirst({ where: { framework: { key: FW_KEY_W }, code: 'A.1' } });
        const control = await prisma.control.create({ data: { tenantId: TENANT_W, name: 'Control for A.1', status: 'IMPLEMENTED' } });
        controlWId = control.id;
        await prisma.controlRequirementLink.create({ data: { tenantId: TENANT_W, controlId: control.id, requirementId: reqA1!.id } });

        // No delta yet (create never propagates).
        expect(await prisma.tenantFrameworkDelta.count({ where: { frameworkKey: FW_KEY_W } })).toBe(0);

        // v2: A.1 changed (new description), A.3 added, A.2 unchanged.
        const v2 = await importLibrary(prisma, makeLib(2, 'fdw-hash-2', [
            { refId: 'A.1', name: 'One', description: 'REVISED' },
            { refId: 'A.2', name: 'Two', description: 'orig' },
            { refId: 'A.3', name: 'Three', description: 'new' },
        ]));
        expect(v2.action).toBe('updated');
        expect(v2.addedCodes).toContain('A.3');
        expect(v2.changedCodes).toContain('A.1');

        // The importer auto-recorded the diff + fanned the delta out to tenant W.
        const delta = await prisma.tenantFrameworkDelta.findFirst({ where: { tenantId: TENANT_W, frameworkKey: FW_KEY_W } });
        expect(delta).toBeTruthy();
        expect(delta!.newGapCount).toBe(1);        // A.3
        expect(delta!.flaggedControlCount).toBe(1); // the A.1 control

        // The changed requirement's control was flagged for re-review.
        const flagged = await prisma.control.findUnique({ where: { id: controlWId } });
        expect(flagged!.status).toBe('NEEDS_REVIEW');
    });
});
