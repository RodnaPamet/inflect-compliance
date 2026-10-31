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
- **Self-hosted.** No online billing is connected. A banner reading **{{ui:admin.billing.selfHosted}}** appears, the upgrade buttons do not, and your operator manages the subscription. Every workspace on such a deployment is on the {{ui:admin.billing.planName.ENTERPRISE}} plan, with no plan limits, and the page says so.

## What you see

**{{ui:admin.billing.currentPlan}}.** Four facts:

| Item | What it shows |
| --- | --- |
| {{ui:admin.billing.plan}} | The workspace's plan: {{ui:admin.billing.planName.FREE}}, {{ui:admin.billing.planName.TRIAL}}, {{ui:admin.billing.planName.PRO}} or {{ui:admin.billing.planName.ENTERPRISE}}. With online billing, a workspace that has never bought a plan reads {{ui:admin.billing.planName.FREE}} |
| {{ui:admin.billing.status}} | The subscription state: {{ui:admin.billing.statusName.ACTIVE}}, {{ui:admin.billing.statusName.TRIALING}}, {{ui:admin.billing.statusName.PAST_DUE}}, {{ui:admin.billing.statusName.CANCELED}} or {{ui:admin.billing.statusName.INCOMPLETE}} |
| {{ui:admin.billing.renewal}} | When the current paid period ends |
| {{ui:admin.billing.trialEnds}} | When the trial ends, and how many days are left |

When a payment has failed, **{{ui:admin.billing.paymentIssue}}** appears under the plan.

**The trial banner.** During a trial, a banner above the plan counts down the days left, and turns red in the last three days.

**{{ui:admin.billing.upgrade}}.** With online billing, on a free or trial plan, two cards describe the Pro and Enterprise plans, each with an upgrade button.

**{{ui:admin.billing.manageSubscription}}.** With online billing, once the workspace has a subscription: {{ui:admin.billing.manageSubscriptionBody}}

**{{ui:admin.billing.recentActivity}}.** The last 10 billing events received from Stripe, newest first: what happened ({{ui:admin.billingLog.events.checkoutCompleted}}, {{ui:admin.billingLog.events.subscriptionCreated}}, {{ui:admin.billingLog.events.subscriptionUpdated}}, {{ui:admin.billingLog.events.subscriptionCanceled}}, {{ui:admin.billingLog.events.paymentSucceeded}} or {{ui:admin.billingLog.events.paymentFailed}}), when, and the start of Stripe's own reference for the event. Any other kind of Stripe event is listed as another Stripe event, with its type. A workspace with none reads **{{ui:admin.billingLog.empty}}**.

## What you can do

### Upgrade the plan

Click the upgrade button on the Pro or Enterprise card, or in the trial banner. Inflect opens Stripe's checkout page in the same tab. When you finish or cancel there, Stripe returns you to this page, which says **{{ui:admin.billing.checkoutSuccessTitle}}** or **{{ui:admin.billing.checkoutCanceledTitle}}**. The new plan shows once Stripe has told Inflect about it, usually within moments.

### Manage the subscription

Click the button under **{{ui:admin.billing.manageSubscription}}**. Stripe's billing portal opens in the same tab, where you can change the payment method, see invoices or change the plan. When you leave the portal, it returns you to this page.

If either button fails, the reason the server gave appears under it, or **{{ui:admin.billing.actionFailed}}**, and nothing is changed.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.billing.selfHosted}}** | This deployment has no online billing | Ask your operator about the subscription |
| **{{ui:admin.billing.paymentIssue}}** | Stripe reported a failed payment | Click the button under **{{ui:admin.billing.manageSubscription}}** and update the payment method |
| **{{ui:admin.billingLog.empty}}** | Stripe has sent no events for this workspace | Nothing; events appear after a checkout |
| **{{ui:admin.billing.checkoutCanceledTitle}}** | You left Stripe's checkout without paying. {{ui:admin.billing.checkoutCanceledBody}} | Upgrade again when you are ready |

## Related

- [{{ui:admin.title}}](administration.md), the list of every admin page.
- [{{ui:nav.controls}}](../govern/controls.md), the records the plan limits.
