// THROWAWAY SPIKE — local, single-user OpenAI-compatible shim over your OWN
// logged-in Claude Code *subscription*. For personal technical learning only.
//
// - Binds to 127.0.0.1 ONLY. Do not expose to a network or serve third parties:
//   that becomes the resale/account-sharing pattern Anthropic's ToS prohibits
//   (see docs/subscription-resale-spike-FEASIBILITY.md).
// - Uses the subscription because no ANTHROPIC_API_KEY is set and you're logged in.
// - macOS: creds are in Keychain, so this MUST run natively on the host (a Linux
//   container can't reach the Keychain).
//
// Run:  bun spike/claude-openai-shim.ts
// Test: curl 127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
//         -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"say hi in 3 words"}]}'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ChatRequest = { model?: string; messages: ChatMessage[] }

// Serialize an OpenAI messages[] into (system prompt, user-visible transcript).
// claude -p is stateless per call, so we rebuild the whole conversation each time.
function buildPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const turns = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n')
  return { system, prompt: `${turns}\n\nAssistant:` }
}

async function runClaude(model: string, system: string, prompt: string) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model]
  if (system) args.push('--append-system-prompt', system)
  // Keep it behaving like a plain LLM, not an agent loose on the filesystem:
  args.push('--disallowed-tools', 'Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch')

  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY // force the subscription path, never an API key

  const proc = Bun.spawn(['claude', ...args], {
    env,
    cwd: '/tmp', // scratch cwd so it can't wander the repo
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`claude exited ${code}: ${err || out}`)

  // claude -p --output-format json → { result, usage: {input_tokens, output_tokens}, ... }
  const parsed = JSON.parse(out)
  return {
    text: parsed.result ?? '',
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
  }
}

function toOpenAI(model: string, r: { text: string; inputTokens: number; outputTokens: number }) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  }
}

Bun.serve({
  hostname: '127.0.0.1', // local only — intentional
  port: 8787,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return new Response('not found', { status: 404 })
    }
    try {
      const body = (await req.json()) as ChatRequest
      const model = body.model ?? 'claude-sonnet-4-6'
      const { system, prompt } = buildPrompt(body.messages ?? [])
      const r = await runClaude(model, system, prompt)
      return Response.json(toOpenAI(model, r))
    } catch (e) {
      return Response.json({ error: { message: String(e) } }, { status: 500 })
    }
  },
})

console.log('local subscription shim on http://127.0.0.1:8787  (Ctrl-C to stop)')
