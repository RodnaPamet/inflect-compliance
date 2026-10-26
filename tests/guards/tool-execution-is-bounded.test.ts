/**
 * No code path in `src/` may execute code or shell out without a deadline AND
 * an output cap (OWASP ASI05).
 *
 * The behavioural half lives in `tests/unit/agent-tool-execution-bounds.test.ts`
 * and proves the bounds WORK. This proves they are REACHED — which is the part
 * that decays, because adding an executor means typing `execFile(cmd, args,
 * cb)` once and nothing anywhere complains. That is the same decay shape
 * `integrations-bounded-fetch-coverage.test.ts` exists for, and the same fix.
 *
 * ## What the population is today, and why the guard is mostly forward-looking
 *
 * NO AGENT-REACHABLE TOOL EXECUTES CODE. The MCP catalogue is fourteen
 * read/propose tools over Prisma; the workflow engine composes exactly those;
 * the automation actions are notify / task / status / webhook / subflow. The
 * only subprocess call sites in `src/` are the two cloud-posture collectors,
 * reached by a scheduled integration check and not by an agent — and both are
 * already bounded.
 *
 * So this guard is not cleaning up a mess. It is the thing that makes the FIRST
 * agent-reachable executor arrive bounded instead of arriving and being noticed
 * later, and it is why `runBoundedTool` is not decoration: nothing is optional
 * once a build fails without it.
 *
 * ## What it deliberately does not cover
 *
 * `scripts/**` and `tests/**`. Those are developer and CI tooling: they do not
 * run in a request path, they are not reachable by a tenant or an agent, and
 * `tests/helpers/repo-files.ts` legitimately shells `git` with a generous
 * buffer and no deadline. Widening the population to them would trade a real
 * invariant for a maintenance chore.
 */
import * as fs from 'node:fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import {
    TOOL_EXEC_MAX_OUTPUT_BYTES,
    TOOL_EXEC_TIMEOUT_MS,
} from '@/lib/agentic/bounded-exec';

const SEAM = 'src/lib/agentic/bounded-exec.ts';

/**
 * Every `src/` file allowed to reach a code/subprocess executor, with the
 * reason. A file appearing here that is not in this map fails the build; an
 * entry here for a file that no longer executes anything fails it too, so a
 * stale carve-out cannot outlive the code it excused.
 */
const ALLOWED_EXECUTORS: Record<string, string> = {
    [SEAM]:
        'The bounded seam itself — the one place allowed to reach node:child_process, ' +
        'and it wraps every call in a deadline race and an output cap.',
    'src/app-layer/integrations/cloud-posture/powerpipe-core.ts':
        'Shared Powerpipe collector for Azure + GCP. Bounded at 64 MiB / 15 min; ' +
        'reached by a scheduled integration check, not by an agent.',
    'src/app-layer/integrations/aws-posture-provider.ts':
        'AWS Powerpipe collector + the aws-cli identity probe. Same bounds, same ' +
        'reachability.',
};

/**
 * Roots whose files an AGENT can reach: the MCP tool surface, the declarative
 * workflows the engine runs, and the automation action executor. A file here
 * that shells out is the exact thing ASI05 names, so it must route through the
 * seam rather than be allowlisted.
 */
const AGENT_REACHABLE_ROOTS = [
    'src/lib/mcp/',
    'src/lib/agentic/workflows/',
    'src/app-layer/automation/',
    'src/app-layer/usecases/workflow-runs.ts',
];

