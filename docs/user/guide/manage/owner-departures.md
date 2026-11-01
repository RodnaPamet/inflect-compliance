---
route: /t/[tenantSlug]/agents/owner-orphan-pass
---

# {{ui:agents.orphanPass.title}}

The {{ui:agents.orphanPass.title}} page controls what happens to an agent whose accountable owner has left the workspace. {{ui:agents.orphanPass.intro}}

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.ownerOrphanPass}}**. The entry appears on the agent register's views menu, and only for Owners. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.orphanPass.crumbAgents}}** › **{{ui:agents.orphanPass.title}}**, and the same **{{ui:common.ui.viewsMenu}}** menu sits in the page header, so you can move to another agent view from here.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and change the mode | Owner |

Everyone else sees **{{ui:agents.orphanPass.accessTitle}}** instead of the page.

## How an owner counts as gone

An owner has left when they no longer hold an active membership in this workspace, or when the HR feed marks them as terminated. The HR match is by exact email address and must point to exactly one person; a name never counts.

## What you see

**{{ui:agents.orphanPass.modeHeading}}.** {{ui:agents.orphanPass.blurb}} The card shows the current mode and the button to move it one step.

**{{ui:agents.orphanPass.passesHeading}}.** {{ui:agents.orphanPass.passesIntro}} Each pass shows:

- when it ran, how it ended, and the mode it ran in:

  | Status | What it means |
  | --- | --- |
  | **{{ui:agents.orphanPass.passStatus.PASSED}}** | The pass checked every active agent |
  | **{{ui:agents.orphanPass.passStatus.PARTIAL}}** | It checked them, but something it asked for did not finish, such as a service principal it could not disable |
  | **{{ui:agents.orphanPass.passStatus.NOT_APPLICABLE}}** | It checked nothing, and says why |
  | **{{ui:agents.orphanPass.passStatus.ERROR}}** | The pass broke before it finished |

- how many agents it found without an owner and, in **{{ui:admin.writeLadder.mode.AUTOMATIC}}**, how many it stopped and how many it could not;
- when it ran at **{{ui:admin.writeLadder.mode.DISABLED}}**, or found nothing to check, the reason instead;
- each agent it found, by name and linked to the agent's page, with what was done to it. An agent that has since left the register is shown by its id:

  | Outcome | What it means |
  | --- | --- |
  | **{{ui:agents.orphanPass.outcome.WOULD_SUSPEND_AND_KILL}}** | A dry run found it; nothing was changed |
  | **{{ui:agents.orphanPass.outcome.SUSPENDED_AND_KILLED}}** | The agent was suspended and its stop switch engaged |
  | **{{ui:agents.orphanPass.outcome.SUSPENDED_KILL_ALREADY_IN_FORCE}}** | It was suspended; someone had already stopped it |
  | **{{ui:agents.orphanPass.outcome.FAILED}}** | Something did not complete; open the agent and check it |

  and the signals that showed the owner had left:

  | Signal | What it means |
  | --- | --- |
  | Membership, with its state | The owner's membership is not active. The state is one of: {{ui:agents.orphanPass.membership.INVITED}}, {{ui:agents.orphanPass.membership.DEACTIVATED}}, {{ui:agents.orphanPass.membership.REMOVED}}, or {{ui:agents.orphanPass.membership.ABSENT}} |
  | {{ui:agents.orphanPass.signal.HR_TERMINATED}} | The HR feed marks the owner as terminated |

  and, for a pass in **{{ui:admin.writeLadder.mode.DRY_RUN}}** or **{{ui:admin.writeLadder.mode.AUTOMATIC}}**, what happened to the agent's Entra service principal, in a sentence. The ones that need you are:

  | What it says | What to do |
  | --- | --- |
  | {{ui:agents.orphanPass.servicePrincipalStatus.LINK_UNCONFIRMED}} | Confirm the link on the agent's page; until then an automatic pass does not disable it |
  | {{ui:agents.orphanPass.servicePrincipalStatus.NO_PAIRED_ENDPOINT}} | Set up the connection that disables service principals, or disable it in Entra yourself |
  | {{ui:agents.orphanPass.servicePrincipalStatus.NO_APPROVED_TEMPLATE}} | Approve saved parameters for the disable on that connection |
  | {{ui:agents.orphanPass.servicePrincipalStatus.PROPOSED}} | Approve or reject the request in the agent proposals queue |
  | {{ui:agents.orphanPass.servicePrincipalStatus.QUARANTINED}} | Review it in the agent quarantine |
  | {{ui:agents.orphanPass.servicePrincipalStatus.FAILED}} | Check the principal in Entra; the request may or may not have reached it |

When the HR roster could not be read in full, a warning says so: {{ui:agents.orphanPass.rosterNotRead}}

## What you can do

### Move to the next mode

The modes go **{{ui:admin.writeLadder.mode.DISABLED}}** → **{{ui:admin.writeLadder.mode.DRY_RUN}}** → **{{ui:admin.writeLadder.mode.AUTOMATIC}}**, one step at a time.

1. Click the button that widens to the next mode.
2. Read what will change, and confirm.

| Moving to | What changes |
| --- | --- |
| {{ui:admin.writeLadder.mode.DRY_RUN}} | {{ui:agents.orphanPass.confirmBody.DRY_RUN}} |
| {{ui:admin.writeLadder.mode.AUTOMATIC}} | {{ui:agents.orphanPass.confirmBody.AUTOMATIC}} |

When a move is not allowed yet, the button is off and the reason is shown beside it, in a sentence:

| Reason | What to do |
| --- | --- |
| Dry run has lasted only some of its days | Wait. The sentence says how many days are left; dry run must last seven |
| Dry run has seen too few completed checks | Wait for the nightly pass to complete in dry run |
| Dry run has no recorded start | Choose **{{ui:admin.writeLadder.mode.DRY_RUN}}** again; that starts its seven days |
| The mode moves one step at a time | Move to the next mode first |
| The mode is above the highest this check acts at | Nothing; this version of the check does not act at that mode |

Before moving to **{{ui:admin.writeLadder.mode.AUTOMATIC}}**, compare a week of dry runs with who actually left.

### Narrow the mode

Click the button that narrows to the previous mode. It takes effect at the next pass, and asks for no confirmation. Leaving dry run, in either direction, restarts its seven days.

### After an agent is stopped

Only the agent's new owner can lift the stop, and only after an ownership transfer to them completes. Start the transfer on the agent's page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:agents.orphanPass.passesNone}} | The pass has not run since it was set up | Wait for the next run |
| {{ui:agents.orphanPass.refusal.MODE_DISABLED}} | The pass is off | Move it to dry run to start checking |
| {{ui:agents.orphanPass.refusal.NO_ACTIVE_AGENTS}} | There was nothing to check | Nothing, unless you expected active agents |
| {{ui:agents.orphanPass.loadError}} | The page could not load | Reload the page |
| {{ui:agents.orphanPass.saveError}} | The mode was not changed | Read the reason shown, and try again |

## Related

- [Agents](agents.md), the agent register, where an agent's owner is transferred.
- [Directory write policy](../admin/identity-write-policy.md), the same ladder for people's directory accounts.
