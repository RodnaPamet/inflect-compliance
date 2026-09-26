'use client';

/**
 * Joiner passes — the OWNER-only read surface (#2881 f12).
 *
 * ═══ WHY THIS PAGE IS NOT OPTIONAL ═══
 *
 * The route behind it already argues its own case: the write ladder mandates a
 * seven-day observation before a direction may be widened past DRY_RUN, and the
 * point of that window is to compare what the pass would have done against what
 * HR and IT actually did. Until now the only way to read a joiner artefact was a
 * raw API call with an OWNER token, so the window existed and nobody could look
 * through it.
 *
 * It is also the second half of a definition the ladder states outright:
 * *"`implemented` means a RUNTIME reads this setting AND an operator can see
 * what it did."* The create verb landed in #2923 and the collision probe in
 * #2928; this is the other half, and `DIRECTION_IMPLEMENTED.joiner` cannot
 * honestly flip without it.
 *
 * ═══ GATED HERE, NOT ONLY IN THE LAYOUT ═══
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * report names which of a customer's people the product would create an account
 * for, and at what address. Reading that is authority of the same class as
 * granting it, which is why the endpoint is `admin.tenant_lifecycle`. Without a
 * matching client gate a non-OWNER admin reaches a rendered page and is told the
 * report "couldn't load" — a permission refusal wearing the costume of a broken
 * backend.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { JoinerPassesClient } from './JoinerPassesClient';

export default function JoinerPassesPage() {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                <ForbiddenPage title={t('forbidden.title')} message={t('joinerPasses.forbidden')} />
            }
        >
            <JoinerPassesClient />
        </RequirePermission>
    );
}
