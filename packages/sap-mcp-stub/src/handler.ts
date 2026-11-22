/**
 * THE STUB'S REQUEST HANDLER — ONE IMPLEMENTATION, TWO CALLERS (#3867 steps 1 and 3).
 *
 * A pure `(url, init) => Response`. `server.ts` binds it to an https socket so
 * it can be registered as a real `mcp-server` connection in a dev tenant; the
 * inflect-side boundary tests call this same function instead of standing up a
 * socket. That is what makes "no second copy" true in the strong sense: the
 * tests do not exercise a fake that resembles the stub, they exercise the stub.
 *
 * Nothing here is SAP. It answers the three tool names with the fixture rows,
 * which is all M4 needs to be written and tested against; what it cannot prove
 * is listed in the roadmap's own table (auth chains, real `$metadata`,
 * release/authorisation design) and no amount of fixture work changes that.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATE FILTER COMPARES UTC CALENDAR DAYS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `date_from`/`date_to` are `YYYY-MM-DD` and inclusive at both ends. The
 * comparison is a string compare of the UTC date prefix, NOT a `Date` subtract
 * against a local-offset midnight, because the fixture's yesterday row sits at
 * 23:40Z specifically to catch an implementation that applies an offset and
 * slides it into the next day. Using the UTC prefix means the stub cannot
 * exhibit the bug it exists to help find on the other side.
 */
import { BILLING_DOCUMENTS, BUSINESS_PARTNERS, SALES_ORDERS, USERS } from './fixtures';
import { DEFINITIONS_VERSION, TOOL_DEFINITIONS, definitionsHash, type StubToolDefinition } from './definitions';

export interface StubOptions {
    /**
     * Answer every tool call with a protocol-level error. Exercises the
     * caller's failure path, which is otherwise only reachable by breaking the
     * network — and a caller that was only ever tested against a healthy server
     * has an untested branch exactly where an incident will put it.
     */
    readonly failMode?: boolean;
    /**
     * Advertise ZERO tools while still completing `initialize`. This is not the
     * same as being down, and the difference matters: M2 gave an empty
     * catalogue its own `WorkflowRunStatus` precisely because "the agent had
     * nothing to call" and "the agent failed" are different outcomes that a
     * single error status conflates.
     */
    readonly emptyCatalogue?: boolean;
}

const JSONRPC = '2.0';
const PROTOCOL_VERSION = '2025-06-18';

type Json = Record<string, unknown>;

