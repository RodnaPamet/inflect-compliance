/**
 * A key that requires the exchange is refused at `/api/mcp` when presented
 * directly, and admitted through an exchanged token (#5004).
 *
 * `completeMcpAuthentication` is the REAL function. The registration gate is
 * mocked to throw a sentinel, so "the request went on past the new check" is
 * visible as that sentinel; the audit writer is mocked so the refusal's row can
 * be read.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => undefined),
    }),
);

class PastTheCheck extends Error {}
jest.mock('@/lib/agentic/agent-registration-gate', () => ({
    ...jest.requireActual('@/lib/agentic/agent-registration-gate'),
    assertRegisteredAgent: jest.fn(async () => {
        throw new PastTheCheck('reached the registration gate');
    }),
}));

import { appendAuditEntry } from '@/lib/audit';
import { assertRegisteredAgent } from '@/lib/agentic/agent-registration-gate';
import {
    assertRunStartNotByExchangeOnlyKey,
    completeMcpAuthentication,
    type VerifiedMcpCredential,
} from '@/lib/mcp/auth';
import { systemClock } from '@/lib/mcp/token-exchange';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';

function verified(opts: { requiresExchange: boolean; audience: readonly string[] | null }): VerifiedMcpCredential {
    const keyCtx = {
        ...makeRequestContext('ADMIN'),
        apiKeyId: 'key_1',
        apiKeyScopes: ['mcp:read'],
        agentId: 'agent_1',
        ...(opts.requiresExchange ? { apiKeyRequiresTokenExchange: true } : {}),
    };
    return {
        keyCtx,
        audience: opts.audience,
        tokenExpiresAt: opts.audience === null ? null : new Date(Date.now() + 60_000),
        now: systemClock,
        surface: { method: 'POST', path: '/api/mcp' },
    };
}

beforeEach(() => jest.clearAllMocks());

describe('a key that requires the exchange', () => {
    it('is refused presented directly, with one AUTHZ_DENIED row, before the registration gate', async () => {
        await expect(completeMcpAuthentication(verified({ requiresExchange: true, audience: null }))).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining('POST /api/mcp/token'),
        });
        expect(assertRegisteredAgent).not.toHaveBeenCalled();
        expect(appendAuditEntry).toHaveBeenCalledTimes(1);
        expect(appendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'AUTHZ_DENIED',
                entity: 'TenantApiKey',
                entityId: 'key_1',
                detailsJson: expect.objectContaining({ gate: 'token_exchange_required', reason: 'TOKEN_EXCHANGE_REQUIRED' }),
            }),
        );
    });

    it('is admitted past the check through an exchanged token', async () => {
        await expect(
            completeMcpAuthentication(verified({ requiresExchange: true, audience: ['get_harness_register'] })),
        ).rejects.toBeInstanceOf(PastTheCheck);
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });
});

describe('a key that does not require the exchange', () => {
    it('is not refused presented directly', async () => {
        await expect(completeMcpAuthentication(verified({ requiresExchange: false, audience: null }))).rejects.toBeInstanceOf(
            PastTheCheck,
        );
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });
});

describe('starting an agent run', () => {
    // A run's tool calls carry no audience, so the engine would be the way
    // around the requirement. Refused before the definition is read or the row
    // exists: the refusal reads nothing from the database.
    const orchestratingKey = (requiresExchange: boolean) => ({
        ...makeRequestContext('ADMIN'),
        apiKeyId: 'key_1',
        apiKeyScopes: ['mcp:*'],
        agentId: 'agent_1',
        ...(requiresExchange ? { apiKeyRequiresTokenExchange: true } : {}),
    });

    it('is refused for a key that requires the exchange, with one AUTHZ_DENIED row', async () => {
        await expect(startWorkflowRun(orchestratingKey(true), 'any-workflow', {})).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining('an agent run'),
        });
        expect(appendAuditEntry).toHaveBeenCalledTimes(1);
        expect(appendAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'AUTHZ_DENIED',
                detailsJson: expect.objectContaining({ gate: 'token_exchange_required', path: 'agent run any-workflow' }),
            }),
        );
    });

    it('lets any other key through the check', async () => {
        await expect(
            assertRunStartNotByExchangeOnlyKey(orchestratingKey(false), { method: 'POST', path: 'agent run x' }),
        ).resolves.toBeUndefined();
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });
});

describe('creating a key that requires the exchange', () => {
    it('is refused without an MCP scope, before anything is written', async () => {
        await expect(
            createApiKey(makeRequestContext('ADMIN'), {
                name: 'ci',
                scopes: ['controls:read'],
                requiresTokenExchange: true,
            }),
        ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('needs an MCP scope') });
    });
});
