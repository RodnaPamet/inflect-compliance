/**
 * THE IDS OF THE TOOL CALLS ONE MODEL REPLY ISSUED, and nothing else of it
 * (owner decision 2026-11-15, Inspect task 9; `FlueModelTurn` in `execute.ts`).
 *
 * The runtime's `turn` event carries the reply (`response.output`), and the
 * reply is model output: its text, its thinking and each tool call's arguments.
 * `execute.ts` must not read it (`flue-model-output-has-one-destination`), so
 * this is the one place that looks inside it, and what leaves is a list of the
 * runtime's correlation ids, which the tool `run`s receive as `toolCallId`. No
 * text, no thinking, no argument and no tool name is read.
 *
 * Structural, with no import of `@flue/runtime`, so it stays off the ESM graph
 * and a CJS suite can run it.
 */
export function toolCallIdsOf(response: {
    readonly output?: { readonly content?: ReadonlyArray<{ readonly type: string; readonly id?: unknown }> };
}): string[] {
    const ids: string[] = [];
    for (const block of response.output?.content ?? []) {
        if (block.type === 'toolCall' && typeof block.id === 'string' && block.id !== '') ids.push(block.id);
    }
    return ids;
}
