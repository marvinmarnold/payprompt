# FEASIBILITY — Reselling Subscription Capacity

_Date: 2026-06-26 · Status: spike complete (throwaway) · Decision: **NO-GO / DROP**_

Companion to `docs/subscription-resale-spike-handoff.md`. This is a go/no-go decision, not a
build. **No PoC was built** — see "Why no PoC" below.

## TL;DR

| Gate | Verdict |
|------|---------|
| **Terms of Service** (Anthropic + OpenAI) | ❌ **Hard no.** Resale, account-sharing, automated-access, and competing-service clauses each independently prohibit it. Suspension is at-will. |
| **Marketplace policy** (this repo, `CONTEXT.md`) | ❌ Contradicts the documented open-weight-only policy. |
| **Technical** (auth/headless/container) | ⚠️ Possible-but-ugly. The token is reusable, but macOS forces a host-native daemon (not a clean container), quota detection is unreliable, and the model is closed-weight. |

Because the spike's gate is "feasible **technically AND under ToS**," and ToS is a hard no for
**both** vendors, the answer is **drop**. Technical detail below is recorded for completeness and to
support a future revisit, not to enable a build.

## Why no PoC

The handoff says "if feasible, a minimal throwaway PoC." It is not feasible under ToS, so the gating
logic says no PoC. Independently, a working PoC here is not a research artifact — it _is_ the
ToS-circumventing resale mechanism (a process that reuses a logged-in subscription OAuth session to
serve third-party paying callers). I did not build, run, or extract any live subscription credential.
All technical findings below come from publicly documented CLI behavior and credential-storage
locations, not from a working tap.

---

## ToS findings (the dispositive gate)

### Anthropic — Consumer Terms of Service (verbatim)

- **Personal, non-commercial use** (§2): _"Use of our Services for evaluation purposes are for your
  personal, non-commercial use only."_
- **No account sharing / no making the account available** (§2, Account creation and access):
  _"You may not share your Account login information, Anthropic API key, or Account credentials with
  anyone else. You also may not make your Account available to anyone else."_
- **No resale, no competing service** (§3): prohibits _"...develop any products or services that
  compete with our Services, including to develop or train any artificial intelligence or machine
  learning algorithms or models or resell the Services."_
- **No automated/non-human access (except via API key)** (§3): _"Except when you are accessing our
  Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services
  through automated or non-human means, whether through a bot, script, or otherwise."_
- **At-will suspension** (§12, Termination): _"We may suspend or terminate your access to the Services
  (including any Subscriptions) at any time without notice to you if we believe that you have breached
  these Terms."_
- **Usage Policy** scopes "passthrough access" / resellers as covered parties and permits reselling
  **only when authorized** by Anthropic. There is no authorized program for reselling personal
  subscription capacity.

The critical line: **a subscription is explicitly excluded from the automated-access carve-out.** The
carve-out is "except when accessing via an Anthropic **API Key**." A subscription OAuth session is not
an API key, so headless/programmatic use of it is squarely prohibited — and serving third parties on
top is separately barred by the resale + account-sharing clauses.

### OpenAI — Terms of Use / Account Sharing Policy (paraphrased)

> Verbatim fetch of `openai.com/policies/...` was blocked (HTTP 403 to automated requests). The
> following is from OpenAI's published terms as surfaced via search; treat wording as paraphrase and
> confirm against the live page before relying on it.

- **No credential sharing / no making the account available** to anyone else; the account holder is
  responsible for all activity under the account.
- **Business terms** are explicit: _Customer will not share account access credentials between users,
  and **may not resell or lease access** to its Account or any End User Account_; **End User Accounts
  may only be provisioned to, registered for, and used by a single End User.**
- Prohibits **programmatically extracting** data or Output.
- Prohibits using Output to **develop competing models**.

Same shape as Anthropic: a ChatGPT/Codex subscription is a single-user, non-resellable, non-shareable
license. The API is the sanctioned path for programmatic third-party serving — which is exactly the
"API-delegating" listing mode the marketplace already supports.

**Net:** subscription resale is a hard no for both vendors. This is not a footnote risk — it's the
decision.

---

## Technical findings (recorded; not gating)

Per-unknown, at decision altitude. "Possible" here never means "permitted."

