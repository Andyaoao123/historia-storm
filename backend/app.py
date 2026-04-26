import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": "*"}},
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "OPTIONS"],
)

PROVIDER_CONFIGS = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1/chat/completions",
        "default_model": os.getenv("OPENROUTER_MODEL", "qwen/qwen-2.5-72b-instruct"),
        "headers": {
            "HTTP-Referer": os.getenv("OPENROUTER_SITE_URL", "http://localhost:5173"),
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


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/storm", methods=["POST", "OPTIONS"])
def storm():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
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
        return jsonify({"error": "persona_prompt and brief are required"}), 400

    if provider_config is None:
        return jsonify({"error": f"Unsupported provider: {provider}"}), 400

    if not api_key:
        return jsonify({"error": f"Missing API key for provider: {provider}"}), 400

    model = model or provider_config["default_model"]

    user_prompt = (
        f"{persona_prompt}\n\n---\n以下是团队提出的创意Brief：\n\n{brief}\n\n---\n"
        "请严格以该人格的身份回应，用你独特的认识论框架和语气。"
    )

    try:
        response = requests.post(
            provider_config["base_url"],
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                **provider_config["headers"],
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": user_prompt}],
                "max_tokens": 1000,
            },
            timeout=90,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        status_code = getattr(exc.response, "status_code", 502)
        detail = None
        if exc.response is not None:
            try:
                detail = exc.response.json()
            except ValueError:
                detail = exc.response.text
        return jsonify({"error": f"{provider} request failed", "detail": detail or str(exc)}), status_code

    data = response.json()
    result = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )

    if not result:
        return jsonify({"error": f"Empty response from {provider}", "detail": data}), 502

    return jsonify({"result": result})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
