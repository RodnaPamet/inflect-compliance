/**
 * SPENDING_AGENT_UNDECLARED, planned from `/4`'s `paymentCapabilities[]` (Agent
 * Pay Phase 2.3, `docs/ai-architecture/mastercard-agent-pay.md`). The rules:
 *
 *   • it opens only for a REGISTERED agent whose code pays and whose register
 *     row holds no live spending authority — the register decides, never the
 *     report, so an unregistered paying agent raises SHADOW_AGENT alone;
 *   • an envelope awaiting review holds it: neither opened nor closed;
 *   • it closes on positive evidence only — a reviewed envelope, or a COMPLETE
 *     code read that reported the agent with `[]`. An absent member, an
 *     incomplete code read, or an agent absent from the scan closes nothing;
 *   • it names where the code pays, and never a value.
 */
import {
    PAYING_AGENT_ID,
    PAYING_AGENT_PAYMENT_AT,
    SDK_AGENT_ID,
    validV4ReportBody,
} from '../../helpers/agent-harness-fake-scanner';
import {
    planHarnessScan,
    spendingAuthorityStandingOf,
    spendingUndeclaredRefOf,
    type IntakeClaim,
    type PriorHarnessState,
    type SpendingAuthorityStanding,
} from '@/lib/agentic/harness-findings';
import type { HarnessReportBodyV4 } from '@/lib/agentic/harness-contract';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

const ROW = 'agt_paying_row';
const REF = spendingUndeclaredRefOf(ROW);

function prior(standing?: SpendingAuthorityStanding): PriorHarnessState {
    return {
        previousLevels: new Map<string, HarnessLevel>(),
        registeredAgentIds: new Set(['agt_registered_1', ROW]),
        acceptedShortfalls: new Set<string>(),
        intakeClaims: new Map<string, IntakeClaim>(),
        openOrphanCredentials: new Set<string>(),
        spendingAuthority: new Map(standing === undefined ? [] : [[ROW, standing]]),
    };
}

type Agent = HarnessReportBodyV4['agents'][number];

/** The `/4` fixture with the paying agent linked to ROW, edited as each case needs. */
function body(edit: (paying: Agent, b: HarnessReportBodyV4) => void = () => {}): HarnessReportBodyV4 {
    const b = JSON.parse(JSON.stringify(validV4ReportBody())) as HarnessReportBodyV4;
    const paying = b.agents.find((a) => a.discoveredId === PAYING_AGENT_ID)!;
    paying.registeredAgentId = ROW;
    edit(paying, b);
    return b;
}

const codeIncomplete = (b: HarnessReportBodyV4) => {
    b.population.sources = b.population.sources.map((s) =>
        s.kind === 'code' ? { kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: s.rows } : s,
    );
};

describe('it opens for a registered paying agent with no spending authority', () => {
    it('opens, keyed by the register row, naming the library and the locator', () => {
        const plan = planHarnessScan(body(), prior());
        const f = plan.assert.find((x) => x.sourceRef === REF);
        expect(f).toMatchObject({ code: 'SPENDING_AGENT_UNDECLARED', severity: 'HIGH', type: 'NONCONFORMITY' });
        expect(f!.description).toContain(`x402-fetch at ${PAYING_AGENT_PAYMENT_AT}`);
        expect(plan.resolve).not.toContain(REF);
        // The planned agent carries the capability as reported.
        expect(plan.agents.find((a) => a.discoveredId === PAYING_AGENT_ID)?.paymentCapabilities).toEqual([
            { protocol: 'x402', library: 'x402-fetch', at: PAYING_AGENT_PAYMENT_AT },
        ]);
    });

    it('opens on an incomplete code read too: what was read is real', () => {
        const plan = planHarnessScan(body((_p, b) => codeIncomplete(b)), prior());
        expect(plan.assert.map((x) => x.sourceRef)).toContain(REF);
    });

    it('does not open for an unregistered paying agent: SHADOW_AGENT is the finding, and the register decides', () => {
        const plan = planHarnessScan(body((p) => {
            p.registeredAgentId = null;
        }), prior());
        expect(plan.assert.map((x) => x.code)).not.toContain('SPENDING_AGENT_UNDECLARED');
        expect(plan.assert.map((x) => x.sourceRef)).toContain(`SHADOW_AGENT:${PAYING_AGENT_ID}`);
    });

    it('does not open against a register row the register does not hold, whatever the report claims', () => {
        const p = prior();
        const plan = planHarnessScan(body(), { ...p, registeredAgentIds: new Set(['agt_registered_1']) });
        expect(plan.assert.map((x) => x.code)).not.toContain('SPENDING_AGENT_UNDECLARED');
    });
});

