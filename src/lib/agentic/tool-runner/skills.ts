/**
 * THE TOOL RUNNER ENGINE'S SKILLS (Step 2d of `docs/claude-tool-runner-design.md`).
 *
 * Progressive disclosure without files. A run's skills are resolved and pinned
 * by the one resolver every reasoning engine uses (`resolveRunSkillMount`,
 * through the mount gate), at admission and again at each segment. This module
 * only puts what that resolver returned in front of the model:
 *
 *   - the CATALOGUE, one `name: description` line per mounted skill, in the
 *     system prompt after the fixed preamble and before the instructions. The
 *     lines are exactly what `catalogBytes` measures, so the per-run budget the
 *     resolver applies is a budget on what is sent;
 *   - `activate_skill`, an Inflect-owned tool that returns one mounted skill's
 *     instructions.
 *
 * `activate_skill` serves THE RUN'S PINNED SKILLS AND NOTHING ELSE. It holds the
 * documents the resolver returned and the pins the run's row recorded, and it
 * never reads a corpus, a database or another run. A name outside that set is
 * answered with an error naming the reason, so a skill the gate refused, a skill
 * this run did not mount and another tenant's skill all read alike: not mounted.
 * A mounted skill is returned only while its text still hashes to its pin; one
 * that does not is refused at activation rather than taught.
 *
 * Each activation is one step of the run: it is charged against the step cap
 * and written to the ledger as a TOOL_CALL step naming `activate_skill`. It is
 * not a funnel call (it reaches no tenant data and no tool the register
 * grants), so it charges no tool-call allowance. It is reported to the register
 * as an engine-supplied tool (`supplied-tools.ts`).
 */
import type { BetaRunnableTool, BetaToolRunContext } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { asToolArgs } from '@/lib/agentic/engine-tools';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import type { MountedSkillPin } from '@/lib/agentic/flue/skills/mount-gate';
import type { ResolvedSkillDocument } from '@/lib/agentic/flue/skills/resolve';

import { ACTIVATE_SKILL_TOOL_NAME } from './supplied-tools';
import { stoppedMessage, type SerialQueue, type ToolRunBinding } from './tools';

/** What a run mounted, as the resolver returned it, with the pins its row recorded. */
export interface RunSkills {
    readonly documents: readonly ResolvedSkillDocument[];
    readonly pins: readonly MountedSkillPin[];
}

/** Why an activation was refused. Each is named in the error the model reads. */
export type SkillActivationRefusal =
    /** The name is not a skill this run mounted. */
    | 'SKILL_NOT_MOUNTED'
    /** The skill's text no longer hashes to the hash the run pinned. */
    | 'SKILL_PIN_MISMATCH';

/** The sentence each refusal is answered with. Never the skill's text, never the name the model sent. */
export function activationRefusalMessage(reason: SkillActivationRefusal): string {
    switch (reason) {
        case 'SKILL_NOT_MOUNTED':
            return (
                'skill_not_mounted: that is not a skill this run mounted. Only the skills in the catalogue can be '
                + 'activated; a skill the mount gate refused is never mounted.'
            );
        case 'SKILL_PIN_MISMATCH':
            return (
                'skill_pin_mismatch: this skill\'s text no longer matches the version this run was pinned to, so it '
                + 'was not returned.'
            );
    }
}

export class SkillActivationRefused extends Error {
    constructor(public readonly reason: SkillActivationRefusal) {
        super(activationRefusalMessage(reason));
        this.name = 'SkillActivationRefused';
    }
}

/**
 * Which mounted skill a call asks for, with its pin, or the refusal. Pure, so
 * the refusal rules are unit-tested without a run.
 */
