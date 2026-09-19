/**
 * The AISVS AI-vendor questionnaire — ONE writer, shared by the dev seed and
 * the production seeder.
 *
 * ═══ WHY THIS FILE EXISTS (#2622) ═══
 *
 * The questionnaire was built inline in `prisma/seed.ts`, which production
 * never runs. `scripts/seed-vendor-questionnaires.ts` — the script
 * `entrypoint.sh` actually invokes — carried only the two Supplier
 * questionnaires, so a fully-built fixture with ten sections and 33 questions,
 * its own coverage readout, finding linkage and ratchet, materialised into the
 * dev demo tenant and nowhere else. Every test passed; no customer ever saw it.
 *
 * The fix is NOT to copy the eighty-odd lines into the production seeder. This
 * repo has already paid for that: `prisma/generic-template-tasks.ts` exists
 * because the same five strings lived as four byte-identical copies and a fix
 * applied to one kept emitting old text from a path nobody was looking at. Its
 * docblock says "DO NOT ADD A FIFTH COPY", and this is the same shape one
 * subsystem over.
 *
 * So the builder moved here and both callers import it. Changing the
 * questionnaire is now one edit that reaches dev and production together.
 *
 * ═══ WHY IT COULD NOT JUST JOIN THE `FIXTURES` ARRAY ═══
 *
 * The two Supplier questionnaires and this one are not the same shape. They
 * carry a `scoringConfig` and plain `{title, description, weight, questions}`
 * sections; AISVS carries no scoring config, marks sections `conditional` with
 * an `appliesTo`, and its questions are `{aisvsId, level, prompt, type}`. The
 * scoring config, the option sets and the risk points are all DERIVED here
 * rather than read from the fixture — which is precisely why it needed a
 * builder rather than a row in a list.
 *
 * @module prisma/aisvs-vendor-questionnaire
 */
import type { PrismaClient } from '@prisma/client';

/** Yes / Partial / No / N/A — risk points feed the existing vendor-scoring service. */
const SELECT_OPTIONS = [
    { label: 'Yes', value: 'yes', points: 0 },
    { label: 'Partial', value: 'partial', points: 5 },
    { label: 'No', value: 'no', points: 10 },
    { label: 'N/A', value: 'na', points: 0 },
];
const SELECT_RISK = { YES: 0, PARTIAL: 5, NO: 10, 'N/A': 0 };

/** The archetype question scores nothing — it decides which sections apply. */
const ARCHETYPE_OPTIONS = [
    { label: 'Prompt-completion (no RAG/agents)', value: 'prompt', points: 0 },
    { label: 'RAG / retrieval-augmented', value: 'rag', points: 0 },
    { label: 'Agentic / tool-using', value: 'agentic', points: 0 },
    { label: 'Other', value: 'other', points: 0 },
];

export interface AisvsQuestionnaireFixture {
    key: string;
    name: string;
    description: string;
    attribution: string;
    sections: Array<{
        title: string;
        weight: number;
        conditional: boolean;
        appliesTo?: string;
        questions: Array<{ aisvsId: string; level: string; weight: number; prompt: string; type?: string }>;
    }>;
}

/**
 * Seed the questionnaire for ONE tenant. Idempotent: returns false when the
 * template already exists, so re-running is safe on a populated database.
 *
 * `VendorAssessmentTemplate` is RLS-tenant-scoped, so a "global" baseline is
 * still a per-tenant row — which is why this takes a tenantId rather than
 * writing once.
 */
export async function seedAisvsVendorQuestionnaire(
    prisma: PrismaClient,
    fixture: AisvsQuestionnaireFixture,
    tenantId: string,
    /**
     * Null on the production path: `scripts/seed-vendor-questionnaires.ts` runs
     * without an acting user, exactly as it does for the two Supplier
     * questionnaires. The dev seed passes its admin so the demo tenant's
     * template has an author.
     */
    createdByUserId: string | null,
): Promise<boolean> {
    const existing = await prisma.vendorAssessmentTemplate.findUnique({
        where: { tenantId_key_version: { tenantId, key: fixture.key, version: 1 } },
        select: { id: true },
    });
    if (existing) return false;

    const tpl = await prisma.vendorAssessmentTemplate.create({
        data: {
            tenantId,
            key: fixture.key,
            version: 1,
            isLatestVersion: true,
            isPublished: true,
            isGlobal: true,
            name: fixture.name,
            description: `${fixture.description}\n\n${fixture.attribution}`,
            scoringConfigJson: {
                mode: 'WEIGHTED_AVERAGE',
                // Percentages, DECLARED rather than implied — see
                // ScoringConfig.thresholdScale. Undeclared, these were bracketed
                // against a points-per-unit-weight average that never exceeds
                // ~10, so every vendor auto-rated LOW.
                thresholdScale: 'PERCENT',
                ratingThresholds: [
                    { rating: 'LOW', minScore: 0, maxScore: 25 },
                    { rating: 'MEDIUM', minScore: 26, maxScore: 50 },
                    { rating: 'HIGH', minScore: 51, maxScore: 75 },
                    { rating: 'CRITICAL', minScore: 76, maxScore: 100 },
                ],
            },
            createdByUserId,
        },
    });

    let sOrder = 0;
    for (const section of fixture.sections) {
        const sec = await prisma.vendorAssessmentTemplateSection.create({
            data: {
                tenantId,
                templateId: tpl.id,
                sortOrder: sOrder++,
                title: section.title,
                description: section.conditional
                    ? `Applies only to ${section.appliesTo} vendors — answer N/A otherwise.`
                    : null,
                weight: section.weight,
            },
        });
        let qOrder = 0;
        for (const q of section.questions) {
            const isArchetype = q.type === 'ARCHETYPE';
            await prisma.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId,
                    templateId: tpl.id,
                    sectionId: sec.id,
                    sortOrder: qOrder++,
                    prompt: q.prompt,
                    answerType: 'SINGLE_SELECT',
                    // A conditional section's questions cannot be required — the
                    // vendor may legitimately answer N/A to all of them — and the
                    // archetype question drives the conditionals rather than
                    // being scored itself.
                    required: !section.conditional && !isArchetype,
                    weight: q.weight,
                    optionsJson: isArchetype ? ARCHETYPE_OPTIONS : SELECT_OPTIONS,
                    riskPointsJson: isArchetype ? {} : SELECT_RISK,
                },
            });
        }
    }
    return true;
}

/** Sections and questions in a fixture — for the seeders' log lines. */
export function aisvsQuestionnaireCounts(fixture: AisvsQuestionnaireFixture): {
    sections: number;
    questions: number;
} {
    return {
        sections: fixture.sections.length,
        questions: fixture.sections.reduce((n, s) => n + s.questions.length, 0),
    };
}
