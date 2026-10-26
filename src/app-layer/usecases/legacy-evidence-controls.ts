/**
 * Step 5b: which controls a legacy recertification evidences.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "WHERE THE TENANT HAS THEM INSTALLED"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no tenant-framework install table. `Framework` is global, keyed by
 * `key`, and a tenant's relationship to it is `ControlRequirementLink` — which
 * IS tenant-scoped, on `(tenantId, controlId, requirementId)`, and indexed on
 * `(tenantId, requirementId)`.
 *
 * So "the tenant has SOC 2 CC6.3" means exactly: some control of theirs is
 * linked to a requirement spelling `CC6.3` under a framework row of the SOC 2
 * family. That is the question this asks, against that index.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CC6.2 AND CC6.3 — THE SUBSTITUTION THIS FILE USED TO CARRY IS RETIRED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 5b's brief names SOC 2 **CC6.2 and CC6.3**, and both now exist, so both
 * are what this asks for.
 *
 * They did not exist when 5b shipped. The catalogue carried one sub-code per
 * criterion — CC1.1, CC2.1, …, CC6.1, … — so a suggestion keyed on CC6.2
 * returned nothing, for every tenant, for ever, while looking exactly like a
 * feature that worked. The owner's decision on 2026-10-10 was to substitute
 * **CC6.1** and file the gap rather than extend the catalogue inside a
 * recertification PR, because adding requirements changes what every tenant's
 * SOC 2 framework contains.
 *
 * #3369 closed that gap: CC6 is complete at CC6.1-CC6.8, six of the eight
 * sub-codes being re-attributions of controls the catalogue already carried
 * under CC6.1. So the nearest-requirement substitution has nothing left to do
 * and is gone — the brief's own codes resolve.
 *
 * The test that asserted CC6.2 and CC6.3 were ABSENT now asserts they are
 * present and linked. That inversion is the point of having written it: it was
 * put there so the substitution would be revisited if the catalogue changed,
 * and the catalogue changed.
 *
 * ISO/IEC 27001 A.5.16 and A.5.18 and NIS2 Art. 21(2)(i) all exist.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESOLVED BY FAMILY AND SPELLING, NOT BY KEY AND CODE (#3716)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module used to ask for `framework.key = 'iso27001'` and
 * `code = 'A.5.18'`. The catalogue every environment holds seeds
 * `key = 'ISO27001'` and numbers Annex A `5.18`; NIS2 is `key = 'NIS2'` and
 * `Art.21(2)(i)`, with no space. So the suggestion matched nothing in any real
 * database, while its own test — which seeded fixture rows under the spellings
 * the module asked for — agreed with it. A suggestion that can never resolve
 * looks exactly like a tenant that mapped nothing.
 *
 * Resolution now follows `resolveEvidenceControls` in `access-review-agent.ts`
 * and `planTargetRequirements` in `agentic-evidence-emission.ts`: the FAMILY
 * (`frameworkFamilyId`, or a listed key) picks the framework rows, and
 * `requirementCodeSpellings` picks the code within them, so a tenant is matched
 * whichever representation of ISO 27001 its controls hang off.
 *
 * NIS2 is matched on its seeded representation only. The library imports the
 * same obligation as `NIS2-HR`, a different code namespace that
 * `domain/framework-representation.ts` does not reconcile, and reconciling it
 * belongs there rather than in one consumer.
 *
 * @module app-layer/usecases/legacy-evidence-controls
 */

import { runInTenantContext } from '@/lib/db-context';
import {
    ISO27001_FAMILY_URN,
    SOC2_FAMILY_URN,
    canonicalRequirementCode,
    frameworkFamilyId,
    requirementCodeSpellings,
} from '@/app-layer/domain/framework-representation';
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';

/** The framework catalogue is a small global table; read whole, as the emitter reads it. */
const FRAMEWORK_CATALOGUE_CAP = 500;
/** Requirement rows across every representation of the four obligations. */
const REQUIREMENT_CAP = 100;
/** Control links one tenant can hold to those requirements. */
const LINK_CAP = 1_000;

/**
 * The library urn of NIS2. The catalogue fixture has carried it since
 * 2026-10-24, but a row seeded by `prisma/seed.ts` or applied earlier carries
 * none, so the key match below stays.
 */
const NIS2_LIBRARY_URN = 'urn:inflect:library:nis2-2022';

/**
 * The requirements a legacy recertification evidences, by framework FAMILY.
 *
 * Each `requirementCode` is one spelling of the obligation within its family;
 * `requirementCodeSpellings` supplies the others. `legacyKeys` are the
 * `Framework.key` values of rows that carry no `sourceUrn` — the seeded
 * spelling first. Where the brief and this repository differ the divergence is
 * recorded beside the entry, because a reader comparing this file with the
 * brief will otherwise assume a typo.
 */
