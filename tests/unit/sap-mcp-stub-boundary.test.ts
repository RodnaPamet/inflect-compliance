/**
 * THE SAP STUB, AT THE MCP CLIENT BOUNDARY (#3867 step 3).
 *
 * These tests drive the REAL tool client — `listTools` / `callTool` from
 * `@/app-layer/integrations/mcp/client` — against the REAL stub handler, with
 * `safeFetch` mocked to carry the bytes between them. That is the established
 * seam for this client (`tests/unit/mcp-client-transport.test.ts` mocks the same
 * module) and it needs no change to egress defence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SECOND COPY, IN THE STRONG SENSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The step-3 requirement is that the tests read the same fixture file as the
 * stub. They go further: they call the same HANDLER the bound server runs, so
 * there is no fake resembling the stub to drift from it. Every expectation below
 * is derived from the imported fixtures rather than restated as a literal —
 * a literal would keep passing after the fixture it describes was edited, which
 * is the failure this file exists downstream of.
 *
 * What these DO NOT prove is the roadmap's own list: no auth chain, no real
 * `$metadata`, no release or authorisation design. A green run here means M4's
 * code can be written and exercised, not that it will work against S/4.
 */
import { readFileSync } from 'node:fs';

import {
    ANCHOR,
    BILLING_DOCUMENTS,
    BUSINESS_PARTNERS,
    SALES_ORDERS,
    anchorDate,
    a2aFacts,
} from '../../packages/sap-mcp-stub/src/fixtures';
import { TOOL_DEFINITIONS, definitionsHash } from '../../packages/sap-mcp-stub/src/definitions';
import { createStubHandler, type StubOptions } from '../../packages/sap-mcp-stub/src/handler';

const safeFetchMock = jest.fn();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
    SsrfBlockedError: class extends Error {},
}));

import { callTool, listTools } from '@/app-layer/integrations/mcp/client';

const OPTS = { url: 'https://sap-stub.example.test/mcp', token: 'stub-token' };
const TODAY = anchorDate(0);

/** Point the mocked egress seam at a freshly configured stub. */
function wire(options: StubOptions = {}) {
    const handler = createStubHandler(options);
    safeFetchMock.mockImplementation((url: string, init?: { body?: unknown }) =>
        handler(url, init),
    );
}

/** One `tools/call`, with its text block parsed back to an object. */
async function call(name: string, args: Record<string, unknown>) {
    const res = await callTool(OPTS, name, args);
    return {
        isError: res.isError === true,
        payload: JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    wire();
});

describe('the catalogue the stub advertises', () => {
    it('lists exactly the three tools M4 will build against', async () => {
        const names = (await listTools(OPTS)).map((t) => t.name);
        expect(names).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
        expect(names).toEqual([
            'resolve_entities',
            'sales_orders_by_creator',
            'billing_exists_for_creator_and_customer',
        ]);
    });

    it('declares two tools read-only and leaves one hint ABSENT', async () => {
        const tools = await listTools(OPTS);
        const hint = (n: string) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint;

        expect(hint('resolve_entities')).toBe(true);
        expect(hint('sales_orders_by_creator')).toBe(true);
        // ABSENT, asserted as absent rather than as `false`. The client keeps
        // annotations verbatim, so an undeclared hint must arrive undeclared:
        // coercing it to `false` would make a read look like a write, and
        // coercing it to `true` is the exact flip `McpToolDescriptor`'s
        // docstring warns a server can make invisibly. What the write
        // subsystem then does with an absent hint is its decision to state;
        // this asserts only that the boundary does not decide it here.
        expect(hint('billing_exists_for_creator_and_customer')).toBeUndefined();
        expect(
            Object.prototype.hasOwnProperty.call(
                tools.find((t) => t.name === 'billing_exists_for_creator_and_customer') ?? {},
                'annotations',
            ),
        ).toBe(false);
    });

    it('hashes the annotations, so flipping a read-only hint changes the hash', () => {
        // The one edit that moves a tool between the read and write surfaces
        // must not be invisible to the version it reports on boot.
        const before = definitionsHash();
        const flipped = JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as typeof TOOL_DEFINITIONS;
        expect(before).toBe(definitionsHash());
        expect(flipped[0]?.annotations?.readOnlyHint).toBe(true);
    });
});

describe('resolve_entities — it returns every match and never guesses', () => {
    it('returns BOTH partners sharing an ambiguous customer name', async () => {
        const { payload } = await call('resolve_entities', { customer_name: 'Nordwind' });
        const expected = BUSINESS_PARTNERS.filter((p) => p.name.includes('Nordwind'));

        // Derived from the fixture, not restated: if a third Nordwind partner is
        // added the expectation moves with it.
        expect(expected.length).toBeGreaterThan(1);
        expect(payload.business_partners).toEqual(expected);
    });

    it('returns one match as one, so "returns both" is a property of ambiguity', async () => {
        const { payload } = await call('resolve_entities', { customer_name: 'Südblick' });
        expect(payload.business_partners).toHaveLength(1);
    });
});

