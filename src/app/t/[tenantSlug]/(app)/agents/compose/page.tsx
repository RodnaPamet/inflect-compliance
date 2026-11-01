import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { oversightReadsFor, readAgentOversightSettings } from '@/app-layer/usecases/agent-oversight-settings';
import { listComposableTemplates } from '@/app-layer/usecases/external-write-compose';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ComposeClient } from './ComposeClient';

/**
 * COMPOSE A REQUEST — the one agentic surface that accepts an instruction (#3301).
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * All twelve pages under `/agents` are governance over agent OUTPUT: proposals,
 * receipts, decisions, runs, reports, quarantine, review quality, parameter
 * sets, external tools. Every one of them reviews something that already
 * happened. **Nothing accepted an intent.**
 *
 * That is the fourth instance in this subsystem of the shape its own siblings
 * name. `ParameterSetsClient`'s page says it plainly — "A control reachable only
 * by curl is a column with governance prose attached" — after #2861 shipped the
 * external-write ladder with no UI and #2921 shipped the tool-approval API with
 * no UI. The compose endpoints landed in this same PR's backend commit; this is
 * the caller, so the pair does not repeat the pattern a third time in one epic.
 *
 * ── NOT A CHAT BOX, AND THAT IS THE DESIGN ─────────────────────────────────
 *
 * The operator picks an approved template and fills only the fields it OPENS.
 * They are not composing a tool call — the reviewed template already exists, so
 * they are filling the open fields of a shape somebody already approved. A
 * free-text layer above this is where a prompt-injection path would enter, since
 * the text would influence a tool call against a customer's directory; it is
 * split out as #3351 with the four things to settle first.
 *
 * ── TWO GATES, AND THEY ARE DIFFERENT ──────────────────────────────────────
 *
 * `admin.view` to SEE this surface, matching `/agents/proposals` — agent
 * governance is one surface and this is part of it. `permissions.canWrite` to
 * SUBMIT, which is deliberately the lower bar of the two: the proposal reaches a
 * reviewer who needs the authority to approve it, and requiring that authority
 * to compose as well would turn four eyes into two. A reader without write sees
 * the form and a sentence saying why they cannot send it, rather than a page
 * that pretends to work.
 *
 * ── WHAT IS READ HERE RATHER THAN IN THE CLIENT ────────────────────────────
 *
 * The TEMPLATES, so the page renders with its picker populated. An empty picker
 * that fills a moment later reads as "you have no templates", which is a
 * different and wrong claim.
 *
 * Their OPEN FIELDS are not read here. Those come from the compose endpoint per
 * selection, because a target field's candidates are resolved from LIVE data —
 * a list rendered with the page would be a snapshot presented as a live bound,
 * and the first subject to leave the population would stay offerable.
 */
export default async function ComposePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    if (!ctx.appPermissions.admin.view) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('compose.accessTitle')}
                message={t('compose.accessMessage')}
            />
        );
    }

    const admin = ctx.appPermissions.admin;
    const [{ templates, notComposable }, oversight, oversightReads] = await Promise.all([
        // Only templates that OPEN a field (#4895): an exact-value set has
        // nothing to fill in, so offering it opened onto an empty form.
        // Label, tool and connection only. The approved PARAMETERS are
        // deliberately not sent to the client: the form has no business
        // rendering them, and a payload that carried them would be one
        // refactor from a payload that accepted them back.
        listComposableTemplates(ctx),
        readAgentOversightSettings(ctx),
        oversightReadsFor(ctx),
    ]);

    return (
        <ComposeClient
            templates={templates}
            notComposable={notComposable}
            canWrite={ctx.permissions.canWrite}
            // The Saved parameters page's own gate, so the empty state links
            // there only for a viewer it would admit.
            canManageTemplates={Boolean(admin.agent_registry)}
            // The Owner's switch (#4905): whether the composer may approve
            // their own request decides what the intro may promise.
            needsSecondApprover={oversight.composeNeedsSecondApprover}
            menu={{
                tenantSlug: resolved.tenantSlug,
                canReviewProposals: mayReadAgentActivity(admin),
                canCompose: true,
                canInvestigate: Boolean(admin.agent_registry),
                canReadReports: mayReadAgentInventory(admin),
                canSetOrphanPass: Boolean(admin.tenant_lifecycle),
                oversightReads,
            }}
        />
    );
}
