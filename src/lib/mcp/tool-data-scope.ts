/**
 * WHICH DATA RUNG DOES THIS TOOL CALL REACH?
 *
 * The policy card caps an agent at a rung of `AgentDataAccessScope` — the same
 * least-exposing-to-most-exposing axis the register already declares on every
 * agent. To enforce that cap the boundary needs the other side of the
 * comparison: the rung THIS CALL reaches. That is what this module answers.
 *
 * ## Why the answer depends on the ARGUMENTS and not only on the tool
 *
 * `get_framework_status` is the worked example, and it is not a contrivance —
 * read its own description. Called with a `frameworkKey` it returns the tenant's
 * coverage summary and section breakdown: tenant data. Called with no arguments
 * it returns the catalogue of INSTALLABLE frameworks, which is global reference
 * content that says nothing about this tenant at all. One tool, two rungs,
 * decided by an argument.
 *
 * A tool-level answer would have to pick one of those, and both choices are
 * wrong in a way that matters: pick the high rung and a metadata-only agent
 * loses a catalogue read it should have; pick the low rung and the same agent
 * reads the tenant's coverage out of a tool the card cleared as harmless.
 *
 * ## Two fail directions, and they point the same way
 *
 *   • A tool with no entry below resolves to its CAPABILITY CLASS's default —
 *     read tools reach tenant data, propose tools write it. That is the honest
 *     reading of what an unremarkable tool does, and it is the same derivation
 *     `mcpToolCapabilityClass` already makes for the autonomy rung, from the
 *     same list membership, so a new tool cannot be quietly cheaper than its
 *     neighbours by being forgotten.
 *   • An argument rule may only RAISE the rung, never lower it. The base is a
 *     floor. So a bug in an argument rule can refuse a call that should have
 *     been allowed; it cannot admit one that should have been refused.
 *
 * ## Read against RAW arguments, before validation
 *
 * The card is evaluated inside `authorizeToolCall`, which runs BEFORE the tool's
 * Zod schema parses anything — nothing may run ahead of the gate. So these rules
 * see whatever the caller sent. That is safe because they only test for the
 * PRESENCE of a named property, and it is the correct direction anyway: an
 * argument that would later fail validation still raises the rung, so a caller
 * cannot probe a higher rung behind a malformed request.
 */
import type { AgentDataAccessScope } from '@prisma/client';

import { mcpToolCapabilityClass } from './tool-catalogue';

/**
 * The rung a tool's class reaches when it says nothing more specific.
 *
 * PROPOSE sits at `WRITE_TENANT_DATA` even though propose-not-commit means no
 * entity is created: the proposal row carries the business content the agent
 * composed, encrypted and queued for a human. The content was written. Reading
 * that as a read because the entity is not created yet is the kind of
 * technically-true that a governance control cannot afford.
 */
const CLASS_DEFAULT: Readonly<Record<'read' | 'propose', AgentDataAccessScope>> = {
    read: 'READ_TENANT_DATA',
    propose: 'WRITE_TENANT_DATA',
};

interface ToolDataScopeRule {
    /**
     * The rung this tool reaches with no qualifying argument. Present only for a
     * tool that reaches LESS than its class default — lowering is the exception
     * and has to be written down.
     */
    base: AgentDataAccessScope;
    /**
     * Arguments that RAISE the rung. First match wins; the result is the higher
     * of it and `base`, never the lower.
     */
    raisedBy?: readonly { readonly arg: string; readonly to: AgentDataAccessScope }[];
}

/**
 * Tools that reach less than their class default, and the arguments that take
 * them back up.
 *
 * Deliberately small. Every entry is a claim about what a specific tool returns,
 * checked against that tool's own description, and an entry that stops being
 * true is a refusal that stops firing — so this table earns additions one at a
 * time rather than being filled in for completeness.
 */
const TOOL_RULES: Readonly<Record<string, ToolDataScopeRule>> = {
    // "with `frameworkKey`, the coverage summary + section breakdown for that
    // framework; without it, the catalogue of installable frameworks".
    get_framework_status: {
        base: 'READ_METADATA',
        raisedBy: [{ arg: 'frameworkKey', to: 'READ_TENANT_DATA' }],
    },
};

/**
 * The table lookup, guarded.
 *
 * `hasOwnProperty.call`, never `toolName in TOOL_RULES`: `in` walks the
 * prototype chain, so a tool named `constructor` or `toString` would "match" and
 * hand back an inherited `Object.prototype` member as a data-scope rule. No tool
 * is named either today; the guard is one keystroke and the failure it prevents
 * is a function being read as a policy.
 */
function ruleFor(toolName: string): ToolDataScopeRule | undefined {
    return Object.prototype.hasOwnProperty.call(TOOL_RULES, toolName)
        ? TOOL_RULES[toolName]
        : undefined;
}

const RUNG_ORDER: readonly AgentDataAccessScope[] = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
];

/** The higher (more exposing) of two rungs. An unknown rung ranks HIGHEST. */
function higher(a: AgentDataAccessScope, b: AgentDataAccessScope): AgentDataAccessScope {
    const ai = RUNG_ORDER.indexOf(a);
    const bi = RUNG_ORDER.indexOf(b);
    if (ai === -1) return a;
    if (bi === -1) return b;
    return ai >= bi ? a : b;
}

/**
 * The data-access rung this tool call reaches.
 *
 * `args` is whatever the caller sent — an object, a string, undefined. Anything
 * that is not a plain object contributes no argument term, which cannot lower
 * the answer below the base.
 */
export function dataScopeForToolCall(toolName: string, args: unknown): AgentDataAccessScope {
    const rule = ruleFor(toolName);
    const base = rule?.base ?? CLASS_DEFAULT[mcpToolCapabilityClass(toolName)];
    if (!rule?.raisedBy || args === null || typeof args !== 'object' || Array.isArray(args)) {
        return base;
    }
    const supplied = args as Record<string, unknown>;
    let reached = base;
    for (const raise of rule.raisedBy) {
        if (supplied[raise.arg] !== undefined && supplied[raise.arg] !== null) {
            reached = higher(reached, raise.to);
        }
    }
    return reached;
}

/**
 * The rung a tool call reaches AT LEAST — its base, with no argument raising it.
 *
 * The admin surface needs this and it needs the MINIMUM, not the maximum. A card
 * whose ceiling is below a tool's base refuses that tool on EVERY call, which is
 * a configuration error and is refused where the operator is writing it — the
 * same shape as `assertGrantWithinTier` in the tool-exposure usecase.
 *
 * A card whose ceiling is below the tool's maximum is NOT an error: it is the
 * useful case. `get_framework_status` at a `READ_METADATA` ceiling is a working
 * catalogue read whose tenant-coverage argument is refused, and rejecting that
 * card would make the whole argument-derived rung pointless.
 */
export function baseDataScopeForTool(toolName: string): AgentDataAccessScope {
    return ruleFor(toolName)?.base ?? CLASS_DEFAULT[mcpToolCapabilityClass(toolName)];
}

/**
 * The rung an MCP RESOURCE read reaches.
 *
 * Resources have no catalogue entries of their own — `authorizeResourceRead`
 * already records that, and it is why the deny-by-default tool allowlist does
 * not apply to them. The data rung DOES apply cleanly, and it is the read
 * default: a resource read returns tenant content.
 */
export const RESOURCE_READ_DATA_SCOPE: AgentDataAccessScope = 'READ_TENANT_DATA';
