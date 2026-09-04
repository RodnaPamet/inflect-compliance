/**
 * The five generic tasks every control template got when nobody had authored
 * it anything better.
 *
 * WHY THIS FILE EXISTS. These five lived as four byte-identical copies —
 * `seed.ts`, `seed-catalog.ts`, `catalog-applier.ts` and
 * `scripts/backfill-framework-catalog.mjs`. Two of those are npm-reachable
 * (`db:seed`, `framework:import`), so a fix applied to one and not the others
 * would have kept emitting the old text from a path nobody was looking at.
 * Consolidating them is what makes "have we stopped shipping generic tasks?"
 * a question with a single answer.
 *
 * WHY IT IS NOT DELETED YET. It is still the honest default for a template
 * with no authored content, and 261 templates are in that state today. The
 * content PRs shrink that population; this constant is deleted when the last
 * one lands, and the `no-generic-task-strings` ratchet is what proves the
 * deletion was complete rather than merely local.
 *
 * DO NOT ADD A FIFTH COPY. If you need these strings in a script, import
 * them from here. A `.mjs` consumer should be converted to `.ts` rather than
 * given its own literal — that is exactly how four copies happened.
 *
 * @module prisma/generic-template-tasks
 */

/** One generic task, in the shape `ControlTemplateTask` stores. */
export interface GenericTemplateTask {
    readonly title: string;
    readonly description: string;
}

/**
 * The five, verbatim as they have shipped since the beginning.
 *
 * The exact strings are load-bearing beyond seeding: the content ratchets
 * assert that no authored task matches one of them, so changing a character
 * here silently narrows what those ratchets can catch. If these ever need to
 * change, the ratchets' frozen copies have to move in the same commit.
 */
export const GENERIC_TEMPLATE_TASKS: readonly GenericTemplateTask[] = [
    {
        title: 'Define control owner and scope',
        description: 'Assign an owner and define the scope of this control within the organization.',
    },
    {
        title: 'Document procedure or policy',
        description: 'Create or reference the policy/procedure that implements this control.',
    },
    {
        title: 'Implement technical or operational measure',
        description:
            'Put the control into practice — deploy tooling, configure settings, or establish processes.',
    },
    {
        title: 'Collect evidence of implementation',
        description: 'Gather evidence demonstrating the control is operating effectively.',
    },
    {
        title: 'Review effectiveness',
        description: 'Periodically review and assess whether the control meets its objectives.',
    },
] as const;

/** Just the titles — what the ratchets and the future backfill match on. */
export const GENERIC_TEMPLATE_TASK_TITLES: readonly string[] = GENERIC_TEMPLATE_TASKS.map(
    (t) => t.title,
);
