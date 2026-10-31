import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { accountHasPassword } from '@/lib/auth/password-management';

import { ChangePasswordForm } from './ChangePasswordForm';

export default async function AccountSecurityPage() {
    const session = await auth();
    if (!session?.user) redirect('/login?next=/account/security');

    const t = await getTranslations('account.security');
    // An account that signs in only through Google, Microsoft or SSO has no
    // password, so it is told so rather than offered a form the server would
    // refuse once all three fields were filled in (#4645).
    const hasPassword = await accountHasPassword(session.user.id);

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page p-4">
            {/* Background effects */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-[var(--brand-default)]/10 blur-3xl" />
                <div className="absolute -bottom-40 -left-40 w-80 h-80 rounded-full bg-[var(--brand-emphasis)]/10 blur-3xl" />
            </div>

            <div className="relative w-full max-w-md">
                {/* Logo */}
                <div className="text-center mb-8 animate-fadeIn">
                    <div className="inline-flex items-center gap-tight mb-2">
                        <div className="w-10 h-10 rounded-lg bg-[var(--brand-default)] flex items-center justify-center">
                            <svg className="w-6 h-6 text-content-inverted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                            </svg>
                        </div>
                    </div>
                    <Heading level={1}>{t('securityTitle')}</Heading>
                </div>

                {hasPassword ? (
                    <ChangePasswordForm />
                ) : (
                    <Card className="animate-fadeIn" id="account-no-password">
                        <Heading level={2} className="mb-4">
                            {t('changePasswordTitle')}
                        </Heading>
                        <InlineNotice variant="info" icon={null}>
                            {t('passwordlessNotice')}
                        </InlineNotice>
                    </Card>
                )}
            </div>
        </div>
    );
}