| # | Unknown | Verdict | Notes |
|---|---------|---------|-------|
| 1 | **Auth mechanism** | Reusable token, but prohibited to reuse | Subscription auth is an OAuth access+refresh token, **not** a portable API key. macOS: stored in the login **Keychain** (a generic-password item, not a plain file). Linux/headless: stored at `~/.claude/.credentials.json` (mode-600 file) because there's no Keychain. Codex/ChatGPT: analogous OAuth session under `~/.codex/`. The token is technically reusable non-interactively by any process that can read+refresh it — which is precisely the "automated means" + "make your Account available to anyone else" prohibition. |
| 2 | **Headless inference** | Technically works | `claude -p "<prompt>"` (print mode) and the Agent SDK run non-interactively and use whatever auth the host session holds — subscription OAuth **or** API key. So a subscription-backed completion is achievable. This is the path that violates the automated-access clause. |
| 3 | **Container ↔ host** | macOS breaks the clean-container story | **Linux host:** `~/.claude/.credentials.json` can be bind-mounted/host-networked into a container — works. **macOS host:** Docker Desktop runs a Linux VM with no bridge to the macOS Keychain, so a container cannot read the subscription token. The only paths are (a) run the bridge **natively on the host** (a host daemon, not a container), or (b) a host-side localhost helper the container calls — but that helper is the component actually using the subscription. Either way macOS forces a host-native component; "just ship a Docker container" does not hold. |
| 4 | **Output fidelity** | Mappable, with a billing caveat | `claude -p --output-format json` (and `stream-json`) returns content plus `usage` token counts, mappable to the OpenAI shape the proxy expects (`forwarder.ts`, `src/format/`). **But** subscription usage is metered against plan limits, not per-token dollars — there is no per-request cost to translate into a Listing's per-million-token price. The reported token counts don't correspond to a marketplace-billable cost. |
| 5 | **Quota / limits** | Unreliable to operate on | Subscription plans enforce rolling windows (e.g. multi-hour + weekly caps) with no clean API to read "remaining capacity." You cannot reliably detect "unused capacity," and exposing it to third-party load risks hitting caps mid-request and account lockout. Concurrency/anomaly patterns also raise the suspension probability under §12. |
| 6 | **Model identity** | Closed-weight — wrong category | The subscription serves Anthropic's current proprietary Claude models. That is the exact category `CONTEXT.md`'s marketplace policy **excludes**, and Phase-4 fingerprinting is built around open-weight HF-repo identity — it doesn't apply to a closed model. |

---

## Recommendation

**DROP.** Do not pursue subscription-capacity resale, and do not integrate anything into
`packages/proxy`.

Reasoning, in priority order:
1. **ToS is a hard no** for both Anthropic and OpenAI — resale, account-sharing, and automated-access
   clauses each independently prohibit it, with at-will suspension. This alone settles it.
2. **It contradicts this repo's own stated policy** (`CONTEXT.md`: open-weight models only, "where
   community inference does not violate terms of service").
3. **Even ignoring 1–2, the engineering is poor**: macOS forces a host-native daemon, quota is
   unobservable, there's no per-token cost to bill against, and the model category breaks verification.

### Revisit-when-X

- Only if Anthropic or OpenAI ship an **authorized** capacity-resale / reseller program for
  subscription plans (none exists today; their terms point resellers to the API, not the subscription).

### Constructive alternative (no ToS exception needed)

The marketplace already supports exactly the legitimate version of this idea: the **self-hosted
open-weight** Provider mode (vLLM / Ollama / llama.cpp exposing an OpenAI-compatible endpoint, which
`forwarder.ts` already forwards to). A provider with spare GPU can resell **their own** open-weight
inference with no resale/sharing conflict — and that path is the documented long-term policy. If the
goal is "let providers monetize spare capacity," point them there, not at subscription tapping.

---

## What was and wasn't done

- **Done:** ToS clause research (Anthropic verbatim; OpenAI via search — site blocks automated fetch),
  technical feasibility assessment per unknown from documented CLI behavior, macOS-vs-Linux analysis,
  and this decision.
- **Not done (intentionally):** no live credential read/extraction, no `claude -p` run against a real
  subscription, no resale PoC. The decision is no-go, so no build was warranted or undertaken.

## Sources

- Anthropic Consumer Terms of Service — <https://www.anthropic.com/legal/consumer-terms>
- Anthropic Usage Policy — <https://www.anthropic.com/legal/aup>
- OpenAI Terms of Use — <https://openai.com/policies/row-terms-of-use/> (verbatim fetch blocked; confirm on live page)
- OpenAI Account Sharing Policy — <https://help.openai.com/en/articles/10471989-openai-account-sharing-policy>
- This repo: `CONTEXT.md` (marketplace open-weight-only policy), `packages/proxy/src/forwarder.ts`, `packages/proxy/src/format/`
