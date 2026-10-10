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
 * So "the tenant has SOC 2 CC6.1" means exactly: some control of theirs is
 * linked to the requirement whose code is `CC6.1` under framework `soc2`. That
 * is the question this asks, in one query, against that index.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CC6.1, NOT CC6.2 AND CC6.3 — AND WHY THAT IS WRITTEN DOWN HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 5b's brief names SOC 2 **CC6.2 and CC6.3**. This product's SOC 2
 * catalogue contains neither: it carries one sub-code per criterion — CC1.1,
 * CC2.1, CC3.1, CC4.1, CC5.1, CC6.1, CC7.1, CC8.1, CC9.1 — measured against
 * `prisma/fixtures/soc2-control-templates.json`, which is what production
 * seeds.
 *
 * A suggestion keyed on CC6.2 would therefore return nothing, for every tenant,
 * for ever, while looking exactly like a feature that worked. So the SOC 2
 * suggestion is **CC6.1**, the logical-access criterion, which a recertification
 * artefact genuinely evidences.
 *
 * Owner decision, 2026-10-10: substitute and file the gap rather than extend the
 * catalogue inside 5b — adding requirements changes what every tenant's SOC 2
 * framework contains, and that is not a recertification change. See the filed
 * issue.
 *
 * ISO/IEC 27001 A.5.16 and A.5.18 and NIS2 Art. 21(2)(i) all exist and are used
 * as the brief names them.
 *
 * @module app-layer/usecases/legacy-evidence-controls
 */

import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';

/**
 * The requirements a legacy recertification evidences, by framework key.
 *
 * Each entry is a code as THIS REPO spells it, not as the brief does. Where
 * those differ the divergence is recorded beside the entry, because a reader
 * comparing this file with the brief will otherwise assume a typo.
 */
export const LEGACY_EVIDENCE_REQUIREMENTS: readonly {
    readonly frameworkKey: string;
    readonly code: string;
    readonly note: string;
}[] = [
    {
        frameworkKey: 'soc2',
        code: 'CC6.1',
        note:
            'The brief names CC6.2 and CC6.3. Neither exists in this catalogue — '
            + 'SOC 2 here carries one sub-code per criterion — so CC6.1, the '
            + 'logical-access criterion, is the nearest requirement a '
            + 'recertification actually evidences.',
    },
    {
        frameworkKey: 'iso27001',
        code: 'A.5.16',
        note: 'Identity management. Named by the brief and present.',
    },
    {
        frameworkKey: 'iso27001',
        code: 'A.5.18',
        note: 'Access rights — review, provisioning and revocation. Named by the brief and present.',
    },
    {
        frameworkKey: 'nis2',
        code: 'Art. 21(2)(i)',
        note: 'Access-control policies and asset management. Named by the brief and present.',
    },
];

export interface SuggestedEvidenceControl {
    readonly controlId: string;
    readonly controlName: string;
    /** The tenant's own control code, when they use one. */
    readonly controlCode: string | null;
    readonly frameworkKey: string;
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

    const wanted = LEGACY_EVIDENCE_REQUIREMENTS;

    const links = await runInTenantContext(ctx, (db) =>
        db.controlRequirementLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                requirement: {
                    OR: wanted.map((w) => ({
                        code: w.code,
                        framework: { key: w.frameworkKey },
                    })),
                },
            },
            select: {
                controlId: true,
                control: { select: { name: true, code: true } },
                requirement: {
                    select: { code: true, framework: { select: { key: true } } },
                },
            },
        })
    );

    // De-duplicated on (controlId, requirementCode). One control can be linked
    // to several of these requirements — a well-mapped access-control is
    // plausibly all four — and the caller wants each control once per
    // requirement it satisfies, not once per row of a join.
    const seen = new Set<string>();
    const out: SuggestedEvidenceControl[] = [];
    for (const l of links) {
        const key = `${l.controlId}|${l.requirement.code}`;
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
