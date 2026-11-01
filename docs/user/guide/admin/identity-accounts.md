---
route: /t/[tenantSlug]/admin/integrations/identity-accounts
---

# {{ui:admin.identityAccounts.title}}

The {{ui:admin.identityAccounts.title}} page lists every account your directory connections have read, from Okta, Google Workspace, Microsoft Entra ID and Active Directory: whose it is, whether it is active, whether it is an administrator and has multi-factor authentication, and whether it matches a person in your HR records. Owners also mark accounts here that automated offboarding must never disable.

## Where to find it

On the [{{ui:admin.integrations.title}}](integrations.md) page, click **{{ui:admin.identityAccounts.linkLabel}}** in the header of {{ui:admin.integrations.configuredConnections}}. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.integrations}}** › **{{ui:admin.identityAccounts.breadcrumb}}**, and its steps go back.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and search the accounts | Owner, Admin |
| Protect an account from automated offboarding, or release it | Owner |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page. An Admin sees the accounts without the **{{ui:admin.identityAccounts.protect}}** and **{{ui:admin.identityAccounts.release}}** buttons, and a line under the title: **{{ui:admin.identityAccounts.protectOwnerOnly}}**

## What it is for

- **Before an access review.** A review of a connected application's accounts is built from these rows, so this is where you check that the directory sync produced what you expect.
- **Before turning on automated offboarding.** When a person leaves, the nightly leaver pass can disable their directory account. It finds that account through the match shown in the {{ui:admin.identityAccounts.colLinked}} column, and it never touches an account marked **{{ui:admin.identityAccounts.colProtected}}**. Break-glass and service accounts belong there.

## What you see

Search by email, name or directory ID, or filter by **{{ui:admin.identityAccounts.filters.provider}}**. The search runs over every synced account, not only the ones on screen.

| Column | What it shows |
| --- | --- |
| {{ui:admin.integrations.colProvider}} | The directory the account was read from |
| {{ui:admin.identityAccounts.colConnection}} | The connection that read it, by name. Shown only when a directory has more than one connection. A connection with no name reads "Unnamed connection" followed by the end of its ID |
| {{ui:admin.identityAccounts.colEmail}} | The account's email, or its display name when it has none |
| {{ui:admin.identityAccounts.colName}} | Its display name |
| {{ui:admin.integrations.colStatus}} | Its state in the directory when last read: **{{ui:admin.identityAccounts.statusLabels.ACTIVE}}**, **{{ui:admin.identityAccounts.statusLabels.SUSPENDED}}** or **{{ui:admin.identityAccounts.statusLabels.DEPROVISIONED}}**. **{{ui:admin.identityAccounts.disableApplied}}** or **{{ui:admin.identityAccounts.disableUnconfirmed}}** means the leaver pass disabled it since then; hover for when |
| {{ui:admin.identityAccounts.colAdmin}} | **{{ui:admin.identityAccounts.admin}}** for an administrator account |
| {{ui:admin.identityAccounts.colLinked}} | **{{ui:admin.identityAccounts.linked}}** when it matches one person in your HR records by work email, or **{{ui:admin.identityAccounts.unlinked}}** with the reason in words: no employee has that address, more than one does, or it is matched to someone else. **{{ui:admin.identityAccounts.unlinkedReasonUnknown}}** means the last match did not record why |
| {{ui:admin.identityAccounts.colProtected}} | **{{ui:admin.identityAccounts.protected}}** for a protected account (hover for the reason given), **{{ui:admin.identityAccounts.selfAccount}}** for the account the connection signs in as (hover for what that means), and, for an Owner, the **{{ui:admin.identityAccounts.protect}}** or **{{ui:admin.identityAccounts.release}}** button |
| {{ui:admin.identityAccounts.colMfa}} | **{{ui:admin.identityAccounts.mfaOn}}** or **{{ui:admin.identityAccounts.mfaOff}}** |
| {{ui:admin.identityAccounts.colSynced}} | When the account was last read |

The page shows a limited number of accounts at a time. When it reaches that limit it says so; search for an account to bring it into view.

## What you can do

### Protect an account from automated offboarding

1. Find the account, and click **{{ui:admin.identityAccounts.protect}}** on its row.
2. Under **{{ui:admin.identityAccounts.reasonLabel}}**, say why it must never be disabled automatically, for example that it is the break-glass administrator.
3. Click **{{ui:admin.identityAccounts.protect}}**.

The leaver pass then leaves the account alone, whatever HR says. The account a connection signs in as is never disabled anyway; protecting it records that decision.

Protection belongs to one account on one connection. If a person has accounts on two connections, protect each one.

### Release protection

Click **{{ui:admin.identityAccounts.release}}** on the row. A message offers **{{ui:admin.identityAccounts.undo}}** for 5 seconds; after that the account is no longer protected.

## What happens next

- Directory connections are read every night at 03:00 UTC. The leaver pass runs at 05:00 UTC, so a disable it applies shows here as **{{ui:admin.identityAccounts.disableApplied}}** until the next read confirms it.
- Accounts are matched to people after each complete sync. An account with **{{ui:admin.identityAccounts.unlinked}}** cannot be acted on by the leaver pass; fix the person's work email in your HR system, or the account's email in the directory.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.identityAccounts.empty}}** | No directory connection has synced yet | Connect and sync a directory on the [{{ui:admin.integrations.title}}](integrations.md) page |
| **{{ui:admin.identityAccounts.noMatches}}** | No account matches the search or the filter | Clear them |
| A note that only the first accounts are shown | There are more accounts than the page shows | Search for the one you want |
| **{{ui:admin.identityAccounts.loadError}}** | The accounts did not load | Reload the page |
| **{{ui:admin.identityAccounts.protectError}}** or **{{ui:admin.identityAccounts.releaseError}}** | The protection did not change | Try again. If it keeps failing, check that you are still an Owner |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.integrations.title}}](integrations.md), where directories are connected.
- [{{ui:admin.leaverPasses.title}}](identity-leaver-passes.md), the nightly offboarding passes.
- [{{ui:personnel.title}}](personnel.md), the HR roster accounts are matched against.
