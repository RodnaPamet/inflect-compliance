/**
 * THE THREE TOOL DEFINITIONS M4 WILL BUILD AGAINST (#3867 step 1).
 *
 * Names and argument shapes are the roadmap's, verbatim, because the point of a
 * stub is that the code written against it needs no edit when a real system
 * replaces it. A rename here is a rename in M4.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * VERSIONED, AND THE HASH COVERS THE ANNOTATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `definitionsHash()` is printed on boot so a test run can state which contract
 * it ran against. It hashes the definitions INCLUDING `annotations`, and that
 * inclusion is the whole reason it is worth having: `McpToolDescriptor`'s own
 * docstring records that a server can flip `readOnlyHint` from true to false
 * and produce an identical manifest hash, which is precisely the change that
 * moves a tool from the read surface to the write surface. A hash that ignored
 * annotations would be blind to the one edit that matters most.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE TOOL IS DELIBERATELY UNANNOTATED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two declare `readOnlyHint: true`; `billing_exists_for_creator_and_customer`
 * declares nothing. All three are reads — the omission is not a claim that it
 * writes. It is there so the inflect side exercises what happens to a tool
 * whose read-ness is UNDECLARED, rather than only the happy path where a server
 * was helpful. An absent hint must not be read as `false` and must not be read
 * as `true`: the first makes a read look like a write, the second is the
 * failure the annotations docstring warns about. Whatever the real classifier
 * does with it, the boundary test asserts THAT rather than an assumption, and a
 * stub whose every tool was annotated could never have asked the question.
 */
import { createHash } from 'node:crypto';

export interface StubToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations?: Record<string, unknown>;
}

/** Bump on any change to the definitions below. */
export const DEFINITIONS_VERSION = '1.0.0';

const str = { type: 'string' } as const;

export const TOOL_DEFINITIONS: readonly StubToolDefinition[] = [
    {
        name: 'resolve_entities',
        description:
            'Resolve a customer name and/or a user identifier to SAP keys. Returns EVERY match; never ranks or guesses.',
        inputSchema: {
            type: 'object',
            properties: { customer_name: str, user_identifier: str },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: 'sales_orders_by_creator',
        description:
            'Sales orders created by one SAP user for one sold-to party within an inclusive date range. Returns the currency per row and never a total.',
        inputSchema: {
            type: 'object',
            properties: {
                sap_username: str,
                sold_to_party: str,
                date_from: str,
                date_to: str,
            },
            required: ['sap_username', 'sold_to_party', 'date_from', 'date_to'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: 'billing_exists_for_creator_and_customer',
        description:
            'Whether a billing document exists whose HEADER names the customer and whose ITEM was created by the user, within an inclusive date range.',
        inputSchema: {
            type: 'object',
            properties: {
                sap_username: str,
                sold_to_party: str,
                date_from: str,
                date_to: str,
            },
            required: ['sap_username', 'sold_to_party', 'date_from', 'date_to'],
            additionalProperties: false,
        },
        // No `annotations` — see the module docstring. This omission is the test.
    },
];

/**
 * Keys sorted at every level, so the hash is of the CONTENT and not of the
 * order a literal happened to be written in. Arrays keep their order, because
 * the order of the tool list is part of the contract.
 */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, canonical(v)]),
        );
    }
    return value;
}

export function definitionsHash(): string {
    return createHash('sha256')
        .update(JSON.stringify(canonical({ version: DEFINITIONS_VERSION, tools: TOOL_DEFINITIONS })))
        .digest('hex');
}