export const LEGACY_EVIDENCE_REQUIREMENTS: readonly {
    readonly familyUrn: string;
    readonly legacyKeys: readonly string[];
    readonly requirementCode: string;
    readonly note: string;
}[] = [
    {
        familyUrn: SOC2_FAMILY_URN,
        legacyKeys: ['SOC2', 'soc2'],
        requirementCode: 'CC6.2',
        note:
            'User registration, authorisation and credential removal. Named by the '
            + 'brief and present since #3369 completed CC6; a recertification that '
            + 'revokes access evidences the removal half directly.',
    },
    {
        familyUrn: SOC2_FAMILY_URN,
        legacyKeys: ['SOC2', 'soc2'],
        requirementCode: 'CC6.3',
        note:
            'Role-based access, least privilege and PERIODIC REVIEW. Named by the '
            + 'brief and present since #3369; this is the criterion a '
            + 'recertification campaign is, almost word for word.',
    },
    {
        familyUrn: ISO27001_FAMILY_URN,
        legacyKeys: ['ISO27001', 'iso27001'],
        requirementCode: 'A.5.16',
        note: 'Identity management. Named by the brief and present (seeded as 5.16).',
    },
    {
        familyUrn: ISO27001_FAMILY_URN,
        legacyKeys: ['ISO27001', 'iso27001'],
        requirementCode: 'A.5.18',
        note: 'Access rights — review, provisioning and revocation. Named by the brief and present (seeded as 5.18).',
    },
    {
        familyUrn: NIS2_LIBRARY_URN,
        legacyKeys: ['NIS2', 'nis2'],
        requirementCode: 'Art.21(2)(i)',
        note:
            'Access-control policies and asset management. Named by the brief as '
            + '"Art. 21(2)(i)"; seeded without the space. The library spells it '
            + 'NIS2-HR, which no shared rule reconciles, so only the seeded '
            + 'representation is matched.',
    },
];

export interface SuggestedEvidenceControl {
    readonly controlId: string;
    readonly controlName: string;
    /** The tenant's own control code, when they use one. */
    readonly controlCode: string | null;
    /** The `Framework.key` of the row the link hangs off — `ISO27001` for the seeded one. */
    readonly frameworkKey: string;
    /** The code as that row spells it — `5.18` for the seeded ISO 27001 row. */
    readonly requirementCode: string;
}

/**
 * The tenant's controls that a legacy recertification evidences.
 *
 * Returns an empty list when the tenant has none of these requirements linked,
 * which is a real answer rather than a failure: a tenant running none of the
 * three frameworks has nothing for this artefact to attach to, and inventing a
 * link would put a compliance claim on a control nobody mapped.
 *
 * `assertCanRead`, not admin: this is a read of the tenant's own control
 * mappings, and the creator choosing where to file evidence needs to see it.
 */
export async function suggestLegacyEvidenceControls(
    ctx: RequestContext
): Promise<readonly SuggestedEvidenceControl[]> {
    assertCanRead(ctx);

    const links = await runInTenantContext(ctx, async (db) => {
        // Global reference data, read whole and grouped in memory, as
        // `resolveEvidenceControls` does for the agent campaign.
        const catalogue = await db.framework.findMany({
            select: { id: true, key: true, sourceUrn: true },
            take: FRAMEWORK_CATALOGUE_CAP,
        });
        const clauses = LEGACY_EVIDENCE_REQUIREMENTS.flatMap((r) => {
            const frameworkIds = catalogue
                .filter((f) => frameworkFamilyId(f) === r.familyUrn || r.legacyKeys.includes(f.key))
                .map((f) => f.id);
            return frameworkIds.length > 0
                ? [{ frameworkId: { in: frameworkIds }, code: { in: requirementCodeSpellings(r.familyUrn, r.requirementCode) } }]
                : [];
        });
        if (clauses.length === 0) return [];

        const requirements = await db.frameworkRequirement.findMany({
            where: { OR: clauses, deprecatedAt: null },
            select: { id: true },
            take: REQUIREMENT_CAP,
        });
        if (requirements.length === 0) return [];

        return db.controlRequirementLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                requirementId: { in: requirements.map((r) => r.id) },
                // A removed control must not keep attracting evidence — the
                // reason `resolveTargetControls` gives on the same join.
                control: { deletedAt: null },
            },
            select: {
                controlId: true,
                control: { select: { name: true, code: true } },
                requirement: {
                    select: { code: true, framework: { select: { key: true, sourceUrn: true } } },
                },
            },
            take: LINK_CAP,
        });
    });

    // De-duplicated on (control, obligation). One control can be linked to
    // several of these requirements — a well-mapped access control is plausibly
    // all four — and the caller wants each control once per obligation it
    // satisfies, not once per row of a join. The obligation is the FAMILY and
    // CANONICAL code, so a control linked to both representations of A.5.18
    // (`5.18` seeded, `A.5.18` imported) is still one suggestion.
    const seen = new Set<string>();
    const out: SuggestedEvidenceControl[] = [];
    for (const l of links) {
        const family = frameworkFamilyId(l.requirement.framework);
        const key = `${l.controlId}|${family}|${canonicalRequirementCode(family, l.requirement.code)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            controlId: l.controlId,
            controlName: l.control.name,
            controlCode: l.control.code,
            frameworkKey: l.requirement.framework.key,
            requirementCode: l.requirement.code,
        });
    }
    // Stable order, so two calls agree and a UI does not reshuffle.
    return out.sort(
        (a, b) =>
            a.frameworkKey.localeCompare(b.frameworkKey)
            || a.requirementCode.localeCompare(b.requirementCode)
            || a.controlId.localeCompare(b.controlId)
    );
}
