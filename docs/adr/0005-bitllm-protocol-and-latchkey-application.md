# bitllm is the protocol; latchkey is an application built on it

> **Status: direction.** Records the intended architecture. The repo is not yet structurally split along this boundary.

This repo produces two outputs.
**bitllm** is a protocol for serving LLM inference: any host can run bitllm to expose a URL that answers inference requests, analogous to bittorrent for files or git for version history.
A bitllm host speaks an OpenAI-compatible wire format, and bitllm is open, so applications other than latchkey could be built on it.
**latchkey** is an application built on bitllm, analogous to what GitHub is to git: a marketplace plus an admin panel.

latchkey runs a bitllm server itself.
A Provider can sell inference on latchkey in two ways: run their own bitllm host and register its URL, or upload an API key and pricing and let latchkey run bitllm on their behalf with no infrastructure.
On the consume side, latchkey proxies Callers that follow terms of service.

There is no principle against latchkey holding upstream credentials.
Storing a Provider's uploaded key is a normal responsibility of a hosted application, the same way any SaaS stores the integration credentials its users entrust to it.
latchkey stores those keys encrypted at rest as a sensible security practice, not to satisfy a no-custody principle (there is none).

## Considered Options

- **One monolithic "marketplace" concept that owns both serving and aggregation** rejected: it conflates the open serving protocol with the application on top, which blocks "anyone can run a host" and forecloses other applications being built on bitllm.
- **Keep "self-hosted" vs "API-delegating" as the boundary** rejected: that boundary described two latchkey provider modes and hid the more important split, which is protocol (bitllm) vs application (latchkey). Running your own inference URL is simply running bitllm.

## Consequences

- The glossary and packages should eventually separate the bitllm context from the latchkey context, and `CONTEXT-MAP.md` should list both as distinct contexts.
- "self-hosted" and "API-delegating" are retired as boundary names, replaced by **bitllm host** and **latchkey-hosted**.
- This supersedes an earlier draft ADR that framed credential custody as breaking a "never holds keys" principle. No such principle exists.
