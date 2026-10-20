/**
 * The assistant loop's bounds — each one halts AND reports (#3819).
 *
 * Asserting only that the loop STOPPED would pass for a loop that silently
 * truncates, which is the failure these bounds exist to prevent: a partial
 * answer returned as though complete is indistinguishable, to the reader, from
 * a finished one. So every case here asserts the outcome AND that the halt is
 * visible in the text a user would see.
 *
 * No network and no key: `AssistantTurnProvider` is an interface, so the whole
 * loop is drivable from a fake. The clock is injected for the same reason
 * `McpInvocation` carries one — a wall-clock bound that needed real time to
 * prove would be a bound nobody re-tests.
 */
import {
    runAssistantLoop,
    boundResult,
    haltNotice,
    DEFAULT_LOOP_BOUNDS,
    type AssistantTurnProvider,
    type LoopTool,
    type ProviderTurn,
} from '@/app-layer/ai/assistant/tool-loop';

/** A provider that replays a fixed script of turns, then answers. */
function scriptedProvider(turns: ProviderTurn[]): AssistantTurnProvider {
    let i = 0;
    return {
        complete: async () => turns[Math.min(i++, turns.length - 1)],
    };
}

const answer = (text: string): ProviderTurn => ({ text, toolCalls: [], stopReason: 'end' });
const wantsTool = (id: string, name: string): ProviderTurn => ({
    text: null,
    toolCalls: [{ id, name, args: {} }],
    stopReason: 'tool_use',
});

function tool(name: string, impl?: () => Promise<string>): LoopTool {
    return {
        name,
        description: `the ${name} tool`,
        jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: impl ?? (async () => `rows from ${name}`),
    };
}

const BOUNDS = { iterations: 3, toolCalls: 4, wallClockMs: 1_000, resultBytes: 200 };

describe('the loop answers when it can', () => {
    it('returns the answer and reports no halt — the positive control', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([answer('You have 3 open findings.')]),
            specifier: 'anthropic/claude-haiku-4-5',
            system: 'sys',
            question: 'how many findings?',
            tools: [tool('list_findings')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.outcome).toBe('answered');
        expect(r.text).toBe('You have 3 open findings.');
        // Without this, every "reports a halt" assertion below is satisfied by
        // a loop that always reports one.
        expect(r.text).not.toMatch(/I stopped/);
        expect(r.truncatedAny).toBe(false);
    });

    it('dispatches a tool, feeds the result back, and answers', async () => {
        const seen: unknown[] = [];
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c1', 'list_findings'), answer('Three.')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [
                tool('list_findings', async () => {
                    seen.push('called');
                    return 'finding rows';
                }),
            ],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(seen).toEqual(['called']);
        expect(r.outcome).toBe('answered');
        expect(r.calls).toEqual([{ name: 'list_findings', ok: true, bytes: 12, truncated: false }]);
    });
});

describe('each bound halts the loop AND reports halting', () => {
    it('iterations', async () => {
        // Always asks for a tool, so only the iteration cap can stop it.
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c', 'list_findings')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: { ...BOUNDS, toolCalls: 999 },
            now: () => 0,
        });

        expect(r.outcome).toBe('halted-iterations');
        expect(r.iterations).toBe(BOUNDS.iterations);
        expect(r.text).toMatch(/stopped after 3 reasoning steps/);
    });

    it('total tool calls across the conversation', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c', 'list_findings')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: { ...BOUNDS, iterations: 999 },
            now: () => 0,
        });

        expect(r.outcome).toBe('halted-tool-calls');
        expect(r.text).toMatch(/stopped after 4 data lookups/);
    });

    it('and the tool-call budget counts calls ALREADY spent earlier in the conversation', async () => {
        // The bound is per CONVERSATION, not per turn. Without `callsAlready` a
        // long conversation would get a fresh budget every turn, which is the
        // same defect as a per-run action budget resetting at a checkpoint.
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c', 'list_findings')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: { ...BOUNDS, iterations: 999 },
            callsAlready: BOUNDS.toolCalls,
            now: () => 0,
        });

        expect(r.outcome).toBe('halted-tool-calls');
        expect(r.calls).toEqual([]);
    });

    it('wall clock', async () => {
        // The injected clock jumps past the budget on its second reading.
        let t = 0;
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c', 'list_findings')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: { ...BOUNDS, iterations: 999, toolCalls: 999 },
            now: () => {
                const v = t;
                t += 600;
                return v;
            },
        });

        expect(r.outcome).toBe('halted-wall-clock');
        expect(r.text).toMatch(/stopped after 1 seconds/);
    });

    it('every halt outcome has a notice — none falls through silently', () => {
        // A new outcome added without a notice would return null here and the
        // halt would become invisible, which is the one failure mode these
        // bounds cannot tolerate.
        const outcomes = [
            'halted-iterations',
            'halted-tool-calls',
            'halted-wall-clock',
            'halted-provider-unavailable',
        ] as const;
        for (const o of outcomes) {
            expect(haltNotice(o, DEFAULT_LOOP_BOUNDS)).toBeTruthy();
        }
        expect(haltNotice('answered', DEFAULT_LOOP_BOUNDS)).toBeNull();
    });
});

