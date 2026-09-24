/**
 * How a tool on an EXTERNAL MCP server is named, as a LEAF module.
 *
 * ## Why external names cannot join `MCP_TOOL_NAMES`
 *
 * That list is a build-time mirror of `READ_TOOLS` and `PROPOSE_TOOLS`, and
 * `tests/guards/mcp-tools-use-shared-authz.test.ts` pins it to equal the
 * registries EXACTLY. The pin is what stops a tool being added to a registry
 * and silently reaching nobody. A tenant-configured tool appearing in that list
 * would break the pin for a good reason — the list is a statement about this
 * build, and an external catalogue is a statement about one tenant's
 * configuration at one moment. So external tools live in a parallel namespace
 * and the two never mix.
 *
 * ## The shape, and why the connection ID is in it
 *
 *     mcp__<connectionId>__<toolName>
 *
 * The name is a PRIMARY KEY in two places that outlive the catalogue it came
 * from: `RegisteredAgentTool.toolName` (the grant) and
 * `McpToolManifestPin.toolName` (the approved definition). Both must survive a
 * rename of the connection, because a name that moves silently revokes every
 * grant made against the old one and re-baselines every pin. So the immutable
 * connection ID is the qualifier, never a slug or a label the tenant can edit.
 *
 * Two servers can advertise the same tool name, and one server's `list_alerts`
 * is not the other's; qualifying by connection keeps
 * `@@unique([tenantId, toolName])` on the pin table correct without widening it.
 *
 * `__` is the separator because a cuid is alphanumeric and cannot contain one,
 * so the qualifier is always unambiguous. An EXTERNAL tool name may itself
 * contain `__`, which is why decoding splits on the first two separators only
 * and treats the whole remainder as the tool.
 */

/** The prefix that marks a name as belonging to an external server. */
export const EXTERNAL_TOOL_PREFIX = 'mcp__';

const SEPARATOR = '__';

export interface ExternalToolRef {
    /** The `Connection` row the tool is advertised by. */
    connectionId: string;
    /** The tool name as the external server's `tools/list` advertises it. */
    toolName: string;
}

/**
 * Is this the name of a tool on an external server?
 *
 * A pure prefix test, deliberately: it has to be answerable in the hot path of
 * authorization with no database and no catalogue, because the question "is
 * this one of ours" gates which registry resolves the call.
 */
export function isExternalToolName(name: string): boolean {
    return name.startsWith(EXTERNAL_TOOL_PREFIX);
}

/**
 * Build the qualified name for a tool on a connection.
 *
 * Throws on an empty part rather than emitting a name with a hole in it: a
 * malformed qualified name would be stored as a grant and never match anything,
 * which reads to an operator as "the grant does nothing" with no clue why.
 */
export function externalToolName(connectionId: string, toolName: string): string {
    if (!connectionId || connectionId.includes(SEPARATOR)) {
        throw new Error(
            `externalToolName: connectionId must be non-empty and free of "${SEPARATOR}" ` +
            `(got ${JSON.stringify(connectionId)})`,
        );
    }
    if (!toolName) {
        throw new Error('externalToolName: toolName must be non-empty');
    }
    return `${EXTERNAL_TOOL_PREFIX}${connectionId}${SEPARATOR}${toolName}`;
}

/**
 * Split a qualified name back into its connection and tool, or `null` if this
 * is not a well-formed external name.
 *
 * `null` rather than a throw: the caller is usually asking "is this external,
 * and if so whose" about a name that arrived from a client, and an unparseable
 * name is an ordinary refusal rather than a programming error.
 */
export function parseExternalToolName(name: string): ExternalToolRef | null {
    if (!isExternalToolName(name)) return null;

    const rest = name.slice(EXTERNAL_TOOL_PREFIX.length);
    const cut = rest.indexOf(SEPARATOR);
    if (cut <= 0) return null;

    const connectionId = rest.slice(0, cut);
    const toolName = rest.slice(cut + SEPARATOR.length);
    if (!connectionId || !toolName) return null;

    return { connectionId, toolName };
}
