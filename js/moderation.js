// ============================================================
// Lightweight client-side pre-filter.
// This is a FIRST line of defense only (fast, no network round-trip),
// so obviously-bad messages never even hit the wire. The real,
// authoritative check happens server-side in /api/moderate (see api/moderate.js),
// which every message is also sent to before being persisted.
//
// NOTE: keyword lists here are intentionally generic categories, not an
// exhaustive blocklist — true detection (harassment, threats, scams,
// explicit content, self-promo, flood) should run server-side using either
// a maintained rules engine or an LLM moderation call (Anthropic/OpenAI),
// since keyword lists alone are trivial to evade and easy to make brittle.
// ============================================================

const Moderation = (() => {
  const LINK_RE = /(https?:\/\/|www\.)\S+/i;
  const REPEAT_CHAR_RE = /(.)\1{7,}/; // aaaaaaaa
  let recentMessages = []; // for flood detection: [{text, ts}]

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
    if (LINK_RE.test(trimmed)) return { ok: false, reason: "links" };
    if (REPEAT_CHAR_RE.test(trimmed)) return { ok: false, reason: "spam" };

    recentMessages.push({ text: trimmed, ts: Date.now() });
    if (checkFlood()) return { ok: false, reason: "flood" };

    // duplicate spam: same message sent 3x in a row
    const last3 = recentMessages.slice(-3);
    if (last3.length === 3 && last3.every((m) => m.text === trimmed)) {
      return { ok: false, reason: "repeated_messages" };
    }

    return { ok: true };
  }

  // Calls the server-side moderation endpoint. Server is the source of truth;
  // client only uses this to show a fast "message blocked" state.
  async function remoteCheck(text) {
    try {
      const res = await fetch("/api/moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { ok: true, degraded: true }; // fail-open on infra errors, log for review
      return await res.json();
    } catch {
      return { ok: true, degraded: true };
    }
  }

  return { localCheck, remoteCheck, resetFloodWindow };
})();
