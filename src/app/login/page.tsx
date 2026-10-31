'use client';
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { getProviders, signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { postSignInPath } from '@/lib/auth/redirect-path';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-limits';
import { EMAIL_NOT_VERIFIED_SIGN_IN_ERROR, isRegisterRefusal } from '@/lib/auth/register-refusals';
import { loginErrorKey, ssoRequiredWorkspace } from './login-error';
import { SsoSignIn } from './SsoSignIn';

function extractErrorMessage(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'message' in value) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === 'string') return nested;
    }
    return fallback;
}

type VerifyStatus = 'verified' | 'invalid' | 'expired';

function LoginForm() {
    const searchParams = useSearchParams();
    // Where to go once signed in. A link says `?callbackUrl=`; the middleware,
    // bouncing a signed-out visitor, says `?next=`. Both are anyone's to
    // write, so only a path on this site survives, and nothing usable means
    // /tenants, the picker (0 → /no-tenant, 1 → direct, >1 → the list).
    const requestedDestination = searchParams?.get('callbackUrl') ?? searchParams?.get('next');
    const callbackUrl = postSignInPath(requestedDestination);
    const verifyStatusParam = searchParams?.get('verifyStatus');
    const verifyStatus: VerifyStatus | null =
        verifyStatusParam === 'verified' ||
        verifyStatusParam === 'invalid' ||
        verifyStatusParam === 'expired'
            ? verifyStatusParam
            : null;
    // A failed SSO callback, or NextAuth itself, sends the browser here with
    // `?error=<code>`. Only the code is read, and only to pick a fixed message.
    const errorCode = searchParams?.get('error');
    const t = useTranslations('login');
    const [mode, setMode] = useState<'login' | 'register'>('login');
    // Arriving from "Sign in to accept" on an invitation (#4689): registering
    // makes an account only, and the sign-in that follows redeems the
    // invitation, so no workspace is created and none is asked for.
    const forInvite = callbackUrl === '/invite/result';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [orgName, setOrgName] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [resendEmail, setResendEmail] = useState('');
    const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
    // `null` = still resolving the provider list (nothing credentials-shaped
    // renders yet). `false` = server is OAuth-only, hide the form + divider
    // + register toggle. `true` = credentials is registered (dev, or prod
    // with AUTH_TEST_MODE=1), show the form.
    const [credentialsEnabled, setCredentialsEnabled] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Resolve in parallel: (1) which providers the server has
        // registered, and (2) the runtime UI-config flag. The flag is
        // served by /api/auth/ui-config so an operator can flip
        // `AUTH_CREDENTIALS_UI_HIDDEN=1` in the VM's .env and recreate
        // the container — no rebuild. When the flag is on the form
        // stays hidden regardless of provider registration.
        void Promise.all([
            getProviders().catch(() => null),
            fetch('/api/auth/ui-config')
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
        ]).then(([providers, uiConfig]) => {
            if (cancelled) return;
            if (uiConfig?.credentialsFormHidden === true) {
                setCredentialsEnabled(false);
                return;
            }
            setCredentialsEnabled(!!providers?.credentials);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleCredentialsSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        const formData = new FormData(e.currentTarget);
        const submitEmail = (formData.get('email') as string) || email;
        const submitPassword = (formData.get('password') as string) || password;

        try {
            if (mode === 'register') {
                // Registration still uses the legacy API (creates tenant + user)
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        forInvite
                            ? { action: 'register', email, password, name }
                            : { action: 'register', email, password, name, orgName },
                    ),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    // A named refusal in the user's language (#4686); the
                    // route's English sentence only for one it does not name.
                    if (res.status === 429) throw new Error(t('tooManyRegistrations'));
                    const code: unknown = data?.code;
                    throw new Error(
                        isRegisterRefusal(code)
                            ? t(`refused.${code}`)
                            : extractErrorMessage(data?.error, t('registrationFailed')),
                    );
                }
                // After registration, sign in with credentials
            }

            // Sign in via NextAuth credentials provider
            const result = await signIn('credentials', {
                email: submitEmail,
                password: submitPassword,
                redirect: false,
                callbackUrl,
            });

            if (result?.error) {
                // Every workspace this person belongs to enforces single
                // sign-on: reload on that notice, with its SSO form open.
                if (ssoRequiredWorkspace(result.error)) {
                    const notice = new URL('/login', window.location.origin);
                    notice.searchParams.set('error', result.error);
                    window.location.href = notice.toString();
                    return;
                }
                if (result.error === EMAIL_NOT_VERIFIED_SIGN_IN_ERROR) {
                    throw new Error(t('emailNotVerified'));
                }
                const raw = extractErrorMessage(result.error, t('loginFailed'));
                throw new Error(raw === 'CredentialsSignin' ? t('invalidCredentials') : raw);
            }

            // Force a native hard redirect. 
            // Using router.push() + router.refresh() synchronously causes App Router transition 
            // cancellations/race conditions, leaving the user stuck on /login permanently.
            window.location.href = callbackUrl;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleResendVerification = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!resendEmail) return;
        setResendState('sending');
        try {
            await fetch('/api/auth/verify-email/resend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: resendEmail }),
            });
        } catch {
            // Uniform response is the whole point — we never branch on
            // outcome here either. Network errors get the same "sent"
            // state so the UI doesn't leak that the backend is reachable
            // for some emails and not others.
        }
        setResendState('sent');
    };

    const handleOAuthSignIn = async (provider: string) => {
        setError('');
        setLoading(true);
        try {
            await signIn(provider, { callbackUrl });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page p-4">
            {/* Background effects */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-40 -right-40 w-80 h-80 rounded-full bg-[var(--brand-default)]/10 blur-3xl" />
                <div className="absolute -bottom-40 -left-40 w-80 h-80 rounded-full bg-[var(--brand-emphasis)]/10 blur-3xl" />
            </div>

            <div className="relative w-full max-w-md">
                {/* Logo wordmark — the shield mark moved to the AISVS L2
                    compliance badge below the sign-in options. */}
                <div className="text-center mb-8 animate-fadeIn">
                    <Heading level={1}>
                        {t('title')}
                    </Heading>
                    <p className="text-content-muted text-sm mt-1">{t('subtitle')}</p>
                </div>

                {/* Form */}
                <Card className="animate-fadeIn">
                    <Heading level={2} className="mb-6">
                        {mode === 'login' ? t('signIn') : forInvite ? t('registerAccount') : t('register')}
                    </Heading>

                    {error && (
                        <InlineNotice variant="error" className="mb-4" icon={null}>
                            {error}
                        </InlineNotice>
                    )}
                    {!error && errorCode && (
                        <InlineNotice id="login-error-notice" variant="error" className="mb-4" icon={null}>
                            {t(loginErrorKey(errorCode))}
                        </InlineNotice>
                    )}

                    {verifyStatus === 'verified' && (
                        <InlineNotice variant="success" className="mb-4" icon={null}>
                            {t('emailVerified')}
                        </InlineNotice>
                    )}
                    {verifyStatus === 'expired' && (
                        <InlineNotice variant="warning" className="mb-4" icon={null}>
                            {t('linkExpired')}
                        </InlineNotice>
                    )}
                    {verifyStatus === 'invalid' && (
                        <InlineNotice variant="warning" className="mb-4" icon={null}>
                            {t('linkInvalid')}
                        </InlineNotice>
                    )}

                    {searchParams?.get('reset') === 'success' && (
                        <InlineNotice variant="success" className="mb-4" icon={null}>
                            {t('resetSuccess')}
                        </InlineNotice>
                    )}
                    {searchParams?.get('passwordChanged') === '1' && (
                        <InlineNotice variant="success" className="mb-4" icon={null}>
                            {t('passwordChanged')}
                        </InlineNotice>
                    )}

                    {/* OAuth Buttons — Polish PR-4: <Button variant="secondary">
                        instead of hand-rolled slate utility classes. The
                        SVG icons keep their brand colours (Google's
                        red/blue/green/yellow, Microsoft's four-square)
                        because those are the third-party brand marks. */}
                    <div className="space-y-compact mb-6">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleOAuthSignIn('google')}
                            disabled={loading}
                            className="w-full gap-default"
                        >
                            {t('continueWithGoogle')}
                            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleOAuthSignIn('microsoft-entra-id')}
                            disabled={loading}
                            className="w-full"
                        >
                            {t('continueWithMicrosoft')}
                            <svg className="w-5 h-5" viewBox="0 0 21 21" aria-hidden="true">
                                <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                                <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                                <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                                <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                            </svg>
                        </Button>
                        <SsoSignIn
                            returnTo={requestedDestination ? callbackUrl : undefined}
                            initialWorkspace={searchParams?.get('sso') ?? ssoRequiredWorkspace(errorCode) ?? undefined}
                        />
                    </div>

                    {credentialsEnabled && (
                        <>
                            {/* Divider */}
                            <div className="relative mb-6">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border-subtle" />
                                </div>
                                <div className="relative flex justify-center text-xs">
                                    <span className="px-2 bg-bg-page text-content-muted">{t('orContinueWithEmail')}</span>
                                </div>
                            </div>

                            {/* Credentials Form */}
                            {/* id="credentials-form" lets E2E scope its
                                selectors inside this form so the resend-
                                verification form below (which has its own
                                email + submit button) doesn't collide with
                                `input[type="email"]` / `button[type="submit"]`
                                lookups. Don't drop this id without updating
                                tests/e2e/e2e-utils.ts. */}
                            <form id="credentials-form" onSubmit={handleCredentialsSubmit} method="post" action="#" className="space-y-default">
                                {mode === 'register' && forInvite && (
                                    <p id="login-invite-account-only" className="text-sm text-content-muted">
                                        {t('inviteAccountOnly')}
                                    </p>
                                )}
                                {mode === 'register' && (
                                    <>
                                        <FormField label={t('name')} required>
                                            <Input id="login-name" name="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder={t('namePlaceholder')} />
                                        </FormField>
                                        {!forInvite && (
                                            <FormField label={t('orgName')} required>
                                                <Input id="login-org-name" name="orgName" value={orgName} onChange={(e) => setOrgName(e.target.value)} required placeholder={t('orgPlaceholder')} />
                                            </FormField>
                                        )}
                                    </>
                                )}
                                <FormField label={t('email')} required>
                                    <Input id="login-email" type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder={t('emailPlaceholder')} />
                                </FormField>
                                <FormField label={t('password')} required>
                                    {/* The policy's limits when SETTING a password. Sign-in
                                        checks none: an account whose password predates the
                                        policy must still get in (#4686). */}
                                    <Input
                                        id="login-password"
                                        type="password"
                                        name="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        placeholder={t('passwordPlaceholder')}
                                        minLength={mode === 'register' ? MIN_PASSWORD_LENGTH : undefined}
                                        maxLength={mode === 'register' ? MAX_PASSWORD_LENGTH : undefined}
                                    />
                                </FormField>
                                <div className="text-right -mt-2">
                                    <a href="/forgot-password" className="text-xs text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">{t('forgotPassword')}</a>
                                </div>
                                <Button type="submit" variant="primary" size="sm" className="w-full" disabled={loading}>
                                    {loading ? t('pleaseWait') : mode === 'login' ? t('submitLogin') : t('submitRegister')}
                                </Button>
                            </form>

                            <div className="mt-6 text-center text-sm text-content-muted">
                                {mode === 'login' ? (
                                    <span>{t('noAccount')} <button onClick={() => setMode('register')} className="text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">{t('registerLink')}</button></span>
                                ) : (
                                    <span>{t('hasAccount')} <button onClick={() => setMode('login')} className="text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)]">{t('signInLink')}</button></span>
                                )}
                            </div>

                            {/* Resend verification — shown unconditionally because
                                the endpoint returns a uniform response regardless
                                of whether the email is registered / verified / rate-
                                limited, so exposing the form doesn't leak account
                                state. Sits below the sign-in/register toggle so it
                                doesn't steal the primary eye path. */}
                            <div className="mt-6 pt-4 border-t border-border-subtle">
                                {resendState === 'sent' ? (
                                    <p
                                        role="status"
                                        className="text-xs text-content-muted text-center"
                                    >
                                        {t('resendSent')}
                                    </p>
                                ) : (
                                    <form
                                        onSubmit={handleResendVerification}
                                        className="flex items-center gap-tight"
                                    >
                                        <input
                                            type="email"
                                            name="resendEmail"
                                            aria-label={t('resendAria')}
                                            className="input flex-1 text-xs"
                                            placeholder={t('resendPlaceholder')}
                                            value={resendEmail}
                                            onChange={(e) => setResendEmail(e.target.value)}
                                        />
                                        <button
                                            type="submit"
                                            disabled={resendState === 'sending' || !resendEmail}
                                            className="text-xs text-content-emphasis underline underline-offset-2 hover:text-[var(--brand-default)] disabled:text-content-subtle disabled:no-underline"
                                        >
                                            {resendState === 'sending' ? t('sending') : t('resend')}
                                        </button>
                                    </form>
                                )}
                            </div>
                        </>
                    )}

                    {/* AISVS L2 compliance badge — the shield mark relocated
                        here as a trust signal below the sign-in options.
                        Rendered unconditionally so it shows in OAuth-only
                        (prod) as well as credentials mode. */}
                    <div className="mt-6 pt-4 border-t border-border-subtle flex flex-col items-center gap-tight text-center">
                        <div className="w-10 h-10 rounded-lg bg-[var(--brand-default)] flex items-center justify-center">
                            <svg className="w-6 h-6 text-content-inverted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                            </svg>
                        </div>
                        <p className="text-xs text-content-muted">{t('aisvsBadge')}</p>
                    </div>
                </Card>
            </div>
        </div>
    );
}

function LoginFallback() {
    const t = useTranslations('common');
    return (
        <div className="min-h-screen flex items-center justify-center bg-bg-page">
            <div className="text-content-muted">{t('loading')}</div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<LoginFallback />}>
            <LoginForm />
        </Suspense>
    );
}
