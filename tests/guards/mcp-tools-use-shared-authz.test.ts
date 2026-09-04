/**
 * No MCP tool authorizes itself, and every one of them declares the gate its
 * human equivalent uses.
 *
 * `/api/mcp` runs every tool call through one funnel, and the funnel applies
 * `assertPermission` — the same function `requirePermission` calls on the human
 * route — plus the same `assertCanRead` / `assertCanWrite` policies the human
 * usecases apply. The value of that is entirely in it being the ONLY path: a
 * tool with its own check is a second decision over the same `PermissionSet`,
 * free to drift from the route it mirrors, and a tool that can perform a check
 * is a tool that can skip one.
 *
 * ── Why this runs an ESLint rule instead of grepping ─────────────────
 *
 * The check is syntax. A regex cannot tell an `authorize` PROPERTY from the word
 * in a comment or a description string, and these files are documented in prose
 * that uses it constantly; nor can it tell a CALL to `assertCanRead` from an
 * import of the same identifier. So the enforcement is
 * `local/require-mcp-tool-authorization`, and this file is the part ESLint
 * cannot do from inside one file: run that rule over the population **git**
 * defines, so a new tool anywhere under `src/` fails here even for somebody who
 * never runs `npm run lint`.
 *
 * The rule's own narrowings are proved by its RuleTester suite at
 * `eslint-rules/__tests__/require-mcp-tool-authorization.test.ts`. That it is
 * WIRED at `error` is owned by `tests/guards/eslint-local-rules-wired.test.ts`.
 * This file asserts the three things neither covers: the SWEEP is real and
 * finds the tools, the detector fires on a planted violation, and every
 * registered tool's declaration resolves to a permission the product actually
 * has — a declaration naming a key that does not exist would satisfy the rule
 * and gate nothing.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Linter } from 'eslint';

import { repoFiles, repoRelative, REPO_ROOT } from '../helpers/repo-files';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { MCP_READ_TOOL_NAMES, MCP_PROPOSE_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import { PERMISSION_SCHEMA } from '@/lib/permissions';

// `require`, not `import`: under ts-jest's CommonJS output an ESM default
// import of a CJS parser yields the interop wrapper rather than the parser
// object, and a flat config silently falls back to espree — which cannot read a
// type annotation, so every TypeScript file would "lint clean".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/rules/require-mcp-tool-authorization');

const RULE_ID = 'require-mcp-tool-authorization';

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
 * espree parser cannot read a type annotation, so without this a TypeScript
 * file would lint clean by failing to be read at all — the silent-skip shape
 * where a detector reports full coverage of the subset it understands.
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
 * The scanned population: every `.ts` file under `src/` that mentions
 * `inputSchema`, which every MCP tool descriptor carries.
 *
 * The narrowing is by SUBSTRING, deliberately weaker than the rule itself — it
 * can only ADD files to the set the AST rule then judges, never remove one the
 * rule would have flagged for a reason the substring cannot see. The first `it`
 * pins that the set is non-empty and holds the known tool files, because a
 * narrowing that silently emptied would make every clean result vacuous.
 */
const CANDIDATES = repoFiles({ under: 'src', extensions: ['.ts'] }).filter((abs) =>
    readFileSync(abs, 'utf8').includes('inputSchema'),
);

