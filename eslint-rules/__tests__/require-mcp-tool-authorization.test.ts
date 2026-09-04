/**
 * `local/require-mcp-tool-authorization` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every object literal in the repository, so each narrowing gets
 * a case that would go red if it broke: the structural descriptor signature (all
 * three shape keys AND a discriminator), the deliberate spread hole, and the
 * scoping of the self-authorization half to files that actually declare a tool.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../rules/require-mcp-tool-authorization');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const READ_TOOL = (extra: string) => `
export const listRisksTool = {
    name: 'list_risks',
    description: 'd',
    inputSchema: {},
    ${extra}
    run: async (ctx, args) => listRisks(ctx, args),
};
`;

describe('local/require-mcp-tool-authorization', () => {
    ruleTester.run('require-mcp-tool-authorization', rule, {
        valid: [
            {
                name: 'a read tool that declares its authorization',
                code: READ_TOOL(`authorize: { keys: ['risks.view'], basis: 'effective', mirrors: 'GET /risks' },`),
            },
            {
                name: 'a propose tool, discriminated by `kind` rather than `run`',
                code: `
                    export const PROPOSE_TOOLS = [{
                        name: 'propose_risks',
                        description: 'd',
                        inputSchema: {},
                        kind: 'RISK',
                        authorize: { keys: ['risks.create'], basis: 'principal', mirrors: 'POST /risks' },
                    }];
                `,
            },
            {
                name: 'a spread could carry `authorize` — the deliberate hole, same as require-agent-attribution',
                code: `
                    export const t = {
                        ...baseTool,
                        name: 'x', description: 'd', inputSchema: {},
                        run: async () => {},
                    };
                `,
            },
            {
                name: 'an object with two of the shape keys but no discriminator is not a tool',
                code: `export const config = { name: 'x', description: 'd', inputSchema: {} };`,
            },
            {
                name: 'a `run` property alone is not a tool',
                code: `export const job = { name: 'nightly', run: async () => {} };`,
            },
            {
                name: 'a file that declares NO tool may call the gate freely — that is the funnel',
                code: `
                    export async function authorizeToolCall(inv, tool) {
                        await assertPermission(inv.ctx, tool.authorize.keys, surface);
                        enforceApiKeyScope(inv.ctx, 'risks', 'read');
                        assertCanWrite(inv.ctx);
                    }
                `,
            },
        ],
        invalid: [
            {
                name: 'a read tool with no `authorize`',
                code: READ_TOOL(''),
                errors: [{ messageId: 'missingAuthorize' }],
            },
            {
                name: 'a propose tool with no `authorize`',
                code: `
                    export const t = {
                        name: 'propose_risks', description: 'd', inputSchema: {}, kind: 'RISK',
                    };
                `,
                errors: [{ messageId: 'missingAuthorize' }],
            },
            {
                name: 'a tool file that authorizes itself with the shared gate',
                code: `
                    ${READ_TOOL(`authorize: { keys: ['risks.view'], basis: 'effective', mirrors: 'GET /risks' },`)}
                    export async function run(ctx) {
                        assertCanRead(ctx);
                        return listRisks(ctx);
                    }
                `,
                errors: [{ messageId: 'selfAuthorized' }],
            },
            {
                name: 'a tool file that reaches for the scope gate directly',
                code: `
                    ${READ_TOOL(`authorize: { keys: ['risks.view'], basis: 'effective', mirrors: 'GET /risks' },`)}
                    export function check(ctx) {
                        enforceApiKeyScope(ctx, 'risks', 'read');
                    }
                `,
                errors: [{ messageId: 'selfAuthorized' }],
            },
            {
                name: 'both halves at once — a tool with no declaration that checks by hand',
                code: `
                    ${READ_TOOL('')}
                    export function check(ctx) { return hasPermission(ctx.appPermissions, 'risks.view'); }
                `,
                errors: [{ messageId: 'missingAuthorize' }, { messageId: 'selfAuthorized' }],
            },
        ],
    });
});
