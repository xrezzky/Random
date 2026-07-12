// ============================================================
// POST /api/moderate  { text: string }
// Header (optional but needed for strike tracking): Authorization: Bearer <Firebase ID token>
// -> { ok, reason?, severity?, action, strikeCount?, held? }
//
// Only ever called by the client when the message contains a word from
// SENSITIVE_WORDS (see public/js/moderation.js) — normal conversation never
// reaches this endpoint, which is the whole cost-saving point.
//
// AI 1 (primary): Groq — tries GROQ_API_KEY_1..10, rotating past any key
//   that's rate-limited/invalid.
// AI 2 (backup): OpenRouter — only if EVERY Groq key fails. Tries
//   OPENROUTER_API_KEY_1..10 the same way.
// If both fail entirely: the message is HELD (action:"block", held:true) —
//   never allowed through silently.
//
// STRIKE SYSTEM (server-authoritative, via Firebase Admin SDK so a client
// can't fake its own strike count):
//   Every non-"allow" verdict adds 1 strike to /strikes/{uid}.
//   1st strike  -> action escalates to "warn"      (message still sent)
//   2nd strike  -> action escalates to "cooldown"   (blocks sending ~20s)
//   3rd strike  -> action escalates to "disconnect" (room is ended)
//   5th+ strike -> action escalates to "temporary_ban" (writes /bans/{uid})
// Strikes only apply when the caller's Firebase ID token verifies — if it's
// missing/invalid we still return the base AI verdict, just without strike
// tracking, so a token hiccup never breaks moderation entirely.
//
// Every check is logged to /moderationLogs, and every non-"allow" verdict
// is also logged to /violations — both readable from the admin dashboard.
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

const BAN_DURATION_MS = 10 * 60 * 1000; // 10 minutes
// 1st violation: counted only, no extra consequence ("aman").
// 2nd violation: show the user a warning.
// 3rd violation: temporary ban for BAN_DURATION_MS.
const STRIKE_ESCALATION = { 2: "warn" };
const BAN_THRESHOLD = 3;

const SYSTEM_PROMPT = `You are a content moderation classifier for an anonymous 1:1 text chat platform.
Classify the SINGLE user message below. Respond with ONLY a JSON object, no other text, no markdown fences:
{"ok": boolean, "reason": string, "severity": "low"|"medium"|"high", "action": "allow"|"warn"|"block"}

Set "ok": false and pick "reason" from this list if the message violates it:
- "harassment": insults, bullying, degrading someone
- "threat": threatening violence or harm
- "scam": phishing, money requests, fraudulent offers
- "illegal": promoting illegal acts (drugs, csam, weapons trafficking, etc.)
- "explicit": sexual content or solicitation
- "promo": spam self-promotion (channels, other platforms, "dm me on...")
Otherwise set "ok": true, "reason": "none", "action": "allow".

Choose "action" when ok is false:
- "warn": mild/borderline (e.g. crude language used as an exclamation, not aimed to hurt) — message can still go through, sender just gets warned.
- "block": clear violations — harassment aimed AT the other person, threats, scams, illegal content, explicit solicitation, spam/self-promo.

Be reasonable: casual swearing, jokes, or ordinary conversation is "ok": true, "action": "allow".`;

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
    err.retryable = true;
    throw err;
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();
  const parsed = JSON.parse(cleaned);
  const ok = parsed.ok !== false;
  return {
    ok,
    reason: parsed.reason && parsed.reason !== "none" ? parsed.reason : undefined,
    severity: parsed.severity || "low",
    action: parsed.action || (ok ? "allow" : "block"),
  };
}

async function tryProvider(keys, baseUrl, model, text, extraHeaders) {
  for (const key of keys) {
    try {
      return await callChatCompletion(baseUrl, key, model, text, extraHeaders);
    } catch (err) {
      if (err.retryable) continue;
      throw err;
    }
  }
  return null;
}

async function verifyUid(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const app = getAdminApp();
    const decoded = await app.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (err) {
    console.warn("moderate: ID token verification failed", err.message);
    return null;
  }
}

// Increments /strikes/{uid} atomically and returns the new count plus any
// escalation the strike thresholds trigger. Also writes /bans/{uid} when the
// ban threshold is crossed.
async function recordStrike(uid) {
  const app = getAdminApp();
  const db = app.database();
  const result = await db.ref(`strikes/${uid}`).transaction((current) => (current || 0) + 1);
  const count = result.snapshot.val() || 1;

  let escalation = null;
  if (count >= BAN_THRESHOLD) {
    escalation = "temporary_ban";
    await db.ref(`bans/${uid}`).set({
      reason: "strike_threshold",
      strikeCount: count,
      bannedUntil: Date.now() + BAN_DURATION_MS,
      createdAt: Date.now(),
    });
  } else if (STRIKE_ESCALATION[count]) {
    escalation = STRIKE_ESCALATION[count];
  }
  return { count, escalation };
}

async function logViolation(uid, text, verdict, action, strikeCount) {
  try {
    const app = getAdminApp();
    await app.database().ref("violations").push({
      sessionId: uid || "unverified",
      violationType: verdict.reason || "flagged",
      severity: verdict.severity || "low",
      evidence: text,
      action,
      strikeCount: strikeCount ?? null,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("violation log failed", err);
  }
}

async function logModeration(entry) {
  try {
    const app = getAdminApp();
    await app.database().ref("moderationLogs").push({ ...entry, createdAt: Date.now() });
  } catch (err) {
    console.error("moderation log write failed", err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: true, action: "allow", degraded: true });
    return;
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    res.status(200).json({ ok: false, action: "block", reason: "empty" });
    return;
  }

  const uid = await verifyUid(req); // null = no strike tracking for this call, verdict still applies

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
    await logModeration({ text, provider: "none", verdict: "held" });
    res.status(200).json({ ok: false, held: true, action: "block" });
    return;
  }

  // ANY violation now ends the room for both users — there's no more
  // "warn but stay in the room" state. The AI's own "warn"/"block" verdict
  // still matters for logging/severity, but the enforced action is always
  // at least "disconnect". Strike count only decides whether something
  // EXTRA gets layered on top (a warning notice, or a temporary ban).
  let action = "allow";
  let strikeCount = null;

  if (!verdict.ok) {
    action = "disconnect"; // base consequence for every violation
    if (uid) {
      const { count, escalation } = await recordStrike(uid);
      strikeCount = count;
      // 1st violation ("aman"): action stays "disconnect", nothing extra.
      // 2nd violation: escalation="warn" — client shows an extra warning toast.
      // 3rd+ violation: recordStrike already wrote /bans/{uid}; escalate action.
      if (count >= BAN_THRESHOLD) action = "temporary_ban";
      else if (escalation) action = escalation === "warn" ? "disconnect" : escalation;
      // strikeCount is passed through so the client can tailor its toast text.
    }
    await logViolation(uid, text, verdict, action, strikeCount);
  }

  await logModeration({
    text, provider, verdict: verdict.ok ? "ok" : verdict.reason, severity: verdict.severity, action, uid: uid || "unverified",
  });

  res.status(200).json({ ok: verdict.ok, reason: verdict.reason, severity: verdict.severity, action, strikeCount });
}