describe('fail closed, and never manufacture a signal', () => {
    it('a tool that throws becomes a RESULT saying so, not an exception', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                wantsTool('c1', 'list_findings'),
                answer('I could not read your findings, so I cannot say.'),
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [
                tool('list_findings', async () => {
                    throw new Error('findings read failed');
                }),
            ],
            bounds: BOUNDS,
            now: () => 0,
        });

        // The turn completed — the model got to answer honestly rather than the
        // user getting a stack trace.
        expect(r.outcome).toBe('answered');
        expect(r.calls[0]).toMatchObject({ name: 'list_findings', ok: false });
    });

    it('a PROVIDER failure degrades, and says nothing about the tenant posture', async () => {
        const r = await runAssistantLoop({
            provider: {
                complete: async () => {
                    throw new Error('upstream 503');
                },
            },
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.outcome).toBe('halted-provider-unavailable');
        expect(r.text).toMatch(/model was unavailable/);
        expect(r.text).toMatch(/nothing was created/);
        // No tool ran, so no posture claim is possible.
        expect(r.calls).toEqual([]);
    });

    it('an invented tool name is reported back, not dispatched', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c1', 'drop_all_controls'), answer('ok')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.outcome).toBe('answered');
        expect(r.calls[0]).toMatchObject({ name: 'drop_all_controls', ok: false, bytes: 0 });
    });

    it('a cut reply (max_tokens) is not reported as a finished answer', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([{ text: 'You have 3 open f', toolCalls: [], stopReason: 'max_tokens' }]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.outcome).not.toBe('answered');
        expect(r.text).toMatch(/may be incomplete/);
        // The partial body is kept, not discarded — the notice is appended.
        expect(r.text).toMatch(/You have 3 open f/);
    });
});

describe('tool results are bounded by serialised SIZE', () => {
    it('cuts on bytes and tells the model it is seeing a prefix', () => {
        const b = boundResult('x'.repeat(500), 200);
        expect(b.truncated).toBe(true);
        expect(b.bytes).toBe(200);
        expect(b.content).toMatch(/TRUNCATED/);
        expect(b.content).toMatch(/do not state totals/);
    });

    it('leaves a result under the limit untouched — the control', () => {
        const b = boundResult('short', 200);
        expect(b.truncated).toBe(false);
        expect(b.content).toBe('short');
        expect(b.content).not.toMatch(/TRUNCATED/);
    });

    it('counts BYTES, not UTF-16 units, so non-ASCII is measured honestly', () => {
        // Cyrillic is TWO bytes per character in UTF-8, so ten of them is 20
        // bytes but only 10 `String.length` units. Against a limit of 15 the
        // two instruments disagree, and that disagreement is the test:
        //
        //   byte budget   20 > 15  -> truncate   (correct)
        //   `.length`     10 <= 15 -> keep       (admits 20 bytes under a 15-byte cap)
        //
        // A cap applied to `.length` therefore leaks in exactly one direction,
        // which is the wrong one for a context-window budget.
        const cyrillic = 'д'.repeat(10);
        expect(cyrillic.length).toBe(10);
        expect(new TextEncoder().encode(cyrillic).byteLength).toBe(20);

        const b = boundResult(cyrillic, 15);
        expect(b.truncated).toBe(true);

        // And the ASCII control at the same limit is NOT truncated, so the
        // assertion above is about the encoding rather than about the limit
        // being too small for anything.
        expect(boundResult('x'.repeat(10), 15).truncated).toBe(false);
    });

    it('marks the turn truncated so the UI can label the answer', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([wantsTool('c1', 'list_findings'), answer('Partial.')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_findings', async () => 'y'.repeat(5_000))],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.truncatedAny).toBe(true);
        expect(r.calls[0].truncated).toBe(true);
    });
});

describe('a GUARD trip stops the turn — it is not data the model may reason past', () => {
    it('halts and says so, rather than feeding the refusal back as a result', async () => {
        // The distinction this asserts: a failed read becomes a result (tested
        // above), but a guard trip must not. `tools-adapter.ts` keeps ONE latch
        // for the whole set so "a flagged list_risks" cannot be followed by "a
        // clean list_controls"; a loop that treated the refusal as data would
        // reintroduce exactly that at the engine layer.
        let tripped = false;
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                { text: null, toolCalls: [{ id: 'c1', name: 'list_risks', args: {} }], stopReason: 'tool_use' },
                answer('here is what I found anyway'),
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [
                tool('list_risks', async () => {
                    tripped = true;
                    throw new Error('ai_guard_review_required: inbound flagged [R12]');
                }),
            ],
            bounds: BOUNDS,
            now: () => 0,
            guardTripped: () => tripped,
        });

        expect(r.outcome).toBe('halted-guard-review');
        expect(r.text).toMatch(/content guard flagged/);
        expect(r.text).toMatch(/Nothing was created/);
        // The model's follow-up answer never ran — the turn stopped at the trip.
        expect(r.text).not.toMatch(/anyway/);
        expect(r.iterations).toBe(1);
    });

    it('does not halt when the latch is clean — the control', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                { text: null, toolCalls: [{ id: 'c1', name: 'list_risks', args: {} }], stopReason: 'tool_use' },
                answer('Two risks.'),
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('list_risks')],
            bounds: BOUNDS,
            now: () => 0,
            guardTripped: () => false,
        });

        expect(r.outcome).toBe('answered');
        expect(r.text).toBe('Two risks.');
    });

    it('a trip is checked after EVERY dispatch, so a second tool in the same turn cannot run', async () => {
        const ran: string[] = [];
        let tripped = false;
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                {
                    text: null,
                    toolCalls: [
                        { id: 'c1', name: 'list_risks', args: {} },
                        { id: 'c2', name: 'list_controls', args: {} },
                    ],
                    stopReason: 'tool_use',
                },
                answer('unreachable'),
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [
                tool('list_risks', async () => {
                    ran.push('list_risks');
                    tripped = true;
                    return 'flagged rows';
                }),
                tool('list_controls', async () => {
                    ran.push('list_controls');
                    return 'control rows';
                }),
            ],
            bounds: BOUNDS,
            now: () => 0,
            guardTripped: () => tripped,
        });

        // The second tool in the SAME provider turn never ran. A check placed
        // only between iterations would have let it through, which is the
        // routing-around in its most direct form.
        expect(ran).toEqual(['list_risks']);
        expect(r.outcome).toBe('halted-guard-review');
    });
});

