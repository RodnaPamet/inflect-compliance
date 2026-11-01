/**
 * What the initiative page and its dialogs share (#4852): the linkable types,
 * their labels, the row and initiative shapes, and how a refusal is read.
 * Kept apart from the dialogs so that importing it does not pull them into
 * the page's First Load JS.
 */
import { apiErrorMessage } from '@/lib/api-error';

export const LINK_TYPES = ['CONTROL', 'RISK', 'TASK', 'FINDING'] as const;
export const TYPE_LABEL_KEY: Record<string, string> = {
    CONTROL: 'initiativeDetail.typeControl',
    RISK: 'initiativeDetail.typeRisk',
    TASK: 'initiativeDetail.typeTask',
    FINDING: 'initiativeDetail.typeFinding',
};

export type LinkRow = {
    id: string;
    entityType: string;
    entityId: string;
    linkedTenantId: string;
    workspaceName: string | null;
    name: string | null;
    href: string | null;
};
export type Initiative = {
    id: string;
    title: string;
    description: string | null;
    status: string;
    ownerUserId: string | null;
    ownerName: string | null;
    targetDate: string | null;
    manualProgressPercent: number | null;
    links: LinkRow[];
};
export type Progress = { percent: number; completed: number; total: number; manual: boolean };
export type Option = { id: string; label?: string; name?: string };

/** The server's reason for a refused write, else this action's sentence. */
export async function failure(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => ({}));
    return apiErrorMessage(body, fallback);
}

