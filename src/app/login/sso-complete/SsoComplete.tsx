'use client';
import { useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { SSO_HANDOFF_PROVIDER_ID } from '@/lib/auth/sso-session';

/**
 * Redeems the SSO hand-off through NextAuth, then navigates on. NextAuth
 * reads the hand-off from its cookie, so nothing is sent from here but the
 * request itself.
 */
export function SsoComplete({ next }: { next: string }) {
    const t = useTranslations('login');
    const [failed, setFailed] = useState(false);
    // A hand-off redeems once; development's double-run effect must not try twice.
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        signIn(SSO_HANDOFF_PROVIDER_ID, { redirect: false })
            .then((result) => {
                if (result?.ok && !result.error) {
                    window.location.href = next;
                } else {
                    setFailed(true);
                }
            })
            .catch(() => setFailed(true));
    }, [next]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page p-4">
            <Card className="w-full max-w-md">
                <Heading level={1} className="mb-4">
                    {t('ssoComplete.title')}
                </Heading>
                {failed ? (
                    <div className="space-y-default">
                        <InlineNotice variant="error" icon={null}>
                            {t('errors.ssoIncomplete')}
                        </InlineNotice>
                        <a
                            id="sso-complete-back-to-login"
                            href="/login"
                            className="text-sm text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]"
                        >
                            {t('ssoComplete.backToSignIn')}
                        </a>
                    </div>
                ) : (
                    <p role="status" className="text-sm text-content-muted">
                        {t('ssoComplete.inProgress')}
                    </p>
                )}
            </Card>
        </div>
    );
}
