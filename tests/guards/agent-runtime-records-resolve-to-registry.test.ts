/**
 * Every agent runtime record resolves to the register, and to the policy version
 * that was in force when it ran.
 *
 * `RegisteredAgent` says which autonomous agents a tenant runs and what
 * authority each holds; `AgentPolicyCardVersion` is the immutable statement of
 * what one of them was allowed to do. `AgentProposal` and `WorkflowRun` are what
 * those agents leave behind. The set only means anything if every runtime row
 * names both — otherwise "which agents run here?" has two answers, the
 * register's and the truth's, and "what was it allowed to do when it did that?"
 * has only today's answer, which is the wrong one precisely when somebody has
 * edited the card.
 *
 * Both columns had to be NULLABLE (each was added to populated tables in the
 * transaction that back-filled them, and a human-started workflow run genuinely
 * has neither an agent nor a card), so the type system cannot demand them.
 *
 * ── Why this runs an ESLint rule instead of grepping ─────────────────
 *
 * The check is syntax — "does this create call name this field" — which is
 * exactly what `eslint-rules/README.md` says belongs in an AST rule: it survives
 * renaming, reformatting, comment edits and helper extraction, none of which a
 * regex survives. So the enforcement is `local/require-agent-attribution`, and
 * this file is the part ESLint cannot do from inside one file: run that rule
 * over the population **git** defines, so a new write site anywhere in `src/`
 * fails here even for someone who never runs `npm run lint`.
 *
 * The rule's own narrowings (model allowlist, method allowlist, the deliberate
 * spread hole) are proved by its RuleTester suite at
 * `eslint-rules/__tests__/require-agent-attribution.test.ts`. That the rule is
 * WIRED at `error` — the regression that costs everything and shows nowhere —
 * is owned by `tests/guards/eslint-local-rules-wired.test.ts`, whose
 * `LOCAL_RULES` list is compared against what the plugin exports, so a rule
 * added and not wired fails there. This file asserts the third thing neither
 * covers: the SWEEP. The population is real, the detector fires on a planted
 * violation, it stays quiet on the shape the seams use, and the tree is clean.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Linter } from 'eslint';

import { repoFiles, repoRelative, REPO_ROOT } from '../helpers/repo-files';

// `require`, not `import`: under ts-jest's CommonJS output an ESM default
// import of a CJS parser yields the interop wrapper rather than the parser
// object, and a flat config silently falls back to espree — which cannot read a
// type annotation, so every TypeScript file would "lint clean".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/rules/require-agent-attribution');

const RULE_ID = 'require-agent-attribution';

const linter = new Linter();

interface Violation {
    file: string;
    line: number;
    message: string;
}

/**
 * Run the rule over one file's source.
 *
 * A PARSE FAILURE THROWS rather than returning zero violations. The default
 * espree parser cannot read a type annotation, so without this a TypeScript file
 * would lint clean by failing to be read at all — the silent-skip shape where a
 * detector reports full coverage of the subset it understands. The repo's own
 * `@typescript-eslint/parser` is used, and anything it still cannot parse is a
 * loud failure.
 */
function lint(source: string, filename: string): Violation[] {
    const messages = linter.verify(
        source,
        [
            {
                files: ['**/*.ts'],
                plugins: { local: { rules: { [RULE_ID]: rule } } },
                languageOptions: {
                    parser: tsParser,
                    ecmaVersion: 2022,
                    sourceType: 'module',
                },
                rules: { [`local/${RULE_ID}`]: 'error' },
            },
        ],
        filename,
    );
    const fatal = messages.filter((m) => m.fatal);
    if (fatal.length > 0) {
        throw new Error(
            `${repoRelative(filename)} did not parse, so it was never checked: ${fatal
                .map((m) => `${m.line}: ${m.message}`)
                .join('; ')}`,
        );
    }
    return messages.map((m) => ({ file: filename, line: m.line, message: m.message }));
}

