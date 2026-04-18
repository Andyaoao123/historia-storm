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

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = os.getenv(
    "OPENROUTER_MODEL",
    "qwen/qwen-2.5-7b-instruct",
)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/storm", methods=["POST", "OPTIONS"])
def storm():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENROUTER_API_KEY:
        return jsonify({"error": "Missing OPENROUTER_API_KEY"}), 500

    payload = request.get_json(silent=True) or {}
    persona_prompt = (payload.get("persona_prompt") or "").strip()
    brief = (payload.get("brief") or "").strip()

    if not persona_prompt or not brief:
        return jsonify({"error": "persona_prompt and brief are required"}), 400

    user_prompt = (
        f"{persona_prompt}\n\n---\n以下是团队提出的创意Brief：\n\n{brief}\n\n---\n"
        "请严格以该人格的身份回应，用你独特的认识论框架和语气。"
    )

    try:
        response = requests.post(
            OPENROUTER_BASE_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": os.getenv("OPENROUTER_SITE_URL", "http://localhost:5173"),
                "X-Title": os.getenv("OPENROUTER_APP_NAME", "Historia Storm"),
            },
            json={
                "model": OPENROUTER_MODEL,
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
        return jsonify({"error": "OpenRouter request failed", "detail": detail or str(exc)}), status_code

    data = response.json()
    result = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )

    if not result:
        return jsonify({"error": "Empty response from OpenRouter", "detail": data}), 502

    return jsonify({"result": result})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
