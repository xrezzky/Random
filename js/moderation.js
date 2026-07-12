// ============================================================
// Cost-efficient AI moderation gate.
//
//   1. localCheck()   — instant, local: empty/too-long/repeated-char spam
//                        and flood/rate-limit. No network call, runs on
//                        every message.
//   2. containsSensitiveWord(text) — simple case-insensitive word match
//                        against SENSITIVE_WORDS below. This is the ONLY
//                        thing that decides whether AI gets called at all.
//                        Normal conversation never touches the API.
//   3. remoteCheck(text) — only invoked by app.js when
//                        containsSensitiveWord() is true. Calls
//                        /api/moderate, which runs the real AI check
//                        (Groq → OpenRouter fallback) AND applies the
//                        server-side strike system, returning a single
//                        `action` field app.js just has to execute:
//                        "allow" | "warn" | "block" | "cooldown" |
//                        "disconnect" | "temporary_ban".
// ============================================================
import { auth } from "./firebase-client.js";

// Edit these freely — plain lowercase words/phrases, case-insensitive,
// matched as whole words. This is the ONLY gate deciding whether a message
// costs an API call, so keep it to genuinely sensitive terms (adding too
// much "normal" vocabulary here just makes every message call the AI).
const SENSITIVE_WORDS = {
  profanityID: [
    "anjing", "anjer", "anjrit", "anjir", "njir", "bangsat", "bajingan",
    "kontol", "memek", "ngentot", "ngewe", "asu", "babi", "goblok", "tolol",
    "bego", "kampret", "jancok", "kacung", "monyet", "pepek", "kimak",
    "sialan", "brengsek", "keparat", "taik", "tai lu", "kntl",
  ],
  profanityEN: [
    "fuck", "fucking", "shit", "bitch", "asshole", "bastard", "dumbass",
    "retard", "idiot", "stupid",
  ],
  threats: [
    "bunuh", "ancam", "bacok", "tusuk", "gorok", "kill you", "i will kill",
    "hurt you", "i'll find you",
  ],
  sexual: [
    "nude", "nudes", "onlyfans", "sex chat", "bokep", "colmek", "porn",
    "sange", "ngewe",
  ],
  scam: [
    "gift card", "western union", "transfer dulu", "investasi bodong",
    "crypto wallet", "send money", "kirim uang dulu", "hadiah gratis",
  ],
  illegal: [
    "narkoba", "drugs", "senjata api", "beli senjata", "jual akun ilegal",
  ],
};

const Moderation = (() => {
  const LINK_RE = /(https?:\/\/|www\.)\S+/i;
  const REPEAT_CHAR_RE = /(.)\1{7,}/; // aaaaaaaa
  let recentMessages = []; // for flood detection: [{text, ts}]

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function buildWordRegex() {
    const all = Object.values(SENSITIVE_WORDS).flat();
    if (!all.length) return null;
    const parts = all.map((w) => escapeRegex(w).replace(/ /g, "\\s+"));
    return new RegExp(`\\b(${parts.join("|")})\\b`, "i");
  }
  const WORD_REGEX = buildWordRegex();

  // The ONLY gate deciding whether a message is even worth an API call.
  function containsSensitiveWord(text) {
    if (LINK_RE.test(text)) return true;
    return WORD_REGEX ? WORD_REGEX.test(text) : false;
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

  // Only ever called by app.js when containsSensitiveWord(text) is true.
  async function remoteCheck(text) {
    let idToken = null;
    try { idToken = await auth.currentUser?.getIdToken(); } catch { /* proceed without it */ }

    try {
      const res = await fetch("/api/moderate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { ok: false, held: true, action: "block" };
      return await res.json();
    } catch {
      return { ok: false, held: true, action: "block" }; // network failure: hold, don't send
    }
  }

  return { localCheck, remoteCheck, resetFloodWindow, containsSensitiveWord };
})();
