import { defineSkill, defineSubagent, useInitialData, useInstruction, useModel, useResponseFinish, useSkill, useSubagent, useTool } from '@flue/runtime';

import { readRunBinding } from './run-binding';
import { SPECIALISTS, narrowTools, narrowSkills } from './subagents';

/**
 * THE ONE AGENT FUNCTION THIS PROCESS SERVES.
 *
 * ── WHY THERE IS EXACTLY ONE ────────────────────────────────────────────────
 *
 * `start({ agents })` fixes the set at boot and throws if the process already
 * has a runtime, so a run cannot bring its own agent. That is a constraint and
 * also a property worth keeping: an agent function that cannot be assembled
 * per request cannot have its tool set widened per request either. What varies
 * per run arrives through the binding below, which was resolved by the driver
 * under the caller's authority before dispatch.
 *
 * ── THIS MODULE MUST NEVER BE IMPORTED FROM THE MAIN SRC GRAPH ──────────────
 *
 * It holds the only VALUE import of `@flue/runtime` in `src/`. That package is
 * ESM-only with no `require` condition, so anything importing it is unloadable
 * from the `node` jest project — and a static edge from, say,
 * `drivers/index.ts` would take every test that transitively reaches the
 * driver registry down with it.
 *
 * The adapter next door gets away with `import type { useTool } …` precisely
 * because a type-only import is erased. This one cannot be. So the driver
 * reaches this module through a dynamic `import()` on the path that has
 * already decided a Flue run is happening, and nothing imports it statically.
 * `tests/guards/flue-refused-capabilities.test.ts` is where that is enforced.
 *
 * ── SYNCHRONOUS, AND IT HAS TO BE ───────────────────────────────────────────
 *
 * The runtime refuses an async agent function: "move async work into tools,
 * actions, or resource factories". Nothing here does I/O — the binding was
 * resolved before dispatch, and `flueToolsFor` is a pure mapping over an
 * invocation that was already authorized.
 */
