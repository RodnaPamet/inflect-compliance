/**
 * AI-System Registry usecase unit tests — classification-driven registration
 * and propose-not-commit conformity drafting (with mocked persistence).
 */
const mockFindPendingDraft = jest.fn().mockResolvedValue(null);
const mockFindDrafts = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            // #4777 — conformity drafts are read back by their origin ref.
            agentProposal: {
                findFirst: (...a: unknown[]) => mockFindPendingDraft(...a),
                findMany: (...a: unknown[]) => mockFindDrafts(...a),
            },
            // The global Framework/FrameworkRequirement catalog is read via the
            // tenant-bound `db` (the tables have no RLS).
            framework: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'fw-eu', key: 'EU-AI-ACT' },
                    { id: 'fw-iso', key: 'ISO42001' },
                ]),
            },
            frameworkRequirement: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'req-art9', code: 'Art.9', frameworkId: 'fw-eu' },
                ]),
            },
        }),
    ),
}));

const mockCreate = jest.fn().mockResolvedValue({ id: 'ai-1', riskTier: 'HIGH', classificationClauseId: 'Annex III(4)' });
const mockLink = jest.fn().mockResolvedValue(1);
const mockGetById = jest.fn();
jest.mock('@/app-layer/repositories/AiSystemRepository', () => ({
    AiSystemRepository: {
        create: (...a: unknown[]) => mockCreate(...a),
        linkRequirements: (...a: unknown[]) => mockLink(...a),
        list: jest.fn().mockResolvedValue([]),
        getById: (...a: unknown[]) => mockGetById(...a),
    },
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const mockProposal = jest.fn().mockResolvedValue({ id: 'prop-1', status: 'PENDING' });
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: (...a: unknown[]) => mockProposal(...a),
}));

import { createAiSystem } from '@/app-layer/usecases/ai-system';
import { generateConformityDraft, listConformityDrafts } from '@/app-layer/usecases/ai-system-conformity';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    mockFindPendingDraft.mockResolvedValue(null);
    mockFindDrafts.mockResolvedValue([]);
});

describe('createAiSystem', () => {
    it('classifies an Annex III use-case as HIGH and links obligations', async () => {
        const result = await createAiSystem(makeRequestContext('EDITOR'), {
            name: 'Candidate screening model',
            classification: { annexIIIArea: 'employment' },
        });
        expect(result.riskTier).toBe('HIGH');
        expect(result.clauseId).toBe('Annex III(4)');
        // The persisted tier is computed here, never taken from the client.
        expect(mockCreate).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ riskTier: 'HIGH', classificationClauseId: 'Annex III(4)' }),
        );
        expect(mockLink).toHaveBeenCalled();
    });

    it('classifies nothing-triggered as MINIMAL', async () => {
        mockCreate.mockResolvedValueOnce({ id: 'ai-2', riskTier: 'MINIMAL', classificationClauseId: 'Art.95' });
        const result = await createAiSystem(makeRequestContext('EDITOR'), { name: 'Spellchecker', classification: {} });
        expect(result.riskTier).toBe('MINIMAL');
    });
});

