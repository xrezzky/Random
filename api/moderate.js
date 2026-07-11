// ============================================================
// POST /api/moderate  { text: string }
// -> { ok: boolean, reason?: string, severity?: "low"|"medium"|"high" }
//
// Flow:
//   1. Fast local regex rules (obvious links / repeated-char spam) — no
//      network call, catches the cheap stuff instantly.
//   2. LLM classification via Groq, trying GROQ_API_KEY1..10 in order.
//      On rate-limit/auth errors it rotates to the next key automatically.
//   3. If every Groq key fails, falls back to OpenRouter, trying
//      OPENROUTER_API_KEY_1..10 the same way.
//   4. If everything fails (no keys configured / all providers down),
//      fails OPEN (allows the message) but flags it `degraded: true` so
//      you can see in logs that AI moderation wasn't actually applied.
//      Only the regex layer stays fail-closed.
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   GROQ_API_KEY1 ... GROQ_API_KEY10          (as many as you have, order doesn't matter)
//   OPENROUTER_API_KEY_1 ... OPENROUTER_API_KEY_10
//   GROQ_MODEL        (optional, default: "llama-3.1-8b-instant")
//   OPENROUTER_MODEL  (optional, default: "meta-llama/llama-3.1-8b-instruct")
// ============================================================

const LOCAL_PATTERNS = [
  { type: "links", severity: "low", re: /(https?:\/\/|www\.)\S+/i },
  { type: "spam", severity: "low", re: /(.)\1{7,}/ }, // aaaaaaaa
];

function localCheck(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > 500) return { ok: false, reason: "too_long" };
  for (const p of LOCAL_PATTERNS) {
    if (p.re.test(trimmed)) return { ok: false, reason: p.type, severity: p.severity };
  }
  return { ok: true };
}

function getKeys(prefix, count = 10) {
  const keys = [];
  for (let i = 1; i <= count; i++) {
    const k = process.env[`${prefix}${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const GROQ_KEYS = getKeys("GROQ_API_KEY");             // GROQ_API_KEY1 .. GROQ_API_KEY10
const OPENROUTER_KEYS = getKeys("OPENROUTER_API_KEY_"); // OPENROUTER_API_KEY_1 .. _10
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
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 100,
    }),
  });

  if (res.status === 401 || res.status === 429) {
    const err = new Error(`provider_${res.status}`);
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`provider_error_${res.status}`);
    err.retryable = false;
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
      if (err.retryable) continue; // this key is rate-limited/invalid, try next
      throw err; // non-retryable (bad response shape etc.) — stop trying this provider
    }
  }
  return null; // every key in this provider exhausted
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: true, degraded: true });
    return;
  }

  const { text } = req.body || {};

  const local = localCheck(text);
  if (!local.ok) {
    res.status(200).json(local);
    return;
  }

  try {
    if (GROQ_KEYS.length) {
      const verdict = await tryProvider(
        GROQ_KEYS,
        "https://api.groq.com/openai/v1/chat/completions",
        GROQ_MODEL,
        text
      );
      if (verdict) { res.status(200).json(verdict); return; }
    }

    if (OPENROUTER_KEYS.length) {
      const verdict = await tryProvider(
        OPENROUTER_KEYS,
        "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_MODEL,
        text,
        { "HTTP-Referer": "https://xrezzky-chat.vercel.app", "X-Title": "XRZ Anonymous Chat" }
      );
      if (verdict) { res.status(200).json(verdict); return; }
    }

    // No provider configured, or every key on every provider failed.
    console.warn("moderation: all providers exhausted, failing open");
    res.status(200).json({ ok: true, degraded: true });
  } catch (err) {
    console.error("moderation error", err);
    res.status(200).json({ ok: true, degraded: true });
  }
}
