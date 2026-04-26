import json
import os
from http.server import BaseHTTPRequestHandler
from urllib import error, request


PROVIDER_CONFIGS = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1/chat/completions",
        "default_model": os.getenv("OPENROUTER_MODEL", "qwen/qwen-2.5-72b-instruct"),
        "headers": {
            "HTTP-Referer": os.getenv("OPENROUTER_SITE_URL", "https://historia-storm.vercel.app"),
            "X-Title": os.getenv("OPENROUTER_APP_NAME", "Historia Storm"),
        },
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/chat/completions",
        "default_model": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "headers": {},
    },
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "default_model": os.getenv("QWEN_MODEL", "qwen-plus"),
        "headers": {},
    },
}


def send_json(handler, status_code, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0"))

        try:
            raw_body = self.rfile.read(content_length).decode("utf-8") if content_length else "{}"
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            send_json(self, 400, {"error": "Invalid JSON body"})
            return

        persona_prompt = (payload.get("persona_prompt") or "").strip()
        brief = (payload.get("brief") or "").strip()
        provider = (payload.get("provider") or "openrouter").strip().lower()
        provider_config = PROVIDER_CONFIGS.get(provider)
        api_key = (
            (payload.get("api_key") or "").strip()
            or os.getenv(f"{provider.upper()}_API_KEY", "").strip()
        )
        model = (payload.get("model") or "").strip()

        if not persona_prompt or not brief:
            send_json(self, 400, {"error": "persona_prompt and brief are required"})
            return

        if provider_config is None:
            send_json(self, 400, {"error": f"Unsupported provider: {provider}"})
            return

        if not api_key:
            send_json(self, 400, {"error": f"Missing API key for provider: {provider}"})
            return

        model = model or provider_config["default_model"]
        user_prompt = (
            f"{persona_prompt}\n\n---\n以下是团队提出的创意Brief：\n\n{brief}\n\n---\n"
            "请严格以该人格的身份回应，用你独特的认识论框架和语气。"
        )

        upstream_payload = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": user_prompt}],
                "max_tokens": 1000,
            }
        ).encode("utf-8")

        upstream_request = request.Request(
            provider_config["base_url"],
            data=upstream_payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                **provider_config["headers"],
            },
            method="POST",
        )

        try:
            with request.urlopen(upstream_request, timeout=90) as response:
                data = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(detail)
            except json.JSONDecodeError:
                pass
            send_json(self, exc.code, {"error": f"{provider} request failed", "detail": detail})
            return
        except error.URLError as exc:
            send_json(self, 502, {"error": f"{provider} request failed", "detail": str(exc.reason)})
            return

        result = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not result:
            send_json(self, 502, {"error": f"Empty response from {provider}", "detail": data})
            return

        send_json(self, 200, {"result": result})
