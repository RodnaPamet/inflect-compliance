/**
 * Coverage wave E batch 2 — `src/app-layer/ai/vendor-doc/index.ts`.
 *
 * Extraction of structured facts from a vendor attestation. Two contracts
 * matter more than the happy path:
 *
 *   • the PRIVACY BOUNDARY — `sanitizeDocText` runs before any text reaches
 *     the model, so email/phone redaction and the length cap are asserted
 *     directly. A leak here sends customer PII to a third-party provider.
 *   • GRACEFUL DEGRADATION — no key, network error, malformed JSON, or a
 *     schema mismatch must all yield the empty OTHER extraction with
 *     `ok: false`, never a throw into the caller.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    sanitizeDocText,
    extractDocument,
    DocExtractionSchema,
} from '@/app-layer/ai/vendor-doc';

const fetchMock = jest.fn();

const VALID = {
    reportType: 'SOC2_TYPE2',
    auditPeriodStart: '2026-01-01',
    auditPeriodEnd: '2026-12-31',
    scope: 'Production environment',
    auditor: 'Example LLP',
    trustServiceCriteria: ['CC6.1'],
    controls: [{ ref: 'CC6.1', description: 'Access control', result: 'IN_PLACE' }],
    exceptions: [{ control: 'CC7.2', description: 'One lapse' }],
};

const chatOk = (content: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
});

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

describe('sanitizeDocText — privacy boundary', () => {
    it('redacts email addresses', () => {
        expect(sanitizeDocText('contact ada@acme.co.uk today')).toBe(
            'contact [email] today',
        );
    });

    it('redacts phone numbers in several shapes', () => {
        expect(sanitizeDocText('call +1 (555) 123-4567 now')).toContain('[phone]');
        expect(sanitizeDocText('call 555-123-4567 now')).toContain('[phone]');
    });

    it('strips control characters', () => {
        expect(sanitizeDocText('a\x00b\x07c\x1Fd')).toBe('abcd');
    });

    it('preserves newlines and tabs while collapsing runs of spaces', () => {
        expect(sanitizeDocText('a   \t  b')).toBe('a b');
        expect(sanitizeDocText('a\nb')).toBe('a\nb');
    });

    it('collapses three or more blank lines to two', () => {
        expect(sanitizeDocText('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('trims surrounding whitespace', () => {
        expect(sanitizeDocText('   padded   ')).toBe('padded');
    });

    it('caps the length, with an overridable maximum', () => {
        expect(sanitizeDocText('x'.repeat(100_000))).toHaveLength(60_000);
        expect(sanitizeDocText('x'.repeat(500), 100)).toHaveLength(100);
    });

    it('handles an empty document', () => {
        expect(sanitizeDocText('')).toBe('');
    });
});

describe('DocExtractionSchema', () => {
    it('accepts a fully-populated extraction', () => {
        expect(DocExtractionSchema.safeParse(VALID).success).toBe(true);
    });

    it('defaults the collection fields when absent', () => {
        const parsed = DocExtractionSchema.parse({ reportType: 'OTHER' });
        expect(parsed.trustServiceCriteria).toEqual([]);
        expect(parsed.controls).toEqual([]);
        expect(parsed.exceptions).toEqual([]);
    });

    it('defaults a control result and description', () => {
        const parsed = DocExtractionSchema.parse({
            reportType: 'ISO27001',
            controls: [{ ref: 'A.5.1' }],
        });
        expect(parsed.controls[0].result).toBe('IN_PLACE');
        expect(parsed.controls[0].description).toBe('');
    });

    it('rejects an unknown reportType', () => {
        expect(
            DocExtractionSchema.safeParse({ ...VALID, reportType: 'MYSTERY' }).success,
        ).toBe(false);
    });

    it('rejects an unknown control result', () => {
        expect(
            DocExtractionSchema.safeParse({
                reportType: 'OTHER',
                controls: [{ ref: 'x', result: 'MAYBE' }],
            }).success,
        ).toBe(false);
    });

    it('enforces the length caps', () => {
        expect(
            DocExtractionSchema.safeParse({
                reportType: 'OTHER',
                controls: [{ ref: 'x'.repeat(61) }],
            }).success,
        ).toBe(false);
        expect(
            DocExtractionSchema.safeParse({
                reportType: 'OTHER',
                scope: 'x'.repeat(2001),
            }).success,
        ).toBe(false);
    });

    it('allows the nullable period fields to be null', () => {
        expect(
            DocExtractionSchema.safeParse({
                reportType: 'PENTEST',
                auditPeriodStart: null,
                auditPeriodEnd: null,
                scope: null,
                auditor: null,
            }).success,
        ).toBe(true);
    });
});

describe('extractDocument — provider gating', () => {
    it('returns the deterministic stub when no provider is configured', async () => {
        const res = await extractDocument('doc');
        expect(res).toEqual({
            ok: true,
            provider: 'stub',
            model: null,
            data: expect.objectContaining({ reportType: 'OTHER' }),
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the stub when the provider is set but the key is missing', async () => {
        mockEnv.AI_RISK_PROVIDER = 'openrouter';
        expect((await extractDocument('doc')).provider).toBe('stub');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the stub for a different provider even with a key present', async () => {
        mockEnv.AI_RISK_PROVIDER = 'anthropic';
        mockEnv.OPENROUTER_API_KEY = 'or-key';
        expect((await extractDocument('doc')).provider).toBe('stub');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is case-insensitive on the provider name', async () => {
        mockEnv.AI_RISK_PROVIDER = 'OpenRouter';
        mockEnv.OPENROUTER_API_KEY = 'or-key';
        fetchMock.mockResolvedValueOnce(chatOk(JSON.stringify(VALID)));
        expect((await extractDocument('doc')).provider).toBe('openrouter');
    });
});

describe('extractDocument — live path', () => {
    beforeEach(() => {
        mockEnv.AI_RISK_PROVIDER = 'openrouter';
        mockEnv.OPENROUTER_API_KEY = 'or-key';
    });

    it('POSTs the chat-completions endpoint with the document in the user turn', async () => {
        fetchMock.mockResolvedValueOnce(chatOk(JSON.stringify(VALID)));

        await extractDocument('SOC 2 report body');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer or-key');
        const body = JSON.parse(init.body);
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0].role).toBe('system');
        expect(body.messages[1].content).toContain('SOC 2 report body');
        expect(body.response_format).toEqual({ type: 'json_object' });
        expect(body.max_tokens).toBe(4096);
    });

    it('uses the default model, and honours an override', async () => {
        fetchMock.mockResolvedValueOnce(chatOk(JSON.stringify(VALID)));
        expect((await extractDocument('doc')).model).toBe(
            'anthropic/claude-3.5-sonnet-20241022',
        );

        mockEnv.OPENROUTER_MODEL = 'some/other-model';
        fetchMock.mockResolvedValueOnce(chatOk(JSON.stringify(VALID)));
        expect((await extractDocument('doc')).model).toBe('some/other-model');
    });

    it('returns the validated extraction on success', async () => {
        fetchMock.mockResolvedValueOnce(chatOk(JSON.stringify(VALID)));

        const res = await extractDocument('doc');

        expect(res.ok).toBe(true);
        expect(res.provider).toBe('openrouter');
        expect(res.data.reportType).toBe('SOC2_TYPE2');
        expect(res.data.controls).toHaveLength(1);
        expect(res.data.exceptions[0].control).toBe('CC7.2');
    });
});

describe('extractDocument — graceful degradation', () => {
    beforeEach(() => {
        mockEnv.AI_RISK_PROVIDER = 'openrouter';
        mockEnv.OPENROUTER_API_KEY = 'or-key';
    });

    const expectEmptyFailure = (res: Awaited<ReturnType<typeof extractDocument>>) => {
        expect(res.ok).toBe(false);
        expect(res.provider).toBe('openrouter');
        expect(res.data.reportType).toBe('OTHER');
        expect(res.data.controls).toEqual([]);
        expect(res.data.exceptions).toEqual([]);
    };

    it('degrades on a non-2xx response', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
        const res = await extractDocument('doc');
        expectEmptyFailure(res);
        expect(res.error).toBe('OpenRouter 429');
    });

    it('degrades when the response carries no content', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ choices: [] }),
        });
        const res = await extractDocument('doc');
        expectEmptyFailure(res);
        expect(res.error).toBe('empty content');
    });

    it('degrades on unparseable JSON', async () => {
        fetchMock.mockResolvedValueOnce(chatOk('not json at all'));
        expectEmptyFailure(await extractDocument('doc'));
    });

    it('degrades with a distinct error when the shape fails validation', async () => {
        fetchMock.mockResolvedValueOnce(
            chatOk(JSON.stringify({ reportType: 'NOT_A_REAL_TYPE' })),
        );
        const res = await extractDocument('doc');
        expectEmptyFailure(res);
        expect(res.error).toBe('schema_validation_failed');
    });

    it('degrades on a network throw', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
        const res = await extractDocument('doc');
        expectEmptyFailure(res);
        expect(res.error).toBe('ECONNRESET');
    });

    it('labels a non-Error throw as unknown', async () => {
        fetchMock.mockRejectedValueOnce('bare string');
        expect((await extractDocument('doc')).error).toBe('unknown');
    });
});
