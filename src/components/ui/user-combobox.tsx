"use client";

/**
 * Epic 55 Prompt 5 — shared <UserCombobox>.
 *
 * One canonical people-picker built on `<Combobox>`. Handles fetching
 * the tenant's membership list, projecting each member into a search-
 * friendly option label ("Alice Admin · alice@acme.com"), and exposing
 * a thin API so call sites can swap out free-text UUID inputs without
 * a big per-call boilerplate.
 *
 * Tenant safety:
 *   - Members are loaded from `/api/t/{tenantSlug}/admin/members`, which
 *     already enforces tenant scoping + admin/auditor RBAC on the
 *     server. We do not touch cross-tenant data.
 *   - The SWR key is the resolved `/users/assignable` URL (tenant in
 *     the path) so the cache is isolated per tenant.
 *
 * Modes:
 *   - Single-select (default) — the typical assignee / owner picker.
 *   - Multi-select (opt-in) — set `multiple={true}` and pass arrays to
 *     `selectedIds` / `onChange`. Reviewers / subscribers are the
 *     natural future clients of this mode.
 *
 * The returned value is the user's id (uuid). The label is rich
 * (name + email) to maximise fuzzy-match hits, but the outbound
 * contract is still "just a uuid" so every existing backend schema
 * (`ownerUserId`, `assigneeUserId`, `treatmentOwnerUserId`, …) works
 * untouched.
 */

import useSWR from 'swr';
import { useTranslations } from "next-intl";
import * as React from "react";
import { Combobox, type ComboboxOption } from "./combobox";
import { InitialsAvatar } from "@/components/ui/initials-avatar";

// ─── Types ──────────────────────────────────────────────────────────

export interface Member {
    id: string;
    name: string | null;
    // Email may be null when the PII middleware can't decrypt the
    // stored value (e.g. KEK mismatch). We render whatever we have and
    // fall back to a stable "User <shortId>" label when both are missing.
    email: string | null;
    image: string | null;
}

// ─── Shared props ───────────────────────────────────────────────────

interface BaseUserComboboxProps {
    tenantSlug: string;
    /**
     * Trigger id — the shared form primitives inject ids via
     * `<FormField>`. When the caller pins a stable id (e.g. for E2E),
     * pass it through.
     */
    id?: string;
    /** Hidden form-input name; same serialisation rules as Combobox. */
    name?: string;
    disabled?: boolean;
    required?: boolean;
    invalid?: boolean;
    placeholder?: string;
    searchPlaceholder?: string;
    /** Preserved for FormField-driven layouts. */
    "aria-describedby"?: string;
    /** Force the desktop popover (needed inside Modal/Sheet). */
    forceDropdown?: boolean;
    /** Match the button width to its trigger (form-field feel). */
    matchTriggerWidth?: boolean;
    /**
     * Trigger size, forwarded to the inner Combobox button. Defaults to the
     * Combobox default (md). Pass "sm" to line up with sibling sm dropdowns
     * (e.g. the Controls rail's Category/Frequency). Locked by
     * tests/guards/controls-quickview-interaction.test.ts for that rail.
     */
    size?: "sm" | "md" | "lg";
    /**
     * Pre-fetched member list. When supplied we skip the internal
     * useQuery — useful for server-rendered pages that already hold the
     * membership roster.
     */
    preloadedMembers?: Member[];
    /**
     * Client-side filter applied to members before they're projected
     * into options. Useful for scoping ("only ACTIVE members").
     */
    filter?: (member: Member) => boolean;
    /**
     * Server-side roster narrowing. `"task-reviewer"` lists only the
     * members a task's reviewer may be — those whose role can edit tasks
     * (#4278). The server decides, from roles the client never sees.
     */
    audience?: "task-reviewer";
    className?: string;
}

type SingleProps = BaseUserComboboxProps & {
    multiple?: false;
    selectedId: string | null;
    onChange: (userId: string | null, member: Member | null) => void;
};

type MultipleProps = BaseUserComboboxProps & {
    multiple: true;
    selectedIds: string[];
    onChange: (userIds: string[], members: Member[]) => void;
};

export type UserComboboxProps = SingleProps | MultipleProps;

// ─── Hook — shared members fetch ───────────────────────────────────

export function useTenantMembers(
    tenantSlug: string,
    options?: { enabled?: boolean; audience?: "task-reviewer" },
) {
    const enabled = options?.enabled ?? true;
    const rosterUrl = `/api/t/${tenantSlug}/users/assignable`;
    const audienceQuery = options?.audience ? `?audience=${options.audience}` : "";
    // Raw `useSWR` (not `useTenantSWR`) because this hook needs a custom
    // fetcher: it fails SILENTLY to an empty roster on a non-OK response
    // (the picker must never crash on an auth miss) and projects the raw
    // payload into `Member[]` — neither fits useTenantSWR's fixed apiGet
    // fetcher. The tenant slug is in the URL, so the cache is per-tenant.
    return useSWR<Member[]>(
        enabled ? `${rosterUrl}${audienceQuery}` : null,
        async (url: string): Promise<Member[]> => {
            // B1 — the picker reads from the non-admin `/users/assignable`
            // endpoint (gated by `assertCanRead`, which every signed-in
            // tenant member has). Pre-B1 it read `/admin/members` and
            // silently rendered an empty dropdown for EDITOR / READER users.
            // Admin-only callers needing session counts / invite-state /
            // deactivated rows still hit `/admin/members` directly.
            const res = await fetch(url);
            if (!res.ok) {
                // Fallback: empty roster rather than crashing the picker.
                return [];
            }
            const data: Array<{
                id: string;
                name: string | null;
                email: string;
                image: string | null;
            }> = await res.json();
            return data.map((m) => ({
                id: m.id,
                name: m.name,
                email: m.email,
                image: m.image,
            }));
        },
        { dedupingInterval: 60_000 },
    );
}

