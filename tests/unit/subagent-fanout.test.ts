/**
 * THE FAN-OUT CAP AND THE GATE THAT ENFORCES IT (#3473).
 *
 * Two halves in one file because they are one claim: a cap that normalises
 * safely and a gate that applies it. Splitting them would let each pass while
 * the pair disagreed about what "no value" means, which is the only
 * interesting way this breaks.
 *
 * ── THE INVERSION THAT MOST NEEDS A TEST ────────────────────────────────────
 *
 * Every other cap in this subsystem treats an absent value as NO CAP, and says
 * so in its own docblock: `agentMonthlyTokenBudget` and
 * `agentMaxConcurrentRuns` bound work that already runs, so defaulting them
 * would refuse live work and `normaliseCap` has an explicit `null` arm for it.
 *
 * This one is the reverse. Nothing can delegate yet, so a default restricts
 * nothing, and the owner's decision (2026-10-15) was a cap DEFAULTING LOW.
 * Every absent-value case below therefore asserts the DEFAULT and not
 * `Infinity` — and the reason that matters is that the obvious edit, made by
 * somebody pattern-matching on the neighbouring module, reintroduces
 * "unlimited" as a reachable state.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
    DEFAULT_MAX_SUBAGENTS_PER_TURN,
    evaluateFanOut,
    fanOutRefusalMessage,
    normaliseFanOutCap,
} from '@/lib/agentic/subagent-fanout';
import {
    DELEGATION_TOOL_NAME,
    DelegationRefusedError,
    gateDelegation,
    delegationsThisTurn,
    releaseDelegationCounts,
    _resetDelegationCounts,
} from '@/lib/agentic/flue/delegation-gate';
import { bindRun, releaseRun } from '@/lib/agentic/flue/run-binding';

beforeEach(() => {
    _resetDelegationCounts();
});

describe('the default is mirrored from the schema, not chosen twice', () => {
    it('equals the column default in auth.prisma', () => {
        // A CONSTANT THAT MIRRORS A SCHEMA GOES STALE SILENTLY, which is the
        // whole reason this assertion exists rather than a comment saying the
        // two agree. Read from the schema text, so changing the column without
        // changing the constant fails here — and the fallback in
        // `normaliseFanOutCap` is the value a binding carries when a settings
        // row could not be read, so a drift means the safe path and the
        // ordinary path disagree about what "low" is.
        const schema = readFileSync(
            path.resolve(__dirname, '../../prisma/schema/auth.prisma'),
            'utf8',
        );
        const m = /agentMaxSubagentsPerTurn\s+Int\s+@default\((\d+)\)/.exec(schema);
        expect(m).not.toBeNull();
        expect(Number(m?.[1])).toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
    });

    it('is low enough to be a cap rather than a formality', () => {
        // The owner's condition for making this a knob was that the shipped
        // behaviour be the safe one for every tenant that never touches it. A
        // default of 50 would satisfy every other assertion in this file and
        // none of that intent.
        expect(DEFAULT_MAX_SUBAGENTS_PER_TURN).toBeGreaterThan(0);
        expect(DEFAULT_MAX_SUBAGENTS_PER_TURN).toBeLessThanOrEqual(5);
    });
});

describe('normalising a stored cap', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['a negative', -1],
    ])('%s falls back to the DEFAULT, never to unlimited', (_label, value) => {
        // Each of these is a way the field arrives wrong, and each has an
        // obvious-looking wrong answer: `undefined`/`null` → unlimited (the
        // neighbouring module's rule), a negative → 0 (a silent kill switch
        // written by a typo), `Infinity` → itself (a silent bypass).
        expect(normaliseFanOutCap(value as number)).toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
    });

    it('keeps a configured value, including ZERO', () => {
        // 0 is legal and means "this tenant's agents may not delegate" — the
        // readable way to withdraw delegation without retiring an agent.
        expect(normaliseFanOutCap(0)).toBe(0);
        expect(normaliseFanOutCap(1)).toBe(1);
        expect(normaliseFanOutCap(7)).toBe(7);
    });

    it('floors a fractional value rather than rounding up', () => {
        // A cap of 2.9 permits two, not three. Rounding up would make a
        // mis-typed setting more permissive than anything anybody chose.
        expect(normaliseFanOutCap(2.9)).toBe(2);
    });
});

describe('evaluating one delegation against the cap', () => {
    it('allows up to the cap and refuses at it', () => {
        const at = (n: number) => evaluateFanOut({ cap: 3, delegatedThisTurn: n });
        expect(at(0)).toEqual({ allowed: true, cap: 3, delegatedThisTurn: 0, headroom: 3 });
        expect(at(2)).toEqual({ allowed: true, cap: 3, delegatedThisTurn: 2, headroom: 1 });
        // AT the cap, not past it: the third delegation is the third, and the
        // fourth is the one refused.
        expect(at(3)).toEqual({ allowed: false, cap: 3, delegatedThisTurn: 3, headroom: 0 });
    });

    it('refuses everything at a cap of zero', () => {
        expect(evaluateFanOut({ cap: 0, delegatedThisTurn: 0 }).allowed).toBe(false);
    });

    it('floors a negative count at zero rather than crediting headroom', () => {
        // The counter is the gate's, and a bug there must not become a bypass
        // here: a count of -5 against a cap of 3 would otherwise buy eight.
        expect(evaluateFanOut({ cap: 3, delegatedThisTurn: -5 }))
            .toEqual({ allowed: true, cap: 3, delegatedThisTurn: 0, headroom: 3 });
    });
});

describe('the refusal message, which the MODEL reads', () => {
    it('tells the model not to retry', () => {
        // The next thing that happens after this string is the model deciding
        // what to do. Without "do not retry" a refusal reads as a transient
        // failure and the turn is spent on a call that cannot succeed.
        const msg = fanOutRefusalMessage(evaluateFanOut({ cap: 3, delegatedThisTurn: 3 }));
        expect(msg).toContain('Do not retry');
        expect(msg).toContain('delegation_limit_reached');
    });

    it('names the cap and the count, which is what the LEDGER needs', () => {
        // The owner's condition for the knob: its effect must be visible when
        // it bites, rather than looking like a model that chose not to
        // delegate.
        const msg = fanOutRefusalMessage(evaluateFanOut({ cap: 2, delegatedThisTurn: 2 }));
        expect(msg).toContain('2 subagent(s)');
        expect(msg).toContain('limit is 2');
    });

    it('says something DIFFERENT at zero, because the remedy is different', () => {
        // "Wait and try later" is wrong when the answer is "never, here".
        const msg = fanOutRefusalMessage(evaluateFanOut({ cap: 0, delegatedThisTurn: 0 }));
        expect(msg).toContain('delegation_disabled');
        expect(msg).not.toContain('A later turn may delegate');
    });

    it('carries no tenant content and names no other delegate', () => {
        // A tool error is the loosest-held string in the system: it crosses
        // into the model's context and into logs. `no-raw-prompt-logging` is
        // the guard that cares.
        const msg = fanOutRefusalMessage(evaluateFanOut({ cap: 3, delegatedThisTurn: 3 }));
        expect(msg).not.toMatch(/tenant|risk|control|evidence|policy/i);
    });
});

describe('the gate: what it ignores', () => {
    const DELEGATION = { type: 'tool', toolName: DELEGATION_TOOL_NAME };
    const CTX = { instanceId: 'run-1', turnId: 'turn-1' };

    it.each([
        ['a model call', { type: 'model' }],
        ['an agent turn', { type: 'agent' }],
        ['a coordinator phase', { type: 'coordinator' }],
        ['an ordinary tool', { type: 'tool', toolName: 'list_risks' }],
        ['the task OPERATION rather than the tool call', { type: 'task' }],
    ])('%s passes through and is not counted', (_label, op) => {
        // The fast path, and the last case is the one measurement corrected:
        // `{ type: 'task' }` appears further in, once a task session exists.
        // Gating there would refuse work the runtime had already committed to,
        // and counting there would double-count every delegation.
        expect(() => gateDelegation(op, CTX)).not.toThrow();
        expect(delegationsThisTurn('run-1', 'turn-1')).toBe(0);
    });

    it('allows an UNKEYABLE delegation rather than refusing it', () => {
        // Deliberate, and the direction matters. Without an `instanceId` there
        // is no binding to read, so the cap is UNKNOWN rather than zero —
        // refusing on unknown would turn a runtime that stopped populating the
        // context into a product that stopped delegating. `ENGINE_CAPS` is the
        // outer bound and does not depend on this context at all.
        expect(() => gateDelegation(DELEGATION, { turnId: 'turn-1' })).not.toThrow();
        expect(() => gateDelegation(DELEGATION, { instanceId: 'run-1' })).not.toThrow();
    });
});

/*
    ═══ THE DEPTH BLOCK THAT USED TO BE HERE (#3581) ═══

    Two cases asserted that `gateDelegation` refuses a `task` call carrying a
    `ctx.taskId`. They passed, the arm could not fire, and the two facts had
    the same cause: a unit test supplies the context it expects.

    MEASURED against the real runtime, `ctx.taskId` is unset on the way IN —
    the context for a root tool call, the parent's `task` call and a tool call
    inside the delegation are indistinguishable except for `turnId`. The value
    is populated only AFTER `next()`, which is where it was first read and
    where `guardDelegateResult` legitimately uses it.

    So the arm is gone and these cases with it. Keeping them retargeted at
    something else would keep the shape that hid this: an assertion whose input
    it also authored.

    DEPTH 1 IS NOW ASSERTED STRUCTURALLY, in
    `tests/guards/flue-refused-capabilities.test.ts` — no file under
    `flue/subagents/` names `useSubagent`, and the delegate's own render in
    `agent.ts` does not either. A fact about the source, which an edge case
    cannot be wrong about.
*/

