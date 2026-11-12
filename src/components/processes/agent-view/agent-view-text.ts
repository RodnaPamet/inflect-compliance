'use client';

/**
 * The translated text one agent-view node draws: its badges and its reason.
 *
 * Its own module so the Elements list can translate a node without importing
 * the canvas, which pulls in the editor. Both tabs read the same function, so
 * the list and the drawing cannot word one node differently.
 */
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

import type { AgentViewNode } from '@/lib/processes/agent-view/agent-canvas-graph';

export function useAgentViewNodeText() {
    const t = useTranslations('agentCanvas');
    return useCallback(
        (n: AgentViewNode): { badges: string[]; reason: string | null } => ({
            badges: n.badges.map((b) => t(`badge.${b.key}`, b.values)),
            reason: n.reason === null ? null : t(`reason.${n.reason}`),
        }),
        [t],
    );
}
