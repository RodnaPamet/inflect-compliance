/**
 * One-off, idempotent backfill of the global framework catalog for
 * environments that were seeded before these frameworks were added
 * (production was never re-seeded — `prisma/seed.ts` only runs on a fresh DB,
 * and it also creates demo tenants so it can't be run against prod).
 *
 * Adds, with their requirements + control templates + an installable pack:
 *   - DORA              (DORA_BASELINE)
 *   - OWASP-AISVS       (AISVS_BASELINE)
 *   - ISO42001          (ISO42001_BASELINE)
 *   - EU-AI-ACT         (EU_AI_ACT_BASELINE)
 * …and authors a control pack for the already-present SOC2 framework
 *   - SOC2              (SOC2_BASELINE)
 *
 * The framework / requirement / template / pack logic is a faithful copy of
 * the corresponding blocks in `prisma/seed.ts` (same fixtures, same codes,
 * same upsert shapes), so a backfilled DB is identical to a freshly-seeded
 * one for these frameworks. Every write is an upsert / create-if-missing, so
 * the script is safe to re-run.
 *
 * Run (locally or inside the prod app container, which ships @prisma/client,
 * @prisma/adapter-pg and prisma/fixtures):
 *
 *   node scripts/backfill-framework-catalog.mjs
 *
 * Connection: DIRECT_DATABASE_URL (preferred) or DATABASE_URL from the env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../prisma/fixtures');
const readFixture = (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
if (!connectionString) {
    console.error('[backfill] FATAL: DIRECT_DATABASE_URL / DATABASE_URL not set');
    process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

// FROZEN COPY — the fourth of what were four. The other three now import
// `GENERIC_TEMPLATE_TASKS` from `prisma/generic-template-tasks.ts`; this file
// is `.mjs` and run directly with node, so it cannot. It is also a completed
// one-off (it backfilled environments seeded before these frameworks existed),
// so it is left frozen rather than converted: what it wrote is history, and
// rewriting the strings here would change a record rather than a behaviour.
// It is allowlisted by name in tests/guardrails/no-generic-task-strings.test.ts
// for exactly this reason. Do NOT copy these strings anywhere else.
const defaultTasks = [
    { title: 'Define control owner and scope', description: 'Assign an owner and define the scope of this control within the organization.' },
    { title: 'Document procedure or policy', description: 'Create or reference the policy/procedure that implements this control.' },
    { title: 'Implement technical or operational measure', description: 'Put the control into practice — deploy tooling, configure settings, or establish processes.' },
    { title: 'Collect evidence of implementation', description: 'Gather evidence demonstrating the control is operating effectively.' },
    { title: 'Review effectiveness', description: 'Periodically review and assess whether the control meets its objectives.' },
];

/** Upsert framework requirements from a fixture, returning code→id. */
async function upsertRequirements(frameworkId, rows) {
    const map = {};
    for (const req of rows) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        map[req.key] = r.id;
    }
    return map;
}

/** Create a control template (idempotent by code) with default tasks + requirement links. */
async function createTemplate(code, title, category, frequency, reqIds) {
    const existing = await prisma.controlTemplate.findUnique({ where: { code } });
    if (existing) return existing;
    const tmpl = await prisma.controlTemplate.create({
        data: { code, title, category, defaultFrequency: frequency },
    });
    for (const task of defaultTasks) {
        await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
    }
    for (const requirementId of reqIds) {
        if (requirementId) {
            await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId } }).catch(() => {});
        }
    }
    return tmpl;
}

/** Upsert a pack and link every template whose code starts with `prefix`. */
async function upsertPack(key, name, frameworkId, version, description, prefix) {
    const pack = await prisma.frameworkPack.upsert({
        where: { key },
        update: { name, frameworkId, version },
        create: { key, name, frameworkId, version, description },
    });
    const tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: prefix } } });
    for (const tmpl of tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: pack.id, templateId: tmpl.id } },
            create: { packId: pack.id, templateId: tmpl.id }, update: {},
        });
    }
    return { pack, linked: tmpls.length };
}

