/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for src/app-layer/usecases/automation-executions.ts (Epic 6).
 *
 * Covers PII scrubbing, pagination passthrough, the read-history gate, and
 * the manual re-trigger (ENABLED guard + targeted dispatch enqueue).
 */

const mockDb = { __db: true } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/automation', () => ({
    AutomationRuleRepository: { getById: jest.fn() },
    AutomationExecutionRepository: { listForRulePaginated: jest.fn(), listForRule: jest.fn() },
    assertCanReadAutomationHistory: (ctx: any) => {
        if (!ctx.permissions.canRead && !ctx.permissions.canAudit) throw new Error('forbidden:history');
    },
    assertCanExecuteAutomation: (ctx: any) => {
        if (!ctx.permissions.canWrite) throw new Error('forbidden:execute');
    },
}));

jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
// reTriggerRule now emits an audit event (the attribution gap it had). Without
// this mock the real writer runs and reaches for the database.
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

import { listRuleExecutions, reTriggerRule } from '@/app-layer/usecases/automation-executions';
import { AutomationRuleRepository, AutomationExecutionRepository } from '@/app-layer/automation';
import { enqueue } from '@/app-layer/jobs/queue';
import { makeRequestContext } from '../helpers/make-context';

const ruleRepo = AutomationRuleRepository as jest.Mocked<typeof AutomationRuleRepository>;
const execRepo = AutomationExecutionRepository as jest.Mocked<typeof AutomationExecutionRepository>;
const enqueueMock = enqueue as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('listRuleExecutions', () => {
    it('scrubs PII-blocklisted payload keys + passes through the cursor', async () => {
        execRepo.listForRulePaginated.mockResolvedValue({
            items: [
                {
                    id: 'e1',
                    ruleId: 'r1',
                    triggerEvent: 'RISK_CREATED',
                    status: 'SUCCEEDED',
                    triggeredBy: 'event',
                    durationMs: 12,
                    errorMessage: null,
                    outcomeJson: null,
                    triggerPayloadJson: { title: 'X', ownerEmail: 'a@b.com', apiKey: 'sk-1' },
                    createdAt: new Date(),
                    completedAt: new Date(),
                } as any,
            ],
            nextCursor: 'e1',
        });
        const ctx = makeRequestContext('ADMIN');
        const out = await listRuleExecutions(ctx, 'r1', { limit: 10 });
        expect(out.nextCursor).toBe('e1');
        expect(out.items[0].triggerPayload.title).toBe('X');
        expect(out.items[0].triggerPayload.ownerEmail).toBe('[redacted]');
        expect(out.items[0].triggerPayload.apiKey).toBe('[redacted]');
    });

    it('rejects a caller without read or audit', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: { canRead: false, canAudit: false } as any,
        });
        await expect(listRuleExecutions(ctx, 'r1')).rejects.toThrow('forbidden:history');
    });
});

describe('reTriggerRule', () => {
    it('enqueues a targeted manual dispatch for an ENABLED rule', async () => {
        ruleRepo.getById.mockResolvedValue({ id: 'r1', status: 'ENABLED', triggerEvent: 'RISK_CREATED' } as any);
        execRepo.listForRule.mockResolvedValue([{ triggerPayloadJson: { severity: 'HIGH' } }] as any);
        const ctx = makeRequestContext('EDITOR');
        const out = await reTriggerRule(ctx, 'r1');
        expect(out.enqueued).toBe(true);
        expect(enqueueMock).toHaveBeenCalledWith(
            'automation-event-dispatch',
            expect.objectContaining({
                targetRuleId: 'r1',
                triggeredBy: 'manual',
                event: expect.objectContaining({ event: 'RISK_CREATED', data: { severity: 'HIGH' } }),
            }),
        );
    });

    it('refuses to re-trigger a non-ENABLED rule', async () => {
        ruleRepo.getById.mockResolvedValue({ id: 'r1', status: 'DISABLED', triggerEvent: 'RISK_CREATED' } as any);
        const ctx = makeRequestContext('EDITOR');
        await expect(reTriggerRule(ctx, 'r1')).rejects.toThrow(/ENABLED/i);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('throws notFound when the rule is missing', async () => {
        ruleRepo.getById.mockResolvedValue(null as any);
        const ctx = makeRequestContext('EDITOR');
        await expect(reTriggerRule(ctx, 'gone')).rejects.toThrow(/not found/i);
    });

    it('reports a no-op (does NOT enqueue) when there is no prior execution to replay', async () => {
        // PR-E honesty — replaying a rule that never ran would enqueue an
        // empty-payload dispatch that silently no-ops. Report it instead.
        ruleRepo.getById.mockResolvedValue({ id: 'r1', status: 'ENABLED', triggerEvent: 'RISK_CREATED' } as any);
        execRepo.listForRule.mockResolvedValue([] as any);
        const ctx = makeRequestContext('EDITOR');
        const out = await reTriggerRule(ctx, 'r1');
        expect(out.enqueued).toBe(false);
        expect((out as { reason?: string }).reason).toBe('no_prior_execution');
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('refuses to replay an UPDATE_STATUS rule (entity target not replayable)', async () => {
        // Honesty — a replay carries a synthetic entityId (= ruleId) and the
        // original entityId is not persisted, so an UPDATE_STATUS action would
        // no-op ("No <entity> matched <ruleId>") while the panel said "Fired".
        // Refuse instead of enqueuing a guaranteed-FAIL execution.
        ruleRepo.getById.mockResolvedValue({
            id: 'r1',
            status: 'ENABLED',
            triggerEvent: 'RISK_CREATED',
            actionType: 'UPDATE_STATUS',
        } as any);
        execRepo.listForRule.mockResolvedValue([{ triggerPayloadJson: { severity: 'HIGH' } }] as any);
        const ctx = makeRequestContext('EDITOR');
        const out = await reTriggerRule(ctx, 'r1');
        expect(out.enqueued).toBe(false);
        expect((out as { reason?: string }).reason).toBe('entity_target_not_replayable');
        expect(enqueueMock).not.toHaveBeenCalled();
    });
});