const ok = (id: unknown, result: unknown): Response =>
    new Response(JSON.stringify({ jsonrpc: JSONRPC, id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

const err = (id: unknown, code: number, message: string): Response =>
    new Response(JSON.stringify({ jsonrpc: JSONRPC, id, error: { code, message } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

/** A tool result: one text block carrying JSON, per the MCP shape. */
const toolText = (id: unknown, payload: unknown, isError = false): Response =>
    ok(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        ...(isError ? { isError: true } : {}),
    });

const utcDay = (iso: string): string => iso.slice(0, 10);

/**
 * Why a tool's arguments are not what its `inputSchema` admits, or null when
 * they are (#5312). Every property the stub's tools declare is a string;
 * `required` keys must be present, and `additionalProperties: false` refuses
 * any other key. Without this a misspelt `soldToParty` or a missing `date_to`
 * got a confident "no orders" — the answer `fixtures.ts` says the stub exists
 * to keep apart from "I could not look".
 */
function invalidParams(tool: StubToolDefinition, args: unknown): string | null {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
    const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
    };
    const properties = schema.properties ?? {};
    const given = args as Json;
    for (const key of Object.keys(given)) {
        if (!Object.hasOwn(properties, key)) {
            if (schema.additionalProperties === false) return `unknown argument ${key}`;
            continue;
        }
        if (typeof given[key] !== 'string') return `argument ${key} must be a string`;
    }
    for (const key of schema.required ?? []) {
        if (!Object.hasOwn(given, key)) return `missing required argument ${key}`;
    }
    return null;
}

const inRange = (iso: string, from: unknown, to: unknown): boolean => {
    const day = utcDay(iso);
    return typeof from === 'string' && typeof to === 'string' && day >= from && day <= to;
};

function resolveEntities(args: Json): Json {
    const name = typeof args.customer_name === 'string' ? args.customer_name.toLowerCase() : null;
    const user = typeof args.user_identifier === 'string' ? args.user_identifier.toLowerCase() : null;
    return {
        // EVERY match, unranked. Two partners share the "Nordwind" prefix and
        // both come back; choosing between them is the caller's problem and
        // refusing to choose is the behaviour under test.
        business_partners: name
            ? BUSINESS_PARTNERS.filter((p) => p.name.toLowerCase().includes(name))
            : [],
        users: user
            ? USERS.filter(
                  (u) =>
                      u.sap_username.toLowerCase().includes(user) ||
                      u.display_name.toLowerCase().includes(user),
              )
            : [],
    };
}

function salesOrdersByCreator(args: Json): Json {
    const rows = SALES_ORDERS.filter(
        (o) =>
            o.created_by === args.sap_username &&
            o.sold_to_party === args.sold_to_party &&
            inRange(o.created_at, args.date_from, args.date_to),
    );
    // No total, by design — see the multi-currency fixture. The caller gets
    // per-row currency and has to decide what summing means.
    return { orders: rows, count: rows.length };
}

function billingExists(args: Json): Json {
    // HEADER customer, ITEM creator. The fixture document has two items made
    // by two different users and carries no header creator at all, so an
    // implementation that took the creator from one place in the document
    // (the first item, say) answers for one of the two and says a confident
    // `false` for the other, rather than an empty answer.
    const matches = BILLING_DOCUMENTS.filter(
        (b) =>
            b.sold_to_party === args.sold_to_party &&
            inRange(b.created_at, args.date_from, args.date_to) &&
            b.items.some((i) => i.created_by === args.sap_username),
    );
    return {
        exists: matches.length > 0,
        billing_documents: matches.map((b) => b.billing_document),
    };
}

/** The tools a handler built with these options serves: none under `emptyCatalogue`. */
export function servedTools(options: StubOptions = {}): readonly StubToolDefinition[] {
    return options.emptyCatalogue ? [] : TOOL_DEFINITIONS;
}

export function createStubHandler(options: StubOptions = {}) {
    const tools = servedTools(options);

    return async function handle(_url: string, init?: { body?: unknown }): Promise<Response> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(String(init?.body ?? '{}'));
        } catch {
            return err(null, -32700, 'parse error');
        }
        // A body of `null`, a number or an array parses, and is not a request.
        // Destructuring `null` threw, the handler rejected, and the bound
        // server died on the unhandled rejection (#5312).
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return err(null, -32600, 'invalid request');
        }
        const { id, method, params } = parsed as { id?: unknown; method?: string; params?: Json };

        if (method === 'initialize') {
            // Completes even with an empty catalogue: "nothing to call" is a
            // successful handshake reporting no tools, not a failed one.
            return ok(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: {
                    name: 'sap-mcp-stub',
                    version: DEFINITIONS_VERSION,
                    definitionsHash: definitionsHash(),
                },
            });
        }

        if (method === 'notifications/initialized') return ok(id ?? null, {});

        if (method === 'tools/list') return ok(id, { tools });

        if (method === 'tools/call') {
            const name = typeof params?.name === 'string' ? params.name : '';
            const args = (params?.arguments ?? {}) as Json;

            if (options.failMode) {
                // A tool-level error, not a transport failure: the caller sees a
                // well-formed response saying the call failed, which is the
                // branch a dead socket never reaches.
                return toolText(id, { error: 'FAIL_MODE: the stub was started with --fail-mode' }, true);
            }
            const tool = tools.find((t) => t.name === name);
            if (!tool) {
                return err(id, -32601, `unknown tool ${name}`);
            }
            const invalid = invalidParams(tool, params?.arguments ?? {});
            if (invalid !== null) return err(id, -32602, `invalid params: ${invalid}`);

            if (name === 'resolve_entities') return toolText(id, resolveEntities(args));
            if (name === 'sales_orders_by_creator') return toolText(id, salesOrdersByCreator(args));
            if (name === 'billing_exists_for_creator_and_customer') {
                return toolText(id, billingExists(args));
            }
            return err(id, -32601, `unknown tool ${name}`);
        }

        return err(id ?? null, -32601, `unsupported method ${String(method)}`);
    };
}

export type StubHandler = ReturnType<typeof createStubHandler>;