async function backfillDora() {
    const data = readFixture('dora_requirements.json');
    const fw = await prisma.framework.upsert({
        where: { key_version: { key: 'DORA', version: '2022/2554' } },
        update: { name: 'Digital Operational Resilience Act', kind: 'REGULATION', description: 'Regulation (EU) 2022/2554 on digital operational resilience for the financial sector' },
        create: { key: 'DORA', name: 'Digital Operational Resilience Act', version: '2022/2554', kind: 'REGULATION', description: 'Regulation (EU) 2022/2554 on digital operational resilience for the financial sector' },
    });
    const reqMap = await upsertRequirements(fw.id, data);
    const doraTemplates = [
        { code: 'DORA-5',  title: 'ICT governance and management-body accountability', reqs: ['DORA.Art.5'] },
        { code: 'DORA-6',  title: 'ICT risk management framework', reqs: ['DORA.Art.6'] },
        { code: 'DORA-7',  title: 'ICT systems, protocols and tools', reqs: ['DORA.Art.7'] },
        { code: 'DORA-8',  title: 'Asset and dependency identification', reqs: ['DORA.Art.8'] },
        { code: 'DORA-9',  title: 'Protection and prevention controls', reqs: ['DORA.Art.9'] },
        { code: 'DORA-10', title: 'Anomalous-activity detection', reqs: ['DORA.Art.10'] },
        { code: 'DORA-11', title: 'Response and recovery / ICT business continuity', reqs: ['DORA.Art.11'] },
        { code: 'DORA-12', title: 'Backup, restoration and recovery procedures', reqs: ['DORA.Art.12'] },
        { code: 'DORA-13', title: 'Learning and evolving (post-incident review)', reqs: ['DORA.Art.13'] },
        { code: 'DORA-14', title: 'Crisis communication', reqs: ['DORA.Art.14'] },
        { code: 'DORA-16', title: 'Simplified ICT risk management framework', reqs: ['DORA.Art.16'] },
        { code: 'DORA-17', title: 'ICT-related incident management process', reqs: ['DORA.Art.17'] },
        { code: 'DORA-18', title: 'Incident classification', reqs: ['DORA.Art.18'] },
        { code: 'DORA-19', title: 'Major-incident reporting to competent authority', reqs: ['DORA.Art.19'] },
        { code: 'DORA-23', title: 'Payment-related operational/security incident handling', reqs: ['DORA.Art.23'] },
        { code: 'DORA-24', title: 'Digital operational resilience testing programme', reqs: ['DORA.Art.24'] },
        { code: 'DORA-25', title: 'Testing of ICT tools and systems', reqs: ['DORA.Art.25'] },
        { code: 'DORA-26', title: 'Threat-led penetration testing (TLPT)', reqs: ['DORA.Art.26'] },
        { code: 'DORA-27', title: 'TLPT tester suitability and independence', reqs: ['DORA.Art.27'] },
        { code: 'DORA-28', title: 'ICT third-party risk strategy and Register of Information', reqs: ['DORA.Art.28'] },
        { code: 'DORA-29', title: 'ICT concentration-risk assessment', reqs: ['DORA.Art.29'] },
        { code: 'DORA-30', title: 'Key contractual provisions for ICT services', reqs: ['DORA.Art.30'] },
        { code: 'DORA-31', title: 'Critical ICT third-party provider tracking', reqs: ['DORA.Art.31'] },
        { code: 'DORA-45', title: 'Cyber threat information-sharing arrangements', reqs: ['DORA.Art.45'] },
    ];
    for (const t of doraTemplates) {
        await createTemplate(t.code, t.title, 'DORA', 'QUARTERLY', t.reqs.map((rk) => reqMap[rk]));
    }
    const { linked } = await upsertPack('DORA_BASELINE', 'DORA Baseline Pack', fw.id, '2022/2554', 'DORA digital operational resilience baseline controls across the five pillars.', 'DORA-');
    return { reqs: data.length, templates: doraTemplates.length, linked };
}

