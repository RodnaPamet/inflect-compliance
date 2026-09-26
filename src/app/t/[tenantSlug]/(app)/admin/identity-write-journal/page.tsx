'use client';

/**
 * The identity write journal — what a disable REPLACED, and what never settled.
 *
 * ═══ WHY THIS PAGE EXISTS ═══
 *
 * On 2026-09-12 this product performed its first real directory disable. The
 * mail that went out told IT the account's prior state "is held against journal
 * reference <id>" and to "quote that reference to your platform administrator,
 * who can read the captured state and re-apply it".
 *
 * #2926 gave that administrator an API to read it with. They still had no page:
 * a raw JSON endpoint whose URL they would have to know is not a surface, and
 * `listUnsettledWrites` — the backlog of writes that never reported an outcome
 * — had no caller in `src/` at all, so it was counted by a metric and shown to
 * nobody. A number saying N accounts are in an unknown state cannot say WHICH.
 *
 * ═══ GATED HERE, NOT IN THE CLIENT ═══
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * endpoints behind this page are `admin.tenant_lifecycle`, because a journal
 * row names a change made to one of a customer's people's accounts and reading
 * that is authority of the same class as granting it. Without a matching
 * client-side gate an ADMIN who is not an OWNER reaches a rendered page and is
 * told the data "couldn't load" — a permission refusal wearing the costume of a
 * broken backend. `ForbiddenPage` says the true thing instead.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { JournalClient } from './JournalClient';

export default function IdentityWriteJournalPage() {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                <ForbiddenPage
                    title={t('forbidden.title')}
                    message={t('identityWriteJournal.forbidden')}
                />
            }
        >
            <JournalClient />
        </RequirePermission>
    );
}
