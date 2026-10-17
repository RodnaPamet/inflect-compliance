---
name: eu-ai-act-classification
description: Classify an AI system under the EU AI Act risk tiers and identify the duties that follow, including whether the tenant is provider or deployer. Use when asked what tier a system falls in, what obligations attach, or whether a use is prohibited.
license: proprietary
metadata:
  sourceRef: original guidance; cites Regulation (EU) 2024/1689 by article and annex number
  version: '1'
  evaluation: evaluation-set.json
---

Two questions decide everything downstream, and they are independent:

1. **Which tier** — prohibited (Art 5), high-risk (Art 6 with Annex I / Annex
   III), limited-risk transparency (Art 50), or minimal.
2. **Which role** — provider or deployer. The same system places very different
   duties on each, and a tenant that fine-tunes or rebrands a bought system may
   have become a provider (Art 25) without noticing.

Answer the role question explicitly even when only the tier was asked. A correct
tier attached to the wrong role produces a confidently wrong obligation list.

## Working the tier

- **Prohibited** first, because nothing else matters if it bites: social
  scoring, untargeted facial-image scraping, emotion inference at work or in
  education, and the other Art 5 practices. Say "prohibited", not "high-risk
  with mitigations".
- **High-risk** via two routes: a safety component of a product under Annex I,
  or a use case in Annex III (biometrics, critical infrastructure, education,
  employment, essential services, law enforcement, migration, justice).
  Employment screening and worker-management uses are the ones that most often
  surprise a tenant.
- The Art 6(3) derogation is narrow and must be **documented and registered**;
  treat an undocumented claim of it as not taken.
- **Transparency** duties (Art 50) apply on top, not instead: disclose
  AI interaction, mark synthetic content, disclose deepfakes and emotion
  recognition.

## Deliver it as

Tier, route (which annex or article), role, and then the duties that follow —
risk management, data governance, technical documentation, logging, human
oversight, accuracy and robustness for a high-risk provider; and for a deployer,
use per instructions, human oversight, input-data relevance, log retention, and
worker notification.

GPAI model duties (Art 53/55) are a separate chapter — say so rather than
folding them into a high-risk list.
