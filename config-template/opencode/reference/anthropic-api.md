# anthropic-api

Working reference for calling the Anthropic (Claude) API from code you write — Python (`anthropic`) and TypeScript (`@anthropic-ai/sdk`). Covers client setup, requests, prompt caching, thinking, errors, streaming, multi-turn, and cost control. Read this before writing any code that hits `api.anthropic.com`; don't answer model/pricing/param questions from memory.

## Model ids and pricing (per 1M tokens, input / output)

| id | use for | price |
|---|---|---|
| `claude-opus-4-8` | default; hardest reasoning/coding | $5.00 / $25.00 |
| `claude-sonnet-4-6` | high-volume production | $3.00 / $15.00 |
| `claude-haiku-4-5` | simple, speed-critical (classify, route) | $1.00 / $5.00 |

Context window is 200K. These ids change over time — if a 404 / `NotFoundError` says "model not found," the id is stale; don't guess a new one, ask. Use `web.py` to look up the current id (`python ~/.config/opencode/web.py search "anthropic current claude model ids"`).

## Install

```powershell
pip install anthropic              # Python
npm install @anthropic-ai/sdk      # TypeScript/Node
```

## Client init — let it read the key from the environment

The SDK resolves credentials in order: `ANTHROPIC_API_KEY` env var, then `ANTHROPIC_AUTH_TOKEN`. Never hardcode a key in source. If a key is needed and not in the env, pull it from the vault rather than asking or failing:
`powershell -NoProfile -File "~\.claude-secrets\secrets.ps1" get ANTHROPIC_API_KEY`

```python
import anthropic
client = anthropic.Anthropic()                 # reads env — preferred
async_client = anthropic.AsyncAnthropic()      # async
```

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();                 // reads env — preferred
```

`base_url` / `ANTHROPIC_BASE_URL` overrides the endpoint (useful for a proxy or a local-compatible server). Set `ANTHROPIC_LOG=debug` for SDK request logging.

**ESM file reads (TS):** `__dirname` / `__filename` are undefined in ES modules and throw at runtime. Use a bare cwd-relative path (`fs.readFileSync("./sample.png")`), or for script-relative paths derive the dir: `const here = path.dirname(fileURLToPath(import.meta.url))`. Never `path.join(__dirname, …)` in an ESM `.ts` file.

## Basic request — content is a list of typed blocks

`response.content` is a list/array of blocks (text, thinking, tool_use, …), NOT a string. Always check `.type` before reading `.text` — TS will type-error otherwise, Python will silently surprise you.

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=16000,
    messages=[{"role": "user", "content": "What is the capital of France?"}],
)
for block in response.content:
    if block.type == "text":
        print(block.text)
```

```typescript
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 16000,
  messages: [{ role: "user", content: "What is the capital of France?" }],
});
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}
```

`max_tokens` caps the OUTPUT. If you hit it mid-answer you get `stop_reason: "max_tokens"` — raise the cap or stream.

## System prompt

Pass `system` as a top-level param (a string, or a list of text blocks for caching). It is NOT a message.

```python
client.messages.create(
    model="claude-opus-4-8", max_tokens=16000,
    system="You are a helpful coding assistant. Give examples in Python.",
    messages=[{"role": "user", "content": "How do I read a JSON file?"}],
)
```

```typescript
await client.messages.create({
  model: "claude-opus-4-8", max_tokens: 16000,
  system: "You are a helpful coding assistant. Give examples in Python.",
  messages: [{ role: "user", content: "How do I read a JSON file?" }],
});
```

## Prompt caching — biggest cost lever, and the easiest to break

