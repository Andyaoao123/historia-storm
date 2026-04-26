import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { PERSONAS } from "./personas";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "";
const API_CONFIG_STORAGE_KEY = "historia-storm-api-config";
const PROVIDER_OPTIONS = [
  {
    value: "openrouter",
    label: "OpenRouter",
    modelPlaceholder: "例如：qwen/qwen-2.5-72b-instruct",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    modelPlaceholder: "例如：deepseek-chat",
  },
  {
    value: "qwen",
    label: "千问 / DashScope",
    modelPlaceholder: "例如：qwen-plus",
  },
];
const DEFAULT_PROVIDER = PROVIDER_OPTIONS[0].value;
const DEFAULT_MODELS = {
  openrouter: "qwen/qwen-2.5-72b-instruct",
  deepseek: "deepseek-chat",
  qwen: "qwen-plus",
};

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

function getInitialApiConfig() {
  if (typeof window === "undefined") {
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS[DEFAULT_PROVIDER],
      apiKey: "",
    };
  }

  try {
    const saved = JSON.parse(window.localStorage.getItem(API_CONFIG_STORAGE_KEY) || "{}");
    const provider = saved.provider || DEFAULT_PROVIDER;

    return {
      provider,
      model: saved.model || DEFAULT_MODELS[provider] || "",
      apiKey: saved.apiKey || "",
    };
  } catch {
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS[DEFAULT_PROVIDER],
      apiKey: "",
    };
  }
}

async function callPersona(persona, brief, apiConfig, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/storm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          persona_prompt: persona.prompt,
          brief,
          provider: apiConfig.provider,
          model: apiConfig.model,
          api_key: apiConfig.apiKey,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        const detail =
          typeof data?.detail === "string"
            ? data.detail
            : data?.detail?.error?.message || data?.error || `HTTP ${response.status}`;
        throw new Error(detail);
      }

      if (!data.result) {
        throw new Error("空响应");
      }

      return data.result;
    } catch (error) {
      if (attempt === retries) {
        const message =
          error instanceof Error && error.message
            ? error.message.slice(0, 120)
            : "暂时无法回应，请重试";
        return `（${persona.name}暂时无法回应：${message}）`;
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 1000 * (attempt + 1));
      });
    }
  }

  return `（${persona.name}暂时无法回应，请重试）`;
}

