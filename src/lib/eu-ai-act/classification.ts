/**
 * EU AI Act — risk-tier classification (authored from the Regulation).
 *
 * Source: Regulation (EU) 2024/1689 of the European Parliament and of the
 * Council (the "AI Act"), public EU law. Every rule below is authored directly
 * from the Regulation text and cites the driving clause by identifier:
 *   - Article 5      — prohibited AI practices              → PROHIBITED
 *   - Article 6(1)   — safety component of an Annex I product → HIGH
 *   - Annex III      — high-risk use-cases                  → HIGH
 *   - Article 50     — transparency obligations             → LIMITED
 *   - otherwise (Art 95 voluntary codes of conduct)         → MINIMAL
 *
 * The classifier is deterministic and explainable: it returns the tier AND the
 * clause identifier that drove it, so the registry can show *why* a system is
 * high-risk. Precedence is strict: PROHIBITED > HIGH > LIMITED > MINIMAL.
 *
 * PROVENANCE: nothing in this file derives from any third-party codebase,
 * model, or dataset. It is authored solely from the Regulation.
 */

/** A tier the Act defines, and the only thing the classifier can return. */
export type AiRiskTier = 'PROHIBITED' | 'HIGH' | 'LIMITED' | 'MINIMAL';

/**
 * What `AiSystem.riskTier` can hold: a classified tier, or UNCLASSIFIED for a
 * provisional entry nobody has classified (#3691). UNCLASSIFIED is deliberately
 * outside `AiRiskTier`, so the classifier cannot return it and a writer typed
 * with `AiRiskTier` cannot store it. Read it as "not classified", never as
 * MINIMAL.
 */
export type StoredAiRiskTier = AiRiskTier | 'UNCLASSIFIED';

export function isClassifiedTier(tier: StoredAiRiskTier): tier is AiRiskTier {
    return tier !== 'UNCLASSIFIED';
}

interface ClauseOption {
    /** Stable machine id used in the questionnaire + persisted on the row. */
    id: string;
    /** The Regulation clause identifier cited as the basis for the tier. */
    clause: string;
    /** Short human-readable label for the questionnaire UI. */
    label: string;
}

/**
 * Article 5(1)(a)–(h) — prohibited AI practices. Presence of ANY of these makes
 * the system PROHIBITED; it may not be placed on the market, put into service,
 * or used.
 */
export const ART5_PROHIBITED_PRACTICES: readonly ClauseOption[] = [
    { id: 'subliminal_manipulation', clause: 'Art.5(1)(a)', label: 'Subliminal or purposefully manipulative techniques that distort behaviour and cause harm' },
    { id: 'exploits_vulnerabilities', clause: 'Art.5(1)(b)', label: "Exploits vulnerabilities due to age, disability, or a specific social/economic situation" },
    { id: 'social_scoring', clause: 'Art.5(1)(c)', label: 'Social scoring leading to detrimental or unfavourable treatment' },
    { id: 'predictive_policing_profiling', clause: 'Art.5(1)(d)', label: 'Predicting criminal offending based solely on profiling or personality traits' },
    { id: 'facial_scraping', clause: 'Art.5(1)(e)', label: 'Untargeted scraping of facial images to build recognition databases' },
    { id: 'emotion_workplace_education', clause: 'Art.5(1)(f)', label: 'Inferring emotions in the workplace or education institutions' },
    { id: 'biometric_categorisation_sensitive', clause: 'Art.5(1)(g)', label: 'Biometric categorisation inferring sensitive attributes (race, beliefs, sexual orientation, …)' },
    { id: 'realtime_remote_biometric_le', clause: 'Art.5(1)(h)', label: "Real-time remote biometric identification in public spaces for law enforcement" },
] as const;

/**
 * Annex III(1)–(8) — high-risk use-cases (referenced by Article 6(2)). A system
 * used in ANY of these areas is HIGH-risk (subject to the Art 6(3) narrow
 * derogations, which a human classifier confirms — the questionnaire asks the
 * area, not the derogation).
 */
