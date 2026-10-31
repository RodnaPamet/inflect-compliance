'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * "Use for Ask" / "Stop using for Ask" (#4629). The one control that writes
 * `TenantSecuritySettings.interactiveAgentId`, through
 * `PUT|DELETE …/admin/agents/:agentId/interactive`, under the register key.
 *
 * Reads `designated` from the server rather than holding its own copy, and
 * refreshes the page after a change, so the badge beside the agent's name and
 * this button cannot disagree about which agent answers.
 */
export function InteractiveAgentAction({
    tenantSlug,
    agentId,
    designated,
}: {
    tenantSlug: string;
    agentId: string;
    designated: boolean;
}) {
    const t = useTranslations('admin');
    const toast = useToast();
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const change = async () => {
        setBusy(true);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/agents/${agentId}/interactive`, {
                method: designated ? 'DELETE' : 'PUT',
            });
            if (!res.ok) {
                toast.error(apiErrorMessage(await res.json().catch(() => null), t('agentDetail.interactive.failed')));
                return;
            }
            toast.success(designated ? t('agentDetail.interactive.cleared') : t('agentDetail.interactive.designated'));
            router.refresh();
        } catch {
            toast.error(t('agentDetail.interactive.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void change()}
            data-testid="agent-interactive-action"
            text={designated ? t('agentDetail.interactive.stop') : t('agentDetail.interactive.use')}
        />
    );
}