export default function App() {
  const [phase, setPhase] = useState("brief");
  const [brief, setBrief] = useState("");
  const [selectedPersonas, setSelectedPersonas] = useState([]);
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState({});
  const [expandedCard, setExpandedCard] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [apiConfig, setApiConfig] = useState(() => getInitialApiConfig());

  const currentProvider = useMemo(
    () => PROVIDER_OPTIONS.find((item) => item.value === apiConfig.provider) ?? PROVIDER_OPTIONS[0],
    [apiConfig.provider]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(API_CONFIG_STORAGE_KEY, JSON.stringify(apiConfig));
  }, [apiConfig]);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      if (!supabase) {
        setHistoryError("Supabase 未配置，历史记录功能已关闭。");
        return;
      }

      setHistoryLoading(true);
      setHistoryError("");

      const { data, error } = await supabase
        .from("briefs")
        .select("id, content, created_at, personas_used")
        .order("created_at", { ascending: false })
        .limit(6);

      if (cancelled) {
        return;
      }

      if (error) {
        setHistoryError("读取 Brief 历史失败，请检查 Supabase 配置或表结构。");
      } else {
        setHistory(data ?? []);
      }

      setHistoryLoading(false);
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  const togglePersona = (id) => {
    setSelectedPersonas((prev) =>
      prev.includes(id) ? prev.filter((personaId) => personaId !== id) : [...prev, id]
    );
  };

  const refreshHistory = async () => {
    if (!supabase) {
      return;
    }

    const { data, error } = await supabase
      .from("briefs")
      .select("id, content, created_at, personas_used")
      .order("created_at", { ascending: false })
      .limit(6);

    if (error) {
      setHistoryError("读取 Brief 历史失败，请检查 Supabase 配置或表结构。");
      return;
    }

    setHistoryError("");
    setHistory(data ?? []);
  };

  const saveBriefToSupabase = async (content, personasUsed) => {
    if (!supabase) {
      return;
    }

    const { error } = await supabase.from("briefs").insert({
      content,
      personas_used: personasUsed,
    });

    if (error) {
      setSaveError("Brief 已生成，但写入 Supabase 历史记录失败。");
      return;
    }

    setSaveError("");
    await refreshHistory();
  };

  const updateApiConfig = (key, value) => {
    setApiConfig((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const changeProvider = (provider) => {
    setApiConfig((prev) => ({
      ...prev,
      provider,
      model: prev.model === DEFAULT_MODELS[prev.provider] ? DEFAULT_MODELS[provider] : prev.model,
    }));
  };

  const runStorm = async () => {
    if (!brief.trim() || selectedPersonas.length === 0 || !apiConfig.apiKey.trim()) {
      return;
    }

    setPhase("storm");
    setResults({});
    setLoading({});
    setExpandedCard(null);
    setSaveError("");

    const chosen = PERSONAS.filter((persona) => selectedPersonas.includes(persona.id));
    await saveBriefToSupabase(
      brief.trim(),
      chosen.map((persona) => persona.name)
    );

    const requestConfig = {
      provider: apiConfig.provider,
      model: apiConfig.model.trim() || DEFAULT_MODELS[apiConfig.provider],
      apiKey: apiConfig.apiKey.trim(),
    };

    const promises = chosen.map(async (persona) => {
      setLoading((prev) => ({ ...prev, [persona.id]: true }));
      try {
        const result = await callPersona(persona, brief.trim(), requestConfig);
        setResults((prev) => ({ ...prev, [persona.id]: result }));
      } catch (error) {
        setResults((prev) => ({ ...prev, [persona.id]: "调用失败，请重试" }));
      } finally {
        setLoading((prev) => ({ ...prev, [persona.id]: false }));
      }
    });

    await Promise.all(promises);
    setPhase("synthesis");
  };

  const allDone =
    selectedPersonas.length > 0 &&
    selectedPersonas.every((id) => results[id] && !loading[id]);

  const canRun = Boolean(
    brief.trim() && selectedPersonas.length > 0 && apiConfig.apiKey.trim() && apiConfig.model.trim()
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #FFFAF4 0%, #FFF0E8 100%)",
        fontFamily: "'Noto Serif SC', serif",
        color: "#4a3728",
        padding: "0",
        overflowX: "hidden",
      }}
    >
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        {[
          { cx: "8%", cy: "12%", r: 4, fill: "#F2A37A", op: 0.25 },
          { cx: "92%", cy: "20%", r: 3, fill: "#8BB8A8", op: 0.3 },
          { cx: "5%", cy: "60%", r: 5, fill: "#B8A9D9", op: 0.2 },
          { cx: "88%", cy: "75%", r: 3, fill: "#F4C990", op: 0.3 },
          { cx: "50%", cy: "5%", r: 2, fill: "#F2A37A", op: 0.2 },
          { cx: "70%", cy: "90%", r: 4, fill: "#9ECFD4", op: 0.25 },
        ].map((circle, index) => (
          <svg key={index} style={{ position: "absolute", width: "100%", height: "100%" }}>
            <circle
              cx={circle.cx}
              cy={circle.cy}
              r={circle.r}
              fill={circle.fill}
              opacity={circle.op}
            />
          </svg>
        ))}
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 860,
          margin: "0 auto",
          padding: "40px 24px 80px",
        }}
      >
        <div
          style={{
            textAlign: "center",
            marginBottom: 48,
            animation: "fadeUp 0.6s ease-out both",
          }}
        >
          <div
            style={{
              fontSize: 13,
              letterSpacing: 4,
              color: "#9a7c6e",
              marginBottom: 12,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            WORKSHOP TOOL
          </div>
          <h1
            style={{
              fontSize: "clamp(2rem, 5vw, 3.2rem)",
              fontFamily: "'ZCOOL XiaoWei', serif",
              margin: "0 0 8px",
              letterSpacing: 2,
              lineHeight: 1.2,
            }}
          >
            历史风暴
          </h1>
          <div
            style={{
              fontSize: 13,
              color: "#9a7c6e",
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
              letterSpacing: 1,
            }}
          >
            Historia Storm · 借历史的眼睛，看见你的盲点
          </div>
        </div>
        <Section title="幕零  API 配置 → Private Keys" step="00">
          <p
            style={{
              fontSize: 14,
              color: "#9a7c6e",
              marginBottom: 20,
              lineHeight: 1.8,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            API Key 只保存在你当前浏览器的本地存储里，不写进网页公开配置。你只需要选供应商、填模型和
            API Key，URL 会在后端自动匹配。
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            <label style={fieldLabelStyle}>
              <span>模型供应商</span>
              <select
                value={apiConfig.provider}
                onChange={(event) => changeProvider(event.target.value)}
                style={inputStyle}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              <span>模型名</span>
              <input
                value={apiConfig.model}
                onChange={(event) => updateApiConfig("model", event.target.value)}
                placeholder={currentProvider.modelPlaceholder}
                style={inputStyle}
              />
            </label>
            <label style={fieldLabelStyle}>
              <span>API Key</span>
              <input
                value={apiConfig.apiKey}
                onChange={(event) => updateApiConfig("apiKey", event.target.value)}
                placeholder="sk-..."
                type="password"
                autoComplete="off"
                style={inputStyle}
              />
            </label>
          </div>
          <div
            style={{
              marginTop: 14,
              padding: "14px 16px",
              borderRadius: 16,
              background: "rgba(255,255,255,0.65)",
              border: "1px solid rgba(242,163,122,0.18)",
              fontSize: 12,
              color: "#7a6050",
              lineHeight: 1.8,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            当前支持：OpenRouter、DeepSeek、千问兼容接口。
            <br />
            如果你切换供应商但没手动改模型名，系统会自动给你带一个推荐默认值。
          </div>
        </Section>
        <Section title="幕一  Human Storm → Brief" step="01">
          <p
            style={{
              fontSize: 14,
              color: "#9a7c6e",
              marginBottom: 20,
              lineHeight: 1.8,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            先不要想答案。把你们真正在解决的问题写下来。
            <br />
            包含：
            <span style={{ color: "#F2A37A" }}>问题核心</span> ·{" "}
            <span style={{ color: "#8BB8A8" }}>不能动的约束</span> ·{" "}
            <span style={{ color: "#B8A9D9" }}>成功长什么样</span>
          </p>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder={
              "例如：\n我们想设计一个帮助职场新人融入团队的破冰工具。\n约束：时间有限，参与者背景差异很大。\n成功：活动结束后，成员之间有了真实的对话，而不只是客套。"
            }
            style={{
              width: "100%",
              minHeight: 160,
              borderRadius: 16,
              border: "1.5px solid rgba(242,163,122,0.3)",
              background: "rgba(255,255,255,0.7)",
              backdropFilter: "blur(8px)",
              padding: "18px 20px",
              fontSize: 15,
              color: "#4a3728",
              fontFamily: "'Noto Serif SC', serif",
              lineHeight: 1.8,
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
              transition: "border-color 0.3s",
            }}
            onFocus={(event) => {
              event.target.style.borderColor = "rgba(242,163,122,0.7)";
            }}
            onBlur={(event) => {
              event.target.style.borderColor = "rgba(242,163,122,0.3)";
            }}
          />
          <div
            style={{
              fontSize: 12,
              color: "#9a7c6e",
              marginTop: 8,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            {brief.length} 字 · 建议 50–300 字
          </div>

          {(historyLoading || historyError || history.length > 0 || saveError) && (
            <div
              style={{
                marginTop: 24,
                paddingTop: 20,
                borderTop: "1px solid rgba(242,163,122,0.18)",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: "#9a7c6e",
                  marginBottom: 12,
                  fontFamily: "'Noto Sans SC', sans-serif",
                  fontWeight: 400,
                  letterSpacing: 1,
                }}
              >
                BRIEF HISTORY
              </div>
              {historyLoading && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#9a7c6e",
                    fontFamily: "'Noto Sans SC', sans-serif",
                    fontWeight: 300,
                  }}
                >
                  正在读取跨设备 Brief 历史…
                </div>
              )}
              {historyError && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#C26A5A",
                    fontFamily: "'Noto Sans SC', sans-serif",
                    fontWeight: 300,
                    marginBottom: 8,
                  }}
                >
                  {historyError}
                </div>
              )}
              {saveError && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#C26A5A",
                    fontFamily: "'Noto Sans SC', sans-serif",
                    fontWeight: 300,
                    marginBottom: 8,
                  }}
                >
                  {saveError}
                </div>
              )}
              <div style={{ display: "grid", gap: 10 }}>
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setBrief(item.content);
                      setSelectedPersonas(
                        PERSONAS.filter((persona) =>
                          (item.personas_used || []).includes(persona.name)
                        ).map((persona) => persona.id)
                      );
                    }}
                    style={{
                      textAlign: "left",
                      borderRadius: 16,
                      border: "1px solid rgba(242,163,122,0.18)",
                      background: "rgba(255,255,255,0.55)",
                      padding: "14px 16px",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        color: "#5a4030",
                        lineHeight: 1.7,
                        fontFamily: "'Noto Serif SC', serif",
                        marginBottom: 8,
                      }}
                    >
                      {item.content.length > 110 ? `${item.content.slice(0, 110)}…` : item.content}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#9a7c6e",
                        fontFamily: "'Noto Sans SC', sans-serif",
                        fontWeight: 300,
                      }}
                    >
                      {(item.personas_used || []).join(" · ")}
                      {item.created_at ? ` · ${new Date(item.created_at).toLocaleString()}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section title="幕二  策展人格 → AI Storm" step="02">
          <p
            style={{
              fontSize: 14,
              color: "#9a7c6e",
              marginBottom: 24,
              lineHeight: 1.8,
              fontFamily: "'Noto Sans SC', sans-serif",
              fontWeight: 300,
            }}
          >
            选 2–4 位历史人物。他们不会给你答案——他们会用各自的世界观，向你提问。
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 16,
            }}
          >
            {PERSONAS.map((persona, index) => {
              const selected = selectedPersonas.includes(persona.id);
              return (
                <div
                  key={persona.id}
                  onClick={() => togglePersona(persona.id)}
                  style={{
                    background: selected ? `${persona.color}22` : "rgba(255,255,255,0.6)",
                    border: `1.5px solid ${
                      selected ? persona.color : "rgba(0,0,0,0.07)"
                    }`,
                    borderRadius: 20,
                    padding: "18px 20px",
                    cursor: "pointer",
                    transition: "all 0.3s ease",
                    transform: selected ? "translateY(-3px)" : "translateY(0)",
                    boxShadow: selected
                      ? `0 8px 24px ${persona.color}33`
                      : "0 2px 8px rgba(0,0,0,0.04)",
                    animation: `fadeUp 0.5s ease-out ${index * 0.08}s both`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      marginBottom: 10,
                    }}
                  >
                    <span style={{ fontSize: 24 }}>{persona.emoji}</span>
                    {selected && <span style={{ fontSize: 16, color: persona.color }}>✓</span>}
                  </div>
                  <div
                    style={{
                      fontSize: 17,
                      fontFamily: "'ZCOOL XiaoWei', serif",
                      marginBottom: 4,
                    }}
                  >
                    {persona.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#9a7c6e",
                      fontFamily: "'Noto Sans SC', sans-serif",
                      fontWeight: 300,
                      marginBottom: 10,
                    }}
                  >
                    {persona.era} · {persona.domain}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#7a6050",
                      lineHeight: 1.6,
                      fontFamily: "'Noto Sans SC', sans-serif",
                      fontWeight: 300,
                    }}
                  >
                    {persona.question_style}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 32, textAlign: "center" }}>
            <button
              onClick={runStorm}
              disabled={!canRun}
              style={{
                background: canRun ? "linear-gradient(135deg, #F2A37A, #E8896A)" : "#e0d0c0",
                color: "white",
                border: "none",
                borderRadius: 50,
                padding: "14px 40px",
                fontSize: 15,
                fontFamily: "'ZCOOL XiaoWei', serif",
                letterSpacing: 2,
                cursor: canRun ? "pointer" : "not-allowed",
                transition: "all 0.3s ease",
                boxShadow: canRun ? "0 8px 24px rgba(242,163,122,0.4)" : "none",
              }}
            >
              ✦ 开启历史风暴
            </button>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "#9a7c6e",
                fontFamily: "'Noto Sans SC', sans-serif",
                fontWeight: 300,
              }}
            >
              {!apiConfig.apiKey.trim()
                ? "先填 API Key 才能发起调用"
                : selectedPersonas.length > 0
                  ? `已选 ${selectedPersonas.length} 位人格 · ${
                      selectedPersonas.length < 2 ? "再选一位效果更好" : "可以出发了"
                    }`
                  : "先选 2–4 位人格"}
            </div>
          </div>
        </Section>
        {(phase === "storm" || phase === "synthesis") && (
          <Section title="风暴进行中" step="03">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: 20,
              }}
            >
              {PERSONAS.filter((persona) => selectedPersonas.includes(persona.id)).map(
                (persona, index) => (
                  <div
                    key={persona.id}
                    style={{
                      background: "rgba(255,255,255,0.75)",
                      backdropFilter: "blur(12px)",
                      borderRadius: 24,
                      border: `1.5px solid ${persona.color}44`,
                      padding: "24px",
                      animation: `fadeUp 0.5s ease-out ${index * 0.12}s both`,
                      boxShadow: `0 8px 32px ${persona.color}20`,
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      setExpandedCard(expandedCard === persona.id ? null : persona.id)
                    }
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        marginBottom: 16,
                      }}
                    >
                      <div
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: "50%",
                          background: `${persona.color}22`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 20,
                          border: `1.5px solid ${persona.color}44`,
                          flexShrink: 0,
                        }}
                      >
                        {persona.emoji}
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: 16,
                            fontFamily: "'ZCOOL XiaoWei', serif",
                          }}
                        >
                          {persona.name}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#9a7c6e",
                            fontFamily: "'Noto Sans SC', sans-serif",
                            fontWeight: 300,
                          }}
                        >
                          {persona.era} · {persona.domain}
                        </div>
                      </div>
                      {loading[persona.id] && (
                        <div
                          style={{
                            marginLeft: "auto",
                            fontSize: 12,
                            color: persona.color,
                            fontFamily: "'Noto Sans SC', sans-serif",
                            fontWeight: 300,
                          }}
                        >
                          思考中…
                        </div>
                      )}
                    </div>

                    {loading[persona.id] ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "12px 0" }}>
                        {[0, 0.15, 0.3].map((delay, dotIndex) => (
                          <div
                            key={dotIndex}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: persona.color,
                              animation: `pulse 1.2s ease-in-out ${delay}s infinite`,
                            }}
                          />
                        ))}
                      </div>
                    ) : results[persona.id] ? (
                      <div
                        style={{
                          fontSize: 13.5,
                          lineHeight: 1.9,
                          color: "#5a4030",
                          fontFamily: "'Noto Serif SC', serif",
                          maxHeight: expandedCard === persona.id ? "none" : "120px",
                          overflow: "hidden",
                          maskImage:
                            expandedCard === persona.id
                              ? "none"
                              : "linear-gradient(to bottom, black 60%, transparent)",
                          WebkitMaskImage:
                            expandedCard === persona.id
                              ? "none"
                              : "linear-gradient(to bottom, black 60%, transparent)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {results[persona.id]}
                      </div>
                    ) : null}

                    {results[persona.id] && !loading[persona.id] && (
                      <div
                        style={{
                          marginTop: 12,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        {results[persona.id].includes("暂时无法回应") ? (
                          <button
                            type="button"
                            onClick={async (event) => {
                              event.stopPropagation();
                              setLoading((prev) => ({ ...prev, [persona.id]: true }));
                              const result = await callPersona(persona, brief.trim(), {
                                provider: apiConfig.provider,
                                model: apiConfig.model.trim() || DEFAULT_MODELS[apiConfig.provider],
                                apiKey: apiConfig.apiKey.trim(),
                              });
                              setResults((prev) => ({ ...prev, [persona.id]: result }));
                              setLoading((prev) => ({ ...prev, [persona.id]: false }));
                            }}
                            style={{
                              fontSize: 11,
                              color: persona.color,
                              background: "transparent",
                              border: `1px solid ${persona.color}66`,
                              borderRadius: 20,
                              padding: "3px 10px",
                              cursor: "pointer",
                              fontFamily: "'Noto Sans SC', sans-serif",
                              fontWeight: 300,
                            }}
                          >
                            重试 ↺
                          </button>
                        ) : (
                          <span />
                        )}
                        <div
                          style={{
                            fontSize: 11,
                            color: persona.color,
                            fontFamily: "'Noto Sans SC', sans-serif",
                            fontWeight: 300,
                          }}
                        >
                          {expandedCard === persona.id ? "收起 ↑" : "展开全文 ↓"}
                        </div>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          </Section>
        )}

        {phase === "synthesis" && allDone && (
          <Section title="幕三  人类收拢 → Synthesis" step="04">
            <div
              style={{
                background: "rgba(242,163,122,0.08)",
                borderRadius: 20,
                border: "1.5px dashed rgba(242,163,122,0.4)",
                padding: "28px 32px",
                animation: "fadeUp 0.6s ease-out both",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontFamily: "'ZCOOL XiaoWei', serif",
                  marginBottom: 16,
                  letterSpacing: 1,
                }}
              >
                现在，你手里有 {selectedPersonas.length} 个不同时代的疑问。
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  color: "#7a6050",
                  lineHeight: 2,
                  fontFamily: "'Noto Serif SC', serif",
                }}
              >
                把所有人格的问题铺开来看：
                <br />
                · 哪个问题让你最不舒服？（往往是盲点所在）
                <br />
                · 哪两个问题之间存在矛盾？（往往是真正的张力）
                <br />
                · 你原来的Brief，现在还成立吗？
              </div>
              <div
                style={{
                  marginTop: 24,
                  paddingTop: 20,
                  borderTop: "1px solid rgba(242,163,122,0.2)",
                  fontSize: 12,
                  color: "#9a7c6e",
                  fontFamily: "'Noto Sans SC', sans-serif",
                  fontWeight: 300,
                }}
              >
                历史风暴不给答案 · 它只帮你问对问题
              </div>
            </div>
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <button
                type="button"
                onClick={() => {
                  setPhase("brief");
                  setResults({});
                  setBrief("");
                  setSelectedPersonas([]);
                  setExpandedCard(null);
                }}
                style={{
                  background: "transparent",
                  border: "1.5px solid rgba(242,163,122,0.4)",
                  borderRadius: 50,
                  padding: "10px 28px",
                  fontSize: 13,
                  color: "#9a7c6e",
                  cursor: "pointer",
                  fontFamily: "'Noto Sans SC', sans-serif",
                  fontWeight: 300,
                  letterSpacing: 1,
                  transition: "all 0.3s",
                }}
              >
                重新来一场风暴
              </button>
            </div>
          </Section>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&family=Noto+Serif+SC:wght@400;500&family=Noto+Sans+SC:wght@300;400&display=swap');
        * { box-sizing: border-box; }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        textarea:focus,
        input:focus,
        select:focus { outline: none; }
        button:active { transform: scale(0.97) !important; }
      `}</style>
    </div>
  );
}

function Section({ title, step, children }) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.55)",
        backdropFilter: "blur(16px)",
        borderRadius: 28,
        border: "1px solid rgba(255,255,255,0.8)",
        boxShadow: "0 8px 32px rgba(242,163,122,0.08)",
        padding: "32px 36px",
        marginBottom: 28,
        animation: "fadeUp 0.5s ease-out both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #F2A37A, #E8896A)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "white",
            fontFamily: "'Noto Sans SC', sans-serif",
            fontWeight: 400,
            flexShrink: 0,
          }}
        >
          {step}
        </div>
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontFamily: "'ZCOOL XiaoWei', serif",
            letterSpacing: 2,
            fontWeight: 400,
          }}
        >
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

const fieldLabelStyle = {
  display: "grid",
  gap: 8,
  fontFamily: "'Noto Sans SC', sans-serif",
  fontSize: 12,
  color: "#9a7c6e",
  letterSpacing: 1,
};

const inputStyle = {
  width: "100%",
  borderRadius: 14,
  border: "1.5px solid rgba(242,163,122,0.25)",
  background: "rgba(255,255,255,0.75)",
  padding: "12px 14px",
  color: "#4a3728",
  fontSize: 14,
  fontFamily: "'Noto Sans SC', sans-serif",
};
