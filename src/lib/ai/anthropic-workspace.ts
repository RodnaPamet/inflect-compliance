/**
 * THE ANTHROPIC WORKSPACE HEADER — one definition for every caller of the
 * Anthropic API.
 *
 * An API key created inside a workspace carries its workspace with it. An
 * ORGANISATION-level key does not, and Anthropic refuses its requests with
 * HTTP 400 — "This API key is not scoped to a workspace, so this request must
 * include the anthropic-workspace-id header with the ID of the workspace" —
 * unless each request names the workspace it belongs to.
 *
 * `ANTHROPIC_WORKSPACE_ID` (`src/env.ts`) is that name. When it is set, every
 * request to the Anthropic API carries `anthropic-workspace-id: <id>`. When it
 * is unset this returns an EMPTY object, so a caller that spreads it sends
 * exactly the headers it sent before and a workspace-scoped key keeps working
 * untouched.
 *
 * ── WHY THE ID IS AN ARGUMENT, NOT READ FROM `env` HERE ─────────────────────
 *
 * Every caller already resolves its credential at its own construction site
 * and passes it in: the two direct providers take the key from their factory,
 * and the Flue provider builder closes over the key `runtime-start.ts` gives
 * it rather than reading ambient configuration (see `providers.ts`). The
 * workspace id travels the same way. It also keeps this module free of any
 * import, so the ESM-only Flue graph and the server providers can both hold it
 * and nothing about it can reach a client bundle.
 *
 * ── WHY IT TRIMS ────────────────────────────────────────────────────────────
 *
 * The schema in `src/env.ts` trims too, but only when it runs: under
 * `SKIP_ENV_VALIDATION=1` (the image build, every Jest run) `@t3-oss/env-nextjs`
 * hands back the raw string unparsed. Trimming at the one place every caller
 * passes through means a trailing newline pasted into an env file cannot become
 * a header value `fetch` refuses, whichever path the value took to get here. A
 * blank or whitespace-only value is treated as unset, which is what an operator
 * who cleared it meant.
 */

/** The request header Anthropic reads to place an organisation-level key's request in a workspace. */
export const ANTHROPIC_WORKSPACE_HEADER = 'anthropic-workspace-id';

/**
 * The extra headers a request to the Anthropic API needs for this workspace
 * id: `{ 'anthropic-workspace-id': id }` when one is configured, `{}` when not.
 */
export function anthropicWorkspaceHeaders(
    workspaceId: string | null | undefined,
): Record<string, string> {
    const id = workspaceId?.trim();
    return id ? { [ANTHROPIC_WORKSPACE_HEADER]: id } : {};
}

/**
 * WHICH WORKSPACE A RESPONSE SAYS IT CAME FROM, against the one configured
 * (#5854 finding 4). Anthropic names the workspace the work ran in, in the
 * RESPONSE's own `anthropic-workspace-id` header.
 *
 *   MATCH     it names the configured workspace;
 *   MISSING   it names none (absent, or blank);
 *   MISMATCH  it names another.
 *
 * THE ONE COMPARISON: the `anthropic-workspace` connection's Test asks it of
 * its one call, and the Managed Agents engine's client asks it of every
 * response (`managed-agents/workspace-header.ts`). What each does with the
 * answer is its own: the Test refuses MISSING (`WORKSPACE_UNCONFIRMED`); the
 * engine passes it, counted, until a real workspace has shown that every
 * endpoint a run uses sends the header (owner decision 2026-11-25).
 *
 * Both sides are trimmed, as `anthropicWorkspaceHeaders` trims what is sent.
 */
export type AnsweredWorkspace = 'MATCH' | 'MISSING' | 'MISMATCH';

export function answeredWorkspace(
    responseHeaders: { get(name: string): string | null },
    configuredWorkspaceId: string,
): AnsweredWorkspace {
    const answeredFor = responseHeaders.get(ANTHROPIC_WORKSPACE_HEADER)?.trim();
    if (!answeredFor) return 'MISSING';
    return answeredFor === configuredWorkspaceId.trim() ? 'MATCH' : 'MISMATCH';
}
