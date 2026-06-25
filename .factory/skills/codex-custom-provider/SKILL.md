---
name: codex-custom-provider
version: 1.0.0
description: |
  Configure OpenAI Codex CLI/Desktop (v0.92.0+) to use ANY custom model provider
  or LLM proxy/router (AgentRouter, OpenRouter, LiteLLM, local models, etc.).
  Covers the Responses API migration, building protocol-translation bridges,
  bypassing provider client restrictions, SSE streaming translation, and
  full verification workflows. Use when setting up Codex with non-OpenAI
  providers, when the provider only speaks Chat Completions, or when hitting
  "unauthorized client" errors from provider gateways.
user-invocable: true
---

# Codex Custom Model Provider Configuration

Complete guide to wiring OpenAI Codex CLI/Desktop to any third-party model
provider, LLM proxy, or API router. Covers the hard problems: the
`chat/completions` deprecation, Responses API translation, client restriction
bypass, and SSE streaming compatibility.

---

## 1. Background: Why This Is Hard

### 1.1 The `chat/completions` Deprecation

In December 2025, OpenAI [announced](https://github.com/openai/codex/discussions/7782)
the deprecation of `wire_api = "chat"` in Codex. Full removal happened by
February 2026. As of Codex **0.92.0+**, only `wire_api = "responses"` is
supported.

**What this means**: If your provider only speaks the OpenAI Chat Completions
API (`/v1/chat/completions`), you CANNOT use it directly with Codex anymore.
You need a translation layer (bridge) that converts Codex's Responses API
calls into Chat Completions calls.

### 1.2 Provider Client Restrictions

Some providers (notably AgentRouter) only allow requests from approved
clients. They inspect HTTP headers (`Originator`, `User-Agent`, `Version`)
and reject unknown clients with:

```
unauthorized client detected, contact support for assistance
```

Your bridge must spoof Codex CLI headers to pass these checks.

### 1.3 The Solution Architecture

```
Codex (Responses API)          Bridge (Python/Flask)         Provider (Chat Completions)
─────────────────────          ─────────────────────         ────────────────────────────
POST /v1/responses      -->    Translate request       -->   POST /v1/chat/completions
                               (input→messages,
                                tools conversion,
                                add spoofed headers)

SSE events received     <--    Translate SSE stream    <--   SSE chunks received
(response.output_text         (chat.completion.chunk        (choices[0].delta.content)
 .delta events)                → response.* events)
```

---

## 2. Prerequisites

- **Python 3.9+** with `flask` and `requests`:
  ```bash
  pip install flask requests
  ```
- **Codex CLI** installed (`npm install -g @openai/codex` or desktop app)
- **Provider API key/token** (obtain from provider's console)

---

## 3. Step 1: Codex Configuration

Edit `~/.codex/config.toml` (Windows: `C:\Users\<YOU>\.codex\config.toml`):

```toml
# Top-level: which model to use (must match what the provider offers)
model = "gpt-5.5"

# Point at your custom provider definition
model_provider = "my-custom-provider"

# ... rest of your existing config (notify, plugins, etc.) ...

# Provider definition — place at END of file to avoid TOML section leakage
[model_providers.my-custom-provider]
name = "My Custom Provider"
base_url = "http://127.0.0.1:9876/v1"   # Points at your local bridge
env_key = "MY_PROVIDER_TOKEN"            # Env var holding the API key
wire_api = "responses"                   # REQUIRED for Codex 0.92.0+
stream_idle_timeout_ms = 300000
```

### Key Configuration Rules

| Rule | Detail |
|------|--------|
| `wire_api` | MUST be `"responses"`. `"chat"` is rejected with a hard error in Codex 0.92.0+. |
| `model_provider` and `model_providers` | These keys are **ignored** in project-local `.codex/config.toml`. Set them in user-level `~/.codex/config.toml` only. |
| TOML section ordering | Once you open `[model_providers.xxx]`, all subsequent bare keys belong to that section. Place the provider block at the **end** of your config file, or ensure no top-level keys follow it without a new section header. |
| `preferred_auth_method` | NOT a valid top-level key in Codex 0.135.0. Don't use it. |
| `env_key` | The environment variable Codex will read for the API key. The bridge forwards this as `Authorization: Bearer <value>`. |
| `openai_base_url` | An alternative to `model_providers` if you just want to redirect the built-in OpenAI provider. But it still uses the Responses API — won't help if your provider only speaks Chat Completions. |

### Multiple Models

You can switch models by changing the top-level `model` key. Available models
depend on what your provider offers. For AgentRouter, supported models include:

```
gpt-5.5, gpt-5.4, deepseek-v4-pro, deepseek-v4-flash,
claude-opus-4-8, claude-opus-4-7, claude-opus-4-6,
claude-sonnet-4-6, claude-sonnet-4-5, glm-5.1
```

---

## 4. Step 2: The Bridge

### 4.1 Full Bridge Implementation

Place this at `~/.codex/bridge/bridge.py` (or any convenient location):

```python
"""
Codex Responses API → Chat Completions Bridge

Translates Codex's Responses API calls to OpenAI Chat Completions for
providers that don't support the Responses API natively.

Usage:
    python bridge.py [--port 9876] [--token YOUR_KEY]

Set MY_PROVIDER_TOKEN env var or pass --token.
"""

import argparse
import json
import os
import sys
import time
import uuid
import logging
from flask import Flask, request, Response, stream_with_context
import requests as http_requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bridge")

# ─── CHANGE THESE ───────────────────────────────────────────────
UPSTREAM_BASE = "https://agentrouter.org/v1"   # Provider base URL
TOKEN_ENV_VAR = "MY_PROVIDER_TOKEN"             # Env var for API key

# ─── SPOOFED HEADERS (bypass client restrictions) ───────────────
# Some providers only allow approved clients.
# These headers mimic Codex CLI.
SPOOF_ORIGINATOR = "codex_cli_rs"
SPOOF_USER_AGENT = "codex_cli_rs/0.135.0 (Windows 10.0.22621; x64) Windows_Terminal"
SPOOF_VERSION = "0.135.0"
# ─────────────────────────────────────────────────────────────────

app = Flask(__name__)


def get_token():
    return os.environ.get(TOKEN_ENV_VAR, "")


def upstream_headers():
    return {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/json",
        "Originator": SPOOF_ORIGINATOR,
        "User-Agent": SPOOF_USER_AGENT,
        "Version": SPOOF_VERSION,
    }


# ═══════════════════════════════════════════════════════════════════
# REQUEST TRANSLATION: Responses API → Chat Completions
# ═══════════════════════════════════════════════════════════════════

def responses_to_chat(body):
    """Convert Responses API request body to Chat Completions format."""
    chat = {"model": body.get("model", "gpt-5.5")}

    # input → messages
    raw_input = body.get("input", [])
    messages = [_convert_input_item(item) for item in raw_input]
    messages = [m for m in messages if m]  # filter None

    # instructions → prepend system message
    instructions = body.get("instructions")
    if instructions:
        messages.insert(0, {"role": "system", "content": instructions})

    chat["messages"] = messages
    chat["stream"] = body.get("stream", False)
    if chat["stream"]:
        chat["stream_options"] = {"include_usage": True}

    # Tools conversion
    tools = body.get("tools", [])
    if tools:
        chat["tools"] = _convert_tools(tools)
        tool_choice = body.get("tool_choice")
        if tool_choice:
            chat["tool_choice"] = tool_choice

    # Scalar fields
    for key in ("temperature", "top_p", "max_output_tokens", "max_tokens"):
        if key in body:
            chat["max_tokens" if key == "max_output_tokens" else key] = body[key]

    return chat


def _convert_input_item(item):
    """Convert a Responses API input item to a Chat Completions message."""
    role = item.get("role", "user")
    content = _extract_text(item.get("content", ""))

    if role == "system":
        return {"role": "system", "content": content}
    if role == "user":
        return {"role": "user", "content": content}
    if role == "assistant":
        msg = {"role": "assistant", "content": content or None}
        tool_calls = item.get("tool_calls", [])
        if tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": tc.get("name", ""),
                        "arguments": tc.get("arguments", ""),
                    },
                }
                for tc in tool_calls
            ]
        if msg["content"] is None and not tool_calls:
            msg["content"] = ""
        return msg
    if role == "tool":
        return {
            "role": "tool",
            "tool_call_id": item.get("call_id", ""),
            "content": content,
        }
    return None


def _extract_text(content):
    """Extract plain text from Responses API content (string or block array)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("type", "")
                if t in ("input_text", "output_text", "text"):
                    parts.append(block.get("text", ""))
                elif t in ("image_url", "input_image"):
                    parts.append("[Image]")
                elif t == "input_file":
                    parts.append("[File]")
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content)


def _convert_tools(tools):
    """Convert Responses API tools to Chat Completions tools format."""
    chat_tools = []
    for tool in tools:
        if tool.get("type") == "function":
            chat_tools.append({
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": tool.get("parameters", {}),
                },
            })
        elif tool.get("type") == "web_search":
            chat_tools.append(tool)
    return chat_tools


# ═══════════════════════════════════════════════════════════════════
# RESPONSE TRANSLATION: Chat Completions SSE → Responses API SSE
# ═══════════════════════════════════════════════════════════════════

def chat_stream_to_responses(response, response_id):
    """Yield Responses API SSE events from Chat Completions streaming."""
    yielded_created = False
    yielded_in_progress = False
    yielded_item = False
    yielded_part = False
    tool_calls = {}
    usage = None
    text_id = response_id + "_text"
    part_id = response_id + "_part"

    for line in response.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8", errors="replace")
        if not line.startswith("data: "):
            continue
        data_str = line[6:].strip()
        if data_str == "[DONE]":
            break

        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        choices = chunk.get("choices", [])
        if not choices:
            u = chunk.get("usage")
            if u:
                usage = u
            continue

        delta = choices[0].get("delta", {})

        # Initial events
        if not yielded_created:
            yielded_created = True
            yield _sse("response.created", {
                "type": "response.created",
                "response": {"id": response_id, "object": "response",
                             "status": "in_progress", "output": []},
            })
        if not yielded_in_progress:
            yielded_in_progress = True
            yield _sse("response.in_progress", {
                "type": "response.in_progress",
                "response": {"id": response_id},
            })

        # Reasoning (DeepSeek, etc.)
        reasoning = delta.get("reasoning_content")
        if reasoning:
            yield _sse("response.reasoning_text.delta", {
                "type": "response.reasoning_text.delta", "delta": reasoning,
            })
            continue

        # Text content
        content = delta.get("content")
        if content:
            if not yielded_item:
                yielded_item = True
                yield _sse("response.output_item.added", {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {"id": text_id, "type": "message",
                             "role": "assistant", "status": "in_progress",
                             "content": []},
                })
            if not yielded_part:
                yielded_part = True
                yield _sse("response.content_part.added", {
                    "type": "response.content_part.added",
                    "item_id": text_id, "output_index": 0,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": ""},
                })
            yield _sse("response.output_text.delta", {
                "type": "response.output_text.delta",
                "item_id": text_id, "output_index": 0,
                "content_index": 0, "delta": content,
            })

        # Tool calls (accumulated)
        for tc in delta.get("tool_calls", []):
            idx = tc.get("index", 0)
            if idx not in tool_calls:
                tool_calls[idx] = {"id": tc.get("id", ""), "name": "", "arguments": ""}
            e = tool_calls[idx]
            if "id" in tc and tc["id"]:
                e["id"] = tc["id"]
            f = tc.get("function", {})
            if "name" in f and f["name"]:
                e["name"] = f["name"]
            if "arguments" in f and f["arguments"]:
                e["arguments"] += f["arguments"]

    # Done events for text
    if yielded_part:
        yield _sse("response.content_part.done", {
            "type": "response.content_part.done",
            "item_id": text_id, "output_index": 0, "content_index": 0,
            "part": {"type": "output_text", "text": ""},
        })
    if yielded_item:
        yield _sse("response.output_item.done", {
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {"id": text_id, "type": "message", "role": "assistant",
                     "status": "completed", "content": []},
        })

    # Tool call events
    for idx in sorted(tool_calls):
        tc = tool_calls[idx]
        if tc["name"]:
            yield _sse("response.output_item.added", {
                "type": "response.output_item.added",
                "item": {"id": tc["id"], "type": "function_call",
                         "name": tc["name"], "arguments": tc["arguments"]},
            })
            yield _sse("response.output_item.done", {
                "type": "response.output_item.done",
                "item": {"id": tc["id"], "type": "function_call",
                         "name": tc["name"], "arguments": tc["arguments"]},
            })

    # Completion
    output = []
    if yielded_item:
        output.append({"id": text_id, "type": "message", "role": "assistant"})
    for idx in sorted(tool_calls):
        tc = tool_calls[idx]
        if tc["name"]:
            output.append({"id": tc["id"], "type": "function_call",
                           "name": tc["name"], "arguments": tc["arguments"]})

    complete = {
        "type": "response.completed",
        "response": {"id": response_id, "object": "response",
                     "status": "completed", "output": output},
    }
    if usage:
        complete["response"]["usage"] = {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        }
    yield _sse("response.completed", complete)


def _sse(event_name, data):
    return f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ═══════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════

@app.route("/v1/models", methods=["GET"])
def list_models():
    """Proxy and normalize /v1/models."""
    try:
        resp = http_requests.get(
            f"{UPSTREAM_BASE}/models",
            headers=upstream_headers(),
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            models_list = data.get("data", [])
            defaults = {
                "object": "model",
                "context_window": 128000,
                "max_output_tokens": 16384,
                "supported_reasoning_levels": [],
                "supports_reasoning": False,
                "supports_images": False,
                "supports_tools": True,
                "supports_streaming": True,
                "shell_type": "default",
                "visibility": "public",
                "features": [],
                "capabilities": {},
                "pricing": {"prompt": 0, "completion": 0},
            }
            for m in models_list:
                for k, v in defaults.items():
                    m.setdefault(k, v)
                m.setdefault("slug", m.get("id", ""))
                m.setdefault("display_name", m.get("id", ""))
                m.setdefault("description", m.get("id", ""))
            return {"object": "list", "models": models_list, "data": models_list}
        return Response(resp.content, status=resp.status_code,
                        mimetype="application/json")
    except Exception as e:
        log.error(f"models error: {e}")
        return {"object": "list", "data": []}


@app.route("/v1/responses", methods=["POST"])
def handle_responses():
    """Translate Responses API → Chat Completions."""
    body = request.get_json(force=True)
    log.info(f"Responses: model={body.get('model')}, stream={body.get('stream')}")

    chat_body = responses_to_chat(body)
    stream = chat_body.get("stream", False)

    try:
        resp = http_requests.post(
            f"{UPSTREAM_BASE}/chat/completions",
            json=chat_body,
            headers=upstream_headers(),
            stream=stream,
            timeout=300,
        )
    except Exception as e:
        log.error(f"Upstream failed: {e}")
        return {"error": str(e)}, 502

    if resp.status_code != 200:
        log.error(f"Upstream {resp.status_code}: {resp.text[:500]}")
        return Response(resp.content, status=resp.status_code,
                        mimetype="application/json")

    if stream:
        def generate():
            rid = f"resp_{uuid.uuid4().hex[:12]}"
            try:
                for event in chat_stream_to_responses(resp, rid):
                    yield event
            except Exception as e:
                log.error(f"Stream error: {e}")
                yield _sse("error", {"type": "error",
                                     "error": {"message": str(e)}})

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    else:
        # Non-streaming fallback
        cr = resp.json()
        choice = cr.get("choices", [{}])[0]
        msg = choice.get("message", {})
        content = msg.get("content", "")
        rid = f"resp_{uuid.uuid4().hex[:12]}"
        output = []
        if content:
            output.append({
                "id": rid + "_text", "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": content}],
            })
        for tc in msg.get("tool_calls", []):
            output.append({
                "id": tc.get("id", ""), "type": "function_call",
                "name": tc.get("function", {}).get("name", ""),
                "arguments": tc.get("function", {}).get("arguments", ""),
            })
        return {
            "id": rid, "object": "response", "status": "completed",
            "output": output,
            "usage": {
                "input_tokens": cr.get("usage", {}).get("prompt_tokens", 0),
                "output_tokens": cr.get("usage", {}).get("completion_tokens", 0),
                "total_tokens": cr.get("usage", {}).get("total_tokens", 0),
            },
        }


@app.route("/health", methods=["GET"])
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Codex Responses API Bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--token", help=f"API token (or set {TOKEN_ENV_VAR})")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if args.token:
        os.environ[TOKEN_ENV_VAR] = args.token

    if not get_token():
        log.warning(f"{TOKEN_ENV_VAR} not set! Set via --token or env var.")

    log.info(f"Bridge: http://{args.host}:{args.port} → {UPSTREAM_BASE}")
    app.run(host=args.host, port=args.port, debug=args.debug)
```

### 4.2 Customizing for Different Providers

To adapt the bridge for a different provider, change these at the top:

| Variable | What to change |
|----------|---------------|
| `UPSTREAM_BASE` | Provider's API base URL (e.g., `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`) |
| `TOKEN_ENV_VAR` | Env var name for the API key |
| `SPOOF_ORIGINATOR` | Set to `"codex_cli_rs"` if the provider has client restrictions. Remove these headers entirely if the provider doesn't check. |
| `SPOOF_USER_AGENT` | Match your Codex version. Check with `codex --version`. |
| `SPOOF_VERSION` | Same as above. |

**For providers WITHOUT client restrictions** (OpenRouter, LiteLLM, most self-hosted):
Remove the `Originator`, `User-Agent`, and `Version` headers from `upstream_headers()`.

**For providers that DO support the Responses API natively**:
Don't use a bridge at all. Just set `base_url` directly in config.toml:
```toml
[model_providers.my-provider]
base_url = "https://api.provider.com/v1"
wire_api = "responses"
```

---

## 5. Step 3: Testing and Verification

### 5.1 Start the Bridge

```powershell
# Windows (PowerShell)
$env:MY_PROVIDER_TOKEN = "your-api-key"
python ~/.codex/bridge/bridge.py --port 9876
```

```bash
# macOS/Linux
export MY_PROVIDER_TOKEN="your-api-key"
python ~/.codex/bridge/bridge.py --port 9876
```

### 5.2 Health Check

```bash
curl http://127.0.0.1:9876/health
# Expected: {"status":"ok"}
```

### 5.3 Models Endpoint

```bash
curl http://127.0.0.1:9876/v1/models
# Expected: {"object":"list","data":[...]}
```

### 5.4 Direct SSE Test (bypassing Codex)

```bash
curl -N -X POST http://127.0.0.1:9876/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","input":[{"role":"user","content":"Say hello world"}],"stream":true}'
```

**Expected output** (SSE events in order):
```
event: response.created
data: {"type":"response.created",...}

event: response.in_progress
data: {"type":"response.in_progress",...}

event: response.output_item.added
data: {"type":"response.output_item.added",...}

event: response.content_part.added
data: {"type":"response.content_part.added",...}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello",...}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":", world!",...}

event: response.content_part.done
data: {...}

event: response.output_item.done
data: {...}

event: response.completed
data: {...}
```

### 5.5 Full Codex Integration Test

```bash
# Verify config loads without errors
codex --strict-config exec "echo test"

# Full end-to-end
codex exec "say hello world"
```

### 5.6 Validate Config with Doctor

```bash
codex doctor
```

The `config` check should pass (green). If it fails, Codex will tell you exactly
which line and why.

---

## 6. Troubleshooting

### 6.1 `wire_api = "chat"` is no longer supported

```
Error loading config.toml:
wire_api = "chat" is no longer supported.
How to fix: set wire_api = "responses"
```

**Fix**: Change `wire_api` to `"responses"` and use the bridge for translation.

### 6.2 `unknown configuration field`

```
Error loading config.toml:
unknown configuration field `preferred_auth_method`
```

**Fix**: `preferred_auth_method` is not a valid top-level key in Codex 0.135.0.
Remove it. The `env_key` in your provider config handles auth.

### 6.3 TOML key parsed under wrong section

```
unknown configuration field `model_providers.my-provider.notify`
```

**Fix**: Your `notify` (or other top-level keys) got pulled into the
`[model_providers]` section. Move the `[model_providers]` block to the **end**
of the config file, or ensure there's a new `[section]` header between it and
any top-level keys.

### 6.4 `unauthorized client detected`

```
401 Unauthorized: unauthorized client detected, contact support
```

**Fix**: The provider has client restrictions. Add the spoofed headers:
```python
"Originator": "codex_cli_rs",
"User-Agent": "codex_cli_rs/0.135.0 (...)",
"Version": "0.135.0",
```

### 6.5 `404 Not Found: Invalid URL (POST /v1/responses)`

```
ERROR: unexpected status 404 Not Found: Invalid URL (POST /v1/responses)
```

**Fix 1**: Your provider doesn't support the Responses API. Use the bridge.

**Fix 2**: The bridge isn't running. Start it with `python bridge.py`.

**Fix 3**: The `base_url` in config.toml doesn't point at the bridge.
Should be `http://127.0.0.1:9876/v1`.

### 6.6 `OutputTextDelta without active item`

```
ERROR codex_core::util: OutputTextDelta without active item
```

**Fix**: Your SSE events are out of order. `response.output_text.delta` must
be preceded by `response.output_item.added` and `response.content_part.added`.
See the SSE event sequence in section 5.4.

### 6.7 `failed to decode models response: missing field 'X'`

```
ERROR codex_models_manager::manager: failed to refresh available models:
missing field `slug` / `display_name` / `shell_type` / `visibility`
```

**Note**: This is **cosmetic**. The models endpoint error doesn't prevent
Codex from working. Codex has a rigid internal schema for model metadata.
Add the missing field to the `defaults` dict in the bridge's `/v1/models`
handler. The error message tells you exactly which field and which valid
values are expected.

### 6.8 `connection refused` when starting bridge

```
ConnectionRefusedError: [Errno 61] Connection refused
```

**Fix**: Port 9876 is already in use. Kill the old bridge process or use a
different port with `--port 9877`.

---

## 7. Productionizing

### 7.1 Auto-start on Login

**Windows** — Create a scheduled task:
```powershell
$action = New-ScheduledTaskAction -Execute "python" `
  -Argument "C:\Users\$env:USERNAME\.codex\bridge\bridge.py"
$trigger = New-ScheduledTaskTrigger -AtLogon
Register-ScheduledTask -TaskName "CodexBridge" -Action $action `
  -Trigger $trigger -RunLevel Limited
```

**macOS** — Create a LaunchAgent at `~/Library/LaunchAgents/com.codex.bridge.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.codex.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/YOU/.codex/bridge/bridge.py</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
```

### 7.2 Use a Production WSGI Server

Flask's dev server is single-threaded. For better reliability:
```bash
pip install waitress
python -c "from waitress import serve; from bridge import app; serve(app, host='127.0.0.1', port=9876)"
```

### 7.3 API Key Security

Never hardcode API keys in the bridge script. Always use environment variables.
For Windows, set via System Properties > Environment Variables.
For macOS/Linux, add to `~/.zshrc` or `~/.bashrc`:
```bash
export MY_PROVIDER_TOKEN="sk-..."
```

---

## 8. Key SSE Event Sequence (Reference)

The Responses API requires this exact SSE event order for text output:

```
1. response.created
2. response.in_progress
3. response.output_item.added      ← item: {type: "message", role: "assistant"}
4. response.content_part.added      ← part: {type: "output_text"}
5. response.output_text.delta       ← (repeated for each token)
6. response.content_part.done
7. response.output_item.done
8. response.completed               ← includes usage stats
```

For tool calls (function calling), after step 2:
```
3. response.output_item.added       ← item: {type: "function_call", name, arguments}
4. response.output_item.done
5. response.completed
```

Getting this order wrong causes `OutputTextDelta without active item` errors.

---

## 9. Sources and References

| Resource | URL |
|----------|-----|
| Codex Advanced Config | https://developers.openai.com/codex/config-advanced |
| Codex Config Reference | https://developers.openai.com/codex/config-reference |
| Codex Custom Providers | https://developers.openai.com/codex/config-advanced#custom-model-providers |
| Chat/Completions Deprecation Discussion | https://github.com/openai/codex/discussions/7782 |
| AgentRouter Codex Docs | https://docs.agentrouter.org/codex.html |
| AgentRouter Token Console | https://agentrouter.org/console/token |
| Bypassing Client Restrictions (blog) | https://blog.rei.my.id/posts/118/bypassing-agentrouter-ai-client-restriction/ |
| va-ai-api-bridge (Rust crate) | https://github.com/jazzenchen/va-ai-api-bridge |
| VibeAround (API bridge + agent launcher) | https://github.com/jazzenchen/VibeAround |
| Responses API → Chat bridge (gist) | https://gist.github.com/jazzenchen/46b2a5301fb5b6d6dce312b2272d7d8f |
| OpenCodex (NVIDIA NIM bridge) | https://github.com/hackwidmaddy/OpenCodex |
| AgentRouter client restriction issue | https://github.com/agentrouter-org/docs/issues/21 |

---

## 10. Quick-Start Checklist

- [ ] Obtain API key from provider console
- [ ] Set `MY_PROVIDER_TOKEN` environment variable
- [ ] Create `~/.codex/bridge/bridge.py` with correct `UPSTREAM_BASE`
- [ ] Edit `~/.codex/config.toml`: add `model`, `model_provider`, and `[model_providers.xxx]` block
- [ ] Start bridge: `python ~/.codex/bridge/bridge.py`
- [ ] Verify: `curl http://127.0.0.1:9876/health`
- [ ] Test SSE: `curl -N -X POST http://127.0.0.1:9876/v1/responses ...`
- [ ] Test Codex: `codex --strict-config exec "say hello"`
- [ ] Done. Use Codex normally.