describe('no MCP tool authorizes itself', () => {
    it('the sweep found the tool files at all — otherwise a clean result is vacuous', () => {
        expect(CANDIDATES.length).toBeGreaterThanOrEqual(2);
        const rels = CANDIDATES.map(repoRelative);
        expect(rels).toContain('src/lib/mcp/tools/risk-tools.ts');
        expect(rels).toContain('src/lib/mcp/tools/propose-tools.ts');
    });

    it('every tool declares an authorization and none performs its own', () => {
        const violations: Violation[] = [];
        for (const abs of CANDIDATES) {
            violations.push(...lint(readFileSync(abs, 'utf8'), abs));
        }
        expect(
            violations.map((v) => `${repoRelative(v.file)}:${v.line} — ${v.message}`),
        ).toEqual([]);
    });

    it('the detector fires — a tool that forgets to declare one is caught', () => {
        // The mutation proof. Without it "no violations" is equally consistent
        // with a rule that reports nothing at all.
        const planted = `
            export const listWidgetsTool = {
                name: 'list_widgets',
                description: 'd',
                inputSchema: { type: 'object' },
                run: async (ctx: unknown) => listWidgets(ctx),
            };
        `;
        const found = lint(planted, path.join(REPO_ROOT, 'src/lib/mcp/tools/planted.ts'));
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('authorize');
    });

    it('the detector fires — a tool file that checks permissions by hand is caught', () => {
        const planted = `
            import { assertCanRead } from '@/app-layer/policies/common';
            export const t = {
                name: 'x', description: 'd', inputSchema: {},
                authorize: { keys: ['risks.view'], basis: 'effective', mirrors: 'GET /risks' },
                run: async (ctx: unknown) => { assertCanRead(ctx as never); },
            };
        `;
        const found = lint(planted, path.join(REPO_ROOT, 'src/lib/mcp/tools/planted2.ts'));
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('funnel');
    });

    it('the detector does NOT fire on the shape the real tools use', () => {
        // Paired negative. A rule that flagged the correct shape too would make
        // the assertions above pass while telling nobody anything.
        const correct = `
            export const listRisksTool = {
                name: 'list_risks',
                description: 'd',
                inputSchema: { type: 'object' },
                argsSchema,
                resourceScope: { resource: 'risks', action: 'read' as const },
                authorize: { keys: ['risks.view'] as const, basis: 'effective' as const, mirrors: 'GET /risks' },
                run: async (ctx: unknown, args: unknown) => listRisks(ctx as never, args as never),
            };
        `;
        expect(lint(correct, path.join(REPO_ROOT, 'src/lib/mcp/tools/planted-ok.ts'))).toEqual([]);
    });
});

describe('every declared authorization resolves to a real gate', () => {
    const ALL_TOOLS = [
        ...READ_TOOLS.map((t) => ({ name: t.name, authorize: t.authorize })),
        ...PROPOSE_TOOLS.map((t) => ({ name: t.name, authorize: t.authorize })),
    ];

    it('the registries are non-empty — the assertions below need something to judge', () => {
        expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(14);
    });

    it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
        '%s declares keys or a policy, a basis, and the route it mirrors',
        (_name, tool) => {
            const { authorize } = tool;
            // At least one enforceable term. A declaration with neither would
            // satisfy the ESLint rule and gate nothing — the shape of a control
            // that ships switched off.
            expect(
                (authorize.keys?.length ?? 0) > 0 || authorize.policy !== undefined,
            ).toBe(true);
            expect(['effective', 'principal']).toContain(authorize.basis);
            // `mirrors` is prose, and prose is not enforcement — but an empty
            // one means nobody decided which human route this tool answers to,
            // and that decision is the whole design.
            expect(authorize.mirrors.trim().length).toBeGreaterThan(5);
        },
    );

    it.each(ALL_TOOLS.flatMap((t) => (t.authorize.keys ?? []).map((k) => [t.name, k] as const)))(
        '%s names %s, which exists in PermissionSet',
        (_name, key) => {
            const [domain, action] = key.split('.');
            const actions = (PERMISSION_SCHEMA as Record<string, string[]>)[domain];
            expect(actions).toBeDefined();
            expect(actions).toContain(action);
        },
    );

    it('propose tools are checked against the PRINCIPAL, read tools against the intersection', () => {
        // The basis is not decoration. A propose key deliberately carries no
        // `<domain>:write` scope, so evaluating `risks.create` against the
        // intersected set would deny every propose call ever made; a read tool
        // evaluated against the principal alone would ignore the credential's
        // own scope narrowing. Getting either backwards is silent — one denies
        // everything, the other over-grants.
        for (const t of PROPOSE_TOOLS) expect(t.authorize.basis).toBe('principal');
        for (const t of READ_TOOLS) expect(t.authorize.basis).toBe('effective');
    });
});

describe('the grantable tool catalogue matches the registries', () => {
    it('the leaf catalogue lists exactly the read tools the registry exports', () => {
        // The catalogue is a copy, kept leaf so an admin route need not import
        // every usecase behind the tool graph to learn eleven strings. A copy
        // that drifts is a tool nobody can grant — reachable by no agent,
        // silently — which is why the equality is pinned rather than trusted.
        expect([...MCP_READ_TOOL_NAMES].sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
    });

    it('and exactly the propose tools', () => {
        expect([...MCP_PROPOSE_TOOL_NAMES].sort()).toEqual(PROPOSE_TOOLS.map((t) => t.name).sort());
    });
});
