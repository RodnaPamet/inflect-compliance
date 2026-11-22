/**
 * The propose result the engines skip the injection scan for is Inflect's own
 * structure, and nothing else (#5548).
 *
 * `runGuardedTool` does not run `guardUntrustedInput` on a propose result: the
 * text is built entirely by `runProposeTool` — counts, proposal ids, the kind
 * and a fixed sentence — so it holds nothing to steer the model with. Scanning
 * it was a false positive on our own structure, recorded below: its
 * `"quarantined": 0` key matches the injection rule `refusal_vocabulary`, so
 * under BALANCED every engine propose call tripped the review latch.
 *
 * The exemption is only safe while the result stays ours, so its field set is
 * pinned here. Adding a field means editing this list and saying why the new
 * field cannot carry tenant- or model-authored text.
 */
import { scanInjection } from '@/app-layer/ai/guard/injection-scanner';
import { PROPOSE_RESULT_FIELDS } from '@/lib/mcp/tools/propose-tools';

describe('the propose result is our own structure (#5548)', () => {
    it('carries exactly these fields: counts, ids, the kind and a fixed sentence', () => {
        expect([...PROPOSE_RESULT_FIELDS]).toEqual([
            'proposed',
            'quarantined',
            'kind',
            'proposalIds',
            'quarantinedProposalIds',
            'message',
        ]);
    });

    it('the root cause: a clean propose result matches the injection scan on its own key', () => {
        // Why the scan is skipped rather than its finding trusted: this is the
        // exact shape `runProposeTool` returns for a clean, unquarantined call.
        const clean = JSON.stringify(
            {
                proposed: 1,
                quarantined: 0,
                kind: 'RISK',
                proposalIds: ['p1'],
                quarantinedProposalIds: [],
                message: 'Proposed 1 risk(s), pending human approval. Nothing was created.',
            },
            null,
            2,
        );
        const scan = scanInjection(clean);
        expect(scan.ruleIds).toContain('inj.answer_steering.refusal_vocabulary');
        expect(scan.maxSeverity).toBe('high');
    });
});
