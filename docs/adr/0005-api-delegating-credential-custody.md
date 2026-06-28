# API-delegating mode custodies the Provider's credential, encrypted at rest

> **Status: not yet built.** Records the decided architecture for Provider self-onboarding (delegated flow).

The Marketplace's founding principle is that the platform **never holds upstream API keys** — it is not a credential-breach target, which is part of the trust story. **API-delegating mode deliberately breaks that principle** for one mode only: a Provider hands over their own upstream credential (e.g. their DeepSeek or Anthropic key) and the platform stores it so it can serve that Provider's Listings. The principle is therefore amended to be **mode-specific** (see `CONTEXT.md`): self-hosted mode holds nothing; API-delegating mode custodies the credential.

We accept custody because it is the **lowest-friction onboarding path** — a would-be Provider who does not run inference infra can become a Provider by pasting a key and a price, with no server to operate. That is the whole point of the delegated mode.

The credential is **encrypted at rest** (AES-256-GCM) under an operator-held master key, decrypted only in the forwarder at call time, and never returned by any read endpoint. The honest limit: because the proxy must decrypt to forward, a **compromise of the running host still exposes every delegated key**. Encryption-at-rest defends against at-rest DB/backup theft, not a live host breach. This raises the operator's blast radius — a conscious early-phase bet that onboarding ease outweighs the added custody risk while the operator set is small and trusted.

## Considered Options

- **Self-hosted only — drop delegated key storage** — rejected: preserves the no-custody principle but removes the easiest path to becoming a Provider; most would-be Providers do not run their own inference infra, so the marketplace would struggle to attract supply.
- **Store credentials in plaintext** — rejected: catastrophic on any host/DB/backup read; unacceptable for a credential the Provider trusted us with.
- **Encrypted at rest, operator-held master key** — chosen: bounds exposure to a live-host compromise rather than at-rest theft, with no new infra.
- **Envelope encryption / KMS / HSM per credential** — deferred: the right long-term posture, but operationally heavy and unjustified while the platform is single-operator.

## Consequences

- The platform becomes a custodian of third-party credentials in delegated mode — a new liability the no-custody principle previously avoided. Revisit envelope/KMS encryption before the operator set or credential volume grows.
- A new env-held master key (`PROVIDER_ENC_KEY`) must be provisioned, rotated carefully (re-encrypt on rotation), and never committed — it joins the private-key rule in `CLAUDE.md`.
- Self-hosted mode remains the no-custody path and should be presented as the privacy-preserving option for Providers who can run infra.
