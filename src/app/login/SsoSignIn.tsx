'use client';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';

interface DiscoveredProvider {
    id: string;
    protocol: 'oidc' | 'saml';
    name: string;
}

type Status = 'idle' | 'looking' | 'none' | 'failed';

/**
 * "Continue with single sign-on" on the sign-in page.
 *
 * The person names their workspace, never their email address: a provider's
 * email domains are typed in by a workspace admin and verified by nobody, so
 * routing by domain would let any workspace claim anyone's domain
 * (`/api/auth/sso/discover`). The start link is followed from this page, so
 * the browser reports the start as same-origin and `/start` accepts it
 * (`isCrossSiteStart` in src/lib/auth/sso-flow.ts).
 *
 * `/login?sso=<workspace>` opens the form with the workspace filled in. That
 * is the shareable form of an SSO link, and where `/start` sends a sign-in
 * that another site tried to begin.
 */
export function SsoSignIn({
    returnTo,
    initialWorkspace,
    navigate = (url) => window.location.assign(url),
}: {
    returnTo?: string;
    initialWorkspace?: string;
    navigate?: (url: string) => void;
}) {
    const t = useTranslations('login.sso');
    const [open, setOpen] = useState(Boolean(initialWorkspace));
    const [workspace, setWorkspace] = useState(initialWorkspace ?? '');
    const [status, setStatus] = useState<Status>('idle');
    const [choices, setChoices] = useState<DiscoveredProvider[]>([]);

    const startUrl = (slug: string, provider: DiscoveredProvider) => {
        const params = new URLSearchParams({ tenant: slug, provider: provider.id });
        if (returnTo) params.set('returnTo', returnTo);
        return `/api/auth/sso/${provider.protocol}/start?${params.toString()}`;
    };

    async function discover(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const slug = workspace.trim().toLowerCase();
        if (!slug) return;
        setStatus('looking');
        setChoices([]);
        try {
            const res = await fetch(`/api/auth/sso/discover?workspace=${encodeURIComponent(slug)}`);
            if (!res.ok) throw new Error(String(res.status));
            const { providers } = (await res.json()) as { providers: DiscoveredProvider[] };
            if (providers.length === 0) {
                setStatus('none');
            } else if (providers.length === 1) {
                navigate(startUrl(slug, providers[0]));
            } else {
                setChoices(providers);
                setStatus('idle');
            }
        } catch {
            setStatus('failed');
        }
    }

    if (!open) {
        return (
            <Button
                type="button"
                variant="secondary"
                id="sso-sign-in-toggle"
                className="w-full"
                onClick={() => setOpen(true)}
            >
                {t('continue')}
            </Button>
        );
    }

    const slug = workspace.trim().toLowerCase();
    return (
        <form id="sso-sign-in-form" onSubmit={discover} className="space-y-compact">
            <FormField label={t('workspaceLabel')} description={t('workspaceHint')}>
                <Input
                    id="sso-workspace"
                    name="workspace"
                    autoComplete="organization"
                    placeholder={t('workspacePlaceholder')}
                    value={workspace}
                    onChange={(e) => {
                        setWorkspace(e.target.value);
                        setStatus('idle');
                        setChoices([]);
                    }}
                    required
                />
            </FormField>
            {status === 'none' && (
                <InlineNotice variant="warning" icon={null}>
                    {t('notAvailable')}
                </InlineNotice>
            )}
            {status === 'failed' && (
                <InlineNotice variant="error" icon={null}>
                    {t('failed')}
                </InlineNotice>
            )}
            {choices.length > 0 ? (
                <div className="space-y-compact" role="group" aria-label={t('chooseProvider')}>
                    {choices.map((p) => (
                        <Button
                            key={p.id}
                            type="button"
                            variant="secondary"
                            className="w-full"
                            onClick={() => navigate(startUrl(slug, p))}
                        >
                            {t('continueWith', { name: p.name })}
                        </Button>
                    ))}
                </div>
            ) : (
                <Button
                    type="submit"
                    variant="secondary"
                    id="sso-sign-in-submit"
                    className="w-full"
                    disabled={status === 'looking' || !slug}
                >
                    {status === 'looking' ? t('looking') : t('submit')}
                </Button>
            )}
        </form>
    );
}
