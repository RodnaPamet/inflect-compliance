'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ShieldCheck, KeyRound, AlertTriangle } from 'lucide-react';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { refreshSessionCookie } from '@/lib/auth/refresh-session-cookie';
import { sanitizeRedirectPath } from '@/lib/auth/redirect-path';

/**
 * MFA Challenge Page — shown when mfaPending is true.
 * User must enter a TOTP code to continue.
 *
 * After successful verification, redirects to the original target page
 * (or tenant home if no target is specified).
 */
export default function MfaChallengePage() {
    const t = useTranslations('mfa');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    // Default to /dashboard, not /, because `/t/<slug>/` has no
    // page.tsx (404) and post-MFA navigation would land on a broken
    // route if the URL didn't carry an explicit `next`.
    // Only a path on this site: `next` comes from the URL, which anybody can
    // write, and the browser is sent there after the code is accepted.
    const safeNext = sanitizeRedirectPath(searchParams.get('next'));
    const next = safeNext === '/' ? tenantHref('/dashboard') : safeNext;

    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Check if user has MFA enrolled. Nothing is drawn until it answers, so
    // the challenge never flashes up for somebody who must enrol (#4926). If
    // the check itself fails, the challenge is the safer page to show: an
    // enrolled person can still continue, and the server decides either way.
    // The page says the check failed, so somebody who has not enrolled is
    // told where to go rather than left facing a code they do not have.
    const [enrolled, setEnrolled] = useState<boolean | null>(null);
    const [checkFailed, setCheckFailed] = useState(false);
    const checkEnrollment = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll'));
            if (res.ok) {
                const data = await res.json();
                setEnrolled(data.isVerified);
                return;
            }
        } catch {
            // fall through to the challenge
        }
        setCheckFailed(true);
        setEnrolled(true);
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void checkEnrollment(); }, [checkEnrollment]);

    const handleVerify = async () => {
        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            setError(t('invalidCodeFormat'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/challenge/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();

            // The lockout is the SERVER's (#4926): it answers 429 with the
            // wait, whatever a counter in this page would have said.
            if (res.status === 429) {
                setCode('');
                const seconds = Math.max(1, Math.ceil(Number(data?.retryAfterMs ?? 0) / 1000));
                setError(t('lockedOut', { seconds }));
                return;
            }

            if (data.success) {
                // MFA challenge complete. Rewrite the session cookie first:
                // the edge gate reads `mfaPending` from it, and nothing else
                // re-signs it, so navigating straight on returns here.
                await refreshSessionCookie();
                window.location.href = next;
            } else {
                setCode('');
                setError(t('invalidCode'));
            }
        } catch {
            setError(t('verifyFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && code.length === 6) {
            void handleVerify();
        }
    };

    const switchAccount = (
        <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            onClick={() => { void signOut({ callbackUrl: '/login' }); }}
            id="mfa-switch-account"
        >
            {t('switchAccount')}
        </Button>
    );

    if (enrolled === null) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="max-w-md w-full" role="status" aria-label={t('checking')}>
                    <SkeletonCard lines={3} />
                </div>
            </div>
        );
    }

    // If not enrolled, show enrollment redirect
    if (enrolled === false) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Card className="max-w-md w-full space-y-default text-center">
                    <div className="flex justify-center">
                        <div className="w-16 h-16 rounded-full bg-bg-warning flex items-center justify-center">
                            <AlertTriangle className="w-8 h-8 text-content-warning" />
                        </div>
                    </div>
                    <Heading level={1}>{t('enrollRequiredTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('enrollRequiredBody')}
                    </p>
                    <a
                        href={tenantHref('/security/mfa')}
                        className={buttonVariants({ variant: 'primary', className: 'w-full justify-center' })}
                        id="mfa-go-enroll-btn"
                    >
                        <KeyRound className="w-4 h-4" />
                        {t('setUpMfa')}
                    </a>
                    {switchAccount}
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Card className="max-w-md w-full space-y-default">
                <div className="flex justify-center">
                    <div className="w-16 h-16 rounded-full bg-[var(--brand-subtle)] flex items-center justify-center">
                        <ShieldCheck className="w-8 h-8 text-[var(--brand-default)]" />
                    </div>
                </div>

                <div className="text-center">
                    <Heading level={1}>{t('verifyTitle')}</Heading>
                    <p className="text-sm text-content-muted mt-2">
                        {t('verifyBody')}
                    </p>
                </div>

                {checkFailed && (
                    <InlineNotice variant="warning" data-testid="mfa-check-failed">
                        {t.rich('checkFailed', {
                            link: (chunks) => (
                                <a href={tenantHref('/security/mfa')} className="underline">
                                    {chunks}
                                </a>
                            ),
                        })}
                    </InlineNotice>
                )}

                {error && (
                    <InlineNotice variant="error" data-testid="mfa-challenge-error">
                        {error}
                    </InlineNotice>
                )}

                <div className="flex flex-col items-center gap-default">
                    <FormField label={t('codeLabel')} className="w-full sm:w-48">
                        <Input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="000000"
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            onKeyDown={handleKeyDown}
                            className="text-center text-2xl font-mono tracking-[0.4em] py-3"
                            id="mfa-challenge-input"
                            autoFocus
                            autoComplete="one-time-code"
                        />
                    </FormField>

                    <Button
                        variant="primary"
                        onClick={handleVerify}
                        disabled={submitting || code.length !== 6}
                        className="w-full justify-center"
                        id="mfa-challenge-submit"
                    >
                        {submitting ? t('verifying') : t('continueBtn')}
                    </Button>
                </div>

                <p className="text-xs text-content-subtle text-center">
                    {t('cantAccess')}
                </p>
                {switchAccount}
            </Card>
        </div>
    );
}
