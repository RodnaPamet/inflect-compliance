/**
 * WHY THE INGEST MUST SHIP BEFORE ANY SCANNER EMITS `H3.egress_enforced` (#3944).
 *
 * This suite exists to write a deploy order down where someone reordering the
 * work will meet it, and to make the reason EXECUTABLE rather than a comment.
 *
 * Criterion ids are not frozen per contract version. `HarnessVerdictSchema`
 * checks each verdict's criterion with `isHarnessCriterionId` against the LIVE
 * ladder, so a new criterion needs no `/4`. That is convenient and it is the
 * hazard: a scanner emitting an id the ingest does not define yet does not lose
 * that verdict — IT LOSES THE WHOLE REPORT. Every agent in it, every source,
 * every other verdict, refused together on one unknown string.
 *
 * Clients update scanner images on their own schedule, so a scanner carrying a
 * criterion can reach an older ingest at any time. The order is therefore: the
 * ingest that defines the criterion ships first, and only then may a scanner
 * image emit it.
 *
 * The test drives the refusal with a criterion the ladder does NOT define,
 * which is exactly the state an older ingest is in with respect to a newer one.
 * It asserts the BLAST RADIUS, not just the refusal: the valid agents in the
 * same report are refused with it.
 */
import { generateKeyPairSync, sign } from 'crypto';

import {
    ALL_HARNESS_CRITERIA,
    isHarnessCriterionId,
    type CriterionVerdict,
} from '@/lib/agentic/harness-ladder';
import {
    harnessSignedMessage,
    verifyAndParseHarnessReport,
    type HarnessReportBodyV3,
} from '@/lib/agentic/harness-contract';
import { validV3ReportBody, validV3ReportBodyWithSandbox } from '../../helpers/agent-harness-fake-scanner';

/** A signer whose key the verifier is told to trust. */
function signer(): { publicKeyHex: string; serialise: (body: unknown) => string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    return {
        publicKeyHex,
        serialise: (body) =>
            JSON.stringify({
                ...(body as object),
                signature: {
                    alg: 'ed25519',
                    signerKey: publicKeyHex,
                    sig: sign(null, harnessSignedMessage(body), privateKey).toString('hex'),
                },
            }),
    };
}

/** The report with one verdict's criterion replaced, wherever it appears first. */
function withCriterion(body: HarnessReportBodyV3, criterion: string): HarnessReportBodyV3 {
    let swapped = false;
    return {
        ...body,
        agents: body.agents.map((a) => {
            if (swapped || a.verdicts.length === 0) return a;
            swapped = true;
            return {
                ...a,
                verdicts: [{ ...a.verdicts[0], criterion } as CriterionVerdict, ...a.verdicts.slice(1)],
            };
        }),
    } as HarnessReportBodyV3;
}

describe('a criterion the ladder does not define refuses the WHOLE report', () => {
    const s = signer();
    const verify = (body: unknown) => verifyAndParseHarnessReport(s.serialise(body), [s.publicKeyHex]);

    it('the control: the same report without the unknown criterion is accepted', () => {
        // Without this, every assertion below is satisfied by a fixture that was
        // already invalid for an unrelated reason.
        expect(verify(validV3ReportBody())).toMatchObject({ ok: true });
        expect(verify(validV3ReportBodyWithSandbox())).toMatchObject({ ok: true });
    });

    it.each([
        ['a plausible near-miss of a real id', 'H3.egress_enforced_v2'],
        ['a criterion from a rung that does not exist', 'H9.made_up'],
        ['an id that is not shaped like one at all', 'not-a-criterion'],
    ])('%s is refused', (_label, criterion) => {
        expect(isHarnessCriterionId(criterion)).toBe(false);
        expect(verify(withCriterion(validV3ReportBody(), criterion))).toMatchObject({ ok: false });
    });

    it('THE BLAST RADIUS: the agents that were valid are refused along with it', () => {
        const good = validV3ReportBody();
        const accepted = verify(good);
        expect(accepted).toMatchObject({ ok: true });
        /*
            Establish there was something to lose, DERIVED rather than indexed.
            The first version asserted on `agents[1]`, which is the shadow agent
            and carries no verdicts — so it failed on the fixture's shape rather
            than on the property. `withCriterion` spoils the first agent that
            HAS verdicts, so the bystander is the next one that does.
        */
        const withVerdicts = good.agents.filter((a) => a.verdicts.length > 0);
        expect(withVerdicts.length).toBeGreaterThan(1);
        const bystander = withVerdicts[1];
        for (const v of bystander.verdicts) expect(isHarnessCriterionId(v.criterion)).toBe(true);

        const spoiled = verify(withCriterion(good, 'H3.egress_enforced_v2'));
        expect(spoiled).toMatchObject({ ok: false });
        // Nothing partial came back: no agents, no sources, no salvage.
        expect(spoiled).not.toHaveProperty('report');
        expect(spoiled).not.toHaveProperty('agents');
    });

    it('and the same is true of a sandbox report, which is the one that carries the new id', () => {
        const sandboxed = validV3ReportBodyWithSandbox();
        expect(verify(sandboxed)).toMatchObject({ ok: true });
        expect(verify(withCriterion(sandboxed, 'H3.egress_enforced_v2'))).toMatchObject({ ok: false });
    });
});

describe('the criterion this order was written for is now defined', () => {
    it('H3.egress_enforced is live, so a scanner may emit it', () => {
        // The precondition the deploy order exists to protect. Once this is
        // true on the ingest a client posts to, a scanner image carrying the id
        // is safe. It went live in phase 2.1.
        expect(isHarnessCriterionId('H3.egress_enforced')).toBe(true);
        expect(ALL_HARNESS_CRITERIA).toContain('H3.egress_enforced');
    });

    it('the other three the OpenShell source emits are live too', () => {
        for (const c of ['H2.tools_allowlisted', 'H3.payloads_guarded', 'H2.credential_bound']) {
            expect(isHarnessCriterionId(c)).toBe(true);
        }
    });
});