describe('what a turn cost, and the difference between zero and unknown (#3833)', () => {
    it('reports NULL when no provider reply carried usage', async () => {
        // Null rather than 0. "This turn cost nothing" and "we do not know what
        // this turn cost" are different facts, and a spend record that conflates
        // them under-reports — the one direction a cost record must not fail in.
        const r = await runAssistantLoop({
            provider: scriptedProvider([answer('done')]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('t')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.tokensIn).toBeNull();
        expect(r.tokensOut).toBeNull();
    });

    it('SUMS usage across every round-trip, not just the last', async () => {
        // A turn that called a tool made two round-trips and the tenant paid for
        // both. Recording only the last would under-report a multi-step turn by
        // most of its cost.
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                { text: null, toolCalls: [{ id: 'c1', name: 't', args: {} }], stopReason: 'tool_use', usage: { tokensIn: 100, tokensOut: 20 } },
                { text: 'done', toolCalls: [], stopReason: 'end', usage: { tokensIn: 300, tokensOut: 40 } },
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('t')],
            bounds: BOUNDS,
            now: () => 0,
        });

        expect(r.tokensIn).toBe(400);
        expect(r.tokensOut).toBe(60);
        // And the control: it is the SUM, not the maximum or the last.
        expect(r.tokensIn).not.toBe(300);
    });

    it('counts a turn that reported usage only once, without zero-filling the rest', async () => {
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                { text: null, toolCalls: [{ id: 'c1', name: 't', args: {} }], stopReason: 'tool_use' },
                { text: 'done', toolCalls: [], stopReason: 'end', usage: { tokensIn: 50, tokensOut: 5 } },
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('t')],
            bounds: BOUNDS,
            now: () => 0,
        });

        // Partial knowledge is reported as what IS known rather than discarded,
        // because an under-report is still better than no record — but the
        // unreported round-trip is not invented as a zero either.
        expect(r.tokensIn).toBe(50);
        expect(r.tokensOut).toBe(5);
    });

    it('still reports the cost of a turn that HALTED', async () => {
        // A bounded turn spent real money before it stopped. Reporting null
        // there would hide the most expensive turns — the ones that ran to a cap.
        const r = await runAssistantLoop({
            provider: scriptedProvider([
                { text: null, toolCalls: [{ id: 'c', name: 't', args: {} }], stopReason: 'tool_use', usage: { tokensIn: 10, tokensOut: 2 } },
            ]),
            specifier: 'spec',
            system: 'sys',
            question: 'q',
            tools: [tool('t')],
            bounds: { ...BOUNDS, iterations: 2 },
            now: () => 0,
        });

        expect(r.outcome).toBe('halted-iterations');
        expect(r.tokensIn).toBeGreaterThan(0);
    });
});
