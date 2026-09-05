/**
 * EU AI Act — conformity artifact generation (propose-not-commit).
 *
 * For HIGH-risk AI systems the Act requires conformity artifacts:
 *   - Technical Documentation — Article 11 + Annex IV structure.
 *   - Risk Management record   — Article 9.
 *   - Declaration of Conformity — Article 47 + Annex V structure.
 *
 * This module DRAFTS those documents from the registry data + the system's
 * linked obligations, then routes them through the propose-not-commit approval
 * queue (`createAgentProposal`). A human with write permission reviews and
 * approves before anything becomes a real (DRAFT) policy/document — and even
 * then it is never auto-published. This generator therefore makes NO direct
 * create/publish call to the policy usecase; the CI ratchet
 * (tests/guards/ai-system-registry.test.ts, PROPOSE-NOT-COMMIT) enforces that.
 *
 * A conformity DECLARATION is never auto-issued — issuing conformity is a
 * human legal act.
 *
 * PROVENANCE: document structures are authored from Regulation (EU) 2024/1689
 * (Annex IV, Article 9, Annex V). Nothing derives from any third-party source.
 */
import { assertCanWrite } from '../policies/common';
import { badRequest } from '@/lib/errors/types';
import { createAgentProposal } from './agent-proposals';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import { getAiSystem } from './ai-system';
import { GenerateConformityDraftSchema } from '../schemas/ai-system.schemas';
import type { RequestContext } from '../types';

type ConformitySystem = Awaited<ReturnType<typeof getAiSystem>>;

function obligationList(system: ConformitySystem): string {
    if (!system.requirementLinks.length) {
        return '_No obligations linked yet — classify the system to populate its obligation set._';
    }
    return system.requirementLinks
        .map(
            (l) =>
                `- **${l.requirement.framework.key} ${l.requirement.code}** — ${l.requirement.title}`,
        )
        .join('\n');
}

const DRAFT_BANNER =
    '> **DRAFT — for human review.** Generated from the AI-System Registry. ' +
    'Not a legal conformity artifact until reviewed, completed, approved, and issued by an authorised person.';

function buildAnnexIvTechnicalDocumentation(system: ConformitySystem): { title: string; content: string } {
    return {
        title: `Technical Documentation (Annex IV) — ${system.name}`,
        content: [
            `# Technical Documentation — ${system.name}`,
            DRAFT_BANNER,
            '',
            '_Structure per Article 11 and Annex IV of Regulation (EU) 2024/1689._',
            '',
            '## 1. General description of the AI system',
            `- **Name:** ${system.name}`,
            `- **Provider / vendor:** ${system.provider ?? '[To be completed]'}`,
            `- **Deployment role:** ${system.deploymentRole}`,
            `- **Risk tier:** ${system.riskTier} (${system.classificationClauseId ?? 'n/a'})`,
            `- **Intended purpose:** ${system.purpose ?? '[To be completed]'}`,
            `- **Use context:** ${system.useContext ?? '[To be completed]'}`,
            `- **Classification basis:** ${system.classificationRationale ?? '[To be completed]'}`,
            '',
            '## 2. Detailed description of the elements and development process',
            'Design specifications, system architecture, data requirements, and the human-oversight measures (Article 14). _[To be completed by the technical owner.]_',
            '',
            '## 3. Monitoring, functioning and control',
            'Capabilities and limitations, expected accuracy, foreseeable unintended outcomes, and input-data specifications. _[To be completed.]_',
            '',
            '## 4. Appropriateness of the performance metrics',
            '_[To be completed.]_',
            '',
            '## 5. Risk management system (Article 9)',
            'See the separate Article 9 Risk Management record. _[Attach or summarise.]_',
            '',
            '## 6. Relevant changes made through the lifecycle',
            '_[To be completed.]_',
            '',
            '## 7. Applied harmonised standards / common specifications',
            '_[To be completed.]_',
            '',
            '## 8. Declaration of Conformity',
            'See the separate Annex V Declaration of Conformity draft.',
            '',
            '## 9. Post-market monitoring plan (Article 72)',
            '_[To be completed.]_',
            '',
            '## Linked obligations (from the registry)',
            obligationList(system),
        ].join('\n'),
    };
}

