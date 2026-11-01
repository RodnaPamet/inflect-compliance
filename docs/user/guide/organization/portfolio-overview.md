---
route: /org/[orgSlug]
---

# {{ui:org.dashboard.title}}

The {{ui:org.dashboard.title}} is the landing page of an organization: one dashboard that rolls up every workspace in the organization. It shows coverage, risks and overdue evidence across all of them, how healthy each workspace is, and three readings the organization keeps by hand: the threat level, security maturity and security initiatives.

## Where to find it

An organization groups several workspaces, for example the subsidiaries of a group. If you belong to one, the workspace switcher in the top bar (the pill with the workspace's name) lists it under **Organizations**, above your workspaces. Click the organization to open this page.

Inside the organization, the sidebar has its own items. Under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.portfolioOverview}}** to come back here. The same pill in the top bar now shows the organization's name; it lists your organizations and the organization's workspaces, so you can switch back into a workspace.

## Who can use it

An organization has three roles of its own, separate from the roles inside each workspace:

| Organization role | What it is for |
| --- | --- |
| {{ui:orgRoles.ORG_OWNER}} | Everything an admin can do, plus creating and removing workspaces and managing other owners. An organization always keeps at least one owner |
| {{ui:orgRoles.ORG_ADMIN}} | Runs the organization day to day. Gets Admin access to every workspace in the organization |
| {{ui:orgRoles.ORG_READER}} | Sees the portfolio summary only, with no access inside the workspaces |

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, Reader |
| Edit the dashboard: add, move, resize, reconfigure and remove widgets, or reset the layout | Owner, Admin |
| Update the threat level | Owner, Admin |
| Rate security maturity | Owner, Admin |

Someone who is not a member of the organization gets **{{ui:errorPage.notFoundTitle}}**, the same as for an organization that does not exist.

## What it is for

A group security officer needs one answer to "how are our companies doing?" without opening each workspace. This page gives it, and links down into the workspaces when a number needs explaining.

The figures come from a snapshot that each workspace takes once a day, at 05:00 UTC. A new workspace has no figures until its first snapshot; until then it counts as pending.

## What you see

**The header.** The title, how many workspaces the organization has, how many are still waiting for their first snapshot, and when the portfolio data was last refreshed.

**The widgets.** A grid of cards. The recommended layout includes:

| Widget | What it shows |
| --- | --- |
| {{ui:org.widgets.coverage}} | The share of applicable controls implemented, across every workspace, with its trend |
| {{ui:org.widgets.criticalRisks}} | How many open risks are critical, with the open and high counts below |
| {{ui:org.widgets.overdueEvidence}} | How many evidence items are past their review date, and how many fall due within 7 days |
| {{ui:org.widgets.tenants}} | How many workspaces the organization has, and how many have a snapshot |
| {{ui:org.widgets.tenantHealthDistribution}} | How many workspaces are healthy, at risk, in critical health or pending |
| {{ui:org.widgets.coverageByTenant}} | One row per workspace: its health, coverage, open and critical risks and overdue evidence. Click a row to open that workspace's dashboard |
| {{ui:org.widgets.drilldown}} | Links to {{ui:org.nav.nonPerformingControls}}, {{ui:org.nav.criticalRisks}} and {{ui:org.nav.overdueEvidence}}, with their counts |
| Trends | Open risks, control coverage and overdue evidence over the last 90 days |
| {{ui:org.widgets.threatLevel}} | The organization's current threat level, from Guarded to Severe, with a headline and who set it when |
| {{ui:org.widgets.securityMaturity}} | A radar of maturity, rated from Initial to Optimizing for each of the six NIST CSF functions |
| {{ui:org.widgets.securityInitiatives}} | Up to five security initiatives in flight, with their progress, and a **{{ui:org.widgets.viewAll}}** link to [{{ui:org.initiatives.title}}](initiatives.md) |

A workspace's health is worked out from its snapshot:

| Health | When |
| --- | --- |
| Red | Coverage below 60%, or 3 or more critical risks, or 10 or more overdue evidence items |
| Amber | Coverage below 80%, or any critical risk, or any overdue evidence |
| Green | Coverage of 80% or more, no critical risks and no overdue evidence |

## What you can do

### Update the threat level

On the {{ui:org.widgets.threatLevel}} card, click **{{ui:org.widgets.update}}**. Choose a level, write a headline (required) and, if you like, some context, then click **{{ui:org.widgets.setThreatLevel}}**. Click **{{ui:org.widgets.history}}** on the card to see earlier levels. A threat level not updated for 30 days is marked as possibly stale.

### Rate security maturity

On the {{ui:org.widgets.securityMaturity}} card, click **{{ui:org.widgets.rateMaturity}}**. For each function, choose a level; each choice is saved as you make it. The panel shows the level the portfolio's coverage suggests, as a hint only. A rating not updated for 90 days is marked as possibly stale.

### Edit the dashboard

Click **{{ui:org.dashboard.editDashboard}}**. You can then:

- drag a widget to move it, or drag its corner to resize it;
- click **{{ui:org.dashboard.addWidget}}** to add one;
- click a widget's gear icon to change its title, chart type or settings, or its bin icon to remove it;
- click **{{ui:org.dashboard.resetLayout}}** to discard your changes and restore the recommended layout.

Each change is saved as you make it, for everyone in the organization. Click **{{ui:org.dashboard.done}}** when you have finished.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.dashboard.onboardingTitle}}** | The organization has no workspaces yet | An owner creates one under [{{ui:org.nav.allTenants}}](workspaces.md) |
| **{{ui:org.dashboard.emptyTitle}}** | The dashboard has no widgets | An Owner or Admin edits the dashboard and adds some |
| **{{ui:org.widgets.notYetRated}}** | Nobody has rated maturity yet | An Owner or Admin rates it |
| **{{ui:org.widgets.postureEmpty}}** | Nobody has set a threat level yet | An Owner or Admin updates it |
| A red line above the widgets | A change to the layout was not saved | Try again |

## Related

- [{{ui:org.nav.allTenants}}](workspaces.md), every workspace in the organization with its health.
- [{{ui:org.initiatives.title}}](initiatives.md), the organization's security initiatives.
