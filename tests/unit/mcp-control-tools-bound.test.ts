jest.mock('@/app-layer/usecases/control/queries', () => ({ listControls: jest.fn(async () => []) }));
jest.mock('@/app-layer/usecases/search', () => ({ getUnifiedSearch: jest.fn(async () => ({ hits: [] })) }));

import { listControlsTool, searchControlsTool } from '@/lib/mcp/tools/control-tools';
import { listControls } from '@/app-layer/usecases/control/queries';
import { getUnifiedSearch } from '@/app-layer/usecases/search';

import type { RequestContext } from '@/app-layer/types';

/**
 * THE CONTROL TOOLS' RUN BODIES (#3647).
 *
 * `control-tools.ts` was the lowest-covered file on the MCP surface — 3 of 8
 * branches, 10 of 14 statements — and no test imported it. `search_controls`'s
 * `run` had never executed AT ALL.
 *
 * ── WHY A UNIT TEST, AND NOT THE READ SUITE ─────────────────────────────────
 *
 * Same reason as `mcp-work-tools-bound.test.ts`: a page bound is only
 * observable in the ARGUMENT handed to the usecase. The read suite seeds no
 * controls, so every assertion about a returned LENGTH passes whatever the
 * bound says — that suite reached 8 of 8 branches on the work tools while a
 * `take: 999` reddened nothing. So the usecases are mocked here and the exact
 * argument is what gets asserted.
 */
const CTX = { tenantId: 't1', requestId: 'r1' } as unknown as RequestContext;

const controlsMock = listControls as jest.MockedFunction<typeof listControls>;
const searchMock = getUnifiedSearch as jest.MockedFunction<typeof getUnifiedSearch>;

beforeEach(() => {
    jest.clearAllMocks();
    searchMock.mockResolvedValue({ hits: [] } as unknown as Awaited<ReturnType<typeof getUnifiedSearch>>);
});

describe('list_controls is bounded, and its filters stay filters', () => {
    it('defaults to 50 when no limit is given', async () => {
        await listControlsTool.run(CTX, {});
        expect(controlsMock).toHaveBeenCalledWith(CTX, {}, { take: 50 });
    });

    it('honours an explicit limit', async () => {
        await listControlsTool.run(CTX, { limit: 7 });
        expect(controlsMock).toHaveBeenCalledWith(CTX, {}, { take: 7 });
    });

    it('passes filters through WITHOUT `limit` leaking into them', async () => {
        // `const { limit, ...filters } = args`. The source explains why there
        // is no cast here: `filters` must structurally satisfy
        // `ControlListInputFilters`, because a cast is "how a `category` key
        // survived here as a silent no-op after the usecase stopped accepting
        // it". A `limit` left in `filters` is that same bug in a new key.
        await listControlsTool.run(CTX, { status: 'IMPLEMENTED', ownerUserId: 'u1', limit: 5 });

        const [, filters, opts] = controlsMock.mock.calls[0];
        expect(filters).toEqual({ status: 'IMPLEMENTED', ownerUserId: 'u1' });
        expect(filters).not.toHaveProperty('limit');
        expect(opts).toEqual({ take: 5 });
    });
});

describe('search_controls returns ONLY control hits', () => {
    /** A unified-search answer spanning every entity type the search surfaces. */
    const mixedHits = [
        { type: 'control', id: 'c1', code: 'A.5.1', name: 'Policies for information security' },
        { type: 'risk', id: 'r1', name: 'Supplier concentration' },
        { type: 'policy', id: 'p1', name: 'Acceptable Use' },
        { type: 'evidence', id: 'e1', name: 'Q3 pen test report' },
        { type: 'control', id: 'c2', code: 'A.8.2', name: 'Privileged access rights' },
    ];

    it('drops every non-control hit — which is what makes its narrow gate honest', async () => {
        // This is an AUTHORIZATION property, not a tidiness one. The tool's own
        // `authorize` comment argues that `controls.view` alone is the right
        // key *because* "this tool returns ONLY control hits, so the narrower,
        // stricter key for the one domain it actually surfaces is the honest
        // gate — not the union the search route needs".
        //
        // `getUnifiedSearch`'s human route gates on a read check across EVERY
        // entity type. So if this filter stopped working, the tool would hand
        // back risks, policies and evidence to a caller holding only
        // `controls.view` — the narrow gate would become a privilege
        // escalation rather than a tightening.
        searchMock.mockResolvedValue({ hits: mixedHits } as unknown as Awaited<ReturnType<typeof getUnifiedSearch>>);

        const out = (await searchControlsTool.run(CTX, { query: 'access' })) as {
            query: string;
            controls: { type: string; id: string }[];
        };

        expect(out.controls.map((c) => c.id)).toEqual(['c1', 'c2']);
        expect(out.controls.every((c) => c.type === 'control')).toBe(true);
        // Named explicitly: an assertion on the length alone would survive a
        // filter that kept the wrong two.
        expect(out.controls.map((c) => c.type)).not.toContain('risk');
        expect(out.controls.map((c) => c.type)).not.toContain('policy');
        expect(out.controls.map((c) => c.type)).not.toContain('evidence');
    });

    it('echoes the query back alongside them', async () => {
        searchMock.mockResolvedValue({ hits: mixedHits } as unknown as Awaited<ReturnType<typeof getUnifiedSearch>>);

        const out = (await searchControlsTool.run(CTX, { query: 'privileged access' })) as { query: string };

        expect(out.query).toBe('privileged access');
    });

    it('bounds the search at 10 per type by default', async () => {
        await searchControlsTool.run(CTX, { query: 'access' });
        expect(searchMock).toHaveBeenCalledWith(CTX, 'access', { perTypeLimit: 10 });
    });

    it('and honours an explicit limit', async () => {
        await searchControlsTool.run(CTX, { query: 'access', limit: 3 });
        expect(searchMock).toHaveBeenCalledWith(CTX, 'access', { perTypeLimit: 3 });
    });

    it('returns an empty control list when nothing matched, not an error', async () => {
        // The positive control for the filter: with no hits at all it must
        // still answer with the envelope, so an agent can tell "no controls
        // match" from "the tool failed".
        const out = (await searchControlsTool.run(CTX, { query: 'nothing' })) as {
            query: string;
            controls: unknown[];
        };

        expect(out.controls).toEqual([]);
        expect(out.query).toBe('nothing');
    });
});