describe('the gate: fan-out, per turn', () => {
    const RUN = 'run-fanout';
    const DELEGATION = { type: 'tool', toolName: DELEGATION_TOOL_NAME };

    afterEach(() => {
        releaseRun(RUN);
        releaseDelegationCounts(RUN);
    });

    function bindWithCap(cap: number) {
        bindRun(RUN, {
            tools: [],
            skills: [],
            modelSpecifier: 'faux/faux-1',
            maxSubagentsPerTurn: cap,
        });
    }

    it('allows the cap and refuses the next, counting on the way IN', () => {
        bindWithCap(2);
        const ctx = { instanceId: RUN, turnId: 'turn-a' };
        gateDelegation(DELEGATION, ctx);
        gateDelegation(DELEGATION, ctx);
        expect(delegationsThisTurn(RUN, 'turn-a')).toBe(2);
        expect(() => gateDelegation(DELEGATION, ctx)).toThrow(/delegation_limit_reached/);
        // AND THE REFUSAL DID NOT COUNT. A refused call that incremented would
        // make the limit drift down every time the model tried.
        expect(delegationsThisTurn(RUN, 'turn-a')).toBe(2);
    });

    it('resets with the TURN, which is why the cap is per turn', () => {
        // A per-run cap would be a weaker spelling of the token budget: a long
        // run legitimately consults specialists across turns. The thing worth
        // bounding is the burst.
        bindWithCap(1);
        gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-a' });
        expect(() => gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-a' })).toThrow();
        expect(() =>
            gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-b' }),
        ).not.toThrow();
    });

    it('does not share a count between RUNS', () => {
        bindWithCap(1);
        bindRun('run-other', {
            tools: [], skills: [], modelSpecifier: 'faux/faux-1', maxSubagentsPerTurn: 1,
        });
        try {
            gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-a' });
            // Same turn id, different run — a key that dropped the run would
            // refuse this.
            expect(() =>
                gateDelegation(DELEGATION, { instanceId: 'run-other', turnId: 'turn-a' }),
            ).not.toThrow();
        } finally {
            releaseRun('run-other');
            releaseDelegationCounts('run-other');
        }
    });

    it('refuses everything for a tenant capped at ZERO', () => {
        bindWithCap(0);
        const err = (() => {
            try {
                gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-a' });
                return null;
            } catch (e) {
                return e as DelegationRefusedError;
            }
        })();
        expect(err?.cap).toBe('fan-out');
        expect(err?.message).toContain('delegation_disabled');
    });

    it('an UNBOUND run gets the default, not no cap', () => {
        // A delegation from a run this product did not dispatch. The safe
        // reading is the conservative one, so the default applies and the
        // (default+1)-th call is refused.
        const ctx = { instanceId: 'never-dispatched', turnId: 'turn-a' };
        for (let i = 0; i < DEFAULT_MAX_SUBAGENTS_PER_TURN; i++) {
            gateDelegation(DELEGATION, ctx);
        }
        expect(() => gateDelegation(DELEGATION, ctx)).toThrow(/delegation_limit_reached/);
    });

    it('releasing a run drops its counters', () => {
        bindWithCap(1);
        gateDelegation(DELEGATION, { instanceId: RUN, turnId: 'turn-a' });
        expect(delegationsThisTurn(RUN, 'turn-a')).toBe(1);
        releaseDelegationCounts(RUN);
        expect(delegationsThisTurn(RUN, 'turn-a')).toBe(0);
        // And it drops ONLY that run's — a prefix match that was too greedy
        // would clear a run whose id merely starts the same way.
        bindRun(`${RUN}-sibling`, {
            tools: [], skills: [], modelSpecifier: 'faux/faux-1', maxSubagentsPerTurn: 1,
        });
        try {
            gateDelegation(DELEGATION, { instanceId: `${RUN}-sibling`, turnId: 'turn-a' });
            releaseDelegationCounts(RUN);
            expect(delegationsThisTurn(`${RUN}-sibling`, 'turn-a')).toBe(1);
        } finally {
            releaseRun(`${RUN}-sibling`);
            releaseDelegationCounts(`${RUN}-sibling`);
        }
    });
});
