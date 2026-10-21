/**
 * THE INJECTION CORPUS, ON THE READ PATH (#3855).
 *
 * ═══ WHAT THIS ADDS TO THE CORPUS THAT ALREADY EXISTS ═══
 *
 * `tests/integration/prompt-injection-corpus.test.ts` drives the same cases
 * down the OUTPUT path: it assumes the agent is fully compromised, submits
 * through the real `propose_risks` tool exactly what the agent would submit if
 * it had obeyed, and asserts IC refuses to queue it. That is the stronger
 * assertion for the write direction, and it deliberately does not depend on a
 * model resisting anything.
 *
 * It leaves one direction unexercised, and #3855 names it: the payload
 * reaching the model through a READ TOOL rather than through the user's
 * prompt. That is the path the assistant actually opened — `assistantTools`
 * hands the Flue read surface to a tool-use loop, so tenant-authored text
 * from a task, a finding or an evidence record now flows into a model's
 * context on every turn.
 *
 * The cases are IMPORTED, not re-written. One corpus, two paths: a case added
 * to `INJECTION_CASES` is covered in both directions with no new test body,
 * which is the property the fixture file asks callers to preserve.
 *
 * ═══ NO GUARD MOCK ═══
 *
 * The guard runs for real. Both of its database touchpoints degrade on their
 * own — `resolveModeForTenant` catches and returns `balanced`, and
 * `emitGuardAudit` is `.catch()`-ed — so the real `guardUntrustedInput` works
 * in a unit test and resolves the DEFAULT posture, which is the one a tenant
 * gets without configuring anything.
 *
 * What IS mocked is the registry, for two reasons: it decides which tool is
 * offered (so the payload can be placed in a result), and `runReadTool` is the
 * authorization funnel, which this adapter performs none of. The adapter's own
 * suite says asserting a refusal here "would be asserting the mock".
 */

import { scanInjection } from '@/app-layer/ai/guard/injection-scanner';
import { INJECTION_CASES } from '../../fixtures/prompt-injection-corpus';
import type { McpInvocation } from '@/lib/mcp/authorize';
import type { McpReadTool } from '@/lib/mcp/tools/types';

jest.mock('@/lib/mcp/tools/registry', () => ({
    loadableReadTools: jest.fn(),
    runReadTool: jest.fn(),
    loadableProposeTools: jest.fn(() => []),
    runProposeTool: jest.fn(),
}));

import { flueToolsFor } from '@/lib/agentic/flue/tools-adapter';
import { loadableReadTools, runReadTool } from '@/lib/mcp/tools/registry';

const mockLoadable = loadableReadTools as jest.MockedFunction<typeof loadableReadTools>;
const mockRun = runReadTool as jest.MockedFunction<typeof runReadTool>;

/**
 * A signed-in human's invocation, which is what the assistant runs as.
 *
 * `offeredTools` / `grantedTools` / `policyCard` are load-bearing, not
 * padding: the adapter calls `isToolLoadable`, which reads all three through
 * `loadableSetOf`. Omitting them threw
 * "Cannot read properties of undefined (reading 'includes')" from inside
 * `toolWasOffered` — a failure that reads like a defect in the loadable-tools
 * module rather than a thin fixture.
 *
 * `grantedTools: null` is the human case specifically: no agent register, so
 * the deny-by-default grant check does not apply.
 */
function invocation(offered: readonly string[] = ['list_tasks']): McpInvocation {
    return {
        ctx: { tenantId: 't1', requestId: 'r1' },
        autonomyCeiling: 6,
        offeredTools: offered,
        grantedTools: null,
        policyCard: null,
    } as unknown as McpInvocation;
}