describe('an envelope awaiting review holds it; a reviewed one closes it', () => {
    it('UNREVIEWED: neither opened nor closed', () => {
        const plan = planHarnessScan(body(), prior('UNREVIEWED'));
        expect(plan.assert.map((x) => x.sourceRef)).not.toContain(REF);
        expect(plan.resolve).not.toContain(REF);
    });

    it('REVIEWED: closed, even while the code still pays', () => {
        const plan = planHarnessScan(body(), prior('REVIEWED'));
        expect(plan.resolve).toContain(REF);
        expect(plan.assert.map((x) => x.sourceRef)).not.toContain(REF);
    });

    it('reads the standing from stored envelopes: withdrawn rows are none, and only a reviewed live one is REVIEWED', () => {
        const at = new Date('2026-11-01T00:00:00Z');
        expect(spendingAuthorityStandingOf([])).toBeNull();
        expect(spendingAuthorityStandingOf([{ status: 'WITHDRAWN', reviewedAt: at }])).toBeNull();
        expect(spendingAuthorityStandingOf([{ status: 'DECLARED', reviewedAt: null }])).toBe('UNREVIEWED');
        // A kill before any review leaves it unreviewed; after one, two people agreed.
        expect(spendingAuthorityStandingOf([{ status: 'SUSPENDED_REQUESTED', reviewedAt: null }])).toBe('UNREVIEWED');
        expect(spendingAuthorityStandingOf([{ status: 'SUSPENDED_REQUESTED', reviewedAt: at }])).toBe('REVIEWED');
        expect(spendingAuthorityStandingOf([{ status: 'DECLARED', reviewedAt: null }, { status: 'REVIEWED', reviewedAt: at }])).toBe('REVIEWED');
    });
});

describe('it closes only on positive evidence', () => {
    const noLongerPays = (p: Agent) => {
        (p as { paymentCapabilities?: unknown[] }).paymentCapabilities = [];
    };

    it('a complete code read that reports the agent with [] closes it', () => {
        expect(planHarnessScan(body(noLongerPays), prior()).resolve).toContain(REF);
    });

    it('an incomplete code read that reports [] closes nothing', () => {
        const plan = planHarnessScan(body((p, b) => {
            noLongerPays(p);
            codeIncomplete(b);
        }), prior());
        expect(plan.resolve).not.toContain(REF);
    });

    it('an agent reported with no member (no code read of it) closes nothing', () => {
        const plan = planHarnessScan(body((p) => {
            delete (p as { paymentCapabilities?: unknown }).paymentCapabilities;
        }), prior());
        expect(plan.resolve).not.toContain(REF);
        expect(plan.assert.map((x) => x.sourceRef)).not.toContain(REF);
    });

    it('an agent absent from the scan closes nothing', () => {
        const plan = planHarnessScan(body((_p, b) => {
            b.agents = b.agents.filter((a) => a.discoveredId !== PAYING_AGENT_ID);
        }), prior());
        expect(plan.resolve).not.toContain(REF);
    });

    it('two agents on one row: one reading [] does not close it while the other still pays', () => {
        const plan = planHarnessScan(body((_p, b) => {
            const sdk = b.agents.find((a) => a.discoveredId === SDK_AGENT_ID)!;
            sdk.registeredAgentId = ROW;
        }), prior());
        expect(plan.resolve).not.toContain(REF);
        expect(plan.assert.filter((x) => x.sourceRef === REF)).toHaveLength(1);
    });
});
