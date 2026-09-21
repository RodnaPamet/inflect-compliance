/**
 * Observability & reliability capstone — the meta-ratchet.
 *
 * Two remediations hardened the backend's runtime-reliability
 * surface:
 *
 *   1. Audit-stream observability — delivery failures became real
 *      OTel metrics instead of an in-memory counter
 *      (`audit-stream-observability.test.ts`).
 *   2. Redis eviction policy — BullMQ-bearing Redis must run
 *      `noeviction`, not a key-evicting policy
 *      (`redis-eviction-policy.test.ts`).
 *
 * Each shipped its own structural guardrail. THIS test guards the
 * guards: it fails CI if either guardrail file is deleted or gutted
 * to a no-op, and it locks the runtime wiring both remediations
 * depend on. A contributor who removes one must reckon with a red
 * meta-ratchet, not a silently weakened backend.
 *
 * Sibling of `ci-pipeline-integrity.test.ts` (the CI/CD-pipeline
 * capstone) — same "guard the guards" pattern, a different domain.
 *
 * See docs/observability-reliability.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read below is
// TypeScript/TSX, re-derived in this file rather than assumed from the paths.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The reliability guardrail registry. Each entry must exist, still
 * contain its subject anchors (proof it was not gutted), and carry a
 * real assertion surface. Retiring a remediation means deleting its
 * guardrail AND its entry here in the same diff — the design
 * conversation, made explicit.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/audit-stream-observability.test.ts',
        pillar: 'audit-stream delivery observability',
        anchors: ['recordAuditStreamDelivery', 'audit_stream.delivery', '_deliveryFailureCount'],
    },
    {
        file: 'tests/guards/redis-eviction-policy.test.ts',
        pillar: 'Redis eviction policy (BullMQ durability)',
        anchors: ['noeviction', 'verifyRedisEvictionPolicy'],
    },
    {
        file: 'tests/guards/redis-production-auth.test.ts',
        pillar: 'Redis production authentication (requirepass)',
        anchors: ['requirepass', 'REDIS_PASSWORD'],
    },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('observability & reliability — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors }) => {
        it('the guardrail file exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the guardrail still references its subject (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        it('the guardrail carries a real assertion surface (>= 3 it-blocks)', () => {
            expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
        });
    });

    it('the registry is complete (3 reliability guardrails, distinct)', () => {
        expect(GUARDRAILS).toHaveLength(3);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(3);
    });
});

describe('observability & reliability — runtime wiring is intact', () => {
    it('metrics.ts exposes the audit-stream delivery recorder', () => {
        expect(read('src/lib/observability/metrics.ts')).toMatch(
            /export function recordAuditStreamDelivery/,
        );
    });

    it('audit-stream.ts calls the OTel recorder in its delivery path', () => {
        expect(read('src/app-layer/events/audit-stream.ts')).toMatch(
            /recordAuditStreamDelivery\(/,
        );
    });

    it('redis.ts exposes the eviction-policy startup check', () => {
        expect(read('src/lib/redis.ts')).toMatch(
            /export async function verifyRedisEvictionPolicy/,
        );
    });

    it('instrumentation.ts runs the Redis eviction-policy check at startup', () => {
        expect(read('src/instrumentation.ts')).toMatch(/verifyRedisEvictionPolicy\(/);
    });

    it('the unified observability-reliability doc exists', () => {
        expect(exists('docs/observability-reliability.md')).toBe(true);
    });
});