export const ANNEX_III_AREAS: readonly ClauseOption[] = [
    { id: 'biometrics', clause: 'Annex III(1)', label: 'Biometrics — remote identification, categorisation, or emotion recognition' },
    { id: 'critical_infrastructure', clause: 'Annex III(2)', label: 'Safety component in critical infrastructure (digital, traffic, utilities)' },
    { id: 'education', clause: 'Annex III(3)', label: 'Education and vocational training (admissions, scoring, proctoring)' },
    { id: 'employment', clause: 'Annex III(4)', label: 'Employment, worker management, and access to self-employment' },
    { id: 'essential_services', clause: 'Annex III(5)', label: 'Access to essential services (credit scoring, benefits, emergency dispatch, insurance)' },
    { id: 'law_enforcement', clause: 'Annex III(6)', label: 'Law enforcement' },
    { id: 'migration_border', clause: 'Annex III(7)', label: 'Migration, asylum, and border control management' },
    { id: 'justice_democracy', clause: 'Annex III(8)', label: 'Administration of justice and democratic processes' },
] as const;

/**
 * Article 50(1)–(4) — transparency obligations. A system that triggers one of
 * these (and is not PROHIBITED or HIGH) is LIMITED-risk: it must disclose its
 * AI nature / mark synthetic content, but carries no high-risk obligation set.
 */
export const ART50_TRANSPARENCY_CASES: readonly ClauseOption[] = [
    { id: 'direct_interaction', clause: 'Art.50(1)', label: 'Interacts directly with people (e.g. a chatbot / assistant)' },
    { id: 'synthetic_content', clause: 'Art.50(2)', label: 'Generates synthetic audio, image, video, or text content' },
    { id: 'emotion_or_biometric_categorisation', clause: 'Art.50(3)', label: 'Emotion recognition or biometric categorisation (not otherwise prohibited/high-risk)' },
    { id: 'deep_fake', clause: 'Art.50(4)', label: 'Produces deep-fake or manipulated image/audio/video content' },
] as const;

export interface ClassificationInput {
    /** Article 5 practice id, if the system engages in a prohibited practice. */
    prohibitedPractice?: string | null;
    /** Article 6(1): the system is a safety component of an Annex I product. */
    isAnnexIProductSafetyComponent?: boolean | null;
    /** Annex III area id, if the system is used in a high-risk area. */
    annexIIIArea?: string | null;
    /** Article 50 transparency case id, if applicable. */
    transparencyCase?: string | null;
}

export interface ClassificationResult {
    tier: AiRiskTier;
    /** The Regulation clause identifier that drove the tier. */
    clauseId: string;
    /** Human-readable explanation citing the clause. */
    rationale: string;
}

const byId = (opts: readonly ClauseOption[], id: string | null | undefined) =>
    id ? opts.find((o) => o.id === id) ?? null : null;

/**
 * Classify an AI system into its EU AI Act risk tier. Deterministic; strict
 * precedence PROHIBITED > HIGH > LIMITED > MINIMAL. Always returns the driving
 * clause id so the decision is auditable and explainable.
 */
export function classifyAiSystem(input: ClassificationInput): ClassificationResult {
    // 1. Article 5 — prohibited practices win outright.
    const prohibited = byId(ART5_PROHIBITED_PRACTICES, input.prohibitedPractice);
    if (prohibited) {
        return {
            tier: 'PROHIBITED',
            clauseId: prohibited.clause,
            rationale: `Prohibited under ${prohibited.clause}: ${prohibited.label}. The system may not be placed on the market, put into service, or used.`,
        };
    }

    // 2. Article 6 + Annex III — high-risk use-cases and product-safety components.
    const annexIII = byId(ANNEX_III_AREAS, input.annexIIIArea);
    if (annexIII) {
        return {
            tier: 'HIGH',
            clauseId: annexIII.clause,
            rationale: `High-risk under Article 6(2) / ${annexIII.clause}: ${annexIII.label}. The full high-risk obligation set applies.`,
        };
    }
    if (input.isAnnexIProductSafetyComponent) {
        return {
            tier: 'HIGH',
            clauseId: 'Art.6(1)',
            rationale: 'High-risk under Article 6(1): the system is a safety component of a product covered by the Annex I harmonisation legislation. The full high-risk obligation set applies.',
        };
    }

    // 3. Article 50 — transparency-only cases.
    const transparency = byId(ART50_TRANSPARENCY_CASES, input.transparencyCase);
    if (transparency) {
        return {
            tier: 'LIMITED',
            clauseId: transparency.clause,
            rationale: `Limited-risk transparency obligation under ${transparency.clause}: ${transparency.label}.`,
        };
    }

    // 4. Otherwise minimal risk — only the voluntary measures of Article 95 apply.
    return {
        tier: 'MINIMAL',
        clauseId: 'Art.95',
        rationale: 'Minimal risk: no prohibited practice, high-risk use-case, or transparency trigger identified. Only the voluntary codes of conduct of Article 95 apply.',
    };
}