export function InflectAgent(): void {
    const { runId } = useInitialData<{ runId: string }>();

    // READ, not taken. The runtime re-runs this function before every model
    // call, so a destructive read gave turn 1 the tools and every later turn
    // the no-authority branch below — zero tools, no `useResponseFinish`, and
    // a run that still reported COMPLETED. Disposal is the driver's, in the
    // `finally` that ends the dispatch.
    const binding = readRunBinding(runId);

    if (!binding) {
        // NO TOOLS, and say so to the model rather than failing silently.
        //
        // An agent with no binding has no resolved authority, so offering it
        // the empty tool set is the only safe answer — but an empty set alone
        // reads, to a model, like a tenant that happens to have granted
        // nothing. The instruction makes the refusal legible in the transcript
        // an operator reads afterwards.
        useInstruction(
            'This run has no resolved authority and no tools are available. ' +
                'Do not attempt any action; report that the run could not be bound.',
        );
        return;
    }

    useModel(binding.modelSpecifier);

    // ALREADY RESOLVED, by the driver, under the caller's authority. This
    // function registers what it was given and cannot compute more: the
    // invocation that decided the set is deliberately not in scope, so no edit
    // here can widen what the run reaches.
    //
    // It is also what keeps this module loadable. `flueToolsFor` reaches the
    // MCP registry and through it Prisma, and `pg` does not load under the ESM
    // project this module must run in — so the resolution happens in ordinary
    // Node, on the driver's side of the boundary.
    for (const tool of binding.tools) {
        useTool(tool);
    }

    // THE SKILLS THE DEFINITION ASKED FOR (#3470), already resolved against the
    // shipped corpus by the driver. `defineSkill` rather than a `SKILL.md`
    // import because that import is a Vite build-time transform and this app
    // builds with Next.js — the runtime documents the two as equivalent, and
    // "packages it into the same shape a SKILL.md import produces".
    //
    // Converted HERE because `defineSkill` is a value from `@flue/runtime`, and
    // this module is the only place in `src/` that may import one. The binding
    // carries plain documents for exactly that reason.
    for (const skill of binding.skills) {
        useSkill(defineSkill({
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
        }));
    }

    // ── THE SPECIALISTS (#3473) ─────────────────────────────────────────────
    //
    // Declared here and nowhere else, because `useSubagent` is a value from
    // `@flue/runtime` and this module is the only place in `src/` that may
    // import one — the same reason `defineSkill` is converted here.
    //
    // EACH DELEGATE'S RENDER TAKES A SUBSET OF *THIS* BINDING, which is the
    // whole invariant of this plan point. The runtime's own docblock is the
    // reason it has to be written this way: a delegate's `agent` function is
    // "rendered at delegation time — in its own frame, fresh per task", and
    // "identity and behavior come only from that render". A fresh frame holds
    // no binding, so the natural thing to write inside it is a resolver that
    // reads the register — which would silently drop the API-key scope and the
    // autonomy-ceiling terms and restore reach this run was never granted.
    //
    // The closure over `binding` is what makes that impossible rather than
    // merely discouraged: the delegate's render has the parent's RESOLVED set
    // in scope and no way to reach anything else. `narrowTools` filters it; it
    // cannot add to it.
    //
    // DECLARING a subagent is also what makes the runtime's `task` tool usable
    // at all. It is in every run's tool list already (#3569) and until now had
    // no valid `agent` value — so this is the line that turns delegation on,
    // and `delegation-gate.ts` is what bounds it.
    for (const spec of SPECIALISTS) {
        const tools = narrowTools(spec, binding.tools);
        const skills = narrowSkills(spec, binding.skills);
        useSubagent(defineSubagent({
            name: spec.name,
            description: spec.description,
            // NO `model` AND NO `thinkingLevel` OVERRIDE. Both inherit the
            // parent's turn when omitted, which is what we want: the model was
            // resolved against the tenant's residency and its budget, and a
            // delegate on a different model would spend a budget nobody
            // resolved for it.
            agent: () => {
                for (const tool of tools) useTool(tool);
                for (const skill of skills) {
                    useSkill(defineSkill({
                        name: skill.name,
                        description: skill.description,
                        instructions: skill.instructions,
                    }));
                }
                // NO NESTED `useSubagent`. Depth 1 is the owner's decision of
                // 2026-10-15, and this absence is half of it — the other half
                // is `delegation-gate.ts` refusing a `task` call that arrives
                // with a `ctx.taskId`, which is what stops the runtime's own
                // `GeneralSubagent` or a future edit here from reopening it.
                return spec.instructions;
            },
        }));
    }

    // ── HOW USAGE GETS BACK TO THE DRIVER ───────────────────────────────────
    //
    // `AgentReply` carries no usage: the settled totals reach agent code only
    // through this hook, whose return value is deep-merged onto the response's
    // metadata — which the reply DOES carry. So the driver reads its token
    // charge off `reply.metadata`, and the alternative (a callback closed over
    // driver state) is avoided: that would put Prisma-reaching code in the one
    // module that must stay loadable under the ESM project.
    //
    // Synchronous and side-effect-free, as the hook requires — "a returned
    // promise fails the submission". It reports; the driver records.
    useResponseFinish(({ response }) => ({
        [FLUE_USAGE_KEY]: {
            totalTokens: response.usage.totalTokens,
            // The SPLIT as well as the total. `AiDecisionLog` records
            // `tokensIn`/`tokensOut` separately, and the sum hides which shape
            // a call had: 200 in / 20 out is a long prompt cheaply answered,
            // 20 in / 200 out is the opposite, and only one of those is a
            // runaway generation.
            tokensIn: response.usage.input,
            tokensOut: response.usage.output,
            toolCalls: response.toolCalls.length,
            // Calls whose recorded outcome was an error. The driver charges
            // tokens either way — a failed tool call still cost a model turn —
            // but a run that spent its budget failing is a different incident
            // from one that spent it working.
            failedToolCalls: response.toolCalls.filter((c) => c.isError).length,
        },
    }));
}

/**
 * The metadata key the usage report lands under.
 *
 * Namespaced rather than bare `usage`: response metadata is a deep-merged
 * shared surface, and the runtime is free to put its own keys there.
 */
export const FLUE_USAGE_KEY = 'inflectUsage';

/** What `FLUE_USAGE_KEY` holds. Read by the driver off `reply.metadata`. */
export interface FlueUsageReport {
    totalTokens: number;
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    failedToolCalls: number;
}

/** The runtime keys durable conversation storage on this. */
InflectAgent.agentName = 'inflect';