async function backfillAisvs() {
    const data = readFixture('owasp_aisvs_requirements.json');
    const meta = JSON.stringify({
        locale: 'en', provider: 'OWASP', packager: 'inflect', publicationDate: '2025-05-01',
        license: 'CC-BY-SA-4.0', sourceUrl: 'https://github.com/OWASP/AISVS', referenceIndexOnly: true,
        copyright: 'OWASP AISVS v1.0 © OWASP Foundation, licensed CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Source: https://github.com/OWASP/AISVS. Inflect stores a reference index (IDs, levels, paraphrased titles) and links to the canonical text.',
    });
    const fw = await prisma.framework.upsert({
        where: { key_version: { key: 'OWASP-AISVS', version: '1.0' } },
        update: { name: 'OWASP AISVS v1.0', kind: 'INDUSTRY_STANDARD', description: 'OWASP AI Security Verification Standard v1.0 — AI-security controls for AI-enabled systems.', metadataJson: meta, sourceUrn: 'urn:inflect:library:owasp-aisvs-1.0' },
        create: { key: 'OWASP-AISVS', name: 'OWASP AISVS v1.0', version: '1.0', kind: 'INDUSTRY_STANDARD', description: 'OWASP AI Security Verification Standard v1.0 — AI-security controls for AI-enabled systems.', metadataJson: meta, sourceUrn: 'urn:inflect:library:owasp-aisvs-1.0' },
    });
    const reqMap = await upsertRequirements(fw.id, data);
    const chapters = new Map();
    for (const req of data) {
        const ch = req.key.split('.')[0]; // 'C1'..'C12'
        if (!chapters.has(ch)) chapters.set(ch, { title: req.section, reqs: [] });
        chapters.get(ch).reqs.push(req.key);
    }
    for (const [ch, info] of chapters) {
        await createTemplate(`AISVS-${ch}`, info.title, 'OWASP AISVS', 'QUARTERLY', info.reqs.map((rk) => reqMap[rk]));
    }
    const { linked } = await upsertPack('AISVS_BASELINE', 'OWASP AISVS Baseline Pack', fw.id, '1.0', 'OWASP AISVS v1.0 AI-security controls across all 12 chapters.', 'AISVS-');
    return { reqs: data.length, templates: chapters.size, linked };
}

async function backfillIso42001() {
    const data = readFixture('iso_42001_requirements.json');
    const meta = JSON.stringify({
        locale: 'en', provider: 'ISO/IEC', packager: 'inflect', publicationDate: '2023-12-18',
        license: 'ISO-copyright', sourceUrl: 'https://www.iso.org/standard/81230', referenceIndexOnly: true,
        copyright: 'Structural outline of ISO/IEC 42001:2023 (clause + Annex A control numbers with paraphrased titles), NOT a reproduction of the copyrighted ISO text. Purchase the full standard from ISO.',
    });
    const fw = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO42001', version: '2023' } },
        update: { name: 'ISO/IEC 42001:2023', kind: 'ISO_STANDARD', description: 'AI Management System (AIMS) — requirements + Annex A controls.', metadataJson: meta, sourceUrn: 'urn:inflect:library:iso-42001' },
        create: { key: 'ISO42001', name: 'ISO/IEC 42001:2023', version: '2023', kind: 'ISO_STANDARD', description: 'AI Management System (AIMS) — requirements + Annex A controls.', metadataJson: meta, sourceUrn: 'urn:inflect:library:iso-42001' },
    });
    const reqMap = await upsertRequirements(fw.id, data);
    const groups = new Map();
    for (const req of data) {
        if (!groups.has(req.section)) groups.set(req.section, { title: req.section, reqs: [] });
        groups.get(req.section).reqs.push(req.key);
    }
    let idx = 0;
    for (const [, info] of groups) {
        await createTemplate(`AIMS-${String(idx++).padStart(2, '0')}`, info.title, 'ISO 42001', 'ANNUALLY', info.reqs.map((rk) => reqMap[rk]));
    }
    const { linked } = await upsertPack('ISO42001_BASELINE', 'ISO 42001 AIMS Baseline Pack', fw.id, '2023', 'ISO/IEC 42001:2023 AI management system clauses + Annex A controls.', 'AIMS-');
    return { reqs: data.length, templates: groups.size, linked };
}

