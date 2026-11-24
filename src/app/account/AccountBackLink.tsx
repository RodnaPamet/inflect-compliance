import { TextLink } from '@/components/ui/text-link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from '@inflect/ui/components/ui/icons/glyphs/arrow-left';

/**
 * The way back into the app from the standalone account pages
 * (`/account/profile`, `/account/security`), which render no top bar or
 * sidebar — before this, the browser's back button was the only way out
 * (#4644). `/tenants` sends a person with one workspace straight to its
 * dashboard and shows the workspace picker otherwise.
 */
export async function AccountBackLink() {
    const t = await getTranslations('account');
    return (
        <TextLink
            href="/tenants"
            id="account-back-link"
            tone="muted"
            className="gap-tight text-sm hover:text-content-default"
        >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('backToWorkspaces')}
        </TextLink>
    );
}
