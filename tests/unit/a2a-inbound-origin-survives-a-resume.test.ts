import { inboundOriginFromRow } from '@/app-layer/usecases/workflow-runs';

/**
 * THE ASSERTION #3861's OWN TEST LIST DID NOT CONTAIN.
 *
 * R17 (writes clamped to `PROPOSE_ONLY`) and R14 (no outbound A2A send) are
 * keyed on `RequestContext.a2aInbound`. A run's FIRST segment gets that flag
 * from the endpoint that started it; every later segment — a person's resume, a
 * queued Flue segment — gets it from this function, reading the run's own
 * columns back.
 *
 * So the failure mode is not a missing clamp. It is a clamp present on the
 * first segment and gone on the second: a run that starts at `PROPOSE_ONLY` and
 * resumes able to write unattended. A test that checks only the start cannot
 * see it, which is why the issue's list missed it and why this file exists.
 */

const EMPTY = {
    inboundPeerId: null,
    inboundMessageId: null,
    inboundHostConsumerId: null,
    inboundHostMessageId: null,
};

describe('a run rebuilt from its row keeps its inbound origin', () => {
    it('restores a PEER origin', () => {
        expect(
            inboundOriginFromRow({ ...EMPTY, inboundPeerId: 'p1', inboundMessageId: 'm1' }),
        ).toEqual({ kind: 'PEER', peerId: 'p1', messageId: 'm1' });
    });

    it('restores a HOST_CONSUMER origin — the arm that did not exist before', () => {
        expect(
            inboundOriginFromRow({ ...EMPTY, inboundHostConsumerId: 'hc1', inboundHostMessageId: 'm2' }),
        ).toEqual({ kind: 'HOST_CONSUMER', hostConsumerId: 'hc1', messageId: 'm2' });
    });

    it('restores NOTHING for a run nobody outside started', () => {
        expect(inboundOriginFromRow(EMPTY)).toBeUndefined();
        expect(inboundOriginFromRow(null)).toBeUndefined();
        expect(inboundOriginFromRow(undefined)).toBeUndefined();
    });

    it.each([
        ['peer id without its message', { inboundPeerId: 'p1' }],
        ['peer message without its id', { inboundMessageId: 'm1' }],
        ['host id without its message', { inboundHostConsumerId: 'hc1' }],
        ['host message without its id', { inboundHostMessageId: 'm2' }],
    ])('restores nothing from a HALF-written origin: %s', (_label, partial) => {
        // A half-written pair restoring nothing is why the database carries
        // `WorkflowRun_host_origin_is_whole` and its peer equivalent: without
        // that CHECK, a half-written row would silently un-clamp a resumed run,
        // and this function could not tell the difference.
        expect(inboundOriginFromRow({ ...EMPTY, ...partial })).toBeUndefined();
    });

    it('prefers the peer pair when a row somehow carries both', () => {
        // The database refuses this (`WorkflowRun_one_inbound_origin`), so it
        // should be unreachable. Pinned anyway because "unreachable" is a
        // property of today's constraints, and the answer must be deterministic
        // rather than whichever branch happens to be first after an edit.
        expect(
            inboundOriginFromRow({
                inboundPeerId: 'p1',
                inboundMessageId: 'm1',
                inboundHostConsumerId: 'hc1',
                inboundHostMessageId: 'm2',
            }),
        ).toEqual({ kind: 'PEER', peerId: 'p1', messageId: 'm1' });
    });

    it('narrows identically whichever arm it is — the property both R17 and R14 rest on', () => {
        // Neither consumer of this flag looks at `kind`:
        // `clampForInboundA2a(mode, Boolean(ctx.a2aInbound))` and
        // `if (ctx.a2aInbound) return []`. So the test of "narrows identically"
        // is that BOTH arms are truthy and neither is distinguishable by
        // presence. If a future change made one arm narrow less, it would have
        // to branch on `kind` — which is what the type's docblock forbids.
        const peer = inboundOriginFromRow({ ...EMPTY, inboundPeerId: 'p', inboundMessageId: 'm' });
        const host = inboundOriginFromRow({ ...EMPTY, inboundHostConsumerId: 'h', inboundHostMessageId: 'm' });
        expect(Boolean(peer)).toBe(true);
        expect(Boolean(host)).toBe(true);
        expect(peer?.messageId).toBe('m');
        expect(host?.messageId).toBe('m');
    });
});