describe('generateConformityDraft (propose-not-commit)', () => {
    it('queues a DRAFT proposal for a HIGH-risk system', async () => {
        mockGetById.mockResolvedValueOnce({
            id: 'ai-1', name: 'Screening', provider: null, deploymentRole: 'DEPLOYER',
            riskTier: 'HIGH', status: 'ACTIVE', purpose: null, useContext: null,
            classificationClauseId: 'Annex III(4)', classificationRationale: 'high',
            requirementLinks: [],
        });
        const res = await generateConformityDraft(makeRequestContext('EDITOR'), 'ai-1', {
            docType: 'ANNEX_IV_TECHNICAL_DOCUMENTATION',
        });
        expect(mockProposal).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ kind: 'POLICY' }),
        );
        expect(res.proposalId).toBe('prop-1');
    });

    it('refuses to generate for a non-HIGH system', async () => {
        mockGetById.mockResolvedValueOnce({
            id: 'ai-3', name: 'Chatbot', riskTier: 'LIMITED', requirementLinks: [],
            provider: null, deploymentRole: 'DEPLOYER', status: 'ACTIVE',
            purpose: null, useContext: null, classificationClauseId: 'Art.50(1)', classificationRationale: 'x',
        });
        await expect(
            generateConformityDraft(makeRequestContext('EDITOR'), 'ai-3', { docType: 'ANNEX_V_DECLARATION_OF_CONFORMITY' }),
        ).rejects.toThrow(/HIGH-risk/);
        expect(mockProposal).not.toHaveBeenCalled();
    });

    it('refuses an UNCLASSIFIED system as not classified, not as not-HIGH, and queues nothing', async () => {
        // A provisional entry from the registration intake (#3669): nobody has
        // classified it, so "not high-risk" would be a classification it never
        // received. It must be refused for its OWN reason.
        mockGetById.mockResolvedValueOnce({
            id: 'ai-4', name: 'Provisional entry', riskTier: 'UNCLASSIFIED', requirementLinks: [],
            provider: null, deploymentRole: 'DEPLOYER', status: 'ACTIVE',
            purpose: null, useContext: null, classificationClauseId: null, classificationRationale: null,
        });
        const err = await generateConformityDraft(makeRequestContext('EDITOR'), 'ai-4', {
            docType: 'ANNEX_IV_TECHNICAL_DOCUMENTATION',
        }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({ status: 400 });
        expect((err as Error).message).toMatch(/has not been classified against the EU AI Act/);
        expect((err as Error).message).not.toMatch(/HIGH-risk/);
        expect(mockProposal).not.toHaveBeenCalled();
    });
});

describe('conformity drafts are remembered (#4777)', () => {
    const HIGH = {
        id: 'ai-1', name: 'Screening', provider: null, deploymentRole: 'DEPLOYER',
        riskTier: 'HIGH', status: 'ACTIVE', purpose: null, useContext: null,
        classificationClauseId: 'Annex III(4)', classificationRationale: 'high',
        requirementLinks: [],
    };

    it('records where the draft came from', async () => {
        mockGetById.mockResolvedValueOnce(HIGH);
        await generateConformityDraft(makeRequestContext('EDITOR'), 'ai-1', { docType: 'ART_9_RISK_MANAGEMENT' });
        expect(mockProposal).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ proposedBySessionRef: 'ai-system-conformity:ai-1:ART_9_RISK_MANAGEMENT' }),
        );
    });

    it('refuses a second draft of a document that is still waiting for review', async () => {
        mockGetById.mockResolvedValueOnce(HIGH);
        mockFindPendingDraft.mockResolvedValueOnce({ id: 'prop-0' });
        await expect(
            generateConformityDraft(makeRequestContext('EDITOR'), 'ai-1', { docType: 'ART_9_RISK_MANAGEMENT' }),
        ).rejects.toMatchObject({ status: 409 });
        expect(mockProposal).not.toHaveBeenCalled();
    });

    it('lists the drafts of one system, naming each document', async () => {
        mockFindDrafts.mockResolvedValueOnce([
            { id: 'p1', status: 'PENDING', createdAt: new Date('2026-10-01'), proposedBySessionRef: 'ai-system-conformity:ai-1:ANNEX_IV_TECHNICAL_DOCUMENTATION' },
        ]);
        const drafts = await listConformityDrafts(makeRequestContext('READER'), 'ai-1');
        expect(drafts).toEqual([{ proposalId: 'p1', docType: 'ANNEX_IV_TECHNICAL_DOCUMENTATION', status: 'PENDING', createdAt: new Date('2026-10-01') }]);
        expect(mockFindDrafts.mock.calls[0][0].where.proposedBySessionRef).toEqual({ startsWith: 'ai-system-conformity:ai-1:' });
    });
});
