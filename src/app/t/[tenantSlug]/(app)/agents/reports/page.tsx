import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { buildAgentGovernancePack } from '@/app-layer/usecases/agent-governance-reports';
import { getAgentGovernanceStatus } from '@/app-layer/usecases/agent-registry';
import { canRunRegistrationIntake } from '@/app-layer/usecases/agent-registration-intake';
import { getHarnessMatrix, getHarnessScannerKeysView } from '@/app-layer/usecases/agent-harness-matrix';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { ReportsClient } from './ReportsClient';

/**
 * THE ASSESSOR PACK — "show me your agent governance" (4/4).
 *
 * ── WHY THIS PAGE EXISTS AT ALL, GIVEN THE MODULE SAYS IT SHOULD NOT ─
 *
 * `agent-governance-reports.ts` carries a section headed WHY THERE IS NO PAGE,
 * arguing the pack is an artefact to hand over rather than a dashboard to
 * browse, and that a page would be "a sixth place the same rows are rendered,
 * with its own filters to keep in step." That reasoning is recorded and
 * deliberate, and this page is a decision to supersede it — so it answers the
 * objection rather than ignoring it:
 *
 *   · IT HAS NO FILTERS. The pack is fixed: five reports, one window. There is
 *     nothing here to keep in step with the register's own filters, because
 *     there is nothing to steer.
 *   · IT RENDERS NOTHING THE SUBSYSTEM PAGES RENDER. Those show rows; this shows
 *     FIGURES WITH THEIR DEFINITIONS, which is the thing none of them shows and
 *     the only thing an assessor asks for.
 *   · IT IS EXPORT-SHAPED. The screen is the artefact, stamped with tenant,
 *     moment and population, so a screenshot carries its own provenance.
 *
 * ── IT READS LIVE, AND STORES NOTHING ───────────────────────────────
 *
 * Contract B: "every figure is derived from rows the earlier prompts already
 * landed... a governance report that needed its own table would be a second copy
 * of the register, and two copies can disagree about what a tenant runs." So
 * this is a server read per visit. No cache, no snapshot row, no "last
 * generated" — if it is slow, the query is the thing to fix.
 *
 * The permission is the INVENTORY read, matching the route's (#3710): the
 * read-only `admin.agent_registry_view`, or the register key whose holders
 * always could (`mayReadAgentInventory`). The pack names people — who approved
 * what, who owns which agent — and the view key is held by OWNER, ADMIN,
 * AI_ADMIN and AUDITOR, the last because this is what an assessor asks for.
 *
 * ── THE HARNESS TAB (#3687) ─────────────────────────────────────────
 *
 * A second view behind the SAME inventory gate, chosen by `?tab=harness`;
 * anything else (or nothing) is the pack. The scanner-key register on it stays
 * behind `admin.agent_registry` — it decides whose reports the tenant believes
 * — so a view-key reader gets the matrix and the shadow list without it, and no
 * shortfall action (`getHarnessMatrix` reports `NONE` for a reader who cannot
 * accept). The server reads ONLY
 * the selected tab: the harness tab never builds the pack and the pack tab never
 * reads a scan, so neither tab pays for the other and a refused caller starts
 * neither read.
 *
 *   · "IT HAS NO FILTERS" STILL HOLDS. A tab chooses which fixed artefact is on
 *     screen; it filters neither. The harness view renders the same thing for
 *     the same rows every visit.
 *   · IT ALSO READS LIVE AND STORES NOTHING (`getHarnessMatrix`,
 *     `getHarnessScannerKeysView`). It is read-only apart from the owner's
 *     shortfall acceptance, the scanner-key register and the registration
 *     intake from the shadow list, which post to their own routes
 *     (`harness-acceptances`, `harness-scanner-keys`, `intake`) and then
 *     refresh this server read. The accept and register actions are shown
 *     only where their usecases would take them — the same rule decides both.
 *   · AN EMPTY SCAN POPULATION IS A FINDING. The inventory's empty state is "a
 *     complete answer" because the register is the whole population by
 *     definition. A scan population is the opposite: no scan means nothing
 *     looked for agents outside the register, so "no agents" would be a claim
 *     about an estate nobody observed.
 */
export default async function AgentReportsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams?: Promise<{ tab?: string | string[] }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    if (!mayReadAgentInventory(ctx.appPermissions?.admin)) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('register.accessTitle')}
                message={t('register.accessMessage')}
            />
        );
    }

    // The menu entry must ask the same question its DESTINATION asks, or it
    // offers a link that renders a ForbiddenPage.
    const canReviewProposals = mayReadAgentActivity(ctx.appPermissions?.admin);
    const canCompose = Boolean(ctx.appPermissions?.admin?.view);
    const canInvestigate = Boolean(ctx.appPermissions?.admin?.agent_registry);
    // The SAME question the export usecase asks. Filing the pack writes into the
    // evidence library, which is the library's grant to give and not the
    // register's — so holding this page is not holding this button, and the two
    // keys are read separately here rather than one being inferred from the
    // other.
    //
    // And the register key (#3710): filing is a write, which the export route
    // keeps on that key, so a reader who holds this page through the view key
    // alone is not offered a button its route would refuse.
    const canExport = Boolean(ctx.appPermissions?.evidence?.edit) && canInvestigate;

    // AFTER the gate, and only for the tab asked for.
    const requested = ((await searchParams) ?? {}).tab;
    if ((Array.isArray(requested) ? requested[0] : requested) === 'harness') {
        const [harness, scannerKeys] = await Promise.all([
            getHarnessMatrix(ctx),
            // Only for a holder of the register key (#3710): the key register
            // is that key's to read, and `null` renders no card at all.
            canInvestigate ? getHarnessScannerKeysView(ctx) : Promise.resolve(null),
        ]);
        return (
            <ReportsClient
                tab="harness"
                tenantSlug={resolved.tenantSlug}
                // JSON-safe by construction (ISO strings); the round trip is the
                // pack's, and keeps the server/client boundary honest.
                harness={JSON.parse(JSON.stringify(harness))}
                scannerKeys={JSON.parse(JSON.stringify(scannerKeys))}
                // The intake's own rule, so the shadow list's Register action
                // is shown exactly where the usecase would take it (#3712).
                canRegisterShadow={canRunRegistrationIntake(ctx)}
                canReviewProposals={canReviewProposals}
                canCompose={canCompose}
                canInvestigate={canInvestigate}
                canExport={canExport}
            />
        );
    }

    // The governance flag comes from the register's own read rather than being
    // re-derived here: the caveat this page puts at the top must be the SAME
    // answer the register's banner gives, or the two disagree about whether the
    // figures below describe anything enforced.
    const [pack, governance] = await Promise.all([
        buildAgentGovernancePack(ctx),
        getAgentGovernanceStatus(ctx),
    ]);

    return (
        <ReportsClient
            tenantSlug={resolved.tenantSlug}
            // Serialised through JSON the way every other server->client agent
            // payload here is: the envelopes carry `Date`s, and a client
            // component boundary does not.
            pack={JSON.parse(JSON.stringify(pack))}
            enforcing={governance.enforcing}
            canReviewProposals={canReviewProposals}
            canCompose={canCompose}
            canInvestigate={canInvestigate}
            canExport={canExport}
        />
    );
}
