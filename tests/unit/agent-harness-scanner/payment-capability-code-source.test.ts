/**
 * THE `code` SOURCE REPORTS WHERE AN AGENT'S CODE CAN PAY (Agent Pay Phase 2,
 * `docs/ai-architecture/mastercard-agent-pay.md`), held to an evaluation
 * record of synthetic repositories (2.5, G11):
 *
 *   1. Every case in the record reads as the record says: each recognised
 *      library is reported at its call, an import that is never called is no
 *      capability, a lookalike and the seller side are not either, and an
 *      import hidden behind a variable makes the read INCOMPLETE rather than
 *      clean.
 *   2. The record is not empty, and names every library the contract accepts —
 *      a library the reader recognises with no case behind it is unproven.
 *   3. A code read always STATES the member, `[]` included, and the signed
 *      report verifies under `inflect-agent-harness/4` with the capability's
 *      locator and never a value.
 */
import { generateKeyPairSync } from 'crypto';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';

import { PAYMENT_CLIENT_LIBRARIES, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { writeCodeEstate } from '../../helpers/agent-harness-code-fixtures';
import { REPO_ROOT } from '../../helpers/repo-files';
import { buildReportBody, rawPublicKeyHex, signReport } from '../../../packages/agent-harness-scanner/src/report';
import type { SourceContext } from '../../../packages/agent-harness-scanner/src/source';
import { langchainCodeSource, observationOf, scanLangChainCode } from '../../../packages/agent-harness-scanner/src/sources/langchain';
import { lstat, readdir, readFile } from 'fs/promises';
import type { CodeFs } from '../../../packages/agent-harness-scanner/src/sources/code/files';

interface RecordCase {
    readonly case: string;
    readonly why: string;
    readonly files: Readonly<Record<string, string>>;
    readonly expect: {
        readonly status: 'COMPLETE' | 'INCOMPLETE';
        readonly capabilities: readonly { readonly library: string; readonly line: number }[];
    };
}

const RECORD = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tests/fixtures/agent-pay-scanner/payment-capability-record.json'), 'utf8'),
) as { readonly record: string; readonly cases: readonly RecordCase[] };

const REAL_FS: CodeFs = { lstat: (p) => lstat(p), readdir: (p) => readdir(p), readFile: (p) => readFile(p) };
const clock = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 };
const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ctxFor(): SourceContext {
    // The code source reads no network; every wire is absent on purpose.
    return { asOf: new Date('2026-11-12T00:00:00Z'), deadline: clock.deadline, now: clock.now } as unknown as SourceContext;
}

async function readCase(c: RecordCase) {
    const dir = writeCodeEstate(c.files);
    dirs.push(dir);
    const root = { label: 'shopco', path: dir };
    const scan = await scanLangChainCode([root], REAL_FS, clock);
    const read = await langchainCodeSource({ roots: [root], fs: REAL_FS }).read(ctxFor());
    return { scan, read };
}

describe('1. every case reads as the evaluation record says', () => {
    it.each(RECORD.cases.map((c) => [c.case, c] as const))('%s', async (_name, c) => {
        const { scan, read } = await readCase(c);
        expect(read.status).toBe(c.expect.status);
        if (c.expect.status === 'INCOMPLETE') expect(read.reason).toBe('UNPARSEABLE');
        // Each case defines exactly one agent; its capabilities are the file's.
        expect(scan.agents).toHaveLength(1);
        const reported = observationOf(scan.agents[0]).paymentCapabilities;
        expect(reported).toBeDefined();
        const path = Object.keys(c.files)[0];
        expect(reported).toEqual(
            c.expect.capabilities.map((e) => ({
                protocol: 'x402',
                library: e.library,
                at: `code://shopco/${path}#L${e.line}`,
            })),
        );
    });
});

describe('2. the record is a population, not a sample of one', () => {
    it('is non-empty, and every library the contract accepts has a case that reports it', () => {
        expect(RECORD.record).toBe('agent-pay-payment-capability');
        expect(RECORD.cases.length).toBeGreaterThan(0);
        const proven = new Set(RECORD.cases.flatMap((c) => c.expect.capabilities.map((e) => e.library)));
        expect([...proven].sort()).toEqual([...PAYMENT_CLIENT_LIBRARIES].sort());
    });

    it('holds a case for each evasion the roadmap names: imported and never called, and an import hidden behind a variable', () => {
        const byName = new Map(RECORD.cases.map((c) => [c.case, c]));
        expect(byName.get('imports-never-calls')?.expect).toEqual({ status: 'COMPLETE', capabilities: [] });
        expect(byName.get('hidden-import-ts')?.expect.status).toBe('INCOMPLETE');
        expect(byName.get('hidden-import-python')?.expect.status).toBe('INCOMPLETE');
    });
});

describe('3. the fact crosses the wire under /4, as a locator', () => {
    it('signs a /4 report whose paying agent carries the capability and whose quiet agent carries []', async () => {
        const paying = RECORD.cases.find((c) => c.case === 'x402-fetch')!;
        const quiet = RECORD.cases.find((c) => c.case === 'imports-never-calls')!;
        const dir = writeCodeEstate(
            Object.fromEntries(Object.entries(paying.files).map(([p, s]) => [p.replace('shop/', 'paying/'), s])),
            Object.fromEntries(Object.entries(quiet.files).map(([p, s]) => [p.replace('shop/', 'quiet/'), s])),
        );
        dirs.push(dir);
        const read = await langchainCodeSource({ roots: [{ label: 'shopco', path: dir }], fs: REAL_FS }).read(ctxFor());
        expect(read.status).toBe('COMPLETE');
        const body = buildReportBody({ scanId: 'scan-pay-1', asOf: new Date('2026-11-12T00:00:00Z'), scannerAgentId: 'scanner-1' }, [read]);
        const keys = generateKeyPairSync('ed25519');
        const verdict = verifyAndParseHarnessReport(signReport(body, keys), [rawPublicKeyHex(keys.publicKey)]);
        if (!verdict.ok) throw new Error(`${verdict.reason}: ${verdict.issues?.join('; ')}`);
        expect(verdict.body.contract).toBe('inflect-agent-harness/4');
        const caps = new Map(verdict.body.agents.map((a) => [a.discoveredId, 'paymentCapabilities' in a ? a.paymentCapabilities : undefined]));
        expect(caps.get('code:shopco/paying/agent.ts#agent')).toEqual([
            { protocol: 'x402', library: 'x402-fetch', at: `code://shopco/paying/agent.ts#L${paying.expect.capabilities[0].line}` },
        ]);
        expect(caps.get('code:shopco/quiet/agent.ts#agent')).toEqual([]);
    });
});
