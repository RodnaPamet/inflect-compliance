/**
 * THE FOUR SPECIALISTS, AND THE NARROWING THAT IS THE POINT OF THEM (#3473).
 *
 * PURE DATA AND TWO PURE FUNCTIONS. No `@flue/runtime` import, so this module
 * loads anywhere — the `defineSubagent`/`useSubagent`/`useTool` calls live in
 * `agent.ts`, which is the one module in `src/` that may value-import the
 * runtime. Same split as the skills: the data is portable and the mount is not.
 *
 * ## The invariant this file exists for
 *
 * > The subset must be taken of the parent's already-intersected set, never
 * > re-derived from the register.
 *
 * The effective tool set for a run is already an intersection (plan point 02):
 * `RegisteredAgentTool` allowlist ∩ API-key resource scopes ∩ autonomy
 * ceiling. Re-deriving a subagent's tools from the register would silently
 * drop the key-scope and ceiling terms — restoring reach the parent run was
 * never granted.
 *
 * AND THE WRONG IMPLEMENTATION IS THE NATURAL ONE, which is why this is
 * structural rather than asserted. `SubagentDefinition` carries no tool list;
 * the runtime's own docblock says a delegate's `agent` function is "rendered at
 * delegation time — in its own frame, fresh per task" and that "identity and
 * behavior come only from that render". A fresh frame holds no parent binding,
 * so the obvious thing to write inside it is a resolver that reads the
 * register. `narrowTools` cannot do that: it takes the parent's resolved tools
 * as an argument and returns a FILTER of them, so the subset property is a
 * property of the function rather than a claim about its caller.
 *
 * ## The same rule applies to SKILLS, and that is not incidental
 *
 * #3470's criterion is that "an agent's loaded skill set is exactly what its
 * workflow declares". A specialist mounting a skill the parent's definition
 * never declared would widen what the run is taught — the same defect in a
 * different currency, and one a tool-only subset rule would miss entirely. So
 * both terms narrow, through the same shape.
 *
 * ## Why each set is what it is
 *
 * Each specialist declares the tools its JOB implies, and the intersection
 * does the rest. `policy_drafter` declares `draft_policy`, a PROPOSE tool at
 * rung 2 — and a parent capped at READ simply does not have it, so the
 * narrowing hands over nothing. That is the property worth having: the
 * specialist's declaration says what it would use, and the parent's binding
 * decides what it gets. No per-specialist ceiling arithmetic, because the
 * ceiling was already spent upstream.
 */

export interface SpecialistDefinition {
    /** Catalog name the model selects on the `task` tool. Snake case, like a tool. */
    readonly name: string;
    /** The catalogue line — how the model decides when to delegate here. */
    readonly description: string;
    /**
     * The tool names this specialist would use. An UPPER BOUND, not a grant:
     * it gets the intersection of this and the parent's resolved set.
     */
    readonly tools: readonly string[];
    /**
     * The corpus skills this specialist would mount. Also an upper bound —
     * intersected with what the parent's workflow definition declared.
     */
    readonly skills: readonly string[];
    /** The delegate's instruction, returned by its render. */
    readonly instructions: string;
}

export const SPECIALISTS: readonly SpecialistDefinition[] = [
    {
        name: 'risk_analyst',
        description:
            'Analyses the tenant\'s risk register and posture: which risks are '
            + 'material, what the gaps are, and what the findings imply. Delegate '
            + 'when the question is about risk rather than about a control or a '
            + 'document.',
        tools: ['list_risks', 'get_compliance_posture', 'find_coverage_gaps', 'list_findings'],
        // NO SKILL, deliberately. The shipped corpus has none whose subject is
        // risk analysis — the nearest are an EU AI Act classifier and an
        // incident-timeline reader, and mounting a mismatched skill would cost
        // its catalogue bytes on every turn to teach the wrong thing. An empty
        // set is the honest value until the corpus has one.
        skills: [],
        instructions:
            'Assess the risks the question concerns using the register and the '
            + 'posture. Name the risks by their identifiers, say what the evidence '
            + 'supports and what it does not, and return the assessment. Do not '
            + 'propose changes — the agent that delegated to you does that.',
    },
    {
        name: 'evidence_assessor',
        description:
            'Judges whether evidence actually supports the control or requirement '
            + 'it is attached to, and says what is missing. Delegate when the '
            + 'question is whether something would satisfy an auditor.',
        tools: [
            'list_evidence_expiring',
            'list_controls',
            'search_controls',
            'get_framework_status',
        ],
        skills: ['evidence-sufficiency'],
        instructions:
            'Judge the evidence on the five sufficiency tests and name the axis '
            + 'any shortfall falls on. Say what an auditor would reject and what '
            + 'to collect instead.',
    },
    {
        name: 'vendor_reviewer',
        description:
            'Reviews third-party and ICT supply-chain arrangements — what the '
            + 'register must record, whether an arrangement supports a critical '
            + 'function, and what is missing before a submission. Delegate for '
            + 'supplier and vendor questions.',
        tools: ['get_tenant_context', 'list_risks', 'list_findings', 'list_tasks'],
        skills: ['dora-register-duties'],
        instructions:
            'Review the arrangement against the register\'s duties. The unit is the '
            + 'contractual arrangement, not the provider. Say what is recorded, what '
            + 'is missing, and whether the arrangement supports a critical or '
            + 'important function.',
    },
    {
        name: 'policy_drafter',
        description:
            'Drafts and reviews control implementations and applicability '
            + 'decisions, keyed to control identifiers. Delegate when the output '
            + 'is prose about a control rather than a judgement about data.',
        tools: ['list_controls', 'search_controls', 'get_framework_status', 'draft_policy'],
        skills: ['iso-27001-annex-a-drafting', 'soa-authoring'],
        instructions:
            'Draft from the control identifier and the tenant\'s own evidence, never '
            + 'from recalled standard wording — a draft that paraphrases the standard '
            + 'back at the reader states the requirement rather than answering it.',
    },
];

/** The catalogue names, for the guards and the mount. */
export const SPECIALIST_NAMES: readonly string[] = SPECIALISTS.map((s) => s.name);

/**
 * The parent's tools this specialist may use — an INTERSECTION, always.
 *
 * Generic over the tool shape so this module needs no runtime type: the caller
 * passes whatever `FlueRunBinding['tools']` holds and gets a filtered slice of
 * the SAME objects back. Returning the parent's own objects rather than
 * rebuilt ones matters: a rebuilt tool would be a second definition of the
 * same name, and the ledger wrapper the driver put around it would be gone.
 */
export function narrowTools<T extends { name: string }>(
    spec: SpecialistDefinition,
    parentTools: readonly T[],
): T[] {
    const wanted = new Set(spec.tools);
    return parentTools.filter((t) => wanted.has(t.name));
}

/**
 * The parent's skills this specialist mounts — the same intersection, in the
 * other currency. See the header for why a tool-only rule would miss this.
 */
export function narrowSkills<T extends { name: string }>(
    spec: SpecialistDefinition,
    parentSkills: readonly T[],
): T[] {
    const wanted = new Set(spec.skills);
    return parentSkills.filter((s) => wanted.has(s.name));
}