/** Ways to reach a SUBPROCESS. */
const CHILD_PROCESS_IMPORT =
    /(from\s+['"](node:)?child_process['"])|((require|import)\(\s*['"](node:)?child_process['"]\s*\))/;

/** Ways to reach a subprocess OR an in-process evaluator — the population. */
const EXECUTOR_IMPORT = new RegExp(
    `${CHILD_PROCESS_IMPORT.source}|(from\\s+['"]node:vm['"])|(require\\(\\s*['"](node:)?vm['"]\\s*\\))`,
);

/** Arbitrary-code evaluation with no process to bound at all. */
const CODE_EVAL = /\bnew\s+Function\s*\(|\bvm\.(runIn|compileFunction|Script)/;

/**
 * The `child_process` APIs that BUFFER their output, so `maxBuffer` and
 * `timeout` are both meaningful options on the call.
 */
const BUFFERED_SPAWNERS = ['exec', 'execSync', 'execFile', 'execFileSync'];

/**
 * The STREAMING spawners. They take no `maxBuffer` at all, so "bounded" cannot
 * be expressed on the call — a caller that needs one has to accumulate output
 * itself, which is precisely how an unbounded read gets written by accident.
 * Banned outright in `src/`; there are none today.
 */
const STREAMING_SPAWNERS = ['spawn', 'spawnSync', 'fork'];

interface SourceFile {
    rel: string;
    code: string;
}

const sources: SourceFile[] = repoFiles({
    under: 'src',
    extensions: ['.ts', '.tsx'],
}).map((abs) => ({
    rel: repoRelative(abs),
    // Comments are masked before ANY match: this file's own prose names every
    // pattern it bans, and so does the seam's docstring.
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

/** Files that reach an executor at all — subprocess or in-process evaluator. */
const executorFiles = sources.filter(
    (f) => EXECUTOR_IMPORT.test(f.code) || CODE_EVAL.test(f.code),
);

/**
 * Files that specifically SPAWN. The boundedness rules apply to these and not
 * to the wider population: an in-process evaluator has no options object to
 * carry a timeout, which is why it is banned outright instead.
 */
const spawnFiles = sources.filter((f) => CHILD_PROCESS_IMPORT.test(f.code));

/**
 * The identifiers a file bound to `child_process`, so a call to a LOCAL `exec`
 * seam (`powerpipe-core.ts` injects one) is not mistaken for a real spawn.
 */
function spawnerBindings(code: string): string[] {
    const names = new Set<string>();
    const destructured = [
        ...code.matchAll(
            /(?:import|const)\s*\{([^}]*)\}\s*(?:=\s*(?:await\s+)?(?:import|require)\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"])/g,
        ),
    ];
    for (const m of destructured) {
        for (const part of m[1].split(',')) {
            // `execFile as run` binds `run`; the local name is what gets called.
            const local = part.includes(' as ') ? part.split(' as ')[1] : part;
            const name = local.trim();
            if (name) names.add(name);
        }
    }
    const namespaced = [
        ...code.matchAll(
            /import\s*\*\s*as\s+(\w+)\s+from\s+['"](?:node:)?child_process['"]/g,
        ),
    ];
    for (const m of namespaced) {
        for (const api of [...BUFFERED_SPAWNERS, ...STREAMING_SPAWNERS]) {
            names.add(`${m[1]}.${api}`);
        }
    }
    return [...names];
}

/** Every balanced call expression for `callee` in `code`. */
function callSites(code: string, callee: string): string[] {
    const out: string[] = [];
    const anchor = new RegExp(`(?<![.\\w])${callee.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of code.matchAll(anchor)) {
        // `RegExpMatchArray.index` is optional in some lib targets; a call at
        // offset 0 and an absent index are both `0`, and neither is a match we
        // could mis-slice.
        const start = m.index ?? 0;
        let depth = 0;
        for (let i = start; i < code.length; i++) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')') {
                depth--;
                if (depth === 0) {
                    out.push(code.slice(start, i + 1));
                    break;
                }
            }
        }
    }
    return out;
}

describe('tool execution is bounded', () => {
    it('has an allowlist entry, with a reason, for every file in src/ that can execute code', () => {
        const found = executorFiles.map((f) => f.rel).sort();
        const allowed = Object.keys(ALLOWED_EXECUTORS).sort();

        // Exact equality in both directions. An unlisted executor is the
        // regression; a listed file that no longer executes is a carve-out that
        // has outlived its reason and must go in the same diff as the fix.
        expect(found).toEqual(allowed);

        // A carve-out without a written reason is a carve-out nobody can
        // review, so the reason is part of the assertion rather than a habit.
        for (const reason of Object.values(ALLOWED_EXECUTORS)) {
            expect(reason.length).toBeGreaterThan(40);
        }
    });

    it('gives every buffered spawn call both a timeout and an output cap', () => {
        const unbounded: string[] = [];

        for (const file of spawnFiles) {
            for (const binding of spawnerBindings(file.code)) {
                const bare = binding.includes('.') ? binding.split('.')[1] : binding;
                if (!BUFFERED_SPAWNERS.includes(bare)) continue;
                for (const call of callSites(file.code, binding)) {
                    const hasTimeout = /\btimeout\s*:/.test(call);
                    const hasCap = /\bmaxBuffer\s*:/.test(call);
                    if (!hasTimeout || !hasCap) {
                        unbounded.push(
                            `${file.rel}: ${binding}(…) is missing ` +
                                `${!hasTimeout ? 'timeout' : ''}${!hasTimeout && !hasCap ? ' and ' : ''}${!hasCap ? 'maxBuffer' : ''}`,
                        );
                    }
                }
            }
        }

        // An executor with one of the two is not half-safe. Without `timeout` a
        // hung child holds its worker slot; without `maxBuffer` a chatty one
        // takes the heap. Either alone is unbounded in the direction it omits.
        expect(unbounded).toEqual([]);
    });

    it('actually resolves the spawner calls it claims to police', () => {
        // The boundedness rule above iterates `spawnerBindings` × `callSites`.
        // If either returned nothing — a new import form the regex has not seen,
        // a call spelled through an alias — the rule would pass by finding
        // nothing to check, and a genuinely unbounded executor would ship green.
        // An absence and a clean bill of health look identical without this.
        const resolved = spawnFiles.map((f) => {
            const buffered = spawnerBindings(f.code).filter((b) =>
                BUFFERED_SPAWNERS.includes(b.includes('.') ? b.split('.')[1] : b),
            );
            return {
                file: f.rel,
                calls: buffered.reduce((n, b) => n + callSites(f.code, b).length, 0),
            };
        });

        for (const entry of resolved) {
            expect(entry).toEqual({ file: entry.file, calls: expect.any(Number) });
            // Every file in this population imports `child_process`, so it
            // spawns something. A zero here means the extractor lost sight of
            // the call, not that the file stopped spawning — the population
            // rule would have caught the latter.
            expect(entry.calls).toBeGreaterThan(0);
        }
    });

    it('refuses in-process code evaluation in src/ outright', () => {
        // `new Function(…)` and `vm.runInNewContext(…)` execute attacker-shaped
        // strings on the SAME thread. There is no child to kill and no stream to
        // cap, so "bounded" is not expressible — the only safe answer is that
        // they do not appear. There are none today.
        const evaluators = sources.filter((f) => CODE_EVAL.test(f.code)).map((f) => f.rel);
        expect(evaluators).toEqual([]);
    });

    it('refuses a streaming spawner in src/, which has no output cap to set', () => {
        const streaming: string[] = [];
        for (const file of spawnFiles) {
            for (const binding of spawnerBindings(file.code)) {
                const bare = binding.includes('.') ? binding.split('.')[1] : binding;
                if (STREAMING_SPAWNERS.includes(bare) && callSites(file.code, binding).length > 0) {
                    streaming.push(`${file.rel}: ${binding}(…)`);
                }
            }
        }
        expect(streaming).toEqual([]);
    });

    it('lets no agent-reachable module reach an executor except through the seam', () => {
        const offenders = sources
            .filter((f) => AGENT_REACHABLE_ROOTS.some((root) => f.rel.startsWith(root)))
            .filter((f) => EXECUTOR_IMPORT.test(f.code) || CODE_EVAL.test(f.code))
            .map((f) => f.rel);

        // The population is empty TODAY — that is the finding, not a reason to
        // drop the check. This is the assertion that turns "somebody added a
        // shell tool to the MCP surface" into a red build on the PR that does
        // it, at which point `runBoundedTool` is the cheapest way back to green.
        expect(offenders).toEqual([]);
    });

    it('keeps the seam importable by an agent-reachable module', () => {
        // A guard that bans the raw API while the sanctioned replacement is
        // unreachable is a guard people route around. The seam must exist, be
        // exported, and not itself live under a banned root.
        expect(sources.map((f) => f.rel)).toContain(SEAM);
        expect(AGENT_REACHABLE_ROOTS.some((root) => SEAM.startsWith(root))).toBe(false);
    });

    it('bounds to finite, positive numbers rather than to the shape of a bound', () => {
        // `timeout: 0` disables the timeout in `child_process`, and `Infinity`
        // is a `maxBuffer` that caps nothing. Both would satisfy a guard that
        // only checked the option was PRESENT, which is why the values are read
        // rather than grepped.
        expect(Number.isFinite(TOOL_EXEC_TIMEOUT_MS)).toBe(true);
        expect(TOOL_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
        expect(Number.isFinite(TOOL_EXEC_MAX_OUTPUT_BYTES)).toBe(true);
        expect(TOOL_EXEC_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    });
});

/**
 * 4.2b (#3963) — a sandbox that cannot be created is a REFUSAL, never a
 * fallback to local execution.
 *
 * ═══ WHY THIS IS A GUARD AND NOT A UNIT TEST ═══
 *
 * The issue's acceptance is "a test makes sandbox creation fail and asserts the
 * call is refused". There is no sandbox creation yet — 4.2 (#3962) adds the
 * OpenShell backend and has not landed, and `src/lib/agentic` contains no
 * OpenShell reference today. A unit test written now would have to mock the
 * thing it is testing into existence, which proves nothing about the code that
 * eventually ships.
 *
 * The issue's second sentence is the durable half and is what these assertions
 * are: "with the mutation proof run the other way too, so a fallback introduced
 * later reddens this rather than passing quietly." The danger is not today's
 * code. It is the plausible edit a year from now — a sandbox backend added, and
 * beside it a `catch` that runs the tool locally so the feature "keeps working"
 * when the gateway is down. That is precisely the moment confinement was most
 * needed, and it is the edit that looks most reasonable in review.
 *
 * ═══ WHY NOT "NO EXECUTOR INSIDE A catch" ═══
 *
 * Because the seam has no `catch` keyword in code at all — measured, not
 * assumed: its three occurrences of the word are in prose, and error handling
 * runs through `Promise.race` and `.then(onOk, onErr)`. A rule phrased around
 * `catch` would be trivially satisfied today and blind to the fallback shapes
 * this module can actually express. So all three are named.
 */
describe('tool execution refuses rather than falling back (4.2b)', () => {
    const seam = sources.find((f) => f.rel === SEAM);

    /** The executor callees the seam is allowed to reach, pinned by name. */
    const SEAM_EXECUTORS = ['exec', 'execFile'];

    it('the seam reaches exactly the executors it is pinned to', () => {
        // A local fallback added beside a sandbox backend is a SECOND execution
        // path, and a second path means a new callee here. Pinning the set
        // makes that edit arrive through this assertion.
        expect(seam).toBeDefined();
        const found = [...SEAM_EXECUTORS, 'spawn', 'spawnSync', 'fork', 'execSync', 'execFileSync']
            .filter((name) => callSites(seam!.code, name).length > 0);
        expect(found.sort()).toEqual([...SEAM_EXECUTORS].sort());
    });

    /**
     * Extract a balanced region starting at the delimiter at `openIdx`.
     *
     * Hand-rolled regexes cannot do this, and the control below proved it: a
     * first version used `\.catch\(([^)]*)\)`, which stops at the arrow
     * function's OWN `()` and captured a single paren, so the assertion passed
     * while detecting nothing. The `.then` variant passed only by luck. Depth
     * counting is the cheapest thing that is actually correct.
     */
    function balancedFrom(code: string, openIdx: number, open: string, close: string): string {
        let depth = 0;
        for (let i = openIdx; i < code.length; i += 1) {
            if (code[i] === open) depth += 1;
            else if (code[i] === close) {
                depth -= 1;
                if (depth === 0) return code.slice(openIdx + 1, i);
            }
        }
        return code.slice(openIdx + 1);
    }

    const EXECUTOR_CALL = /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/;

    /**
     * The three positions a rejection can be handled from in this module, each
     * returning the HANDLER BODIES it finds. Paired with a fixture below, so a
     * shape that cannot be detected cannot be claimed as covered.
     */
    const REJECTION_HANDLERS: ReadonlyArray<{ name: string; bodies: (code: string) => string[] }> = [
        {
            name: 'catch block',
            bodies: (code) => {
                const out: string[] = [];
                for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
                    out.push(balancedFrom(code, m.index! + m[0].length - 1, '{', '}'));
                }
                return out;
            },
        },
        {
            name: '.catch(handler)',
            bodies: (code) => {
                const out: string[] = [];
                for (const m of code.matchAll(/\.catch\s*\(/g)) {
                    out.push(balancedFrom(code, m.index! + m[0].length - 1, '(', ')'));
                }
                return out;
            },
        },
        {
            // `.then(onFulfilled, onRejected)` — only the SECOND argument is an
            // error path, which is the arm the seam already uses for its timer.
            name: '.then(ok, onRejected)',
            bodies: (code) => {
                const out: string[] = [];
                for (const m of code.matchAll(/\.then\s*\(/g)) {
                    const args = balancedFrom(code, m.index! + m[0].length - 1, '(', ')');
                    // Split on the top-level comma only.
                    let depth = 0;
                    for (let i = 0; i < args.length; i += 1) {
                        const c = args[i];
                        if (c === '(' || c === '[' || c === '{') depth += 1;
                        else if (c === ')' || c === ']' || c === '}') depth -= 1;
                        else if (c === ',' && depth === 0) { out.push(args.slice(i + 1)); break; }
                    }
                }
                return out;
            },
        },
    ];

    it.each(REJECTION_HANDLERS.map((h) => h.name))(
        'no executor is reached from a %s in the seam',
        (name) => {
            const handler = REJECTION_HANDLERS.find((h) => h.name === name)!;
            const offenders = handler
                .bodies(seam!.code)
                .filter((body) => EXECUTOR_CALL.test(body))
                .map((body) => body.trim().slice(0, 80));
            expect(offenders).toEqual([]);
        },
    );

    it('each rejection-handler pattern CAN detect an executor — the control', () => {
        // Without this, the three assertions above are satisfied by extractors
        // that find nothing. A first version of this guard failed exactly here.
        const fixtures: Record<string, string> = {
            'catch block': 'try { await sandbox(); } catch (e) { execFile(cmd, args); }',
            '.catch(handler)': 'await sandbox().catch(() => exec(cmd));',
            '.then(ok, onRejected)': 'await sandbox().then((r) => r, () => exec(cmd));',
        };
        for (const { name, bodies } of REJECTION_HANDLERS) {
            const detected = bodies(fixtures[name]).filter((b) => EXECUTOR_CALL.test(b)).length;
            expect({ name, detected }).toEqual({ name, detected: 1 });
        }
    });

    it('no agent-reachable module names a local-execution fallback', () => {
        // The wider population, in case the fallback is added one level out
        // rather than inside the seam: a module that reaches the seam must not
        // also reach an executor, which the "only through the seam" assertion
        // above already enforces. This states the 4.2b reason for it, so the
        // rule is not relaxed later as merely structural.
        const reachable = sources.filter((f) =>
            AGENT_REACHABLE_ROOTS.some((root) => f.rel.startsWith(root)) && f.rel !== SEAM,
        );
        const offenders = reachable
            .filter((f) => EXECUTOR_IMPORT.test(f.code) || CODE_EVAL.test(f.code))
            .map((f) => f.rel);
        expect(offenders).toEqual([]);
    });
});
