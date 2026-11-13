/**
 * The lockdown proof (Step 4a, item 3): run under lockedOptions against a
 * hostile host, and `system/init` names exactly the resolved tools plus
 * `Skill`, while nothing from the host (settings, CLAUDE.md, AGENTS.md, MCP
 * servers, auto memory, hooks, skills, agents, commands, the host's own
 * environment) reaches the model or the init message.
 *
 * Runs in faux mode under this folder's own package, never the root Jest:
 *   npm test
 * and against a builder that has lost a row, which must FAIL:
 *   SPIKE_MUTATE=settingSources npm test
 *
 * The "catches" cases run the same check against a builder with one row
 * removed each, so the proof that the check can fail is part of the suite.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { buildHostileHost, hostileProcessEnv, type HostileHost } from './hostile-host.ts';
import { toolPrefix, type SpikeRun } from './locked-options.ts';
import { freshDir, lockdownViolations, materialiseSkillPlugin, observeLockedRun } from './lockdown-check.ts';
import { fauxTools, PROFILE_INSTRUCTIONS } from './profile.ts';

const base = mkdtempSync(join(tmpdir(), 'agent-sdk-lockdown-'));
after(() => rmSync(base, { recursive: true, force: true }));

const tools = fauxTools();
const killed = tools[1].name;
const failing = tools[2].name;

type Case = Omit<SpikeRun, 'baseUrl' | 'apiKey' | 'abortController'>;

/** The hostile-directories case: cwd IS the planted project, HOME and the config dir ARE the planted ones. */
function hostileDirsCase(h: HostileHost): Case {
    return {
        tools,
        skills: materialiseSkillPlugin(freshDir(base, 'skills'), { 'review-guide': 'INFLECT_SKILL_BODY: read controls before risks.' }),
        systemPrompt: PROFILE_INSTRUCTIONS,
        model: 'claude-sonnet-5-5',
        maxTurns: 10,
        maxBudgetUsd: 5,
        configDir: h.configDir,
        cwd: h.project,
        home: h.home,
        // The run's own gate refuses one resolved tool, as a kill switch would, and THROWS for another, as a
        // kill-switch read that failed would: the catch-all hook must deny both.
        gate: (name) => {
            if (name === `${toolPrefix}${failing}`) throw new Error('kill-switch read failed (spike)');
            return name === `${toolPrefix}${killed}` ? { allow: false, reason: 'kill switch engaged (spike)' } : { allow: true };
        },
    };
}

/** An allowed tool, a refused tool and a tool whose gate throws; then the Skill tool; then text. */
const SCRIPT = [[tools[0].name, killed, failing], ['=Skill']];
const DENIED = [`${toolPrefix}${killed}`, `${toolPrefix}${failing}`];

/** Run with the HOST process's own environment poisoned too: lockedOptions' env must not inherit it. */
async function observe(c: Case, h: HostileHost, mutate?: string) {
    const saved = { ...process.env };
    Object.assign(process.env, hostileProcessEnv(h));
    if (mutate !== undefined) process.env.SPIKE_MUTATE = mutate;
    try {
        return await observeLockedRun(c, SCRIPT);
    } finally {
        process.env = saved;
    }
}

describe('lockedOptions under a hostile host', () => {
    it('init names exactly the resolved tools plus Skill; nothing from the host loads or reaches the model', async () => {
        const h = buildHostileHost(base);
        const c = hostileDirsCase(h);
        const o = await observe(c, h);
        assert.deepEqual(lockdownViolations(o, c, h.hookFlags, DENIED), []);
        assert.deepEqual([...o.init!.tools].sort(), [...tools.map((t) => `${toolPrefix}${t.name}`), 'Skill'].sort());
        // The mounted skill really loaded through the plugin path: its body reached the model after the Skill call.
        assert.ok(o.requests.some((r) => r.text.includes('INFLECT_SKILL_BODY')), 'the plugin skill did not load');
    });

    it('per-run directories under a hostile parent, no skills: init names exactly the resolved tools', async () => {
        const h = buildHostileHost(base);
        const home = freshDir(base, 'home');
        const c: Case = {
            ...hostileDirsCase(h),
            skills: undefined,
            cwd: h.freshCwdUnderProject(),
            home,
            configDir: join(home, '.claude'),
        };
        mkdirSync(c.configDir);
        const o = await observe(c, h);
        assert.deepEqual(lockdownViolations(o, c, h.hookFlags, DENIED), []);
        assert.deepEqual([...o.init!.tools].sort(), tools.map((t) => `${toolPrefix}${t.name}`).sort());
    });
});

/**
 * Each row whose loss the check detects. The rows it cannot detect here are
 * named in the implementation note with the reason: strictMcpConfig (claude.ai
 * connectors need a claude.ai login the worker never has), disallowedTools and
 * CLAUDE_CODE_FORK_SUBAGENT (`tools: []` already removes Agent and every other
 * built-in), and HOME / CLAUDE_CONFIG_DIR (redundant with each other here,
 * because the planted config dir IS HOME/.claude).
 */
const DETECTED = [
    'settingSources',
    'permissionMode',
    'tools',
    'allowedTools',
    'hooks',
    'hooks.onFailure',
    'skills',
    'persistSession',
    'env',
    'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'env.CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
    'env.ENABLE_TOOL_SEARCH',
    'env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
];

describe('the check fails when lockedOptions loses a row', () => {
    for (const row of DETECTED) {
        it(`catches a builder without ${row}`, async () => {
            const h = buildHostileHost(base);
            const c = hostileDirsCase(h);
            const o = await observe(c, h, row);
            const v = lockdownViolations(o, c, h.hookFlags, DENIED);
            assert.ok(v.length > 0, `dropping ${row} went unnoticed`);
        });
    }
});
