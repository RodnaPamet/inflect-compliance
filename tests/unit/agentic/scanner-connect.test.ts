/**
 * What "Connect a scanner" hands a customer (owner decisions, 2026-11-24): one
 * key carrying the ticked reports' scopes, the env lines and the config block
 * scanent reads.
 */
import {
    SCANNER_KEY_ENV,
    SCANNER_KEY_PLACEHOLDER,
    postsAnyReport,
    scannerKeyCeiling,
    scannerAgentBlock,
    scannerConfigBlock,
    scannerEnvLines,
    scannerKeyRequiresExchange,
    scannerKeyScopes,
    scannerKeyVariables,
    type ScannerConnectSelection,
} from '@/lib/agentic/scanner-connect';
import { validateScopes } from '@/lib/auth/api-key-auth';
import { admitsMcpEndpoint } from '@/lib/mcp/endpoint-scope';

const NONE: ScannerConnectSelection = { agentReport: false, integrations: false, agentRules: false, readRegister: false };

/** Every combination of the four ticks. */
const ALL_SELECTIONS: ScannerConnectSelection[] = Array.from({ length: 16 }, (_, n) => ({
    agentReport: Boolean(n & 1),
    integrations: Boolean(n & 2),
    agentRules: Boolean(n & 4),
    readRegister: Boolean(n & 8),
}));

/**
 * scanent 0.17.0's own rules for the fields the block writes, copied from
 * `packages/scanner/src/config.ts` of that release. A rule changed there is a
 * scanent release and a version bump here; this copy is what the printed block
 * has to satisfy for a customer running the released scanner.
 */
const SCANENT_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SCANENT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCANENT_AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

describe('one key, the ticked scopes and no more', () => {
    it('the agent report alone is admin:harness_ingest', () => {
        expect(scannerKeyScopes({ ...NONE, agentReport: true })).toEqual(['admin:harness_ingest']);
    });

    it('all three reports are one key carrying all three ingest scopes', () => {
        expect(scannerKeyScopes({ agentReport: true, integrations: true, agentRules: true, readRegister: false })).toEqual([
            'admin:agent_rules_ingest',
            'admin:harness_ingest',
            'admin:integrations_ingest',
        ]);
    });

    it('the integrations report alone carries no harness scope', () => {
        expect(scannerKeyScopes({ ...NONE, integrations: true })).toEqual(['admin:integrations_ingest']);
    });

    it('reading the register adds mcp:read and the harness scope, and asks for the token exchange', () => {
        const sel = { ...NONE, integrations: true, readRegister: true };
        expect(scannerKeyScopes(sel)).toEqual(['admin:harness_ingest', 'admin:integrations_ingest', 'mcp:read']);
        expect(scannerKeyRequiresExchange(sel)).toBe(true);
    });

    it('a key that does not read the register never asks for the exchange, and never carries an MCP scope', () => {
        for (const sel of ALL_SELECTIONS.filter((s) => !s.readRegister)) {
            expect(scannerKeyRequiresExchange(sel)).toBe(false);
            expect(admitsMcpEndpoint(scannerKeyScopes(sel))).toBe(false);
        }
    });

    it('the exchange is asked for only on a key the route lets carry it', () => {
        // `createApiKey` refuses requiresTokenExchange without an MCP scope.
        for (const sel of ALL_SELECTIONS.filter(scannerKeyRequiresExchange)) {
            expect(admitsMcpEndpoint(scannerKeyScopes(sel))).toBe(true);
        }
    });

    it('every scope any selection asks for is one the key route accepts', () => {
        for (const sel of ALL_SELECTIONS.filter(postsAnyReport)) {
            expect(validateScopes(scannerKeyScopes(sel))).toEqual([]);
        }
    });

    it('the ceiling is the agent\'s own level, and never above 1', () => {
        expect(scannerKeyCeiling(0)).toBe(0);
        expect(scannerKeyCeiling(1)).toBe(1);
        expect(scannerKeyCeiling(4)).toBe(1);
    });

    it('nothing ticked posts nothing', () => {
        expect(postsAnyReport(NONE)).toBe(false);
        expect(postsAnyReport({ ...NONE, readRegister: true })).toBe(false);
    });
});