export function selectSkillToActivate(
    skills: RunSkills,
    args: unknown,
): { ok: true; document: ResolvedSkillDocument; pin: MountedSkillPin } | { ok: false; reason: SkillActivationRefusal } {
    const name = (args as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') return { ok: false, reason: 'SKILL_NOT_MOUNTED' };
    const document = skills.documents.find((d) => d.name === name);
    const pin = skills.pins.find((p) => p.name === name);
    if (!document || !pin) return { ok: false, reason: 'SKILL_NOT_MOUNTED' };
    // RE-CHECKED HERE, not trusted from the segment's resolution: what reaches
    // the model is this string, so this string is what must match the pin.
    if (skillContentHash(document.instructions) !== pin.contentHash) return { ok: false, reason: 'SKILL_PIN_MISMATCH' };
    return { ok: true, document, pin };
}

/** The catalogue's opening sentence, and its fence. */
export const SKILL_CATALOGUE_INTRO =
    'You have skills: reviewed instructions for particular kinds of task. Before you do a task one of them covers, '
    + `call ${ACTIVATE_SKILL_TOOL_NAME} with its name and follow what it returns. The list below names each skill and `
    + 'says when it applies.';
export const SKILL_CATALOGUE_OPEN = '<skill_catalogue>';
export const SKILL_CATALOGUE_CLOSE = '</skill_catalogue>';

/**
 * The catalogue block for the system prompt, or null when the run mounted
 * nothing. One `name: description` line per skill, in mount order: the lines
 * `catalogBytes` measures.
 */
export function skillCatalogueText(documents: readonly ResolvedSkillDocument[]): string | null {
    if (documents.length === 0) return null;
    return [
        SKILL_CATALOGUE_INTRO,
        SKILL_CATALOGUE_OPEN,
        ...documents.map((d) => `${d.name}: ${d.description}`),
        SKILL_CATALOGUE_CLOSE,
    ].join('\n');
}

/** What an activation returns: the skill's instructions, fenced and labelled with its pin. */
export function activatedSkillText(document: ResolvedSkillDocument, pin: MountedSkillPin): string {
    return [
        `<skill name="${pin.name}" version="${pin.version}" content_hash="${pin.contentHash}">`,
        document.instructions,
        '</skill>',
    ].join('\n');
}

/** One activation, charged, answered and recorded. */
async function activate(binding: ToolRunBinding, skills: RunSkills, args: Record<string, unknown>): Promise<string> {
    const before = binding.stopped();
    if (before) throw new Error(stoppedMessage(before));

    const halt = binding.budget.charge('STEPS', 1);
    if (halt) {
        binding.stopAtCap(halt);
        throw new Error(halt.message);
    }

    const seq = binding.nextSeq();
    const selected = selectSkillToActivate(skills, args);
    // The name is recorded only when it is a mounted skill's: any other string
    // is the model's, and the ledger keeps the reason instead.
    if (!selected.ok) {
        binding.onFailure();
        await recordStep(binding.ctx, binding.runId, seq, 'TOOL_CALL', {
            toolCalled: ACTIVATE_SKILL_TOOL_NAME,
            status: 'FAILED',
            label: ACTIVATE_SKILL_TOOL_NAME,
            output: { refused: selected.reason },
        });
        throw new SkillActivationRefused(selected.reason);
    }
    await recordStep(binding.ctx, binding.runId, seq, 'TOOL_CALL', {
        toolCalled: ACTIVATE_SKILL_TOOL_NAME,
        status: 'DONE',
        label: ACTIVATE_SKILL_TOOL_NAME,
        input: { name: selected.pin.name, version: selected.pin.version, contentHash: selected.pin.contentHash },
    });
    return activatedSkillText(selected.document, selected.pin);
}

/**
 * The `activate_skill` tool for a run that mounted skills, or null for one that
 * mounted none (the tool is offered only beside a catalogue). It shares the
 * run's serial queue, so an activation keeps its place in the ledger's order.
 */
export function activateSkillTool(
    binding: ToolRunBinding,
    skills: RunSkills,
    queue: SerialQueue,
): BetaRunnableTool<Record<string, unknown>> | null {
    if (skills.documents.length === 0) return null;
    return {
        type: 'custom',
        name: ACTIVATE_SKILL_TOOL_NAME,
        description:
            'Read the full instructions of one skill from the catalogue in your instructions. Call it before a task '
            + 'the skill covers.',
        input_schema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    enum: skills.documents.map((d) => d.name),
                    description: 'The skill\'s name, exactly as the catalogue writes it.',
                },
            },
            required: ['name'],
            additionalProperties: false,
        },
        parse: (content: unknown) => asToolArgs(content),
        run: (args: Record<string, unknown>, _context?: BetaToolRunContext) =>
            queue.run(() => activate(binding, skills, args)),
    };
}