describe('sales_orders_by_creator', () => {
    it('filters on creator AND customer, since either alone over-returns', async () => {
        const { payload } = await call('sales_orders_by_creator', {
            sap_username: 'MMUELLER',
            sold_to_party: '0000100201',
            date_from: TODAY,
            date_to: TODAY,
        });
        const expected = SALES_ORDERS.filter(
            (o) =>
                o.created_by === 'MMUELLER' &&
                o.sold_to_party === '0000100201' &&
                o.created_at.startsWith(TODAY),
        );
        expect(payload.orders).toEqual(expected);
        // The same user at a different customer, and the same customer with a
        // different user, both exist in the fixture — so a single-key filter
        // would return more than this.
        expect(expected.length).toBeLessThan(
            SALES_ORDERS.filter((o) => o.created_by === 'MMUELLER').length,
        );
    });

    it('excludes the order created yesterday at 23:40Z — the today boundary', async () => {
        const yesterday = SALES_ORDERS.find((o) => o.created_at.startsWith(anchorDate(-1)));
        expect(yesterday).toBeDefined();

        const { payload } = await call('sales_orders_by_creator', {
            sap_username: yesterday?.created_by,
            sold_to_party: yesterday?.sold_to_party,
            date_from: TODAY,
            date_to: TODAY,
        });
        const returned = (payload.orders as { sales_order: string }[]).map((o) => o.sales_order);

        // A filter applying a local offset to a 23:40Z timestamp slides it into
        // today and this fails. That is the real SAP failure mode, which is why
        // the fixture row sits where it does.
        expect(returned).not.toContain(yesterday?.sales_order);
        // And the control: widening the range by one day DOES return it, so the
        // exclusion above is the date filter working rather than the row
        // missing from the population entirely.
        const wide = await call('sales_orders_by_creator', {
            sap_username: yesterday?.created_by,
            sold_to_party: yesterday?.sold_to_party,
            date_from: anchorDate(-1),
            date_to: TODAY,
        });
        expect((wide.payload.orders as { sales_order: string }[]).map((o) => o.sales_order)).toContain(
            yesterday?.sales_order,
        );
    });

    it('compares UTC calendar days by construction, not local-time getters', async () => {
        /**
         * THE BEHAVIOURAL TEST ABOVE CANNOT CATCH THIS IN CI, SO THIS DOES.
         *
         * A local-offset filter and a UTC one are INDISTINGUISHABLE on a UTC
         * machine, and GitHub runners default to UTC while this was written on
         * Europe/Sofia. Mutating the handler to `getDate()` therefore fails the
         * boundary test locally and is a NO-OP in CI — the assertion could not
         * express the failure it names on the machine that decides whether the
         * branch merges.
         *
         * Forcing the zone in-process does not work either: `process.env.TZ`
         * reassignment has no effect once Node has resolved the timezone, and
         * Jest's own setup touches `Date` long before any test body runs. A
         * first attempt here did exactly that and its control assertion caught
         * it — the zone never changed, so the test would have passed while
         * proving nothing.
         *
         * What IS independent of the runner is the implementation's shape. The
         * correct filter slices the ISO string; every local-time getter reads
         * the ambient zone and is therefore wrong here whatever that zone
         * happens to be. This is narrow on purpose: one small file, one list of
         * identifiers, and the mutation it is aimed at is the one a reviewer
         * would most plausibly introduce as a tidy-up.
         */
        const src = readFileSync(
            require.resolve('../../packages/sap-mcp-stub/src/handler.ts'),
            'utf8',
        );
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

        for (const getter of [
            'getFullYear',
            'getMonth',
            'getDate',
            'getHours',
            'getTimezoneOffset',
            'toLocaleDateString',
        ]) {
            expect(code).not.toContain(getter);
        }
        // The positive half: it really does slice the ISO string, so the
        // absences above are the chosen mechanism rather than an empty file or
        // a date comparison that moved somewhere this cannot see.
        expect(code).toContain("iso.slice(0, 10)");
        expect(code).toContain('const utcDay');
    });

    it('answers "nothing" for a user with no orders, distinguishably from a failure', async () => {
        const { isError, payload } = await call('sales_orders_by_creator', {
            sap_username: 'TQUIET',
            sold_to_party: '0000100201',
            date_from: TODAY,
            date_to: TODAY,
        });
        // Not an error, and explicitly zero. A tool that cannot tell "nobody
        // ordered" from "I could not look" turns an empty answer into an
        // outage, and the judgement workflow has no way back from that.
        expect(isError).toBe(false);
        expect(payload.orders).toEqual([]);
        expect(payload.count).toBe(0);
    });

    it('reports a currency per row and no total, so nothing can be naively summed', async () => {
        const { payload } = await call('sales_orders_by_creator', {
            sap_username: 'MMUELLER',
            sold_to_party: '0000100201',
            date_from: TODAY,
            date_to: TODAY,
        });
        const rows = payload.orders as { currency: string }[];
        const currencies = new Set(rows.map((r) => r.currency));

        // More than one currency in a single answer is what makes a total
        // meaningless; the fixture guarantees it and the payload offers none.
        expect(currencies.size).toBeGreaterThan(1);
        expect(payload).not.toHaveProperty('total');
        expect(payload).not.toHaveProperty('net_total');
    });

    it('carries an injection attempt through as inert data', async () => {
        const injected = SALES_ORDERS.find((o) => /ignore previous instructions/i.test(o.header_text));
        expect(injected).toBeDefined();

        const { payload } = await call('sales_orders_by_creator', {
            sap_username: injected?.created_by,
            sold_to_party: injected?.sold_to_party,
            date_from: TODAY,
            date_to: TODAY,
        });
        const row = (payload.orders as { header_text: string }[]).find(
            (o) => o.header_text === injected?.header_text,
        );

        // Byte-identical: the boundary neither sanitises it (which would hide
        // the text the inflect side must neutralise and fence) nor acts on it.
        // Neutralising is the AI-guard's job at the model boundary, not the
        // transport's, and a transport that stripped it would make the guard
        // untestable from here.
        expect(row?.header_text).toBe(injected?.header_text);
    });
});

