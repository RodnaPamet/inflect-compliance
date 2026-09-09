/**
 * The internal-controls library reaches a tenant through a pack of its OWN,
 * and a control that belongs to several frameworks reports all of them.
 *
 * Two questions, both of which used to have the wrong answer:
 *
 *   1. INSTALL SCOPE. `installPack` used to install the pack's templates PLUS
 *      every global ControlTemplate carrying a requirement link into the same
 *      framework. That made installing ISO 27001 create 233 controls where
 *      Annex A defines 93 — the 93 plus 140 internal controls swept in because
 *      their policies happened to map to an Annex A clause. The sweep is gone,
 *      so this suite plants a template that WOULD have been swept in and
 *      asserts it is not.
 *
 *   2. FRAMEWORK REPORTING. Removing the sweep left the 151 ICN-* templates
 *      seeded and unreachable, so they were given a framework and a pack of
 *      their own (prisma/fixtures/internal-controls-catalog.json). A control
 *      from that pack is mapped to its Internal Control domain AND, through
 *      the policies it references, to ISO 27001 / NIS2 — so the list's
 *      Framework column has to report a SET, not one code-derived guess.
 *      `ControlRepository` projects that set; this proves it dedupes (a
 *      control with two links into one framework is one badge) and that a
 *      control genuinely spanning two frameworks reports both.
 *
 * DB-backed per repo convention — integration tests never mock Prisma.
 * Framework keys, template codes and the pack key are suite-unique because
 * `ControlTemplate.code` and `FrameworkPack.key` are globally unique columns.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { installPack } from '@/app-layer/usecases/framework';
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { runInTenantContext } from '@/lib/db-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `icfw-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

const IC_KEY = `INTERNAL_CONTROLS-${SUITE}`;
const STD_KEY = `ISO27001-${SUITE}`;
const PACK_KEY = `INTERNAL_CONTROLS_PACK_${SUITE}`;

const IN_PACK_BOTH = `ICN-BOTH-${SUITE}`;
const IN_PACK_ONLY = `ICN-ONLY-${SUITE}`;
const NOT_IN_PACK = `ICN-OUTSIDER-${SUITE}`;

describeFn('Internal Control framework — pack scope and multi-framework reporting', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: SUITE, slug: SUITE },
        });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({
            where: { id: ctx.userId }, update: {},
            create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
        });

        // The library's own framework — requirements are its categories.
        const ic = await prisma.framework.create({
            data: { key: IC_KEY, version: '1.0', name: 'Internal Control', kind: 'CUSTOM' },
        });
        const icAccess = await prisma.frameworkRequirement.create({
            data: { frameworkId: ic.id, code: `IC-ACCESS-MANAGEMENT-${SUITE}`, title: 'Access Management' },
        });
        const icBackup = await prisma.frameworkRequirement.create({
            data: { frameworkId: ic.id, code: `IC-BACKUP-${SUITE}`, title: 'Backup' },
        });

        // A published standard the same controls are cross-mapped into.
        const std = await prisma.framework.create({
            data: { key: STD_KEY, version: '2022', name: 'ISO/IEC 27001', kind: 'ISO_STANDARD' },
        });
        const a515 = await prisma.frameworkRequirement.create({
            data: { frameworkId: std.id, code: `A.5.15-${SUITE}`, title: 'Access control' },
        });
        const a518 = await prisma.frameworkRequirement.create({
            data: { frameworkId: std.id, code: `A.5.18-${SUITE}`, title: 'Access rights' },
        });

        const mk = async (code: string, title: string) =>
            prisma.controlTemplate.create({ data: { code, title, category: 'Access Management' } });

        // In the pack, and cross-mapped: one Internal Control link + TWO ISO
        // links. Two links, ONE framework badge — that is the dedup case.
        const both = await mk(IN_PACK_BOTH, 'Cross-mapped internal control');
        for (const requirementId of [icAccess.id, a515.id, a518.id]) {
            await prisma.controlTemplateRequirementLink.create({ data: { templateId: both.id, requirementId } });
        }

        // In the pack, Internal Control only.
        const only = await mk(IN_PACK_ONLY, 'Domain-only internal control');
        await prisma.controlTemplateRequirementLink.create({
            data: { templateId: only.id, requirementId: icBackup.id },
        });

        // NOT in the pack, but mapped into the same framework. The removed
        // sweep would have installed this one too.
        const outsider = await mk(NOT_IN_PACK, 'Mapped but not packed');
        await prisma.controlTemplateRequirementLink.create({
            data: { templateId: outsider.id, requirementId: icAccess.id },
        });

        const pack = await prisma.frameworkPack.create({
            data: { key: PACK_KEY, name: 'Internal Control Library', frameworkId: ic.id, version: '1.0' },
        });
        for (const t of [both, only]) {
            await prisma.packTemplateLink.create({ data: { packId: pack.id, templateId: t.id } });
        }
    }, 60_000);

    afterAll(async () => {
        // Global-unique columns first (ControlTemplate.code, FrameworkPack.key),
        // then their links, then the frameworks. The TENANT is left in place —
        // installPack writes an AuditLog row that references it, and unpicking
        // the whole tenant graph is not what this suite is testing. Tenant ids
        // are suite-unique and the per-worker database is disposable.
        const tmpls = await prisma.controlTemplate.findMany({
            where: { code: { in: [IN_PACK_BOTH, IN_PACK_ONLY, NOT_IN_PACK] } },
            select: { id: true },
        });
        const tids = tmpls.map((t) => t.id);
        if (tids.length) {
            await prisma.packTemplateLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplateRequirementLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplate.deleteMany({ where: { id: { in: tids } } });
        }
        await prisma.controlRequirementLink.deleteMany({
            where: { requirement: { framework: { key: { in: [IC_KEY, STD_KEY] } } } },
        });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        await prisma.frameworkPack.deleteMany({ where: { key: PACK_KEY } });
        // Requirements before frameworks — the FK is not ON DELETE CASCADE.
        await prisma.frameworkRequirement.deleteMany({
            where: { framework: { key: { in: [IC_KEY, STD_KEY] } } },
        });
        await prisma.framework.deleteMany({ where: { key: { in: [IC_KEY, STD_KEY] } } });
        await prisma.$disconnect();
    }, 60_000);

    it('installs the pack\'s templates and NOT the framework-mapped outsider', async () => {
        const result = await installPack(ctx, PACK_KEY);

        expect(result.controlsCreated).toBe(2);

        const codes = (
            await prisma.control.findMany({ where: { tenantId: TENANT }, select: { code: true } })
        ).map((c) => c.code).sort();
        expect(codes).toEqual([IN_PACK_BOTH, IN_PACK_ONLY].sort());
        expect(codes).not.toContain(NOT_IN_PACK);
    }, 60_000);

    it('reports every framework a control is mapped to, deduped', async () => {
        const rows = (await runInTenantContext(ctx, (db) =>
            ControlRepository.list(db, ctx),
        )) as Array<{ code: string | null; frameworks: Array<{ key: string; name: string }> }>;

        const both = rows.find((r) => r.code === IN_PACK_BOTH);
        expect(both).toBeTruthy();
        // Three requirement links, two frameworks — the two ISO links collapse.
        expect(both!.frameworks.map((f) => f.key).sort()).toEqual([IC_KEY, STD_KEY].sort());
        // Ordered by name so the badges do not reshuffle between renders.
        // localeCompare, so "Internal Control" precedes "ISO/IEC 27001" —
        // punctuation is not weighted the way a raw codepoint sort would.
        expect(both!.frameworks.map((f) => f.name)).toEqual(['Internal Control', 'ISO/IEC 27001']);

        const only = rows.find((r) => r.code === IN_PACK_ONLY);
        expect(only!.frameworks.map((f) => f.key)).toEqual([IC_KEY]);
    }, 60_000);
});