/**
 * The scanned population. `.ts` only — `.tsx` is React and the default parser
 * would choke on type annotations there anyway; no Prisma write lives in a
 * component, and `tests/unit/no-prisma-in-routes.test.ts` is what keeps it that
 * way.
 *
 * Narrowed to the files that mention a create against one of the
 * agent-attributed accessors, so the sweep lints two files rather than the whole
 * of `src/`. The narrowing is by SUBSTRING, which is a weaker test than the rule
 * itself — deliberately so: it can only ever ADD files to the set the AST rule
 * then judges, never remove one the rule would have flagged for a reason the
 * substring cannot see. The `it` below pins that the set is non-empty and holds
 * both known seams, because a narrowing that silently emptied would make every
 * clean result vacuous.
 */
const AGENT_TABLE_ACCESSORS = ['agentProposal', 'workflowRun'] as const;

const CANDIDATES = repoFiles({ under: 'src', extensions: ['.ts'] }).filter((abs) => {
    const src = readFileSync(abs, 'utf8');
    return AGENT_TABLE_ACCESSORS.some((m) => src.includes(`${m}.create`) || src.includes(`${m}.upsert`));
});

describe('every agent runtime record resolves to the register', () => {
    it('the sweep found the write sites at all — otherwise a clean result is vacuous', () => {
        // Two seams exist today: the propose-not-commit queue and the workflow
        // engine. If this drops to zero the scan is looking at nothing and
        // every assertion below passes for the wrong reason.
        expect(CANDIDATES.length).toBeGreaterThanOrEqual(2);
        const rels = CANDIDATES.map(repoRelative);
        expect(rels).toContain('src/app-layer/usecases/agent-proposals.ts');
        expect(rels).toContain('src/app-layer/usecases/workflow-runs.ts');
    });

    it('no create against an agent-attributed table omits agentId or the policy-card pin', () => {
        const violations: Violation[] = [];
        for (const abs of CANDIDATES) {
            violations.push(...lint(readFileSync(abs, 'utf8'), abs));
        }
        expect(
            violations.map((v) => `${repoRelative(v.file)}:${v.line} — ${v.message}`),
        ).toEqual([]);
    });

    it('the detector fires — a write site that forgets both fields is caught', () => {
        // The mutation proof. Without it "no violations" is equally consistent
        // with a rule that reports nothing at all, which is how a sweep keyed
        // on its own marker reports full coverage of the subset it understands.
        const planted = `
            export async function propose(ctx: { tenantId: string }) {
                return db.agentProposal.create({
                    data: { tenantId: ctx.tenantId, kind: 'RISK', status: 'PENDING' },
                });
            }
        `;
        const found = lint(planted, path.join(REPO_ROOT, 'src/planted.ts'));
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('agentId');
        expect(found[0].message).toContain('policyCardVersion');
    });

    it('the detector fires on the HALF-updated shape, which is how this actually regresses', () => {
        // The realistic failure is not a site that forgot everything — it is a
        // site written before the pin existed and left behind when the column
        // was added. A detector that only caught the total omission would have
        // reported this tree clean on the day the column landed.
        const halfDone = `
            export async function start(ctx: { tenantId: string; agentId?: string }) {
                return db.workflowRun.create({
                    data: { tenantId: ctx.tenantId, agentId: ctx.agentId ?? null },
                });
            }
        `;
        const found = lint(halfDone, path.join(REPO_ROOT, 'src/planted-half.ts'));
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('policyCardVersion');
    });

    it('the detector does NOT fire on the shape the seams actually use', () => {
        // Paired negative. A rule that flagged the correct shape too would make
        // the assertions above pass while telling nobody anything.
        const correct = `
            export async function propose(ctx: { tenantId: string; agentId?: string }) {
                return db.agentProposal.create({
                    data: {
                        tenantId: ctx.tenantId,
                        agentId: ctx.agentId ?? null,
                        policyCardVersion: 0,
                    },
                });
            }
        `;
        expect(lint(correct, path.join(REPO_ROOT, 'src/planted-ok.ts'))).toEqual([]);
    });
});
