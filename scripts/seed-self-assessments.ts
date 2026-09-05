/**
 * Standalone, idempotent seeder for the onboarding SELF-ASSESSMENT library
 * content — the NIS2 gap-assessment and AI-governance question sets.
 *
 * Why this exists as its own script (not just `prisma/seed.ts`):
 * these question sets live in dedicated global reference tables
 * (`Nis2GapDomain`/`Nis2GapQuestion`, `AiGovDomain`/`AiGovQuestion`,
 * `AgentAssessmentDomain`/`AgentAssessmentQuestion`) that are
 * populated by the fixtures, NOT by migrations. Migrations create the tables;
 * they carry no data. `prisma/seed.ts` DOES seed them, but the full seed also
 * provisions demo tenants/users and is unsafe to run against production. When
 * these question sets were added after the initial prod seed, the tables stayed
 * empty and the wizard's self-assessment steps rendered zero questions.
 *
 * This script seeds ONLY the global question sets, via upsert, so it is safe
 * to run on any environment (including production) and safe to re-run. Run with:
 *   tsx scripts/seed-self-assessments.ts        (npm run db:seed-self-assessments)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 — adapter is required for PrismaClient construction.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

async function seedNis2GapAssessment(): Promise<void> {
    const nis2Gap = require('../prisma/fixtures/nis2-gap-assessment.json') as {
        version: string;
        domains: Array<{ id: number; code: string; name: unknown; description: unknown; day: number }>;
        questions: Array<{
            id: string; domain: number; text: unknown; plainText: unknown; legalBasis: string;
            criticality: string; respondent: string; consequence: string; fineExposure: boolean;
            timeToFix: string; day: number; dependsOn: string[];
        }>;
    };
    for (const d of nis2Gap.domains) {
        await prisma.nis2GapDomain.upsert({
            where: { id: d.id },
            update: { code: d.code, name: d.name as object, description: d.description as object, day: d.day },
            create: { id: d.id, code: d.code, name: d.name as object, description: d.description as object, day: d.day },
        });
    }
    for (const q of nis2Gap.questions) {
        const data = {
            domainId: q.domain,
            text: q.text as object,
            plainText: q.plainText as object,
            legalBasis: q.legalBasis,
            criticality: q.criticality,
            respondent: q.respondent,
            consequence: q.consequence,
            fineExposure: q.fineExposure,
            timeToFix: q.timeToFix,
            day: q.day,
            dependsOn: q.dependsOn,
        };
        await prisma.nis2GapQuestion.upsert({ where: { id: q.id }, update: data, create: { id: q.id, ...data } });
    }
    console.log(`✅ NIS2 gap-assessment ${nis2Gap.version} — ${nis2Gap.domains.length} domains + ${nis2Gap.questions.length} questions seeded`);
}

async function seedAiGovAssessment(): Promise<void> {
    const aiGov = require('../prisma/fixtures/ai-governance-self-assessment.json') as {
        questionSetVersion: number;
        domains: Array<{ id: number; code: string; name: string }>;
        questions: Array<{ id: string; domainId: number; criticality: string; conditional: string | null; text: string; mappings: { aisvs: string[]; iso42001: string[]; euAiAct: string[] } }>;
    };
    for (const d of aiGov.domains) {
        await prisma.aiGovDomain.upsert({
            where: { id: d.id },
            update: { code: d.code, name: d.name },
            create: { id: d.id, code: d.code, name: d.name },
        });
    }
    for (const q of aiGov.questions) {
        const data = { domainId: q.domainId, text: q.text, mappingsJson: q.mappings, conditional: q.conditional, criticality: q.criticality };
        await prisma.aiGovQuestion.upsert({ where: { id: q.id }, update: data, create: { id: q.id, ...data } });
    }
    console.log(`✅ AI-governance self-assessment v${aiGov.questionSetVersion} — ${aiGov.domains.length} domains + ${aiGov.questions.length} questions seeded`);
}

async function seedAgentRiskAssessment(): Promise<void> {
    const agentRisk = require('../prisma/fixtures/agent-risk-assessment.json') as {
        questionSetVersion: number;
        domains: Array<{ id: number; code: string; name: string; description: string; sortOrder: number }>;
        questions: Array<{ id: string; domainId: number; criticality: string; text: string; guidance: string | null; mappings: { asi: string[]; imda: string[] } }>;
    };
    for (const d of agentRisk.domains) {
        const data = { code: d.code, name: d.name, description: d.description, sortOrder: d.sortOrder };
        await prisma.agentAssessmentDomain.upsert({ where: { id: d.id }, update: data, create: { id: d.id, ...data } });
    }
    for (const q of agentRisk.questions) {
        const data = { domainId: q.domainId, text: q.text, guidance: q.guidance ?? null, mappingsJson: q.mappings, criticality: q.criticality };
        await prisma.agentAssessmentQuestion.upsert({ where: { id: q.id }, update: data, create: { id: q.id, ...data } });
    }
    console.log(`✅ Agent risk assessment v${agentRisk.questionSetVersion} — ${agentRisk.domains.length} domains + ${agentRisk.questions.length} questions seeded`);
}

async function main(): Promise<void> {
    console.log('🌱 Seeding self-assessment library content (NIS2 gap + AI governance + agent risk)...');
    await seedNis2GapAssessment();
    await seedAiGovAssessment();
    await seedAgentRiskAssessment();
    console.log('✅ Self-assessment library content seeded.');
}

main()
    .catch((err) => {
        console.error('❌ Self-assessment seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
