/**
 * A finding's provenance (`sourceKind` / `sourceRef`) is how a system
 * materializer finds the finding it raised, and it dedupes on the pair. So the
 * HTTP create body carries none: a body that sends them has them stripped,
 * whichever route parses it. A FINDING agent proposal keeps them, because the
 * auditor's procedures and a dissenting workpaper review raise their findings
 * as proposals that a person approves.
 */
import { CreateFindingSchema, ProposedFindingSchema } from '@/lib/schemas';

const BODY = {
    severity: 'LOW',
    type: 'NONCONFORMITY',
    title: 'housekeeping',
    sourceKind: 'AGENT_HARNESS',
    sourceRef: 'SHADOW_AGENT:entra:sp:00000000-0000-0000-0000-000000000000',
};

describe('finding provenance', () => {
    it('the HTTP create schema strips sourceKind and sourceRef', () => {
        const parsed = CreateFindingSchema.parse(BODY) as Record<string, unknown>;
        expect(parsed.title).toBe('housekeeping');
        expect('sourceKind' in parsed).toBe(false);
        expect('sourceRef' in parsed).toBe(false);
    });

    it('the HTTP create schema does not declare them, so the published contract does not either', () => {
        expect(Object.keys(CreateFindingSchema.shape)).not.toContain('sourceKind');
        expect(Object.keys(CreateFindingSchema.shape)).not.toContain('sourceRef');
    });

    it('a FINDING proposal keeps them', () => {
        const parsed = ProposedFindingSchema.parse({ ...BODY, sourceKind: 'AUDIT_PROCEDURE', sourceRef: 'p1:2026-Q4:u1:E1' });
        expect(parsed.sourceKind).toBe('AUDIT_PROCEDURE');
        expect(parsed.sourceRef).toBe('p1:2026-Q4:u1:E1');
    });
});
