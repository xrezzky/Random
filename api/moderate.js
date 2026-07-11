// ============================================================
// POST /api/moderate  { text: string }
// -> { ok: boolean, reason?: string, severity?: "low"|"medium"|"high", held?: boolean }
//
// Only called for messages the client already flagged as "suspicious"
// (see public/js/moderation.js looksSuspicious()) — plain conversation
// never reaches this endpoint at all.
//
// AI 1 (primary): Groq — tries GROQ_API_KEY_1..10 in order, rotating past
//   any key that's rate-limited or invalid.
// AI 2 (backup): OpenRouter — only used if EVERY Groq key fails (timeout,
//   error, rate limit). Tries OPENROUTER_API_KEY_1..10 the same way.
// If AI 1 and AI 2 both fail entirely: the message is HELD (ok:false,
//   held:true) rather than allowed through — the client shows a
//   "moderation temporarily unavailable" notice and does not send it.
//
// Every check that reaches this endpoint is logged to
// /moderationLogs in Firebase (message, verdict, which provider answered,
// timestamp) so it shows up in the admin dashboard.
//
// Note on naming: you asked for "Grok" as AI 1 — this uses Groq (the fast
// Llama-hosting API, api.groq.com), matching the GROQ_API_KEY env vars
// already set in Vercel. xAI's actual Grok API is a different product with
// different env vars; say the word if you specifically meant that one and
// this can be swapped.
// ============================================================
import { getAdminApp } from "./_firebaseAdmin.js";

function getKeys(prefix, count = 10) {
  const keys = [];
  for (let i = 1; i <= count; i++) {
    const k = process.env[`${prefix}${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const GROQ_KEYS = getKeys("GROQ_API_KEY_");             // GROQ_API_KEY_1 .. GROQ_API_KEY_10
const OPENROUTER_KEYS = getKeys("OPENROUTER_API_KEY_"); // OPENROUTER_API_KEY_1 .. OPENROUTER_API_KEY_10
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct";

const SYSTEM_PROMPT = `You are a content moderation classifier for an anonymous 1:1 text chat platform.
Classify the SINGLE user message below. Respond with ONLY a JSON object, no other text, no markdown fences:
{"ok": boolean, "reason": string, "severity": "low"|"medium"|"high"}

Set "ok": false and pick "reason" from this list if the message violates it:
- "harassment": insults, bullying, degrading someone
- "threat": threatening violence or harm
- "scam": phishing, money requests, fraudulent offers
- "illegal": promoting illegal acts (drugs, csam, weapons trafficking, etc.)
- "explicit": sexual content or solicitation
- "promo": spam self-promotion (channels, other platforms, "dm me on...")
Otherwise set "ok": true and "reason": "none". Default "severity" to "low" unless the
content is clearly severe (explicit/illegal/threat with intent), then use "high".
Be reasonable: casual swearing, jokes, or ordinary conversation is "ok": true.`;

async function callChatCompletion(baseUrl, key, model, text, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let res;
  try {
    res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 429) {
    const err = new Error(`provider_${res.status}`);
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`provider_error_${res.status}`);
    err.retryable = true; // treat any non-2xx as "try the next key/provider"
    throw err;
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    ok: parsed.ok !== false,
    reason: parsed.reason && parsed.reason !== "none" ? parsed.reason : undefined,
    severity: parsed.severity || "low",
  };
}

async function tryProvider(keys, baseUrl, model, text, extraHeaders) {
  for (const key of keys) {
    try {
      return await callChatCompletion(baseUrl, key, model, text, extraHeaders);
    } catch (err) {
      if (err.retryable) continue; // rotate to next key
      throw err;
    }
  }
  return null; // every key in this provider exhausted
}

async function logModeration(entry) {
  try {
    const app = getAdminApp();
    await app.database().ref("moderationLogs").push({ ...entry, createdAt: Date.now() });
  } catch (err) {
    console.error("moderation log write failed", err); // logging failure should never block the response
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: true, degraded: true });
    return;
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    res.status(200).json({ ok: false, reason: "empty" });
    return;
  }

  let verdict = null;
  let provider = null;

  try {
    if (GROQ_KEYS.length) {
      verdict = await tryProvider(GROQ_KEYS, "https://api.groq.com/openai/v1/chat/completions", GROQ_MODEL, text);
      if (verdict) provider = "groq";
    }

    if (!verdict && OPENROUTER_KEYS.length) {
      verdict = await tryProvider(
        OPENROUTER_KEYS,
        "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_MODEL,
        text,
        { "HTTP-Referer": "https://xrezzky-chat.vercel.app", "X-Title": "XRZ Anonymous Chat" }
      );
      if (verdict) provider = "openrouter";
    }
  } catch (err) {
    console.error("moderation provider error", err);
  }

  if (!verdict) {
    // Both AI 1 and AI 2 failed entirely — hold the message, don't allow it.
    await logModeration({ text, provider: "none", verdict: "held" });
    res.status(200).json({ ok: false, held: true });
    return;
  }

  await logModeration({ text, provider, verdict: verdict.ok ? "ok" : verdict.reason, severity: verdict.severity });
  res.status(200).json(verdict);
}
