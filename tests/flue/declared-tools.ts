import type { Context } from '@earendil-works/pi-ai';

/**
 * THE TOOL NAMES A RUN WAS ACTUALLY OFFERED.
 *
 * Deliberately NOT `context.tools`. pi-ai carried tool declarations in that
 * field through 0.83.x, which is what every call site here used to read. From
 * 0.87 a provider receives a `TranscriptContext` instead, and that type's own
 * docblock states the new arrangement outright — "the prompt and tool
 * declarations are carried by the transcript's system messages" — leaving
 * `context.tools` `null` on every request.
 *
 * That is why the five sites this replaces all failed with `[]` rather than
 * with a wrong name: the assertions were right and the field had simply stopped
 * being populated. Measured on pi-ai 1.4.0: `.tools` is `null`, while the
 * system message carries `toolsAdded: [{ name: 'task', description: … }]` and
 * the prompt gains an "## Available Agents" section naming the delegates. So
 * delegation was never lost — only this seam moved.
 *
 * The names are the UNION across the transcript, not the first message's. A
 * roster may change mid-conversation and the runtime announces each change the
 * same way, so a single-message read would see only the opening set.
 */
export function declaredToolNames(context: Context): string[] {
    const messages =
        (context as unknown as { messages?: ReadonlyArray<Record<string, unknown>> })
            .messages ?? [];
    const names = new Set<string>();
    for (const message of messages) {
        const added = message.toolsAdded;
        if (!Array.isArray(added)) continue;
        for (const tool of added as ReadonlyArray<{ name?: unknown }>) {
            if (typeof tool?.name === 'string') names.add(tool.name);
        }
    }
    return [...names].sort();
}

/**
 * EVERYTHING THE MODEL WAS TOLD, as one string.
 *
 * The same move that emptied `context.tools` emptied `context.systemPrompt`:
 * pi-ai's `TranscriptContext` carries "the prompt and tool declarations" in the
 * transcript's system messages, so from 0.87 the field reads `''` on every
 * request. That mattered more than it looks here, because this file identifies
 * WHICH captured context belonged to the delegate by its instruction text — so
 * an empty prompt did not merely weaken an assertion, it made the delegate
 * unfindable and four subset tests fail at `expect(delegate).toBeDefined()`
 * while the delegate had in fact run.
 *
 * `systemPrompt` is still read and unioned in, rather than replaced, so this
 * holds whichever way a given pi-ai version carries it. System message content
 * arrives as a bare string today and as `{ type: 'text', text }` parts
 * elsewhere in the transcript; both are accepted.
 */
export function systemPromptText(context: Context): string {
    const parts: string[] = [];
    const direct = (context as { systemPrompt?: unknown }).systemPrompt;
    if (typeof direct === 'string' && direct !== '') parts.push(direct);

    const messages =
        (context as unknown as { messages?: ReadonlyArray<Record<string, unknown>> })
            .messages ?? [];
    for (const message of messages) {
        if (message.role !== 'system') continue;
        const content = message.content;
        if (typeof content === 'string') {
            parts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content as ReadonlyArray<{ text?: unknown }>) {
                if (typeof part?.text === 'string') parts.push(part.text);
            }
        }
    }
    return parts.join('\n\n');
}
