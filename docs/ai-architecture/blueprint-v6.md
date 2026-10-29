> **Status: historical record (2026-10-29)** — the target-state blueprint as
> received from the owner on 2026-10-29 (the "Enterprise AI SaaS Architecture
> Blueprint (v6)" markdown plus the companion diagram), transcribed here so the
> input to the planning exercise is durable. It describes an intended end state,
> not shipped behaviour. The authoritative mapping of this target onto the
> codebase — what exists, what is missing, in what order it lands — is
> [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md). Where this
> document and the codebase disagree about the present, the codebase wins; where
> it and the master roadmap disagree about the future, the master roadmap wins,
> because it records the decisions taken since.

# Enterprise AI SaaS Architecture Blueprint (v6) — as received

## Components named on the diagram that the markdown below does not name

The diagram carries more boxes than the markdown. They are listed here because
several of them are the frameworks the per-framework roadmaps exist for.

| Layer | Diagram box | In the markdown? |
| --- | --- | --- |
| 1 — Security, guards & alignment | NVIDIA Morpheus · NeMo Guardrails · **nemoclaw** · Microsoft Presidio | nemoclaw: no |
| 2 — Orchestration & workflow | Langflow · **TS Client (`@datastax/langflow-client`, "replaces Dify for flow design")** · Flue Framework ("native TypeScript master orchestrator, persistent state, subagents, skills") | TS client: no |
| 3 — Cognitive & reasoning | NVIDIA Nemotron (Super/Ultra NIMs — reason, plan, act) · **Supervisor Agent & Worker Runtime** · Claude Agent SDK (TypeScript client) · NVIDIA cuOpt ("optimisation tool for ERP/SAP scheduling & logistics routing") | supervisor/worker split: implied only |
| 4 — Knowledge & deep RAG | RAGFlow · NVIDIA Nemotron Retriever (NIM embeddings & reranking) · Weaviate ("vector DB & multi-tenant isolation") · Langfuse / **LlamaIndex** ("tracing & observability") | LlamaIndex: no |
| 5 — Runtime, runtimes & infrastructure | NVIDIA Triton Inference Server ("optimised multi-tenant model serving, dynamic batching") · NVIDIA NIM ("deployment containers for models, Retriever, Morpheus, cuOpt") · **TypeScript API Gateway & Microservices** | gateway: no |
| Security evaluation & testing (right-hand column) | **Garak** (security testing) → Validation: **Ragas** (testing) · **ARES** (diagnostic testing) · **SWE-bench** (testing) · **Inspect** | none of these |

Two operator instructions arrived with the diagram and are binding on the master
roadmap:

1. Layer 5 is to be planned on a **serverless GPU provider — Modal — for
   Nemotron 3 Super**, not on rented always-on GPUs as §5 below assumes.
2. Layer 5 is **optional**: when a deployment uses an online LLM API, none of
   Layer 5 is deployed.

One edit to the transcription below: the sample `apiKey` placeholder in
§6A carries a `pragma: allowlist secret` comment, because the repository's
secret guardrail (`tests/guardrails/no-secrets.test.ts`) reads its shape as a
credential. Everything else is verbatim.

---

# Enterprise AI SaaS Architecture Blueprint (v6)
### Technical & Operational Specifications for Infleqt.io (TypeScript-Native, Permissive Open-Source, and NVIDIA-Enhanced Agentic Stack)

This blueprint outlines the target-state, high-performance, and business-friendly multi-agent architecture for **Infleqt.io**. It is designed for multi-tenant Enterprise SaaS, specifically tailored for secure corporate process automation, ERP/SAP data ingestion, and scalable agentic workflows without licensing risks.

---

## 1. Architectural Overview & System Map

```text
             ┌──────────────────────────────────────────────┐
             │            Users & Inbound Intents           │
             └──────────────────────┬───────────────────────┘
                                    │ (Incoming API / Network Traffic)
┌───────────────────────────────────▼───────────────────────────────────┐
│ LAYER 1: SECURITY, PRIVACY & GUARDRAILS                               │
│  ├── NVIDIA Morpheus (Network-Level ML Security & Anomaly Detection)  │
│  ├── NeMo Guardrails (Conversational Boundaries & Input Prompt Safety)│
│  └── Microsoft Presidio (Automated PII Masking & Redaction)          │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ LAYER 2: ORCHESTRATION & WORKFLOW                                     │
│  ├── Langflow (Visual Multi-Agent Chain & Rapid Prototype Designer)   │
│  └── Flue Framework (Durable TypeScript State Machine & Coordinator)   │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ LAYER 3: COGNITION & REASONING (The "Brains")                         │
│  ├── Claude 3.5 Sonnet (Cloud Supervisor / Planner Layer)             │
│  └── NVIDIA Nemotron / Qwen (Local Reasoning Workers & Function Calls)│
│       └── NVIDIA cuOpt (GPU-Accelerated Routing, ERP & SAP Optimizer) │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ LAYER 4: KNOWLEDGE & RETRIEVAL (RAG & Parsing)                       │
│  ├── RAGFlow (Layout-Aware Document & Multi-Modal ERP Parsing Engine) │
│  ├── NVIDIA Nemotron Retriever (Sparse/Dense Embedding & Reranking)   │
│  ├── Weaviate (Multi-Tenant Vector & Hybrid Database)                │
│  └── Langfuse (E2E Observability, Token Tracking & Prompt Management) │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ LAYER 5: RUNTIMES, INFERENCE & CONTAINERIZATION                       │
│  ├── NVIDIA Triton Inference Server (Dynamic Batching, GPU Pooling)   │
│  ├── vLLM (Optimized GenAI Text Generation, OpenAI-Compatible)       │
│  ├── NVIDIA OpenShell (Isolated Kernel-Level Execution Sandbox)      │
│  └── Docker / Kubernetes (Containerized Microservices)                │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2. Layer-by-Layer Technical Specification

### Layer 1: Security, Privacy & Guardrails
Protects the enterprise perimeter from malicious intents, prompt injection, and accidental data exposure before payloads touch processing logic or external models.
*   **NVIDIA Morpheus:** Implemented as a high-throughput, AI-powered cybersecurity/zero-trust sidecar. Analyzes streaming logs and ERP data transactions for pattern anomalies.
    *   *License:* Apache 2.0 (100% Business-Friendly).
*   **NeMo Guardrails:** Provides semantic walls, preventing prompt injections, steering LLMs to follow explicit guidelines, and ensuring agent output stays within business constraints.
    *   *License:* Apache 2.0.
*   **Microsoft Presidio:** Analyzes textual inputs to detect, mask, or redact PII (personally identifiable information) on-the-fly.
    *   *Role:* Operates on the host CPU using fast, lightweight NLP models. Zero external API leaks.
    *   *License:* MIT.

### Layer 2: Orchestration & Workflow (The Nervous System)
Provides visual and code-level coordination of multi-agent tasks, workflows, and state persistence.
*   **Langflow (Replaces Dify):** A highly flexible visual canvas to construct, test, and adapt workflows, agents, and pipelines. Exposes REST endpoints that can be seamlessly consumed by your front-end and backend.
    *   *Integrations:* High integration with RAGFlow and any standard API/LLM models.
    *   *License:* MIT.
*   **Flue Framework:** Robust TypeScript session orchestration, managing durable state machines, sub-agents, and execution hooks on-premises or at the edge. Native to Node.js/TypeScript environments.
    *   *License:* Proprietary/Standard Dev.

### Layer 3: Cognitive & Reasoning Layer (AI Logic)
Fuses fast local workers with capable cloud model supervisors to execute logic, API tool calling, and workflow logic.
*   **Claude 3.5 Sonnet / Claude SDK:** Serve as the Primary/General Supervisor executing complex high-level planning, validation, and multi-layered reasoning.
    *   *Client SDK:* `@anthropic-ai/sdk` (Native Node.js / TS).
*   **NVIDIA Nemotron 70B / Qwen 72B (Production Upgrade):** Handles multi-step worker duties, tool integration, and structural data conversion locally.
    *   *Interface:* Access via standard OpenAI-compatible `/v1` interfaces via vLLM.
    *   *License:* NVIDIA Nemotron Open Model License / Apache 2.0 (No multi-tenant restriction, permissive for SaaS).
*   **NVIDIA cuOpt:** Integrated as a specialized agentic skill via API/Triton. Performs extremely fast, GPU-accelerated routing, task scheduling, resource allocation, and math optimizations on SAP data.
    *   *License:* Open-sourced in GitHub under Apache 2.0.

### Layer 4: Knowledge, Database & RAG (Data Grounding)
Manages ERP ingestion, layout-aware parsing, vector search, and model tracking.
*   **RAGFlow (Replaces Dify's Knowledge module):** Performs complex document, layout, OCR, and multi-modal analysis (parsing complex ERP tables and PDFs).
    *   *License:* Apache 2.0.
*   **NVIDIA Nemotron Retriever:** High-accuracy sparse/dense embeddings and reranking for document search.
    *   *Model Usage:* Best deployed via non-NIM (vLLM or Hugging Face) for zero license fee.
*   **Weaviate:** Vector storage and hybrid indexing, enabling multi-tenant data separation.
    *   *Client SDK:* `weaviate-client` (Native TypeScript).
    *   *License:* BSD 3-Clause.
*   **Langfuse:** Full agent observability, tracing LLM generations, latency, token usage, and tracking evals.
    *   *SDK:* `langfuse-node` (Native TypeScript).
    *   *License:* MIT/FOSS.

### Layer 5: Runtimes & Inference (Compute Isolation)
Infrastructure layer managing GPU utilisation, inference speed, and code isolation.
*   **NVIDIA Triton Inference Server:** Serves multi-modal, guardrails, and embedding models concurrently on shared GPUs with dynamic batching.
    *   *License:* BSD 3-Clause.
*   **vLLM:** Ultra-fast generative LLM text engine managing PagedAttention & Continuous Batching for Worker agents.
    *   *License:* Apache 2.0.
*   **NVIDIA OpenShell:** High-security, isolated runtime/kernel sandbox preventing unsafe Python/Shell code generated by agents from compromising the host server.
    *   *SDK:* `@nvidia/openshell-sdk` (TypeScript support).
    *   *License:* Apache 2.0.

---

## 3. The licensing Watchlist: Avoiding the NVIDIA NIM Catch

**Goal:** Ensure 100% royalty-free, SaaS-compliant open-source licensing with zero commercial fees.

### The Problem: NVIDIA NIM (Inference Microservices)
While excellent for prototyping, using **NVIDIA NIM** container packages in enterprise production requires a paid subscription to **NVIDIA AI Enterprise (NVAIE)**, costing **$4,500/GPU/Year**.

### The Solution: "De-NIMing" (Engines Replacement)
NVIDIA opens most model weights and architectures independently from NIM. Strip the runtime container, keep the model, use free open-source engines instead.

| Function | Proprietary / Paid (NIM-dependent) | Open-Source Replacement (Free 0 USD) |
| :--- | :--- | :--- |
| **Generative LLM** | NVIDIA Nemotron NIM | Open-weight Nemotron via **vLLM** (Apache 2.0) |
| **Embedding Ensembling**| Paid NVAIE Container | **Triton Inference Server** (BSD-3-Clause) |
| **Embeddings & Search** | Nemotron Retriever NIM | Open model weights via Triton vLLM or HuggingFace |
| **Optical parsing (OCR)**| Nemotron OCR NIM | Layout-aware processing via **RAGFlow** (Apache 2.0) |

---

## 4. Operational Transition: Pilot vs. Production

```text
           PHASE 1: THE PILOT (Day 1)                    PHASE 2: PRODUCTION SCALING
     ┌────────────────────────────────────┐         ┌────────────────────────────────────┐
     │ • 0 GPU Local Setup Needed         │         │ • High GPU On-Prem / Cloud (Rent)  │
     │ • Focus: Fast validation (MVP)     │         │ • Focus: Low OpEx & Secure Data    │
     │ • Cost: pay-as-you-go APIs         │ ──────► │ • Cost: Fixed Server GPU Rent      │
     │ • Models: Cloud Claude 3.5 API     │         │ • Models: Local Nemotron (vLLM)    │
     │ • RAG: Cloud embeddings, Weaviate  │         │ • Security: Total Air-Gap Isolation │
     └────────────────────────────────────┘         └────────────────────────────────────┘
```

### Phase 1: Zero-GPU Pilot (API-Wired Blueprints)
Rather than spinning up massive GPU clusters on Day 1, take the logic and blueprints and wire them directly to cloud APIs:
*   **Models:** Deploy **Claude 3.5 Sonnet / Haiku** via Anthropic SDK as both Supervisors and Workers.
*   **RAG & Embedded:** Configure RAGFlow and Weaviate Cloud to rely on external embeddings APIs (e.g. Cohere or OpenAI API) which cost cents to use for low pilot volume.
*   **DevOps:** 100% CPU-only deployments. Requires standard NodeJS VMs (AWS EC2 / DigitalOcean Droplet) at **~$50-$100/month**.

### Phase 2: Production Scaling (Local/Private Cloud Host)
Transition to self-hosted, sovereign infrastructure on dedicated/rented GPUs:
*   **Models:** Settle **Nemotron 70B** on **vLLM** for internal heavy agentic worker loops.
*   **Consolidation:** Host OCR, layout extraction, embedding (Retriever), and Guardrails on **Triton** on shared GPUs, minimizing CPU-GPU roundtrips.
*   **Operational Cost:** See Cost Estimations.

---

## 5. Hosting & Resource Cost Projections

Since you are relying purely on MIT/Apache-2.0/BSD-3-Clause systems, **your licensing cost is always $0**. Your ONLY cost is Infrastructure (Cloud or bare-metal GPUs).

### Tier A: Moderate Scale/Beta (Renting Server-grade GPU)
Sufficient to host a quantized 70B Model, and embedding/security pipelines.
*   **Compute:** Renting 1x NVIDIA L40S (48GB) or A100 (80GB) from specialized AI providers (RunPod, Lambda, Jarvis Labs).
*   **Estimated Cost:**
    *   ~$1.00 to $1.80 per hour.
    *   **Monthly Budget:** **~$750 – $1,300/mo** (Always Online).

### Tier B: High-Throughput Production (Bare Metal Cluster)
Required to support dozens of parallel client requests running multiple agents loops over ERP data.
*   **Compute:** 8x NVIDIA A100 (80GB) or L40S Cluster on AWS/GCP/CoreWeave.
*   **Estimated Cost:**
    *   ~$8.00 to $15.00/hour for the cluster.
    *   **Monthly Budget:** **~$5,800 – $11,000/mo** (Scalable on Kubernetes).

---

## 6. Integrations - TypeScript API Connection Examples

All of the elements of the stack integrate directly into standard Node.js & TypeScript apps without Python or NIM limitations.

### A. Calling Locally Hosted Nemotron (OpenAI Compatible) via TypeScript
Since vLLM exposes standard OpenAI endpoints, your TypeScript services don't need any complex customized SDK:
```typescript
import OpenAI from "openai";

// Points to your local vLLM / Triton service
const localAgentAI = new OpenAI({
  baseURL: "http://localhost:8000/v1", // No external network leaks
  apiKey: "NOT_NEEDED_FOR_LOCAL_STACK", // pragma: allowlist secret — the blueprint's placeholder, not a credential
});

async function runLocalAgentTask(taskPrompt: string) {
  const completion = await localAgentAI.chat.completions.create({
    model: "nvidia/Nemotron-3-70B-Instruct", // Your deployed local model
    messages: [{ role: "user", content: taskPrompt }],
    temperature: 0.2,
    response_format: { type: "json_object" }, // Crucial for reliable ERP/JSON extraction
  });

  return completion.choices[0].message.content;
}
```

### B. Calling Claude SDK for Supervisory Operations (Cloud Pilot/Safety Layer)
You can seamlessly blend this local stack with high-level cognitive supervision:
```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function superviseWorkflow(agentPlan: string) {
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-latest",
    max_tokens: 1024,
    messages: [{ role: "user", content: `Review and confirm the worker plan: ${agentPlan}` }],
  });

  return response.content[0];
}
```

### C. Integrating With Flue Orchestrator (Action Logic Example)
Manage multi-step flows without blocking state:
```typescript
// Define state tracking within TypeScript Agent Workflow
flue.defineSkill("Extract_ERP_Invoice", async (context) => {
  const fileBytes = context.state.documentBuffer;

  // 1. Submit file to visual RAGFlow for advanced layout parse (REST HTTP API)
  const parseResult = await ragflowClient.ingestAndParse(fileBytes);

  // 2. Local JSON structuring via Fast inference
  const invoiceData = await runLocalAgentTask(`Extract structured data from parse: ${parseResult}`);

  // 3. Confirm details with Claude Supervisor API
  const validation = await superviseWorkflow(invoiceData);

  // 4. Persistence in Weaviate for Agent RAG
  await weaviateClient.insert("InvoiceCollection", invoiceData);

  return { success: true, payload: { invoiceData, validation } };
});
```