async function backfillEuAiAct() {
    const data = readFixture('eu_ai_act_requirements.json');
    const meta = JSON.stringify({
        locale: 'en', provider: 'European Union', packager: 'inflect', publicationDate: '2024-06-13',
        license: 'public-domain', sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', notLegalAdvice: true,
        copyright: 'Regulation (EU) 2024/1689 is EU legislation in the public domain. Source: https://eur-lex.europa.eu/eli/reg/2024/1689/oj. Risk-tier classification is a tenant + legal-counsel decision; not legal advice.',
    });
    const fw = await prisma.framework.upsert({
        where: { key_version: { key: 'EU-AI-ACT', version: '2024' } },
        update: { name: 'EU AI Act (2024/1689)', kind: 'REGULATION', description: 'Risk-tiered AI regulation obligations (prohibited / high-risk / limited / GPAI / minimal).', metadataJson: meta, sourceUrn: 'urn:inflect:library:eu-ai-act' },
        create: { key: 'EU-AI-ACT', name: 'EU AI Act (2024/1689)', version: '2024', kind: 'REGULATION', description: 'Risk-tiered AI regulation obligations (prohibited / high-risk / limited / GPAI / minimal).', metadataJson: meta, sourceUrn: 'urn:inflect:library:eu-ai-act' },
    });
    const reqMap = await upsertRequirements(fw.id, data);
    const tiers = new Map();
    for (const req of data) {
        if (!tiers.has(req.section)) tiers.set(req.section, { title: req.section, reqs: [] });
        tiers.get(req.section).reqs.push(req.key);
    }
    let idx = 0;
    for (const [, info] of tiers) {
        await createTemplate(`EUAIA-${String(idx++).padStart(2, '0')}`, info.title, 'EU AI Act', 'ANNUALLY', info.reqs.map((rk) => reqMap[rk]));
    }
    const { linked } = await upsertPack('EU_AI_ACT_BASELINE', 'EU AI Act Baseline Pack', fw.id, '2024', 'EU AI Act (2024/1689) obligations across the five risk tiers.', 'EUAIA-');
    return { reqs: data.length, templates: tiers.size, linked };
}

/**
 * SOC2 framework + its requirements already exist; author the missing control
 * pack so it becomes installable (one control template per Trust Services
 * Criterion). Authored here (not in seed.ts) — the new baseline for SOC2.
 */
async function backfillSoc2Pack() {
    const soc2Reqs = [
        { code: 'CC1.1', title: 'COSO principle 1 — Integrity and ethical values', category: 'Control Environment' },
        { code: 'CC2.1', title: 'Information for internal controls', category: 'Communication' },
        { code: 'CC3.1', title: 'Specifies objectives', category: 'Risk Assessment' },
        { code: 'CC5.1', title: 'Selects and develops control activities', category: 'Control Activities' },
        { code: 'CC6.1', title: 'Logical and physical access controls', category: 'Logical Access' },
        { code: 'CC7.1', title: 'System operations monitoring', category: 'System Operations' },
        { code: 'CC8.1', title: 'Change management', category: 'Change Management' },
    ];
    const fw = await prisma.framework.findFirst({ where: { key: 'SOC2' } });
    if (!fw) {
        console.warn('[backfill] SOC2 framework not found — skipping SOC2 pack');
        return { reqs: 0, templates: 0, linked: 0 };
    }
    // Ensure requirements exist (idempotent) and capture their ids.
    const reqMap = {};
    for (let i = 0; i < soc2Reqs.length; i++) {
        const req = soc2Reqs[i];
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: fw.id, code: req.code } },
            update: {},
            create: { frameworkId: fw.id, code: req.code, title: req.title, category: req.category, sortOrder: i },
        });
        reqMap[req.code] = r.id;
    }
    for (const req of soc2Reqs) {
        await createTemplate(`SOC2-${req.code}`, req.title, req.category, 'QUARTERLY', [reqMap[req.code]]);
    }
    const { linked } = await upsertPack('SOC2_BASELINE', 'SOC 2 Baseline Pack', fw.id, null, 'SOC 2 Trust Services Criteria baseline controls.', 'SOC2-');
    return { reqs: soc2Reqs.length, templates: soc2Reqs.length, linked };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    if (dryRun) {
        console.log('[backfill] --dry-run: connecting + counting only, no writes');
        const fw = await prisma.framework.findMany({ select: { key: true }, orderBy: { key: 'asc' } });
        console.log('[backfill] current frameworks:', fw.map((f) => f.key).join(', '));
        return;
    }
    const results = {
        DORA: await backfillDora(),
        'OWASP-AISVS': await backfillAisvs(),
        ISO42001: await backfillIso42001(),
        'EU-AI-ACT': await backfillEuAiAct(),
        SOC2: await backfillSoc2Pack(),
    };
    console.log('[backfill] done:');
    for (const [k, v] of Object.entries(results)) {
        console.log(`  ${k}: ${v.reqs} requirements, ${v.templates} templates, ${v.linked} pack links`);
    }
    const installable = await prisma.framework.findMany({
        where: { packs: { some: {} } }, select: { key: true }, orderBy: { key: 'asc' },
    });
    console.log('[backfill] installable frameworks now:', installable.map((f) => f.key).join(', '));
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
        console.error('[backfill] FATAL:', e);
        await prisma.$disconnect();
        process.exit(1);
    });
