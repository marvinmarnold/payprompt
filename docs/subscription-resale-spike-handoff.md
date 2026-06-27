# Spike Handoff — Reselling Subscription Capacity (feasibility)

_Date: 2026-06-26 · Status: research spike (throwaway) · Owner: TBD (separate agent)_

## What this spike answers

Is it feasible — **technically AND under ToS** — for a provider to resell their *unused Claude Code /
Codex **subscription** capacity* (not an API key) through the Latchkey marketplace, via a Docker
container on their host that taps the host's already-logged-in subscription session and exposes an
OpenAI-compatible endpoint the proxy forwards to?

This is a **go/no-go feasibility study, not a build.** Output = a short report (+ a minimal throwaway
PoC if feasible). Do **not** integrate into `packages/proxy`.

## Read first — why this is uncertain

- **ToS risk (a go/no-go input, not a footnote):** reselling personal Claude/OpenAI *subscription*
  capacity to third parties very likely violates their consumer terms (personal use, no resale, no
  automated third-party access) → real risk of account suspension. It also contradicts this repo's
  documented **open-weight-only** marketplace policy (`CONTEXT.md`). The spike must surface the actual
  ToS clauses so the user can make an informed call.
- **Technical uncertainty:** subscription auth is an OAuth session, not a portable API key, so "a
  container uses the host's subscription" may not be straightforward (or possible) — that's the point of the spike.

## Product frame (so the PoC targets the right interface)

The proxy already forwards to any OpenAI-compatible `endpoint` (`packages/proxy/src/forwarder.ts`). A
subscription provider is therefore just a **self-hosted listing** whose endpoint is the provider's
container. So the PoC's entire job is:

> On a host with a logged-in Claude Code (or Codex) **subscription**, a container (or host-side bridge)
> exposes `POST /v1/chat/completions` (OpenAI format) and returns a real completion produced via the
> **subscription** — not an API key — including token usage.

If that works, the proxy side is already done.

## Unknowns to research (priority order)

1. **Auth mechanism** — where/how Claude Code stores subscription credentials (`~/.claude/`? a
   credentials/OAuth token file? macOS Keychain?), and whether that token is reusable
   non-interactively by another process. Same for Codex.
2. **Headless inference** — can `claude` run non-interactively (`claude -p` / print mode / Agent SDK)
   using **subscription** auth (not API key) to return a completion? Distinguish the subscription-backed
   path from the API-key path. Same for Codex/OpenAI.
3. **Container ↔ host session** — Linux host: can the credential file be mounted / host-networked into
   the container? **macOS host: the Keychain is not mountable into a Linux container** — is there any
   path (a host-side helper the container calls over localhost; or running the bridge *natively* on the
   host instead of in Docker)? This may force a "host daemon," not a pure container.
4. **Output fidelity** — streaming tokens + usage counts, mappable to the wire format the proxy expects
   (`packages/proxy/src/format/`, `forwarder.ts`).
5. **Quota / limits** — subscription usage caps and rate limits: how to detect "unused capacity," avoid
   lockout, and report remaining capacity.
6. **Model identity** — which model(s) the subscription actually serves (for listing + Phase-4 fingerprinting).

## Deliverables

- `FEASIBILITY.md` — works / conditionally / no, per unknown, with the ToS-clause findings and the
  macOS-vs-Linux story, and a recommendation (ship / drop / revisit-when-X).
- If feasible: a **minimal throwaway PoC** — container or host-bridge → one completion via the host
  subscription → OpenAI-format JSON. No proxy integration, no auth, no production concerns.

## Constraints

- Throwaway and isolated — own branch/worktree (e.g. `spike/subscription-resale`). Do not touch `packages/proxy`.
- Never store or commit subscription tokens/credentials.
- Timebox it; the goal is a decision, not a product.

## References

- `CONTEXT.md` — marketplace glossary + the open-weight-only policy this would contradict.
- `packages/proxy/src/forwarder.ts` — how the proxy forwards to a listing endpoint (the interface to satisfy).
- `packages/proxy/src/format/` — wire-format translation the output must match.
- `docs/superpowers/specs/2026-06-19-per-provider-payout-design.md`, `docs/frontend-onboarding-handoff.md` — adjacent context.
- Provider-onboarding design (in progress; delegated flow first): a subscription provider would register
  as a **self-hosted** listing once/if this spike proves feasible.