Caching is a **prefix match**: the API caches a prefix of the request, and **any byte change anywhere earlier in the prefix invalidates everything after it**. Put stable content first (system prompt, tool defs, big documents), volatile content last (the user's latest turn). Savings up to ~90% on the cached portion.

Simplest: top-level `cache_control` auto-caches the last cacheable block.

```python
client.messages.create(
    model="claude-opus-4-8", max_tokens=16000,
    cache_control={"type": "ephemeral"},        # auto-cache last cacheable block
    system=large_document_text,                  # e.g. 50KB of stable context
    messages=[{"role": "user", "content": "Summarize the key points"}],
)
```

```typescript
await client.messages.create({
  model: "claude-opus-4-8", max_tokens: 16000,
  cache_control: { type: "ephemeral" },          // auto-cache last cacheable block
  system: largeDocumentText,
  messages: [{ role: "user", content: "Summarize the key points" }],
});
```

Fine-grained: put `cache_control: {type:"ephemeral"}` on a specific block. Default TTL is 5 min; add `"ttl": "1h"` for an hour.

```python
system=[{"type": "text", "text": doc, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]
```

**Verify hits** via `response.usage`:
- `cache_creation_input_tokens` — written to cache (~1.25x cost)
- `cache_read_input_tokens` — served from cache (~0.1x cost)
- `input_tokens` — uncached (full cost)

**If `cache_read_input_tokens` stays 0 across identical-looking repeated requests, a silent invalidator is in the prefix.** Hunt these first:
- a timestamp in the system prompt — `datetime.now()` / `Date.now()`
- a UUID or request id baked into stable content
- non-deterministic serialization — unsorted `json.dumps()` (use `sort_keys=True`), unstable key order
- a tool set whose order or contents vary between calls

Freeze the prefix byte-for-byte and the reads appear.

## Extended thinking

Current models (Opus 4.8 / 4.7, Sonnet 4.6) use **adaptive** thinking with an effort knob — there is no `budget_tokens` (sending it 400s on 4.8/4.7). Control depth with `output_config.effort`: `low | medium | high | max`. Thinking text is omitted by default; opt in with `display: "summarized"`.

```python
response = client.messages.create(
    model="claude-opus-4-8", max_tokens=16000,
    thinking={"type": "adaptive", "display": "summarized"},
    output_config={"effort": "high"},
    messages=[{"role": "user", "content": "Solve this step by step..."}],
)
for block in response.content:
    if block.type == "thinking": print("Thinking:", block.thinking)
    elif block.type == "text":   print("Response:", block.text)
```

```typescript
const response = await client.messages.create({
  model: "claude-opus-4-8", max_tokens: 16000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
  messages: [{ role: "user", content: "Solve this step by step..." }],
});
```

(Older models only: `thinking: {type:"enabled", budget_tokens: N}`, N ≥ 1024 and < `max_tokens`.)

## Vision (images)

Send an `image` content block — by URL or base64 — alongside a text block.

```python
import base64
with open("image.png", "rb") as f:
    data = base64.standard_b64encode(f.read()).decode("utf-8")
client.messages.create(
    model="claude-opus-4-8", max_tokens=16000,
    messages=[{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
        {"type": "text", "text": "What's in this image?"},
    ]}],
)
# URL form: "source": {"type": "url", "url": "https://example.com/image.png"}
```

```typescript
import fs from "fs";
const data = fs.readFileSync("image.png").toString("base64");
await client.messages.create({
  model: "claude-opus-4-8", max_tokens: 16000,
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
    { type: "text", text: "What's in this image?" },
  ]}],
});
// URL form: source: { type: "url", url: "https://example.com/image.png" }
```

## Streaming

For long outputs, stream so you render incrementally and never truncate on `max_tokens`.

```python
with client.messages.stream(
    model="claude-opus-4-8", max_tokens=16000,
    messages=[{"role": "user", "content": "Write a long essay."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    final = stream.get_final_message()
```

```typescript
const stream = client.messages.stream({
  model: "claude-opus-4-8", max_tokens: 16000,
  messages: [{ role: "user", content: "Write a long essay." }],
});
stream.on("text", (t) => process.stdout.write(t));
const final = await stream.finalMessage();
```

## Multi-turn — the API is stateless

There is no server-side session. Send the **full message history** every call. Append the assistant's reply to your array and resend next turn.

```python
messages = []
def chat(user_msg):
    messages.append({"role": "user", "content": user_msg})
    r = client.messages.create(model="claude-opus-4-8", max_tokens=16000, messages=messages)
    reply = next((b.text for b in r.content if b.type == "text"), "")
    messages.append({"role": "assistant", "content": reply})
    return reply
```

```typescript
const messages: Anthropic.MessageParam[] = [];
async function chat(userMsg: string) {
  messages.push({ role: "user", content: userMsg });
  const r = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 16000, messages });
  const reply = r.content.find((b) => b.type === "text")?.text ?? "";
  messages.push({ role: "assistant", content: reply });
  return reply;
}
```

Rules: first message must be `user`; consecutive same-role messages are merged into one turn. In TS, use the SDK types (`Anthropic.MessageParam`, `Anthropic.Message`, `Anthropic.Tool`) — don't redefine your own equivalents.

## Stop reasons — branch on these

`response.stop_reason`:

| value | meaning / what to do |
|---|---|
| `end_turn` | finished naturally |
| `max_tokens` | hit the output cap — raise `max_tokens` or stream |
| `stop_sequence` | hit a custom stop sequence |
| `tool_use` | wants a tool — run it, append the result, call again |
| `pause_turn` | paused; resend to resume (agentic flows) |

## Token counting (estimate cost before sending)

```python
c = client.messages.count_tokens(model="claude-opus-4-8", messages=messages, system=system)
print("input tokens:", c.input_tokens, "≈ $%.4f" % (c.input_tokens * 5e-6))
```

```typescript
const c = await client.messages.countTokens({ model: "claude-opus-4-8", messages, system });
console.log("input tokens:", c.input_tokens, "≈ $" + (c.input_tokens * 5e-6).toFixed(4));
```

## Per-request overrides, timeouts, retries

- Override per call without mutating the client: Python `client.with_options(timeout=5.0, max_retries=5).messages.create(...)`.
- Default request timeout is 10 minutes; pass `timeout=<seconds>` on the client (or an `httpx.Timeout`). On timeout the SDK raises `APITimeoutError`.
- The SDK **already auto-retries** connection errors, 408, 409, 429, and ≥500 with exponential backoff (default 2 retries). Tune with `max_retries`; `0` disables. Only write your own retry loop if you need behavior beyond that.

## Error handling — catch typed exceptions, never string-match messages

```python
import anthropic
try:
    r = client.messages.create(...)
except anthropic.BadRequestError as e:      print("Bad request:", e.message)   # 400 — malformed call
except anthropic.AuthenticationError:        print("Invalid API key")            # 401
except anthropic.PermissionDeniedError:      print("Key lacks permission")       # 403
except anthropic.NotFoundError:              print("Bad model or endpoint")      # 404 — likely a stale model id
except anthropic.RateLimitError as e:                                            # 429
    retry_after = int(e.response.headers.get("retry-after", "60"))
    print(f"Rate limited; retry after {retry_after}s")
except anthropic.APIStatusError as e:        print(f"API error {e.status_code}: {e.message}")  # 5xx → retry
except anthropic.APIConnectionError:         print("Network error")
```

```typescript
import Anthropic from "@anthropic-ai/sdk";
try {
  const r = await client.messages.create({ /* ... */ });
} catch (error) {
  if (error instanceof Anthropic.BadRequestError)         console.error("Bad request:", error.message);
  else if (error instanceof Anthropic.AuthenticationError) console.error("Invalid API key");
  else if (error instanceof Anthropic.RateLimitError)      console.error("Rate limited — retry later");
  else if (error instanceof Anthropic.APIError)            console.error(`API error ${error.status}:`, error.message);
}
```

All exceptions extend `APIError` (`.status` / `.status_code`). Check most-specific first. When reporting a failure to Anthropic, include the request id: Python `response._request_id` (public despite the underscore), or read the `request-id` response header.

## Cost checklist

1. Cache repeated context (system prompt, tool defs, big docs) — see the silent-invalidator hunt above; this is where the real savings and the real bugs are.
2. Right-size the model: Opus default, Sonnet for volume, Haiku only for trivial speed-critical work.
3. `count_tokens` before large requests to estimate spend.
4. Stream long outputs; keep `max_tokens` realistic.
