'use client';

/**
 * Epic O-4 — Tenant creation form (org context).
 *
 * Three fields: name, slug, framework. Only `name` and `slug` are
 * POSTed to `/api/org/{slug}/tenants` (Epic O-2 contract); the
 * framework selection is captured client-side and threaded through to
 * the new tenant's frameworks page on success so the user lands one
 * click away from installation. When "Choose later" is selected, we
 * just redirect to the new tenant's dashboard.
 *
 * The slug is auto-derived from the name on the first keystroke and
 * stops auto-syncing once the user edits it manually — the same
 * UX pattern used in the standard onboarding flow.
 *
 * Validation mirrors the server schema (`CreateOrgTenantInput` in
 * `organization.schemas.ts`) so the user gets fast feedback without a
 * round-trip; the server remains the source of truth.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getCsrfToken } from 'next-auth/react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button, buttonVariants } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';

interface Props {
    orgSlug: string;
}

interface FrameworkOption {
    key: string;
    label: string;
    description: string;
}

type OrgTranslate = ReturnType<typeof useTranslations>;

// The framework catalog lives behind a per-tenant context and isn't
// reachable from org-scope, so the picker shows a curated short list
// of the well-known compliance frameworks (matches the catalog used
// on the per-tenant frameworks page). "later" is the no-redirect
// fall-through. Framework names are proper nouns (kept verbatim);
// only "Choose later" + the descriptions are localized.
function buildFrameworkOptions(t: OrgTranslate): FrameworkOption[] {
    return [
        { key: 'later', label: t('newTenant.fwChooseLater'), description: t('newTenant.fwChooseLaterDesc') },
        { key: 'ISO27001', label: 'ISO/IEC 27001', description: t('newTenant.fwIso27001Desc') },
        { key: 'NIS2', label: 'NIS2', description: t('newTenant.fwNis2Desc') },
    ];
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

interface FieldErrors {
    name?: string;
    slug?: string;
}

/**
 * Re-mint the NextAuth JWT cookie so the OWNER membership the server
 * just granted on the new tenant is reflected in the token BEFORE we
 * navigate into the tenant. Without this the Edge tenant-access gate —
 * which reads membership claims straight from the JWT with no DB hit —
 * would bounce the redirect to /no-tenant, because those claims are
 * otherwise frozen at sign-in.
 *
 * The app deliberately mounts no <SessionProvider> (session is resolved
 * server-side via `auth()`), so we can't use `useSession().update()`.
 * We POST the NextAuth session-update endpoint directly — exactly what
 * `update()` does internally — which re-runs the `jwt` callback with
 * `trigger: 'update'`; see `applyMembershipClaims` in `src/auth.ts`.
 * Best-effort — a failure here just means the user may need a manual
 * refresh, never a broken create.
 */
async function refreshSessionClaims(): Promise<void> {
    try {
        const csrfToken = await getCsrfToken();
        if (!csrfToken) return;
        await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ csrfToken, data: {} }),
        });
    } catch {
        /* best-effort — navigation below still proceeds */
    }
}

function validate({ name, slug }: { name: string; slug: string }, t: OrgTranslate): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
        errors.name = t('newTenant.nameRequired');
    } else if (trimmedName.length > 120) {
        errors.name = t('newTenant.nameTooLong');
    }
    const trimmedSlug = slug.trim();
    if (!trimmedSlug) {
        errors.slug = t('newTenant.slugRequired');
    } else if (!SLUG_RE.test(trimmedSlug)) {
        errors.slug = t('newTenant.slugInvalid');
    }
    return errors;
}

