/**
 * The global agent risk-assessment question bank (`AgentAssessmentDomain` +
 * `AgentAssessmentQuestion`), upserted from its fixture by stable id.
 *
 * Migrations create these tables and carry no rows. A database seeded only by
 * `prisma migrate deploy` — the agent-evals nightly's — has an empty bank, and
 * scoring an agent against no questions reads every mitigation as missing
 * (`unmitigatedFraction` is 1 when nothing is applicable). So any seeder that
 * scores an agent calls this first. Idempotent: the ids (`ara-<domain>-<nn>`)
 * are stable external keys, which is why this upserts and never reloads.
 */
import type { PrismaClient } from '@prisma/client';

import { fixtureObject } from './fixture-io';

type BankClient = Pick<PrismaClient, 'agentAssessmentDomain' | 'agentAssessmentQuestion'>;

export async function seedAgentRiskAssessmentLibrary(
    client: BankClient,
): Promise<{ questionSetVersion: number; domains: number; questions: number }> {
    const agentRisk = fixtureObject<{
        questionSetVersion: number;
        domains: Array<{ id: number; code: string; name: string; description: string; sortOrder: number }>;
        questions: Array<{ id: string; domainId: number; criticality: string; text: string; guidance: string | null; mappings: { asi: string[]; imda: string[] } }>;
    }>(
        'fixtures/agent-risk-assessment',
        require('./fixtures/agent-risk-assessment.json'),
        'questionSetVersion', 'domains', 'questions',
    );
    for (const d of agentRisk.domains) {
        const data = { code: d.code, name: d.name, description: d.description, sortOrder: d.sortOrder };
        await client.agentAssessmentDomain.upsert({ where: { id: d.id }, update: data, create: { id: d.id, ...data } });
    }
    for (const q of agentRisk.questions) {
        const data = { domainId: q.domainId, text: q.text, guidance: q.guidance ?? null, mappingsJson: q.mappings, criticality: q.criticality };
        await client.agentAssessmentQuestion.upsert({ where: { id: q.id }, update: data, create: { id: q.id, ...data } });
    }
    return {
        questionSetVersion: agentRisk.questionSetVersion,
        domains: agentRisk.domains.length,
        questions: agentRisk.questions.length,
    };
}