function buildArt9RiskManagement(system: ConformitySystem): { title: string; content: string } {
    return {
        title: `Risk Management Record (Art. 9) — ${system.name}`,
        content: [
            `# Risk Management Record — ${system.name}`,
            DRAFT_BANNER,
            '',
            '_Structure per Article 9 of Regulation (EU) 2024/1689 — a continuous, iterative risk management process across the system lifecycle._',
            '',
            `- **System:** ${system.name} (${system.riskTier}, ${system.classificationClauseId ?? 'n/a'})`,
            `- **Intended purpose:** ${system.purpose ?? '[To be completed]'}`,
            '',
            '## (a) Identification and analysis of known and foreseeable risks',
            'Risks to health, safety, and fundamental rights that the system may pose when used for its intended purpose. _[To be completed.]_',
            '',
            '## (b) Estimation and evaluation of risks',
            'Risks that may emerge under intended use and under conditions of reasonably foreseeable misuse. _[To be completed.]_',
            '',
            '## (c) Evaluation of risks from post-market monitoring',
            '_[To be completed.]_',
            '',
            '## (d) Risk management measures adopted',
            'Measures to eliminate or reduce risks, mitigation and control measures for non-eliminable risks, and information/training for deployers. _[To be completed.]_',
            '',
            '## Testing',
            'Testing performed to identify the most appropriate risk-management measures, against prior-defined metrics and probabilistic thresholds. _[To be completed.]_',
            '',
            '## Linked obligations (from the registry)',
            obligationList(system),
        ].join('\n'),
    };
}

function buildAnnexVDeclaration(system: ConformitySystem): { title: string; content: string } {
    return {
        title: `Declaration of Conformity (Annex V) — ${system.name}`,
        content: [
            `# EU Declaration of Conformity (DRAFT) — ${system.name}`,
            DRAFT_BANNER,
            '',
            '> **A Declaration of Conformity is a legal act.** This draft must be completed, reviewed, and issued/signed by an authorised person. It is never auto-issued.',
            '',
            '_Content per Article 47 and Annex V of Regulation (EU) 2024/1689._',
            '',
            `1. **AI system name and identification:** ${system.name} — _[unique identifier to be completed]_`,
            `2. **Provider (and authorised representative):** ${system.provider ?? '[To be completed]'} — _[name and address to be completed]_`,
            '3. **Responsibility:** This declaration of conformity is issued under the sole responsibility of the provider.',
            '4. **Conformity statement:** The above AI system is in conformity with Regulation (EU) 2024/1689 and, where applicable, with other relevant Union harmonisation legislation. _[Confirm applicable law.]_',
            '5. **Standards / common specifications referenced:** _[To be completed.]_',
            '6. **Notified body (where applicable):** _[Name, number, and certificate — to be completed.]_',
            '7. **Place and date of issue; signatory:** _[To be completed by the authorised signatory.]_',
            '',
            '## Linked obligations (from the registry)',
            obligationList(system),
        ].join('\n'),
    };
}

const BUILDERS = {
    ANNEX_IV_TECHNICAL_DOCUMENTATION: buildAnnexIvTechnicalDocumentation,
    ART_9_RISK_MANAGEMENT: buildArt9RiskManagement,
    ANNEX_V_DECLARATION_OF_CONFORMITY: buildAnnexVDeclaration,
} as const;

/**
 * Generate a DRAFT conformity artifact for a HIGH-risk AI system and route it
 * through the propose-not-commit approval queue. Returns the proposal id — a
 * human must approve it before any policy/document row exists.
 */
export async function generateConformityDraft(ctx: RequestContext, aiSystemId: string, input: unknown) {
    assertCanWrite(ctx);
    const { docType } = GenerateConformityDraftSchema.parse(input);

    const system = await getAiSystem(ctx, aiSystemId);
    if (system.riskTier !== 'HIGH') {
        throw badRequest(
            'Conformity artifacts are only generated for HIGH-risk AI systems (Art 11 / Annex IV / Annex V apply to high-risk systems).',
        );
    }

    const { title, content } = BUILDERS[docType](system);

    // Propose-not-commit: this NEVER calls createPolicy/publishPolicy directly.
    // The proposal is a PENDING row; on human approval the queue creates a DRAFT
    // policy (still unpublished). A conformity declaration is never auto-issued.
    const proposal = await createAgentProposal(ctx, {
        kind: 'POLICY',
        payload: { title, content, category: 'EU AI Act Conformity' },
        rationale: `Draft ${docType} generated from the AI-System Registry for "${system.name}" (${system.riskTier}). Requires human review before it becomes a document; a Declaration of Conformity is never auto-issued.`,
        // Which policy-card version governed this. A conformity draft is
        // generated by a PERSON clicking a button in the registry, not by a
        // registered agent, so `ctx.agentId` is absent and this resolves to
        // `NO_POLICY_CARD` without a query. Recorded rather than left NULL
        // because the proposal queue holds rows from both kinds of author, and
        // "no card governed this" is a different fact from "this row predates
        // pinning".
        policyCardVersion: await resolvePolicyCardPin(ctx.tenantId, ctx.agentId),
    });

    return { proposalId: proposal.id, docType, aiSystemId, status: proposal.status };
}
