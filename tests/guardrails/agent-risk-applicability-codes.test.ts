/**
 * The gated ASI codes still mean what the applicability rule assumes.
 *
 * `services/agent-risk-applicability.ts` puts ASI02 out of scope for an agent
 * with no tool grants and ASI08 out of scope for an agent at autonomy 0. Both
 * gates are keyed on the CODE, and both are only defensible because of what
 * those codes mean in the shipped taxonomy: ASI02 is "Tool Misuse and
 * Exploitation" (a risk about the agent's AUTHORISED tools) and ASI08 is
 * "Cascading Failures" (a risk about damage propagating through automated
 * actions). Neither the code nor the rule is wrong on its own; the pairing is
 * the fact, and the fact belongs to OWASP, not to us.
 *
 * WHY THIS RATCHET IS NOT OPTIONAL. OWASP re-issues Top-10 lists IN PLACE, and
 * this repo pins the framework on an edition-free `ref_id` precisely so a
 * revision re-imports over the same rows rather than forking a new framework.
 * That is the right call for evidence continuity and it is exactly what makes
 * a silent renumber possible: update the catalogue, and ASI02 keeps resolving
 * while quietly naming a different risk — at which point the rule excuses the
 * wrong agents from the wrong risk and every readout still looks healthy.
 *
 * This is not hypothetical. `prisma/fixtures/agent-risk-assessment.json`'s
 * `mappings.asi` arrays are keyed to a DIFFERENT ASI edition than the shipped
 * framework (its own guidance calls ASI08 "agent supply chain" and ASI06
 * "cascading failures"), and nothing caught it because nothing compared the
 * two. That drift is cosmetic today because its only consumer renders the ids
 * as a display string. This one would not be.
 *
 * So the assertions read the SHIPPED titles out of both representations the
 * product actually installs and compare them to `GATED_RISK_TITLES`. Comparing
 * the rule's constants against constants declared beside them would pass
 * forever and guard nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadLibrary, parseLibraryFile } from '@/app-layer/libraries';
import {
    agentRiskApplicability,
    GATED_RISK_TITLES,
} from '@/app-layer/services/agent-risk-applicability';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Representation 1 — the YAML library, imported by `syncAllLibraries` into the
 * `OWASP-ASI-TOP10` framework row.
 */
const library = loadLibrary(
    parseLibraryFile(path.join(ROOT, 'src/data/libraries/owasp-agentic-top10.yaml')),
    'owasp-agentic-top10',
);

/**
 * Representation 2 — the seed CatalogFile, applied by `prisma/seed.ts` and
 * `scripts/seed-framework-catalogs.ts` into the `OWASP-ASI` framework row. A
 * tenant's controls may hang off EITHER row, which is why both are checked:
 * one of the two drifting is the same failure as both drifting.
 */
const catalogue = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'prisma/fixtures/owasp-asi-control-templates.json'), 'utf8'),
) as { requirements: Array<{ code: string; title: string }> };

const GATED_CODES = Object.keys(GATED_RISK_TITLES) as Array<keyof typeof GATED_RISK_TITLES>;

describe('the gated ASI codes still carry the titles the applicability rule assumes', () => {
    it.each(GATED_CODES)('%s carries its expected title in the YAML library', (code) => {
        const node = library.framework.nodesByRefId.get(code);
        // Assert presence separately: a code that vanished from the catalogue
        // would make a bare title comparison pass vacuously against undefined.
        expect(node).toBeDefined();
        expect(node!.name).toBe(GATED_RISK_TITLES[code]);
    });

    it.each(GATED_CODES)('%s carries its expected title in the seed catalogue', (code) => {
        const row = catalogue.requirements.find((r) => r.code === code);
        expect(row).toBeDefined();
        expect(row!.title).toBe(GATED_RISK_TITLES[code]);
    });

    it('names every code the rule actually gates, and no others', () => {
        // The other half of the ratchet. The two constants above are only
        // meaningful if they describe what the rule DOES, so drive the rule
        // with the least-exposed profile a real agent can have and read back
        // which codes it excuses. Add a third gate without adding it to
        // GATED_RISK_TITLES and this fails — as it should, because that gate
        // would carry an unguarded editorial dependency.
        // `registrationEnforced: true` because this probe asks which codes the
        // rule CAN excuse — the ASI02 exemption is conditional on the register
        // being enforced, and a probe with it false would report ASI02 as
        // ungated and make this ratchet disagree with GATED_RISK_TITLES for a
        // reason that has nothing to do with the editorial drift it guards.
        const bare = {
            autonomyLevel: 0,
            toolGrantCount: 0,
            isLegacyPlaceholder: false,
            registrationEnforced: true,
        };
        const gated = library.framework.nodes
            .filter((n) => n.assessable)
            .map((n) => n.refId)
            .filter((code) => !agentRiskApplicability(code, bare).applicable);

        expect(gated.sort()).toEqual([...GATED_CODES].sort());
    });
});