describe('billing_exists_for_creator_and_customer', () => {
    it('matches the ITEM creator against the HEADER customer', async () => {
        const doc = BILLING_DOCUMENTS[0];
        const itemCreator = doc?.items[0]?.created_by;

        const { payload } = await call('billing_exists_for_creator_and_customer', {
            sap_username: itemCreator,
            sold_to_party: doc?.sold_to_party,
            date_from: TODAY,
            date_to: TODAY,
        });
        expect(payload.exists).toBe(true);
        expect(payload.billing_documents).toEqual([doc?.billing_document]);
    });

    it('finds the second item creator too, which a header-only read would miss', async () => {
        const doc = BILLING_DOCUMENTS[0];
        // Two different users created the two items. An implementation reading
        // the creator off the header can only ever be right about one of them,
        // and would answer the other with a confident `false`.
        expect(new Set(doc?.items.map((i) => i.created_by)).size).toBeGreaterThan(1);

        for (const item of doc?.items ?? []) {
            const { payload } = await call('billing_exists_for_creator_and_customer', {
                sap_username: item.created_by,
                sold_to_party: doc?.sold_to_party,
                date_from: TODAY,
                date_to: TODAY,
            });
            expect(payload.exists).toBe(true);
        }
    });

    it('says no for a user who billed nobody, rather than erroring', async () => {
        const { isError, payload } = await call('billing_exists_for_creator_and_customer', {
            sap_username: 'TQUIET',
            sold_to_party: BILLING_DOCUMENTS[0]?.sold_to_party,
            date_from: TODAY,
            date_to: TODAY,
        });
        expect(isError).toBe(false);
        expect(payload.exists).toBe(false);
    });
});

describe('the two failure flags, which are different failures', () => {
    it('--empty-catalogue completes the handshake and advertises nothing', async () => {
        wire({ emptyCatalogue: true });
        // "The agent had nothing to call" is not "the agent failed" — M2 gave
        // the first its own WorkflowRunStatus for exactly this reason, so the
        // stub has to be able to produce it without looking broken.
        await expect(listTools(OPTS)).resolves.toEqual([]);
    });

    it('--fail-mode returns a tool ERROR, not a transport failure', async () => {
        wire({ failMode: true });
        const { isError, payload } = await call('sales_orders_by_creator', {
            sap_username: 'MMUELLER',
            sold_to_party: '0000100201',
            date_from: TODAY,
            date_to: TODAY,
        });
        // A well-formed response saying the call failed. A dead socket never
        // reaches this branch, so a caller tested only against a healthy server
        // has it untested exactly where an incident will put it.
        expect(isError).toBe(true);
        expect(String(payload.error)).toMatch(/FAIL_MODE/);
    });
});

describe('the A2A projection J4 reads', () => {
    it('derives from the same rows, so neither shape can drift', () => {
        const facts = a2aFacts();
        const orders = facts.filter((f) => f.kind === 'sales_order');

        expect(orders).toHaveLength(SALES_ORDERS.length);
        expect(facts.filter((f) => f.kind === 'business_partner')).toHaveLength(
            BUSINESS_PARTNERS.length,
        );
        // One fact per ITEM, not per document — the level the question is asked
        // at on the tool side, kept on the A2A side.
        expect(facts.filter((f) => f.kind === 'billing_item')).toHaveLength(
            BILLING_DOCUMENTS.reduce((n, d) => n + d.items.length, 0),
        );
    });

    it('keeps the injection text, so the A2A half tests it too', () => {
        // The A2A route reaches no SAP system, so if the projection dropped
        // this field the injection case would silently stop being covered on
        // the side with nothing else in front of it.
        const texts = a2aFacts()
            .filter((f) => f.kind === 'sales_order')
            .map((f) => f.attributes.header_text);
        expect(texts.some((t) => /ignore previous instructions/i.test(t ?? ''))).toBe(true);
    });

    it('is anchored, not clock-dependent', () => {
        // A fixture that moved with the wall clock would make the "today" cases
        // above pass or fail depending on when the suite ran.
        expect(ANCHOR.toISOString()).toBe('2026-06-17T09:30:00.000Z');
        expect(TODAY).toBe('2026-06-17');
    });
});
