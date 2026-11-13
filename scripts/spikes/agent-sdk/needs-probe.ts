/**
 * Faux-mode evidence for two of the three Phase 4 trigger needs:
 *   (1) a PreToolUse hook DEFERS one call to a person; the run ends with
 *       `terminal_reason: 'tool_deferred'`, and a resumed query re-asks the
 *       hook, which now allows it, and the run completes;
 *   (2) context compaction fires inside a run driven by lockedOptions, and
 *       the hooks see it.
 * Need (3), a file / code workspace, is not probed: lockedOptions refuses
 * every built-in file tool by design, which is the point the note makes.
 *
 *   npx tsx needs-probe.ts
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { FAUX_KEY, startFauxServer } from './faux-server.ts';
import { lockedOptions, toolPrefix, type SpikeRun } from './locked-options.ts';
import { fauxTools, PROFILE_INSTRUCTIONS } from './profile.ts';

// The spike reads loosely shaped messages and records; one alias, scoped to this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

async function drain(q: AsyncIterable<SDKMessage>) {
    const out: Any[] = [];
    try {
        for await (const m of q) out.push(m as Any);
    } catch (e) {
        out.push({ type: 'thrown', message: String(e) });
    }
    return out;
}

function baseRun(dir: string, url: string, over: Partial<SpikeRun> = {}): SpikeRun {
    return {
        tools: fauxTools().slice(0, 3),
        systemPrompt: PROFILE_INSTRUCTIONS,
        model: 'claude-sonnet-4-5',
        maxTurns: 20,
        maxBudgetUsd: 5,
        apiKey: FAUX_KEY,
        baseUrl: url,
        configDir: join(dir, 'config'),
        cwd: dir,
        home: dir,
        abortController: new AbortController(),
        spikeEnv: { PATH: process.env.PATH ?? '' },
        ...over,
    };
}

async function deferral() {
    const tools = fauxTools().slice(0, 3);
    const faux = await startFauxServer({ turns: [[tools[0].name], [tools[1].name]], toolPrefix, finalText: 'done after approval' });
    const report: Any = {};
    for (const persist of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'spike-defer-'));
        let approved = false;
        const run = baseRun(dir, faux.url, {
            gate: (name) =>
                name === `${toolPrefix}${tools[1].name}` && !approved
                    ? { allow: false, defer: true, reason: 'held for a person' }
                    : { allow: true },
        });
        const opts = { ...lockedOptions(run), persistSession: persist };
        const first = await drain(query({ prompt: 'go', options: opts }));
        const r1 = first.find((m) => m.type === 'result') ?? {};
        const sessionId = first.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;
        approved = true;
        const second = await drain(
            query({ prompt: 'The person approved the held call.', options: { ...lockedOptions(run), persistSession: persist, resume: sessionId } }),
        );
        const results2 = second.filter((m) => m.type === 'result');
        const r2 = results2[results2.length - 1] ?? {};
        const ranAfter = faux.requests.filter((r) => r.main).length;
        report[persist ? 'persistSession:true' : 'persistSession:false'] = {
            first: { subtype: r1.subtype, terminal_reason: r1.terminal_reason, deferred: r1.deferred_tool_use?.name ?? null },
            resume: {
                // Every result the resumed query emitted, in order: the first can be a spurious
                // tool_deferred_unavailable while the in-process server reconnects.
                results: results2.map((m) => m.terminal_reason ?? m.subtype),
                deferredCallRan: second.some((m) => m.type === 'user' && JSON.stringify(m.message?.content ?? '').includes(tools[1].name)),
                thrown: second.find((m) => m.type === 'thrown')?.message?.slice(0, 160) ?? null,
            },
            transcriptFilesOnDisk: listFiles(join(dir, 'config', 'projects')),
            fauxMainRequestsSoFar: ranAfter,
        };
        rmSync(dir, { recursive: true, force: true });
    }
    await faux.close();
    return report;
}

/**
 * The CLI hooks page says `defer` is ignored when the model makes several calls
 * in one turn, and the call then goes through the normal permission flow. Under
 * lockedOptions that flow would ALLOW it (it is in allowedTools), so this case
 * is the one that would fail open. Observed: whether the deferred handler ran.
 */
async function deferralParallel() {
    const tools = fauxTools().slice(0, 3);
    const ran: string[] = [];
    const wrapped = tools.map((t) => ({ ...t, handler: async (a: Record<string, unknown>) => (ran.push(t.name), t.handler(a)) }));
    const faux = await startFauxServer({ turns: [[tools[0].name, tools[1].name]], toolPrefix, finalText: 'done' });
    const dir = mkdtempSync(join(tmpdir(), 'spike-defer-par-'));
    const run = baseRun(dir, faux.url, {
        tools: wrapped,
        gate: (name) => (name === `${toolPrefix}${tools[1].name}` ? { allow: false, defer: true, reason: 'held for a person' } : { allow: true }),
    });
    const msgs = await drain(query({ prompt: 'go', options: { ...lockedOptions(run), persistSession: true } }));
    const r = msgs.find((m) => m.type === 'result') ?? {};
    await faux.close();
    rmSync(dir, { recursive: true, force: true });
    return { terminal_reason: r.terminal_reason, deferred: r.deferred_tool_use?.name ?? null, handlersThatRan: ran };
}

function listFiles(dir: string): number {
    try {
        return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).length;
    } catch {
        return 0;
    }
}

async function compaction(compactEnv: Record<string, string>) {
    const tools = fauxTools();
    // Report a context near the window from turn 3 on, so the CLI's own autocompact decides to act.
    const turns = Array.from({ length: 8 }, (_, i) => [tools[i].name]);
    const faux = await startFauxServer({ turns, toolPrefix, finalText: 'done', inputTokens: (k) => (k >= 3 ? 190_000 : 1_000) });
    const dir = mkdtempSync(join(tmpdir(), 'spike-compact-'));
    const seen: string[] = [];
    const run = baseRun(dir, faux.url, { tools, maxBudgetUsd: 100, spikeEnv: { PATH: process.env.PATH ?? '', ...compactEnv } });
    const opts = lockedOptions(run);
    opts.hooks = {
        ...opts.hooks,
        PreCompact: [{ hooks: [async () => (seen.push('PreCompact'), {})] }],
        PostCompact: [{ hooks: [async () => (seen.push('PostCompact'), {})] }],
    };
    const msgs = await drain(query({ prompt: 'go', options: opts }));
    const result = msgs.find((m) => m.type === 'result') ?? {};
    const boundaries = msgs
        .filter((m) => m.type === 'system' && m.subtype === 'compact_boundary')
        .map((m) => ({ trigger: m.compact_metadata?.trigger, pre: m.compact_metadata?.pre_tokens, post: m.compact_metadata?.post_tokens }));
    // A compaction summary is a model call of its own; count the requests that carried no tools.
    const summaryCalls = faux.requests.filter((r) => r.toolNames.length === 0).length;
    const side = faux.requests.filter((r) => !r.main).map((r) => r.text.slice(0, 160));
    await faux.close();
    rmSync(dir, { recursive: true, force: true });
    return {
        hooks: seen,
        boundaries,
        requests: faux.requests.length,
        summaryCalls,
        sideRequests: side.length,
        result: { subtype: result.subtype, terminal_reason: result.terminal_reason },
    };
}

console.log(
    JSON.stringify(
        {
            deferral: await deferral(),
            deferralInAParallelTurn: await deferralParallel(),
            compactionDefault: await compaction({}),
            compactionWindowOverride: await compaction({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' }),
        },
        null,
        2,
    ),
);
