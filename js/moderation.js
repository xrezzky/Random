// ============================================================
// Two-stage moderation, client side:
//
//   1. localCheck()   — instant, local: empty/too-long/repeated-char spam
//                        and flood/rate-limit. No network call.
//   2. remoteCheck()  — only actually calls /api/moderate if the message
//                        LOOKS suspicious (looksSuspicious() below). Plain
//                        conversation skips the AI call entirely and goes
//                        straight through — cheaper and faster.
//
// /api/moderate itself tries Grok/Groq first, falls back to OpenRouter if
// that fails, and if BOTH fail it returns { held: true } — meaning the
// message must NOT be sent, and the user should be told moderation is
// temporarily down (see app.js chatForm handler).
// ============================================================

const Moderation = (() => {
  const LINK_RE = /(https?:\/\/|www\.)\S+/i;
  const REPEAT_CHAR_RE = /(.)\1{7,}/; // aaaaaaaa
  let recentMessages = []; // for flood detection: [{text, ts}]

  // Lightweight pre-filter: does this message even warrant an AI call?
  // Deliberately broad/cheap — false positives just mean "send it to AI
  // anyway", which is safe; false negatives mean skipping AI on something
  // that needed it, so keep this list generous.
  const SUSPICION_PATTERNS = [
    /\b(kill|hurt|threat|bunuh|ancam)\b/i,
    /\b(gift ?card|western union|transfer dulu|investasi|crypto wallet|send money)\b/i,
    /\b(nude|onlyfans|sex ?chat|bokep|colmek)\b/i,
    /\b(subscribe|dm me|check out my|follow (my|akun)|promo|jual|beli akun)\b/i,
    /\b(drugs?|narkoba|senjata|weapon)\b/i,
    /\b(bodoh|anjing|goblok|tolol|idiot|stupid)\b/i, // mild harassment signal
    LINK_RE,
  ];

  function looksSuspicious(text) {
    return SUSPICION_PATTERNS.some((re) => re.test(text));
  }

  function resetFloodWindow() {
    recentMessages = [];
  }

  function checkFlood() {
    const now = Date.now();
    recentMessages = recentMessages.filter((m) => now - m.ts < 8000);
    return recentMessages.length >= 6; // 6 msgs in 8s = flood
  }

  function localCheck(text) {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    if (trimmed.length > 500) return { ok: false, reason: "too_long" };
    if (REPEAT_CHAR_RE.test(trimmed)) return { ok: false, reason: "spam" };

    recentMessages.push({ text: trimmed, ts: Date.now() });
    if (checkFlood()) return { ok: false, reason: "flood" };

    const last3 = recentMessages.slice(-3);
    if (last3.length === 3 && last3.every((m) => m.text === trimmed)) {
      return { ok: false, reason: "repeated_messages" };
    }

    return { ok: true };
  }

  // Calls /api/moderate ONLY if the message looks suspicious. Server is the
  // source of truth for that call; this function just decides whether to
  // bother making it.
  async function remoteCheck(text) {
    if (!looksSuspicious(text)) return { ok: true };

    try {
      const res = await fetch("/api/moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { ok: false, held: true };
      return await res.json();
    } catch {
      return { ok: false, held: true }; // network failure on a suspicious message: hold it
    }
  }

  return { localCheck, remoteCheck, resetFloodWindow, looksSuspicious };
})();
