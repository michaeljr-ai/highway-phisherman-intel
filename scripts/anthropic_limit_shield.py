#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import random
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_STATE = Path.home() / ".claude-limit-shield" / "chat_state.json"


RETRYABLE_STATUS = {429, 500, 502, 503, 504, 529}


class PromptTooLongError(RuntimeError):
    pass


class ApiRequestError(RuntimeError):
    pass


@dataclass
class Pacer:
    requests_per_minute: float
    next_ready_monotonic: float = 0.0

    def wait(self) -> None:
        if self.requests_per_minute <= 0:
            return
        interval = 60.0 / self.requests_per_minute
        now = time.monotonic()
        if now < self.next_ready_monotonic:
            time.sleep(self.next_ready_monotonic - now)
        self.next_ready_monotonic = time.monotonic() + interval


def estimate_tokens(text: str) -> int:
    # Conservative approximation for budget control.
    return max(1, len(text) // 4)


def estimate_message_tokens(messages: List[Dict[str, str]], system_prompt: str) -> int:
    total = estimate_tokens(system_prompt) if system_prompt else 0
    for msg in messages:
        total += 8 + estimate_tokens(msg.get("content", ""))
    return total


def normalize_text(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text).strip()


def split_by_size(text: str, max_chars: int) -> List[str]:
    if len(text) <= max_chars:
        return [text]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        paragraphs = [text]

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for para in paragraphs:
        p = para + "\n\n"
        if len(p) > max_chars:
            if current:
                chunks.append("".join(current).strip())
                current, current_len = [], 0
            for i in range(0, len(para), max_chars):
                chunks.append(para[i : i + max_chars].strip())
            continue
        if current_len + len(p) > max_chars and current:
            chunks.append("".join(current).strip())
            current, current_len = [], 0
        current.append(p)
        current_len += len(p)
    if current:
        chunks.append("".join(current).strip())
    return [c for c in chunks if c]


def _headline_lines(text: str) -> List[str]:
    selected: List[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(("#", "##", "###", "-", "*")):
            selected.append(stripped)
            continue
        if stripped.endswith(":") and len(stripped) <= 120:
            selected.append(stripped)
            continue
        if "?" in stripped and len(stripped) <= 200:
            selected.append(stripped)
    return selected


def compress_text(text: str, target_chars: int) -> str:
    if len(text) <= target_chars:
        return text

    paragraphs = [normalize_text(p) for p in re.split(r"\n\s*\n", text) if normalize_text(p)]
    if not paragraphs:
        return text[: target_chars - 1] + "…"

    lines: List[str] = []
    lines.extend(_headline_lines(text))

    # Keep beginning and end context.
    lines.extend(paragraphs[:3])
    if len(paragraphs) > 3:
        lines.append("…")
    lines.extend(paragraphs[-3:])

    out: List[str] = []
    used = 0
    seen = set()
    for item in lines:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        candidate = item if item.startswith(("•", "-", "#")) else f"• {item}"
        need = len(candidate) + 1
        if used + need > target_chars:
            break
        out.append(candidate)
        used += need
    if not out:
        return text[: target_chars - 1] + "…"
    joined = "\n".join(out)
    if len(joined) > target_chars:
        return joined[: target_chars - 1] + "…"
    return joined


def summarize_messages(messages: List[Dict[str, str]], max_chars: int = 5000) -> str:
    bullets: List[str] = []
    for msg in messages:
        role = msg.get("role", "user")
        prefix = "User" if role == "user" else "Assistant"
        content = normalize_text(msg.get("content", ""))
        if not content:
            continue
        snippet = content if len(content) <= 280 else content[:280] + "…"
        bullets.append(f"• {prefix}: {snippet}")
    merged = "\n".join(bullets)
    return compress_text(merged, max_chars)


def ensure_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def load_state(path: Path) -> Dict[str, object]:
    if not path.exists():
        return {"summary": "", "messages": []}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if "summary" not in data:
        data["summary"] = ""
    if "messages" not in data or not isinstance(data["messages"], list):
        data["messages"] = []
    return data


def save_state(path: Path, state: Dict[str, object]) -> None:
    ensure_dir(path)
    with path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def parse_error_message(body: bytes) -> str:
    try:
        payload = json.loads(body.decode("utf-8", errors="ignore"))
    except Exception:
        return body.decode("utf-8", errors="ignore")[:600]
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            msg = err.get("message")
            if isinstance(msg, str):
                return msg
    return json.dumps(payload)[:600]


def build_ssl_context(allow_insecure_ssl: bool) -> ssl.SSLContext:
    if allow_insecure_ssl:
        return ssl._create_unverified_context()

    # Prefer certifi because some Python installations miss macOS trust roots.
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def anthropic_call(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    max_output_tokens: int,
    timeout_seconds: float,
    retries: int,
    pacer: Pacer,
    ssl_context: ssl.SSLContext,
) -> str:
    payload = {
        "model": model,
        "max_tokens": max_output_tokens,
        "messages": messages,
    }
    if system_prompt:
        payload["system"] = system_prompt

    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
    }

    for attempt in range(retries + 1):
        pacer.wait()
        req = urllib.request.Request(API_URL, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds, context=ssl_context) as resp:
                body = resp.read()
                obj = json.loads(body.decode("utf-8"))
                parts = []
                for item in obj.get("content", []):
                    if isinstance(item, dict) and item.get("type") == "text":
                        parts.append(item.get("text", ""))
                text = "".join(parts).strip()
                if not text:
                    raise ApiRequestError("Anthropic response did not include text content.")
                return text
        except urllib.error.HTTPError as exc:
            body = exc.read()
            message = parse_error_message(body)
            if exc.code == 400 and ("too long" in message.lower() or "context" in message.lower()):
                raise PromptTooLongError(message) from exc
            if exc.code in RETRYABLE_STATUS and attempt < retries:
                retry_after = exc.headers.get("retry-after")
                if retry_after:
                    try:
                        sleep_s = max(0.5, float(retry_after))
                    except ValueError:
                        sleep_s = 1.5
                else:
                    sleep_s = min(45.0, (2 ** attempt) + random.uniform(0.2, 1.4))
                time.sleep(sleep_s)
                continue
            raise ApiRequestError(f"HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            err_text = str(exc)
            if "CERTIFICATE_VERIFY_FAILED" in err_text:
                raise ApiRequestError(
                    "TLS certificate verification failed. "
                    "Use certifi-backed trust store or run with --allow-insecure-ssl as last resort."
                ) from exc
            if attempt < retries:
                sleep_s = min(30.0, (2 ** attempt) + random.uniform(0.1, 0.8))
                time.sleep(sleep_s)
                continue
            raise ApiRequestError(f"Network error: {exc}") from exc

    raise ApiRequestError("request failed after retries")


def maybe_compress_history(state: Dict[str, object], keep_last_messages: int, summary_chars: int) -> bool:
    messages: List[Dict[str, str]] = state.get("messages", [])  # type: ignore[assignment]
    if len(messages) <= keep_last_messages:
        return False

    older = messages[:-keep_last_messages]
    recent = messages[-keep_last_messages:]
    delta = summarize_messages(older, max_chars=summary_chars // 2)

    existing_summary = str(state.get("summary", ""))
    merged = (existing_summary + "\n" + delta).strip() if existing_summary else delta
    state["summary"] = compress_text(merged, summary_chars)
    state["messages"] = recent
    return True


def build_messages(state: Dict[str, object], user_text: str) -> List[Dict[str, str]]:
    messages: List[Dict[str, str]] = []
    summary = str(state.get("summary", "")).strip()
    if summary:
        messages.append(
            {
                "role": "assistant",
                "content": (
                    "Conversation memory (compressed):\n"
                    f"{summary}\n\nUse this only as context."
                ),
            }
        )
    base_messages: List[Dict[str, str]] = state.get("messages", [])  # type: ignore[assignment]
    messages.extend(base_messages)
    messages.append({"role": "user", "content": user_text})
    return messages


def compress_user_input_if_needed(user_text: str, max_input_tokens: int) -> Tuple[str, bool]:
    budget_chars = max(1200, int((max_input_tokens * 4) * 0.45))
    if len(user_text) <= budget_chars:
        return user_text, False

    chunks = split_by_size(user_text, max_chars=max(900, budget_chars // 4))
    compact_chunks = []
    for i, chunk in enumerate(chunks, start=1):
        brief = compress_text(chunk, target_chars=max(500, budget_chars // max(3, len(chunks))))
        compact_chunks.append(f"[Chunk {i}/{len(chunks)}]\n{brief}")

    compressed = (
        "Long user input auto-compressed to avoid context overflow.\n"
        "If key details are missing, ask focused follow-up questions.\n\n"
        + "\n\n".join(compact_chunks)
    )
    if len(compressed) > budget_chars:
        compressed = compress_text(compressed, budget_chars)
    return compressed, True


def send_user_message(
    *,
    state: Dict[str, object],
    user_text: str,
    api_key: str,
    model: str,
    system_prompt: str,
    max_input_tokens: int,
    max_output_tokens: int,
    retries: int,
    timeout_seconds: float,
    keep_last_messages: int,
    summary_chars: int,
    pacer: Pacer,
    ssl_context: ssl.SSLContext,
) -> Tuple[str, Dict[str, object], Dict[str, object]]:
    original_user_text = user_text
    user_text, user_input_compressed = compress_user_input_if_needed(user_text, max_input_tokens)

    # Make a working copy; only persist if call succeeds.
    working = {
        "summary": state.get("summary", ""),
        "messages": list(state.get("messages", [])),  # type: ignore[arg-type]
    }

    compression_passes = 0
    while True:
        messages = build_messages(working, user_text)
        input_tokens = estimate_message_tokens(messages, system_prompt)
        if input_tokens <= max_input_tokens:
            break
        did = maybe_compress_history(working, keep_last_messages=keep_last_messages, summary_chars=summary_chars)
        compression_passes += 1
        if not did or compression_passes > 8:
            # Last resort: compress current user input harder.
            user_text = compress_text(user_text, max(1200, int((max_input_tokens * 4) * 0.25)))
            messages = build_messages(working, user_text)
            if estimate_message_tokens(messages, system_prompt) <= max_input_tokens:
                break
            raise PromptTooLongError(
                "Input remains over context budget after compression. Shorten prompt or reset chat state."
            )

    prompt_too_long_retries = 0
    while True:
        messages = build_messages(working, user_text)
        try:
            assistant_text = anthropic_call(
                api_key=api_key,
                model=model,
                system_prompt=system_prompt,
                messages=messages,
                max_output_tokens=max_output_tokens,
                timeout_seconds=timeout_seconds,
                retries=retries,
                pacer=pacer,
                ssl_context=ssl_context,
            )
            break
        except PromptTooLongError:
            prompt_too_long_retries += 1
            if prompt_too_long_retries > 4:
                raise
            did = maybe_compress_history(
                working, keep_last_messages=max(4, keep_last_messages // 2), summary_chars=summary_chars
            )
            if not did:
                user_text = compress_text(user_text, max(1000, int((max_input_tokens * 4) * 0.2)))

    messages_store: List[Dict[str, str]] = working.get("messages", [])  # type: ignore[assignment]
    messages_store.append({"role": "user", "content": user_text})
    messages_store.append({"role": "assistant", "content": assistant_text})
    working["messages"] = messages_store

    while estimate_message_tokens(build_messages(working, ""), system_prompt) > max_input_tokens:
        if not maybe_compress_history(working, keep_last_messages=keep_last_messages, summary_chars=summary_chars):
            break

    meta = {
        "user_input_compressed": user_input_compressed,
        "user_input_original_chars": len(original_user_text),
        "user_input_sent_chars": len(user_text),
        "estimated_input_tokens": estimate_message_tokens(build_messages(working, ""), system_prompt),
    }
    return assistant_text, working, meta


def read_multiline_input() -> str:
    print("Enter message. Finish with a single line containing only `/end`.")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == "/end":
            break
        lines.append(line)
    return "\n".join(lines).strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Anthropic chat wrapper with context compression + 429 backoff.\n"
            "This does not bypass server limits; it stays within them automatically."
        )
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--system-prompt", default="Be accurate, concise, and explicit about assumptions.")
    parser.add_argument("--max-input-tokens", type=int, default=140000)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--requests-per-minute", type=float, default=8.0)
    parser.add_argument("--retries", type=int, default=6)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument(
        "--allow-insecure-ssl",
        action="store_true",
        help="Disable TLS certificate verification (last resort only).",
    )
    parser.add_argument("--keep-last-messages", type=int, default=10)
    parser.add_argument("--summary-chars", type=int, default=10000)
    parser.add_argument("--prompt", help="Single prompt mode. If omitted, starts interactive shell.")
    parser.add_argument(
        "--api-key-env",
        default="ANTHROPIC_API_KEY",
        help="Environment variable containing Anthropic API key.",
    )
    args = parser.parse_args()

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        print(f"Missing API key in ${args.api_key_env}", file=sys.stderr)
        return 1

    state = load_state(args.state_file)
    pacer = Pacer(requests_per_minute=args.requests_per_minute)
    ssl_context = build_ssl_context(args.allow_insecure_ssl)

    def handle_prompt(user_text: str) -> int:
        nonlocal state
        if not user_text.strip():
            return 0
        try:
            answer, next_state, meta = send_user_message(
                state=state,
                user_text=user_text,
                api_key=api_key,
                model=args.model,
                system_prompt=args.system_prompt,
                max_input_tokens=args.max_input_tokens,
                max_output_tokens=args.max_output_tokens,
                retries=args.retries,
                timeout_seconds=args.timeout_seconds,
                keep_last_messages=args.keep_last_messages,
                summary_chars=args.summary_chars,
                pacer=pacer,
                ssl_context=ssl_context,
            )
        except (ApiRequestError, PromptTooLongError) as exc:
            print(f"[error] {exc}", file=sys.stderr)
            return 2

        state = next_state
        save_state(args.state_file, state)
        print(answer)
        print(
            f"\n[meta] compressed={meta['user_input_compressed']} "
            f"chars={meta['user_input_sent_chars']}/{meta['user_input_original_chars']} "
            f"est_tokens={meta['estimated_input_tokens']}"
        )
        return 0

    if args.prompt is not None:
        return handle_prompt(args.prompt)

    print(f"Limit Shield ready. model={args.model} state={args.state_file}")
    print("Commands: /exit, /reset, /stats, /multiline")
    while True:
        try:
            raw = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not raw:
            continue
        if raw in {"/exit", "/quit"}:
            break
        if raw == "/reset":
            state = {"summary": "", "messages": []}
            save_state(args.state_file, state)
            print("[ok] state reset")
            continue
        if raw == "/stats":
            msgs = build_messages(state, "")
            est = estimate_message_tokens(msgs, args.system_prompt)
            print(
                f"[stats] messages={len(state.get('messages', []))} "
                f"summary_chars={len(str(state.get('summary', '')))} est_tokens={est}"
            )
            continue
        if raw == "/multiline":
            raw = read_multiline_input()
            if not raw:
                continue

        rc = handle_prompt(raw)
        if rc != 0:
            continue

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
