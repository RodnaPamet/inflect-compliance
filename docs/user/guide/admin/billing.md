---
route: /t/[tenantSlug]/admin/billing
---

# {{ui:admin.billing.title}}

The {{ui:admin.billing.title}} page shows this workspace's plan and its subscription state, and is where an Owner or Admin upgrades the plan or manages payment. On a deployment that runs without online billing it shows the plan only, and says so.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.billing}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.crumb.billing}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Upgrade the plan, or open the billing portal | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can use the page only if that role can manage the workspace's settings.

## What it is for

A workspace's plan decides how much it can hold. Today the plan limits one thing, the number of controls: a free workspace can have 10, a trial or Pro workspace 100, and an Enterprise workspace has no limit. When the limit is reached, creating or installing more controls is refused until the plan is upgraded.

Inflect runs in one of two ways, and the page shows which:

- **With online billing.** Plans are bought and changed through Stripe, the payment service. Upgrade buttons and a link to Stripe's billing portal appear on this page.
- **Self-hosted.** No online billing is connected. A banner reading **{{ui:admin.billing.selfHosted}}** appears, the upgrade buttons do not, and your operator manages the subscription. Every workspace on such a deployment has no plan limits.

## What you see

**{{ui:admin.billing.currentPlan}}.** Four facts:

| Item | What it shows |
| --- | --- |
| {{ui:admin.billing.plan}} | The workspace's plan: FREE, TRIAL, PRO or ENTERPRISE. A workspace that has never bought a plan reads FREE |
| {{ui:admin.billing.status}} | The subscription state: ACTIVE, TRIALING, PAST DUE, CANCELED or INCOMPLETE |
| {{ui:admin.billing.renewal}} | When the current paid period ends |
| {{ui:admin.billing.trialEnds}} | When the trial ends, and how many days are left |

When a payment has failed, **{{ui:admin.billing.paymentIssue}}** appears under the plan.

**The trial banner.** During a trial, a banner above the plan counts down the days left, and turns red in the last three days.

**{{ui:admin.billing.upgrade}}.** With online billing, on a free or trial plan, two cards describe the Pro and Enterprise plans, each with an upgrade button.

**{{ui:admin.billing.manageSubscription}}.** With online billing, once the workspace has a subscription: {{ui:admin.billing.manageSubscriptionBody}}

**{{ui:admin.billing.recentActivity}}.** The last 10 billing events received from Stripe, newest first: what happened (a checkout completed, a subscription created, updated or canceled, a payment that succeeded or failed), when, and the start of Stripe's own reference for the event. A workspace with none reads **{{ui:admin.billingLog.empty}}**.

## What you can do

### Upgrade the plan

Click the upgrade button on the Pro or Enterprise card, or in the trial banner. Inflect opens Stripe's checkout page in the same tab. When you finish or cancel there, Stripe returns you to the {{ui:admin.title}} page. The new plan shows on this page once Stripe has told Inflect about it, usually within moments.

### Manage the subscription

Click the button under **{{ui:admin.billing.manageSubscription}}**. Stripe's billing portal opens in the same tab, where you can change the payment method, see invoices or change the plan.

If either button fails, a short message appears under it and nothing is changed.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.billing.selfHosted}}** | This deployment has no online billing | Ask your operator about the subscription |
| **{{ui:admin.billing.paymentIssue}}** | Stripe reported a failed payment | Click the button under **{{ui:admin.billing.manageSubscription}}** and update the payment method |
| **{{ui:admin.billingLog.empty}}** | Stripe has sent no events for this workspace | Nothing; events appear after a checkout |

## Related

- [{{ui:admin.title}}](administration.md), where Stripe returns you after a checkout.
- [{{ui:nav.controls}}](../govern/controls.md), the records the plan limits.