describe('the variables and the env lines', () => {
    it('one variable per ticked report, in scanent\'s order, each its own name', () => {
        expect(scannerKeyVariables({ agentReport: true, integrations: true, agentRules: true, readRegister: false })).toEqual([
            SCANNER_KEY_ENV.agentReport,
            SCANNER_KEY_ENV.integrations,
            SCANNER_KEY_ENV.agentRules,
        ]);
        for (const sel of ALL_SELECTIONS) {
            const names = scannerKeyVariables(sel);
            expect(new Set(names).size).toBe(names.length);
            for (const name of names) expect(SCANENT_ENV_NAME.test(name)).toBe(true);
        }
    });

    it('each line waits for the key with a placeholder, and no line carries a key', () => {
        const lines = scannerEnvLines({ agentReport: true, integrations: false, agentRules: true, readRegister: false });
        expect(lines).toBe(
            `${SCANNER_KEY_ENV.agentReport}=${SCANNER_KEY_PLACEHOLDER}\n${SCANNER_KEY_ENV.agentRules}=${SCANNER_KEY_PLACEHOLDER}`,
        );
        expect(lines.includes('iflk_')).toBe(false);
    });
});

describe('the config block scanent reads', () => {
    const base = { origin: 'https://app.acme.example/', tenantSlug: 'acme', agentId: 'clx9agent01' };

    it('names the scanner, the tenant and only the ticked reports\' variables', () => {
        expect(
            scannerConfigBlock({ ...base, sel: { ...NONE, agentReport: true, agentRules: true } }),
        ).toEqual({
            scanner: { agentId: 'clx9agent01' },
            inflect: {
                baseUrl: 'https://app.acme.example',
                tenantSlug: 'acme',
                apiKeyEnv: SCANNER_KEY_ENV.agentReport,
                agentRulesApiKeyEnv: SCANNER_KEY_ENV.agentRules,
            },
        });
    });

    it('reading the register adds the source and the agent report\'s variable', () => {
        const block = scannerConfigBlock({ ...base, sel: { ...NONE, integrations: true, readRegister: true } });
        expect(block.sources).toEqual([{ kind: 'inflect-register' }]);
        expect(block.inflect).toMatchObject({
            apiKeyEnv: SCANNER_KEY_ENV.agentReport,
            integrationsApiKeyEnv: SCANNER_KEY_ENV.integrations,
        });
    });

    it('satisfies scanent 0.17.0\'s rules for every selection', () => {
        for (const sel of ALL_SELECTIONS.filter(postsAnyReport)) {
            const block = scannerConfigBlock({ ...base, sel });
            const inflect = block.inflect as Record<string, string>;
            expect(SCANENT_AGENT_ID.test((block.scanner as { agentId: string }).agentId)).toBe(true);
            expect(SCANENT_SLUG.test(inflect.tenantSlug)).toBe(true);
            expect(new URL(inflect.baseUrl).origin).toBe(inflect.baseUrl);
            const names = [inflect.apiKeyEnv, inflect.integrationsApiKeyEnv, inflect.agentRulesApiKeyEnv].filter(
                (n): n is string => n !== undefined,
            );
            // 0.17.0 refuses one variable name for two reports.
            expect(new Set(names).size).toBe(names.length);
            // The register read and the agent report post with apiKeyEnv.
            if (sel.agentReport || sel.readRegister) expect(inflect.apiKeyEnv).toBe(SCANNER_KEY_ENV.agentReport);
            else expect(inflect.apiKeyEnv).toBeUndefined();
        }
    });
});

describe('which agent can be connected', () => {
    const agent = { id: 'a', name: 'Scanner', status: 'ACTIVE', autonomyLevel: 1, aiSystemClassified: true, riskScored: true };

    it('an ACTIVE agent can carry a key', () => {
        expect(scannerAgentBlock(agent)).toBeNull();
    });

    it('anything else names what activation asks for first', () => {
        expect(scannerAgentBlock({ ...agent, status: 'DRAFT', aiSystemClassified: false, riskScored: false })).toBe('unclassified');
        expect(scannerAgentBlock({ ...agent, status: 'DRAFT', riskScored: false })).toBe('unscored');
        expect(scannerAgentBlock({ ...agent, status: 'SUSPENDED' })).toBe('notActive');
    });
});
