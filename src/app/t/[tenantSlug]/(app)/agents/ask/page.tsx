import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AD_HOC_QUESTION_MAX_CHARS } from '@/lib/agentic/workflows/ad-hoc-question';

import { AskClient } from './AskClient';

/**
 * ASK THE WORKSPACE A QUESTION (#3870, M3 of the SAP agent integration roadmap).
 *
 * A person types a question; the agent their tenant designated answers it from
 * this workspace's own records. M1 (#3868) built the authority, M2 (#3869) the
 * workflow and the two routes; this is the surface.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READER-LEVEL, UNLIKE EVERY SIBLING UNDER `/agents`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other page in this directory gates on `admin.agent_registry`, because
 * every other one shows the REGISTER — rows that name people, owners and
 * credentials. This one shows a person their own answer, so it gates on
 * `controls.view`, the same key the two routes behind it take and the same key
 * `/assistant/ask` has always taken.
 *
 * The argument is ADR 0004's, determined by test rather than asserted: a
 * session is its own principal, the propose class authorises on the principal,
 * and the workflow declares `readOnly: true` so it is offered no propose
 * surface at all. An answer therefore cannot reach data the asker could not
 * reach through the UI, which is what makes an admin key wrong here rather
 * than merely strict — it would gate against something that cannot happen.
 *
 * Reachability was checked rather than assumed: there is no `agents/layout.tsx`
 * and the app layout gates on no register key, so a READER can actually arrive
 * here. A page admitted by its own check and refused by a layout above it is
 * the failure mode that would otherwise be invisible from this file.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO BREADCRUMB TO `/agents`, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `canonical-parents.ts` maps every `/agents/*` page to `/agents` as its
 * parent. That page is admin-gated, so inheriting the convention would hand a
 * READER a breadcrumb to a page that forbids them — a link whose own audience
 * cannot follow it. This page is therefore absent from that map on purpose,
 * and the absence is recorded here so it reads as a decision rather than an
 * oversight.
 */
export default async function AgentAskPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    if (!ctx.appPermissions?.controls?.view) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('ask.accessTitle')} message={t('ask.accessMessage')} />;
    }

    return (
        <AskClient
            tenantSlug={resolved.tenantSlug}
            // The SAME constant the server enforces, handed down rather than
            // restated. M2's definition declares it and the usecase enforces
            // it; a second literal in the client would eventually disagree, and
            // the half that is wrong would be whichever nobody tested.
            maxChars={AD_HOC_QUESTION_MAX_CHARS}
        />
    );
}
