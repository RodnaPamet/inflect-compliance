/**
 * Integration coverage: the SOC 2 Starter Pack installs through the GENERIC
 * framework-install machinery and produces a REAL coverage baseline — controls
 * + tasks + requirement links — not the bare 0% a tenant used to get when it
 * installed SOC 2.
 *
 * DB-backed (per repo convention — integration tests never mock Prisma). The
 * test seeds a SOC 2-shaped framework from the ACTUAL curated Starter Pack
 * fixture (prisma/fixtures/soc2-control-templates.json), linking each control
 * to the Trust Services criteria it declares, then drives the SAME
 * previewPackInstall / installPack / computeCoverage usecases every framework
 * uses. This proves the fixture's control → criterion wiring resolves and
 * yields full coverage of the criteria it targets.
 *
 * Framework key/version, template codes and pack key are suite-unique so the
 * suite is parallel-safe (ControlTemplate.code + FrameworkPack.key are global
 * unique columns) and so `installPack`'s "also install internal controls mapped
 * to this framework" arm cannot pull in templates from another pack.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { previewPackInstall, installPack, computeCoverage } from '@/app-layer/usecases/framework';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `soc2-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

const FW_KEY = `SOC2-${SUITE}`;
const FW_VERSION = `2017-${SUITE}`;
const PACK_KEY = `SOC2_STARTER_PACK_${SUITE}`;

interface StarterControl {
    code: string;
    title: string;
    description: string;
    category: string;
    defaultFrequency: string;
    requirements: string[];
    tasks: Array<{ title: string; description: string }>;
}
const FIXTURE = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, '../../prisma/fixtures/soc2-control-templates.json'),
        'utf8',
    ),
) as StarterControl[];

// Every Trust Services criterion the fixture references (dedup across controls).
const REQ_REFS = [...new Set(FIXTURE.flatMap((c) => c.requirements))];
const TOTAL_TASKS = FIXTURE.reduce((a, c) => a + c.tasks.length, 0);
const TOTAL_LINKS = FIXTURE.reduce((a, c) => a + c.requirements.length, 0);
// Suite-unique control code so global-unique columns never collide.
const codeFor = (c: string) => `${c}-${SUITE}`;

let frameworkId: string;

describeFn('SOC 2 Starter Pack install (real DB, generic flow)', () => {
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

        const fw = await prisma.framework.create({
            data: {
                key: FW_KEY,
                version: FW_VERSION,
                name: 'SOC 2 Trust Services Criteria',
                kind: 'SOC_CRITERIA',
                description: 'SOC 2 Trust Services Criteria',
            },
        });
        frameworkId = fw.id;

        // One requirement row per referenced criterion.
        const reqIdByRef: Record<string, string> = {};
        let sort = 0;
        for (const ref of REQ_REFS) {
            const req = await prisma.frameworkRequirement.create({
                data: { frameworkId: fw.id, code: ref, title: ref, section: 'Common Criteria', sortOrder: sort++ },
            });
            reqIdByRef[ref] = req.id;
        }

        const pack = await prisma.frameworkPack.create({
            data: { key: PACK_KEY, name: 'SOC 2 Starter Pack', frameworkId: fw.id, version: FW_VERSION },
        });

        for (const c of FIXTURE) {
            const tmpl = await prisma.controlTemplate.create({
                data: {
                    code: codeFor(c.code),
                    title: c.title,
                    description: c.description,
                    category: c.category,
                    defaultFrequency: c.defaultFrequency as never,
                },
            });
            for (const t of c.tasks) {
                await prisma.controlTemplateTask.create({
                    data: { templateId: tmpl.id, title: t.title, description: t.description },
                });
            }
            for (const ref of c.requirements) {
                await prisma.controlTemplateRequirementLink.create({
                    data: { templateId: tmpl.id, requirementId: reqIdByRef[ref] },
                });
            }
            await prisma.packTemplateLink.create({
                data: { packId: pack.id, templateId: tmpl.id },
            });
        }
    });

    afterAll(async () => {
        const tmpls = await prisma.controlTemplate.findMany({
            where: { code: { in: FIXTURE.map((c) => codeFor(c.code)) } }, select: { id: true },
        });
        const tids = tmpls.map((t) => t.id);
        if (tids.length) {
            await prisma.packTemplateLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplateRequirementLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplateTask.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplate.deleteMany({ where: { id: { in: tids } } });
        }
        if (frameworkId) {
            await prisma.controlRequirementLink.deleteMany({ where: { requirement: { frameworkId } } });
            await prisma.control.deleteMany({ where: { tenantId: TENANT } });
            await prisma.frameworkPack.deleteMany({ where: { frameworkId } });
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } });
            await prisma.framework.delete({ where: { id: frameworkId } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('preview reports the whole curated pack as new for a fresh tenant', async () => {
        const preview = await previewPackInstall(ctx, PACK_KEY);
        expect(preview.framework.key).toBe(FW_KEY);
        expect(preview.totalTemplates).toBe(FIXTURE.length);
        expect(preview.newControls).toBe(FIXTURE.length);
        expect(preview.existingControls).toBe(0);
    });

    it('installPack creates controls + tasks + requirement links via the generic path', async () => {
        const result = await installPack(ctx, PACK_KEY);
        expect(result.framework).toBe(FW_KEY);
        expect(result.controlsCreated).toBe(FIXTURE.length);
        expect(result.tasksCreated).toBe(TOTAL_TASKS);
        expect(result.mappingsCreated).toBe(TOTAL_LINKS);
    });

    it('computeCoverage reflects a REAL baseline (not bare 0%)', async () => {
        const coverage = await computeCoverage(ctx, FW_KEY, FW_VERSION);
        expect(coverage.framework.key).toBe(FW_KEY);
        expect(coverage.total).toBe(REQ_REFS.length);
        // Every referenced criterion is mapped by an installed control.
        expect(coverage.mapped).toBe(REQ_REFS.length);
        expect(coverage.coveragePercent).toBe(100);
    });

    it('every Common Criteria category CC1–CC9 is covered by an installed control', async () => {
        const coverage = await computeCoverage(ctx, FW_KEY, FW_VERSION);
        expect(coverage.unmappedRequirements).toEqual([]);
        const categories = new Set(
            coverage.controlMappings.map((m) => m.requirementCode.split('.')[0]),
        );
        const missing = ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8', 'CC9']
            .filter((cc) => !categories.has(cc));
        expect(missing).toEqual([]);
    });
});