export function NewTenantForm({ orgSlug }: Props) {
    const router = useRouter();
    const t = useTranslations('org');
    const FRAMEWORK_OPTIONS = useMemo(() => buildFrameworkOptions(t), [t]);

    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [framework, setFramework] = useState<string>('later');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [touched, setTouched] = useState<{ name: boolean; slug: boolean }>({
        name: false,
        slug: false,
    });

    const errors = useMemo(() => validate({ name, slug }, t), [name, slug, t]);
    const hasErrors = Boolean(errors.name || errors.slug);

    const onNameChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            setName(next);
            if (!slugTouched) {
                setSlug(slugify(next));
            }
        },
        [slugTouched],
    );

    const onSlugChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setSlug(e.target.value);
        setSlugTouched(true);
    }, []);

    const onSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setTouched({ name: true, slug: true });
            if (hasErrors) return;

            setSubmitting(true);
            setSubmitError(null);
            try {
                const res = await fetch(`/api/org/${orgSlug}/tenants`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
                });
                if (!res.ok) {
                    let message = t('newTenant.tenantCreationFailed', { status: res.status });
                    try {
                        const body = (await res.json()) as { error?: { message?: string } };
                        if (body?.error?.message) message = body.error.message;
                    } catch {
                        /* response wasn't JSON; keep the generic message */
                    }
                    setSubmitError(message);
                    setSubmitting(false);
                    return;
                }
                const body = (await res.json()) as { tenant: { slug: string } };
                const newSlug = body.tenant.slug;
                // Pick up the just-granted OWNER membership in the JWT
                // before navigating into the new tenant (see helper above).
                await refreshSessionClaims();
                if (framework === 'later') {
                    router.push(`/t/${newSlug}/dashboard`);
                } else {
                    // Land on the frameworks page with a hint so the user
                    // can install the chosen framework in one step.
                    router.push(`/t/${newSlug}/frameworks?install=${framework}`);
                }
            } catch (err) {
                setSubmitError(
                    err instanceof Error
                        ? err.message
                        : t('newTenant.unexpectedCreate'),
                );
                setSubmitting(false);
            }
        },
        [orgSlug, name, slug, framework, hasErrors, router, t],
    );

    return (
        <div className="max-w-xl mx-auto space-y-section">
            <div>
                <Link
                    href={`/org/${orgSlug}/tenants`}
                    className="inline-flex items-center gap-1 text-sm text-content-muted hover:text-content-emphasis"
                    data-testid="org-new-tenant-back"
                >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    {t('newTenant.backToTenants')}
                </Link>
                <Heading level={1} className="mt-3">
                    {t('newTenant.title')}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('newTenant.subtitle')}
                </p>
            </div>

            <form
                onSubmit={onSubmit}
                noValidate
                data-testid="org-new-tenant-form"
                className={cn(cardVariants(), 'space-y-default')}
            >
                <FormField
                    label={t('newTenant.nameLabel')}
                    description={t('newTenant.nameDesc')}
                    error={touched.name ? errors.name : undefined}
                    required
                >
                    <Input
                        name="name"
                        value={name}
                        onChange={onNameChange}
                        onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                        autoComplete="off"
                        autoFocus
                        maxLength={120}
                        placeholder="Acme EU Operations"
                        data-testid="org-new-tenant-name"
                    />
                </FormField>

                <FormField
                    label={t('newTenant.slugLabel')}
                    description={t('newTenant.slugDesc')}
                    error={touched.slug ? errors.slug : undefined}
                    required
                >
                    <Input
                        name="slug"
                        value={slug}
                        onChange={onSlugChange}
                        onBlur={() => setTouched((t) => ({ ...t, slug: true }))}
                        autoComplete="off"
                        maxLength={64}
                        placeholder="acme-eu"
                        data-testid="org-new-tenant-slug"
                    />
                </FormField>

                {/* Elevation PR-8 — fieldset/legend/native-radio cocktail
                    replaced with the canonical <RadioGroup> primitive
                    (Radix-backed). Card-shape labels preserved, but
                    state + a11y now flow through Radix. data-testid
                    naming preserved verbatim — no spec changes. */}
                <div className="space-y-tight" data-testid="org-new-tenant-framework-group">
                    <p className="text-sm font-medium text-content-emphasis">
                        {t('newTenant.startingFramework')}
                    </p>
                    <p className="text-xs text-content-muted">
                        {t('newTenant.frameworkHint')}
                    </p>
                    <RadioGroup
                        value={framework}
                        onValueChange={(v) => setFramework(v as typeof framework)}
                        aria-label={t('newTenant.frameworkAria')}
                        className="space-y-1.5 pt-1"
                    >
                        {FRAMEWORK_OPTIONS.map((opt) => {
                            const id = `org-new-tenant-framework-${opt.key}`;
                            const checked = framework === opt.key;
                            return (
                                <label
                                    key={opt.key}
                                    htmlFor={id}
                                    className={`flex items-start gap-compact rounded-lg border p-3 cursor-pointer transition-colors duration-150 ease-out ${
                                        checked
                                            ? 'border-border-emphasis bg-bg-subtle'
                                            : 'border-border-subtle hover:bg-bg-muted'
                                    }`}
                                >
                                    <RadioGroupItem
                                        id={id}
                                        value={opt.key}
                                        size="sm"
                                        className="mt-0.5"
                                        data-testid={id}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-content-emphasis">
                                            {opt.label}
                                        </p>
                                        <p className="text-xs text-content-muted">
                                            {opt.description}
                                        </p>
                                    </div>
                                </label>
                            );
                        })}
                    </RadioGroup>
                </div>

                {submitError && (
                    <p
                        className="text-sm text-content-error"
                        role="alert"
                        data-testid="org-new-tenant-error"
                    >
                        {submitError}
                    </p>
                )}

                <div className="flex items-center justify-end gap-tight pt-2">
                    <Link
                        href={`/org/${orgSlug}/tenants`}
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        data-testid="org-new-tenant-cancel"
                    >
                        {t('common.cancel')}
                    </Link>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={submitting}
                        disabled={submitting || hasErrors}
                        data-testid="org-new-tenant-submit"
                        text={submitting ? t('newTenant.creating') : t('newTenant.createTenant')}
                    />
                </div>
            </form>
        </div>
    );
}