function readTool(name: string): McpReadTool<unknown> {
    return {
        name,
        description: `the ${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        argsSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        resourceScope: { resource: name, action: 'read' },
        authorize: { basis: 'effective', mirrors: `GET /${name}` },
        run: jest.fn(),
    } as unknown as McpReadTool<unknown>;
}

/**
 * Run the single offered read tool and report how it ended.
 *
 * The result is shaped as MCP content blocks because that is what the adapter
 * guards: it joins `result.content[].text` and scans the join, with the
 * comment "text is what the model actually receives". A plain object here
 * threw "Cannot read properties of undefined (reading 'map')" from inside
 * `runGuardedTool` — so the block shape is part of the contract under test,
 * not boilerplate.
 *
 * It also means the scan sees the SERIALISED result, so a payload is caught
 * wherever it sits in the structure rather than only at the top level.
 */
async function readReturning(payloadBearing: unknown): Promise<'threw-review' | 'returned'> {
    mockLoadable.mockReturnValue([readTool('list_tasks')] as never);
    mockRun.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(payloadBearing) }],
    } as never);
    const set = flueToolsFor(invocation(), undefined, undefined, { readOnly: true });
    try {
        await set.tools[0].run({ toolCallId: 'call-1', data: {} } as never);
        return 'returned';
    } catch (err) {
        if (/ai_guard_review_required/.test(String(err))) return 'threw-review';
        throw err;
    }
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the detector sees every payload in the corpus', () => {
    // The denominator, asserted rather than assumed: a corpus import that
    // silently resolved to an empty array would make every `it.each` below
    // vanish, and a suite with no tests reports as a pass.
    it('the corpus is non-empty and covers more than one surface', () => {
        expect(INJECTION_CASES.length).toBeGreaterThanOrEqual(8);
        expect(new Set(INJECTION_CASES.map((c) => c.surface)).size).toBeGreaterThanOrEqual(5);
    });

    it.each(INJECTION_CASES.map((c) => [c.id, c.surface, c.technique, c.payload]))(
        '%s (%s / %s) does not scan clean',
        (_id, _surface, _technique, payload) => {
            const scan = scanInjection(payload as string);
            expect(scan.verdict).not.toBe('clean');
            // A verdict with no rule ids cannot be investigated — "the guard
            // flagged it" with nothing naming WHAT is a report that arrives
            // without a reproduction.
            expect(scan.ruleIds.length).toBeGreaterThan(0);
        },
    );

    it('benign text from the same surfaces scans CLEAN', () => {
        // The control. Without it, a scanner that flagged everything would
        // satisfy every assertion above — and would also refuse every real
        // task and finding the assistant reads, which is a worse product than
        // no assistant.
        for (const benign of [
            'Access Review Q3 2026 — sign-off attached. All 42 users reviewed, 3 revoked.',
            'We hold ISO 27001, certificate 12345, valid until 2027-03-01.',
            'Disk utilisation on the prod cluster exceeded 85% on 2026-10-14; resized.',
            'Reviewed with the control owner. Evidence refreshed and expiry extended.',
            'All staff must complete security awareness training within 30 days of joining.',
        ]) {
            expect(scanInjection(benign).verdict).toBe('clean');
        }
    });
});

describe('a payload reaching the model through a READ TOOL stops the turn', () => {
    it.each(INJECTION_CASES.map((c) => [c.id, c.surface, c.payload]))(
        '%s (%s) planted in a tool RESULT requires review',
        async (_id, _surface, payload) => {
            // The field name matters less than the fact that it is free text a
            // tenant authored: the adapter guards the whole result on its way
            // back to the model.
            const outcome = await readReturning({
                tasks: [{ id: 'task-1', title: 'Remediate access review', description: payload }],
            });
            expect(outcome).toBe('threw-review');
        },
    );

    it('a clean result passes through, so the gate is not simply always shut', async () => {
        // The positive control for the whole block above. A latch that tripped
        // on everything would make all of it pass while making the assistant
        // unable to read anything at all.
        const outcome = await readReturning({
            tasks: [{ id: 'task-1', title: 'Remediate access review', description: 'Reviewed with the owner; evidence refreshed.' }],
        });
        expect(outcome).toBe('returned');
    });

    it('the payload is caught however deeply it is nested', async () => {
        // Tenant text arrives nested — a task inside a page inside an
        // envelope. The adapter scans the serialised text, so depth should not
        // matter; this pins that, because the alternative implementation
        // (walking known fields) would pass the shallow cases above and miss
        // this one.
        const nested = await readReturning({
            page: { items: [{ task: { notes: [{ body: INJECTION_CASES[0].payload }] } }] },
        });
        expect(nested).toBe('threw-review');
    });
});

describe('which surfaces can reach the model through a read tool at all', () => {
    /**
     * Three of the five surfaces #3855 names have NO read-tool path today.
     *
     * This is pinned rather than left implicit, because the alternative is a
     * corpus that looks complete and is partly vacuous: a payload planted in a
     * vendor questionnaire answer is inert on this path for the structural
     * reason that nothing reads it to a model — not because a guard caught it.
     * Asserting "it was inert" there would be a test that cannot fail.
     *
     * Pinning the absence converts it into a tripwire: the day a vendor,
     * policy or ticket read tool is offered, this fails and the corpus above
     * has to grow to cover it.
     */
    it('no vendor, policy, ticket or questionnaire read tool exists in this build', () => {
        // Asserted on `READ_TOOLS`, the BUILD's catalogue, rather than on
        // `loadableReadTools(inv)`. The filtered view depends on one
        // invocation's permissions and external tools, so a thin fixture can
        // empty it — which would turn every "no such tool" assertion below
        // into a pass for the wrong reason. The build catalogue cannot.
        const registry = jest.requireActual<typeof import('@/lib/mcp/tools/registry')>(
            '@/lib/mcp/tools/registry',
        );
        const names = (registry.READ_TOOLS as ReadonlyArray<{ name: string }>).map((t) => t.name);

        // The denominator.
        expect(names.length).toBeGreaterThanOrEqual(10);

        for (const word of ['vendor', 'policy', 'ticket', 'questionnaire']) {
            expect(names.filter((n: string) => n.includes(word))).toEqual([]);
        }

        // And the surfaces that DO have a path, so this test states both halves
        // rather than only the absence.
        expect(names).toEqual(expect.arrayContaining(['list_tasks', 'list_findings', 'list_risks']));
    });
});