// ─── Option projection ─────────────────────────────────────────────

/**
 * A `v1:`/`v2:` envelope coming through to the UI means the PII
 * middleware didn't decrypt the field on its way out (decrypt failure
 * with the OLD fail-mode, OR — observed on prod 2026-04-29 — the
 * middleware not running on the read path at all). Treat ciphertext
 * the same as missing: the user shouldn't see encryption artefacts.
 */
function isCiphertextEnvelope(value: string): boolean {
    return value.startsWith('v1:') || value.startsWith('v2:');
}

function readableField(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (isCiphertextEnvelope(trimmed)) return null;
    return trimmed;
}

function memberLabel(member: Member): string {
    const name = readableField(member.name);
    const email = readableField(member.email);
    if (name && email) return `${name} · ${email}`;
    if (name) return name;
    if (email) return email;
    // Both fields unreadable (PII decrypt failure or middleware not
    // attached on the read path). Fall back to a stable opaque handle
    // so the picker still renders + the row is distinguishable.
    // Operators chasing "why is this label opaque?" see
    // `pii.decrypt_failure` in logs (or the middleware-attachment
    // telemetry once the diagnostic from C lands).
    return `User ${member.id.slice(0, 8)}`;
}

function toOption(member: Member): ComboboxOption<Member> {
    return {
        value: member.id,
        label: memberLabel(member),
        // Avatar roadmap P1 — the people-picker renders identity
        // through the shared `<InitialsAvatar>` primitive (one
        // renderer, app-wide). Initials derive from the name, falling
        // back to the email. P2 — `imageUrl` surfaces the member's
        // photo (OAuth `User.image` today) with initials as the
        // load-failure fallback.
        icon: (
            <InitialsAvatar
                value={
                    readableField(member.name) ??
                    readableField(member.email)
                }
                size="sm"
                imageUrl={member.image}
            />
        ),
        meta: member,
    };
}

// ─── Component ─────────────────────────────────────────────────────

export function UserCombobox(props: UserComboboxProps) {
    const t = useTranslations("common.members");
    const {
        tenantSlug,
        id,
        name,
        disabled,
        required,
        invalid,
        placeholder = t("unassigned"),
        searchPlaceholder = t("searchMembers"),
        "aria-describedby": ariaDescribedBy,
        forceDropdown = true,
        matchTriggerWidth = true,
        size,
        preloadedMembers,
        filter,
        audience,
        className,
    } = props;

    // Shared trigger props so the single + multi branches stay identical.
    const triggerProps = {
        className: className ?? "w-full",
        ...(size ? { size } : {}),
    };

    const query = useTenantMembers(tenantSlug, {
        enabled: !preloadedMembers,
        audience,
    });

    const members = preloadedMembers ?? query.data ?? [];
    const filtered = filter ? members.filter(filter) : members;

    const options = React.useMemo(
        () => filtered.map(toOption),
        [filtered],
    );

    if (props.multiple) {
        const selectedOptions = options.filter((o) =>
            props.selectedIds.includes(o.value),
        );
        return (
            <Combobox<true, Member>
                multiple
                id={id}
                name={name}
                disabled={disabled}
                required={required}
                invalid={invalid}
                aria-describedby={ariaDescribedBy}
                options={options}
                selected={selectedOptions}
                setSelected={(opts) =>
                    props.onChange(
                        opts.map((o) => o.value),
                        opts.map((o) => o.meta as Member),
                    )
                }
                loading={!preloadedMembers && query.isLoading}
                placeholder={placeholder}
                searchPlaceholder={searchPlaceholder}
                emptyState={t("noMembersMatch")}
                forceDropdown={forceDropdown}
                matchTriggerWidth={matchTriggerWidth}
                buttonProps={triggerProps}
                caret
            />
        );
    }

    const selected =
        options.find((o) => o.value === props.selectedId) ?? null;

    return (
        <Combobox<false, Member>
            id={id}
            name={name}
            disabled={disabled}
            required={required}
            invalid={invalid}
            aria-describedby={ariaDescribedBy}
            options={options}
            selected={selected}
            setSelected={(option) =>
                props.onChange(
                    option?.value ?? null,
                    (option?.meta as Member | undefined) ?? null,
                )
            }
            loading={!preloadedMembers && query.isLoading}
            placeholder={placeholder}
            searchPlaceholder={searchPlaceholder}
            emptyState={t("noMembersMatch")}
            forceDropdown={forceDropdown}
            matchTriggerWidth={matchTriggerWidth}
            buttonProps={triggerProps}
            caret
        />
    );
}
