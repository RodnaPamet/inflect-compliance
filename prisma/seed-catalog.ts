/**
 * Production-safe catalog seed.
 *
 * Populates only GLOBAL reference data: Framework, FrameworkRequirement,
 * ControlTemplate, ControlTemplateTask, ControlTemplateRequirementLink,
 * FrameworkPack, PackTemplateLink.
 *
 * Intentionally does NOT create any Tenant, User, TenantMembership, or
 * demo per-tenant fixtures — unlike `prisma/seed.ts` which is for dev/E2E.
 *
 * Idempotent: every insert is an upsert (or findUnique-then-create),
 * so re-running is safe.
 *
 * Run locally:   npx tsx prisma/seed-catalog.ts
 * Run on VM:     docker exec -it inflect-app-1 npx tsx /app/prisma/seed-catalog.ts
 */
const { PrismaClient } = require('@prisma/client');
// Shared with seed.ts and catalog-applier.ts — see prisma/generic-template-tasks.ts.
const { GENERIC_TEMPLATE_TASKS } = require('./generic-template-tasks');
// Granular ISO 27001 domain taxonomy — the SAME module the Controls
// "Browse" rail derives categories from at runtime, so the persisted
// FrameworkRequirement / ControlTemplate categories never drift from
// what the UI shows. The module is dependency-free, so a relative
// require resolves cleanly under tsx.
const { iso27001Domain } = require('../src/lib/controls/control-taxonomy');
import { fixtureArray } from './fixture-io';

const prisma = new PrismaClient();


