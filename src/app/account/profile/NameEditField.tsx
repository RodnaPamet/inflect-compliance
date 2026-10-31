'use client';
/**
 * `<NameEditField>` — capture the user's first + last name (UI roadmap 14b).
 *
 * The owner / assignee columns and the top-bar show the user's NAME, falling
 * back to the email local-part ("username") when none is set. This form lets a
 * user set a real name so those surfaces read as a person. First + last are
 * composed server-side into the single `User.name` field.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { refreshSessionClaims } from '@/lib/auth/refresh-session-claims';

/** Split an existing single display name into first / rest-as-last. */
function splitName(name: string | null): { first: string; last: string } {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { first: '', last: '' };
    const idx = trimmed.indexOf(' ');
    if (idx === -1) return { first: trimmed, last: '' };
    return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1).trim() };
}

export function NameEditField({ initialName }: { initialName: string | null }) {
    const t = useTranslations('account.profile');
    const initial = splitName(initialName);
    const [firstName, setFirstName] = useState(initial.first);
    const [lastName, setLastName] = useState(initial.last);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setSuccess(false);
        if (!firstName.trim() && !lastName.trim()) {
            setError(t('enterAName'));
            return;
        }
        setLoading(true);
        try {
            const res = await fetch('/api/account/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firstName, lastName }),
            });
            if (res.ok) {
                setSuccess(true);
                // Re-mint the session so the top bar and this form read the
                // new name now rather than at the next sign-in (#4644), then
                // re-render the server components with it.
                await refreshSessionClaims();
                router.refresh();
            } else {
                const data: unknown = await res.json().catch(() => null);
                setError(apiErrorMessage(data, t('couldNotSaveName')));
            }
        } catch {
            setError(t('couldNotSaveName'));
        }
        setLoading(false);
    };

    return (
        <Card className="animate-fadeIn mt-6">
            <Heading level={2} className="mb-6">
                {t('nameTitle')}
            </Heading>
            {success && (
                <InlineNotice variant="success" className="mb-4" icon={null}>
                    {t('nameSaved')}
                </InlineNotice>
            )}
            {error && (
                <InlineNotice variant="error" className="mb-4" icon={null}>
                    {error}
                </InlineNotice>
            )}
            <form onSubmit={handleSubmit} className="space-y-default">
                <FormField label={t('firstName')}>
                    <Input
                        id="profile-first-name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        autoComplete="given-name"
                        maxLength={100}
                    />
                </FormField>
                <FormField label={t('lastName')}>
                    <Input
                        id="profile-last-name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        autoComplete="family-name"
                        maxLength={100}
                    />
                </FormField>
                <Button type="submit" variant="primary" disabled={loading}>
                    {loading ? t('saving') : t('saveName')}
                </Button>
            </form>
        </Card>
    );
}
