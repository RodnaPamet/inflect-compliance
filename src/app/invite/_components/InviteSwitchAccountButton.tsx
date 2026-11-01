'use client';

/**
 * "Sign out and use another account", for someone who opened an invitation
 * while signed in with a different email address (#4853).
 *
 * The page used to offer them "Sign in to accept". Signing in again with the
 * same account redeems the invitation in the sign-in callback, where the email
 * check fails only after the token has been claimed, so the link was used up
 * and the person got nothing. Signing out first leaves the invitation
 * untouched; the page then offers "Sign in to accept" to whoever comes back.
 */
import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function InviteSwitchAccountButton({ returnTo, id }: { returnTo: string; id: string }) {
    const t = useTranslations('invite');
    const [signingOut, setSigningOut] = useState(false);

    return (
        <Button
            type="button"
            variant="secondary"
            id={id}
            className="w-full"
            disabled={signingOut}
            loading={signingOut}
            onClick={() => {
                setSigningOut(true);
                void signOut({ callbackUrl: returnTo });
            }}
        >
            {t('switchAccount')}
        </Button>
    );
}