async function main() {
    console.log('🌱 Seeding global catalog (frameworks, requirements, control templates, packs)…');

    // ── ISO 27001:2022 ───────────────────────────────────────────
    const annexAData = fixtureArray<{
        key: string; theme: string; themeNumber: number; sortOrder: number; title: string; summary?: string;
    }>(
        'fixtures/iso27001_2022_annexA',
        require('./fixtures/iso27001_2022_annexA.json'),
    );
    const iso27001 = await prisma.framework.upsert({
        where: { key: 'ISO27001' },
        update: { name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
        create: { key: 'ISO27001', name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
    });
    const requirementMap: Record<string, string> = {};
    for (const req of annexAData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso27001.id, code: req.key } },
            update: { title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
            create: { frameworkId: iso27001.id, code: req.key, title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
        });
        requirementMap[req.key] = r.id;
    }
    console.log(`✅ ISO 27001:2022 + ${annexAData.length} Annex A requirements`);

    // ── SOC 2 ────────────────────────────────────────────────────
    const soc2 = await prisma.framework.upsert({
        where: { key: 'SOC2' },
        update: { name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
        create: { key: 'SOC2', name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
    });
    // Keep in lockstep with `soc2Reqs` in prisma/seed.ts — the SOC 2 Starter
    // Pack's control templates link against these criterion codes.
    const soc2Reqs = [
        { code: 'CC1.1', title: 'COSO principle 1 — Integrity and ethical values', category: 'Control Environment' },
        { code: 'CC1.2', title: 'Board independence and oversight', category: 'Control Environment' },
        { code: 'CC2.1', title: 'Information for internal controls', category: 'Communication' },
        { code: 'CC3.1', title: 'Specifies objectives', category: 'Risk Assessment' },
        { code: 'CC4.1', title: 'Evaluates and communicates control deficiencies', category: 'Monitoring Activities' },
        { code: 'CC5.1', title: 'Selects and develops control activities', category: 'Control Activities' },
        { code: 'CC6.1', title: 'Logical and physical access controls', category: 'Logical Access' },
        { code: 'CC7.1', title: 'System operations monitoring', category: 'System Operations' },
        { code: 'CC8.1', title: 'Change management', category: 'Change Management' },
        { code: 'CC9.1', title: 'Risk mitigation — business disruption and vendors', category: 'Risk Mitigation' },
    ];
    for (let i = 0; i < soc2Reqs.length; i++) {
        const req = soc2Reqs[i];
        await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: soc2.id, code: req.code } },
            update: {},
            create: { frameworkId: soc2.id, code: req.code, title: req.title, category: req.category, sortOrder: i },
        });
    }
    console.log(`✅ SOC 2 + ${soc2Reqs.length} requirements`);

    // ── NIS2 ─────────────────────────────────────────────────────
    const nis2Data = fixtureArray<{ key: string; section: string; sortOrder: number; title: string }>(
        'fixtures/nis2_requirements',
        require('./fixtures/nis2_requirements.json'),
    );
    const nis2 = await prisma.framework.upsert({
        where: { key_version: { key: 'NIS2', version: '2022/2555' } },
        update: { name: 'NIS2 Directive', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
        create: { key: 'NIS2', name: 'NIS2 Directive', version: '2022/2555', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
    });
    const nis2ReqMap: Record<string, string> = {};
    for (const req of nis2Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nis2.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nis2.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nis2ReqMap[req.key] = r.id;
    }
    console.log(`✅ NIS2 + ${nis2Data.length} requirements`);

    // ── ISO 27001:2022 Control Templates (one per Annex A) ───────
    let templatesCreated = 0;
    for (const req of annexAData) {
        const code = `A-${req.key}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const template = await prisma.controlTemplate.create({
                data: { code, title: req.title, description: req.summary || null, category: iso27001Domain(req.key) || req.theme, defaultFrequency: 'QUARTERLY' },
            });
            for (const task of GENERIC_TEMPLATE_TASKS) {
                await prisma.controlTemplateTask.create({ data: { templateId: template.id, title: task.title, description: task.description } });
            }
            await prisma.controlTemplateRequirementLink.create({
                data: { templateId: template.id, requirementId: requirementMap[req.key] },
            });
            templatesCreated++;
        }
    }
    console.log(`✅ ISO 27001 control templates (${templatesCreated} new)`);

    // ── NIS2 Control Templates ───────────────────────────────────
    const nis2Templates = [
        { code: 'NIS2-RA', title: 'Risk analysis and information security policies', reqs: ['Art.21(2)(a)'] },
        { code: 'NIS2-IH', title: 'Incident handling procedures', reqs: ['Art.21(2)(b)'] },
        { code: 'NIS2-BC', title: 'Business continuity and crisis management', reqs: ['Art.21(2)(c)'] },
        { code: 'NIS2-SC', title: 'Supply chain security management', reqs: ['Art.21(2)(d)'] },
        { code: 'NIS2-NS', title: 'Network and information system security', reqs: ['Art.21(2)(e)'] },
        { code: 'NIS2-EF', title: 'Effectiveness assessment of cybersecurity measures', reqs: ['Art.21(2)(f)'] },
        { code: 'NIS2-CH', title: 'Cyber hygiene and security training', reqs: ['Art.21(2)(g)'] },
        { code: 'NIS2-CR', title: 'Cryptography and encryption policies', reqs: ['Art.21(2)(h)'] },
        { code: 'NIS2-HR', title: 'HR security and access control', reqs: ['Art.21(2)(i)'] },
        { code: 'NIS2-MFA', title: 'Multi-factor authentication and secured communications', reqs: ['Art.21(2)(j)'] },
        { code: 'NIS2-EW', title: 'Early warning notification (24h)', reqs: ['Art.23(1)'] },
        { code: 'NIS2-IN', title: 'Incident notification (72h)', reqs: ['Art.23(2)'] },
        { code: 'NIS2-FR', title: 'Final incident report (1 month)', reqs: ['Art.23(3)'] },
        { code: 'NIS2-GO', title: 'Management body cybersecurity oversight', reqs: ['Art.20(1)'] },
        { code: 'NIS2-TR', title: 'Management cybersecurity training', reqs: ['Art.20(2)'] },
        { code: 'NIS2-CE', title: 'Cybersecurity certification schemes', reqs: ['Art.24(1)'] },
        { code: 'NIS2-ST', title: 'Standards and technical specifications', reqs: ['Art.25'] },
        { code: 'NIS2-DN', title: 'Domain name registration accuracy', reqs: ['Art.28(1)'] },
        { code: 'NIS2-IS', title: 'Information sharing arrangements', reqs: ['Art.29(1)'] },
        { code: 'NIS2-NS2', title: 'National cybersecurity strategy compliance', reqs: ['Art.7(1)'] },
    ];
    for (const t of nis2Templates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'NIS2', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of GENERIC_TEMPLATE_TASKS) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (nis2ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nis2ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ NIS2 control templates');

    // ── Framework Packs ──────────────────────────────────────────
    const allIsoTemplates = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'A-' } } });
    const pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO27001_2022_BASE' },
        update: { name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022' },
        create: { key: 'ISO27001_2022_BASE', name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022', description: 'Full Annex A control set with default implementation tasks.' },
    });
    for (const tmpl of allIsoTemplates) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: pack.id, templateId: tmpl.id } },
            create: { packId: pack.id, templateId: tmpl.id }, update: {},
        });
    }

    const nis2Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'NIS2-' } } });
    const nis2Pack = await prisma.frameworkPack.upsert({
        where: { key: 'NIS2_BASELINE' },
        update: { name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555' },
        create: { key: 'NIS2_BASELINE', name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555', description: 'NIS2 directive security measures baseline.' },
    });
    for (const tmpl of nis2Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: nis2Pack.id, templateId: tmpl.id } },
            create: { packId: nis2Pack.id, templateId: tmpl.id }, update: {},
        });
    }




    console.log('✅ Framework Packs');

    const counts = await Promise.all([
        prisma.framework.count(),
        prisma.frameworkRequirement.count(),
        prisma.controlTemplate.count(),
        prisma.frameworkPack.count(),
    ]);
    console.log(`\n📊 Final counts — frameworks: ${counts[0]}, requirements: ${counts[1]}, control templates: ${counts[2]}, packs: ${counts[3]}`);
}

main()
    .then(() => prisma.$disconnect())
    .catch((err: unknown) => {
        console.error('❌ Seed failed:', err);
        prisma.$disconnect();
        process.exit(1);
    });
