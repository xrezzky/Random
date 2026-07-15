// ============================================================
// XRZ Anonymous Chat — app logic (Firebase Realtime Database)
//
// Matching model (per spec): rooms are NEVER created on Start. Clicking
// Start only puts the user in /queue. Whenever anyone's client checks the
// queue (on join, and on a light poll as a safety net) it looks at the
// FULL queue, and if there are >= 2 people waiting, pairs the two
// oldest (FIFO) and creates a room for THEM — who may or may not include
// the client doing the checking. That's why every queued client also
// listens on /matchAssignments/{uid}: it's how you find out someone
// else's check paired you up.
// ============================================================
import { db, auth, authReady } from "./firebase-client.js";
import { Moderation } from "./moderation.js";
import {
  ref, push, set, update, remove, get, onValue, onChildAdded, off,
  runTransaction, onDisconnect, serverTimestamp, query, limitToLast,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const State = {
  uid: null,
  displayId: null,
  room: null,            // { id, token, partnerId }
  reportReason: null,
  listeners: [],          // [{ ref, cb, event }] for cleanup via off()
  typingSendAt: 0,
  queuePoll: null,
  inQueue: false,
  roomDisconnectRef: null,
  partnerLeftHandled: false,
  consentGiven: false,
};

// ---------------- helpers ----------------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

function showScreen(id) {
  $all(".screen").forEach((s) => s.classList.remove("active"));
  $(`#${id}`).classList.add("active");
}

function randomId(prefix) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

// Cryptographically strong Room ID: 20 chars from [A-Za-z0-9], generated via
// crypto.getRandomValues() with rejection sampling (no modulo bias). This is
// the actual Firebase key for the room AND the public URL segment
// (/r/{ROOM_ID}) — no UUID, no timestamp, no incrementing counter.
function generateRoomId(length = 20) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const alphabetLen = alphabet.length; // 62
  const maxValid = Math.floor(256 / alphabetLen) * alphabetLen; // reject bytes >= this
  const buf = new Uint8Array(1);
  let id = "";
  while (id.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < maxValid) id += alphabet[buf[0] % alphabetLen];
  }
  return id;
}

// ---------------- theme (dark/light) ----------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#btnThemeToggle");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
}
(function initTheme() {
  const saved = localStorage.getItem("xrz-theme");
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (prefersLight ? "light" : "dark"));
})();
$("#btnThemeToggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  localStorage.setItem("xrz-theme", next);
});

// ---------------- back-button trap while in an active room ----------------
// If someone arrives via a shared /r/{roomId} link (or navigates there
// during the session), pressing Back shouldn't dump them out of an active
// chat — re-push the same URL so they stay put until they explicitly end
// the conversation.
window.addEventListener("popstate", () => {
  if (State.room) {
    history.pushState({ roomId: State.room.id }, "", `/r/${State.room.id}`);
  }
});

function toast(message, kind = "") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// Persistent on-screen log (toasts disappear too fast to screenshot
// reliably). Appears under the queue screen; survives until the tab closes.
function dlog(msg) {
  console.log("[XRZ]", msg);
  const el = $("#debugLog");
  if (!el) return;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  line.textContent = `${time}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 40) el.removeChild(el.firstChild);
}

function setStatusOnline(on) {
  $("#statusDot").className = `dot ${on ? "dot-on" : "dot-off"}`;
  $("#statusText").textContent = on ? "Online" : "Offline";
}

function trackListener(r, cb, event = "value") {
  if (event === "value") onValue(r, cb);
  else onChildAdded(r, cb);
  State.listeners.push({ ref: r, cb, event });
}
function clearListeners() {
  State.listeners.forEach(({ ref: r, cb, event }) => off(r, event, cb));
  State.listeners = [];
}

// ---------------- session bootstrap ----------------
// Wraps an async step with a label so a failure says exactly which write
// broke, instead of a generic "set" from the SDK's internal error code.
async function step(label, fn) {
  try {
    return await fn();
  } catch (err) {
    err.stepLabel = label;
    throw err;
  }
}

async function ensureSession() {
  if (State.uid) return State.uid;
  await authReady;
  const uid = auth.currentUser.uid;
  State.uid = uid;
  State.displayId = randomId("Guest");
  dlog(`[SESSION] ensureSession: uid=${uid.slice(0, 8)} displayId=${State.displayId}`);

  await step("sessions-write", () => set(ref(db, `sessions/${uid}`), {
    displayId: State.displayId,
    status: "idle",
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  }));
  dlog("[SESSION] sessions-write OK");

  const presenceRef = ref(db, `presence/${uid}`);
  await step("presence-write", () => set(presenceRef, { displayId: State.displayId, at: serverTimestamp() }));
  dlog("[SESSION] presence-write OK");
  onDisconnect(presenceRef).remove().catch((e) => console.error("onDisconnect presence failed", e));
  onDisconnect(ref(db, `sessions/${uid}/status`)).set("idle").catch((e) => console.error("onDisconnect status failed", e));
  // if the tab dies while queued, don't leave a ghost entry blocking FIFO
  onDisconnect(ref(db, `queue/${uid}`)).remove().catch((e) => console.error("onDisconnect queue failed", e));

  setStatusOnline(true);
  return uid;
}

// ---------------- landing ----------------
$("#btnStartChat")?.addEventListener("click", () => showScreen("screen-consent"));
$("#btnConsentBack")?.addEventListener("click", () => showScreen("screen-landing"));

$("#btnPrivacy")?.addEventListener("click", () => toast("Kebijakan Privasi — halaman ini belum tersedia."));
$("#btnTerms")?.addEventListener("click", () => toast("Ketentuan — halaman ini belum tersedia."));
$("#linkTos1")?.addEventListener("click", (e) => { e.preventDefault(); toast("Ketentuan — halaman ini belum tersedia."); });
$("#linkPrivacy1")?.addEventListener("click", (e) => { e.preventDefault(); toast("Kebijakan Privasi — halaman ini belum tersedia."); });

$all(".consent-box").forEach((box) => {
  box.addEventListener("change", () => {
    const all = [...$all(".consent-box")].every((b) => b.checked);
    $("#btnConsentContinue").disabled = !all;
  });
});

$("#btnConsentContinue")?.addEventListener("click", async () => {
  dlog("[UI] btnConsentContinue clicked");
  State.consentGiven = true;
  await beginMatching();
});

$("#btnFindNewPartner")?.addEventListener("click", async () => {
  dlog("[UI] btnFindNewPartner clicked");
  if (!State.consentGiven) { showScreen("screen-consent"); return; }
  await beginMatching();
});

async function beginMatching() {
  showScreen("screen-queue");
  try {
    const uid = await ensureSession();

    const banSnap = await get(ref(db, `bans/${uid}`));
    const ban = banSnap.val();
    if (ban && ban.bannedUntil && ban.bannedUntil > Date.now()) {
      const until = new Date(ban.bannedUntil).toLocaleTimeString();
      toast(`Kamu dibatasi sementara sampai ${until}.`, "danger");
      showScreen("screen-landing");
      return;
    }

    const limited = await checkRateLimit(uid);
    if (limited) {
      dlog("[RATE LIMIT] blocked: too many attempts in the last minute");
      toast("Terlalu banyak percobaan berturut-turut. Coba lagi sebentar lagi.", "danger");
      showScreen("screen-landing");
      return;
    }

    await enterQueue();
  } catch (err) {
    console.error(err);
    const parts = [err?.name, err?.code, err?.message].filter(Boolean);
    const detail = parts.length ? parts.join(" | ") : String(err);
    const label = err?.stepLabel ? ` [${err.stepLabel}]` : "";
    dlog(`[SESSION] ERROR${label}: ${detail}`);
    toast(`Error sesi${label}: ${detail}`, "danger");
    showScreen("screen-landing");
  }
}

// Lightweight abuse deterrent: more than 8 "start matching" attempts within
// 60s from the same uid gets briefly blocked. This is enforced via a
// Firebase transaction (so it's shared/consistent across tabs/reloads for
// the same uid) rather than an in-memory counter, which would reset on
// every reload and be trivial to bypass.
async function checkRateLimit(uid) {
  const WINDOW_MS = 60000;
  const MAX_ATTEMPTS = 8;
  try {
    const result = await runTransaction(ref(db, `rateLimits/${uid}`), (current) => {
      const now = Date.now();
      if (!current || now - (current.windowStart || 0) > WINDOW_MS) {
        return { windowStart: now, count: 1 };
      }
      current.count = (current.count || 0) + 1;
      return current;
    });
    const val = result.snapshot.val();
    return !!(val && val.count > MAX_ATTEMPTS);
  } catch (err) {
    dlog(`[RATE LIMIT] check failed (allowing through): ${err?.message}`);
    return false; // never block someone because the rate limiter itself broke
  }
}

// ---------------- queue (FIFO) / matching ----------------
async function enterQueue() {
  const uid = await ensureSession();
  $("#queueSession").textContent = `session_${uid.slice(0, 7).toUpperCase()}`;
  $("#queueWait").textContent = "Perkiraan tunggu: beberapa detik lagi";

  State.inQueue = true;
  await step("session-status-queued", () => update(ref(db, `sessions/${uid}`), { status: "queued" }));
  await step("queue-write", () => set(ref(db, `queue/${uid}`), { joinedAt: Date.now(), displayId: State.displayId }));
  dlog(`[QUEUE] queue-write OK, joined as ${uid.slice(0, 8)}`);

  trackListener(ref(db, "queue"), (snap) => {
    const n = snap.exists() ? Object.keys(snap.val()).length : 0;
    $("#queueWait").textContent = `${n} ${n === 1 ? "person" : "people"} in queue right now`;
  });

  // Reconnect handling: mobile browsers frequently drop the Firebase
  // WebSocket briefly (screen lock, backgrounding, switching WiFi/cell),
  // which fires our own onDisconnect and removes us from /queue. When
  // .info/connected flips back to true, verify we're still queued and, if
  // not, rejoin. A plain set() on our OWN leaf is safe here (idempotent,
  // no risk of clobbering anyone else's entry) — no need for a
  // whole-node transaction.
  let wasConnected = true;
  trackListener(ref(db, ".info/connected"), async (snap) => {
    const connected = snap.val() === true;
    if (connected && !wasConnected && State.inQueue && !State.room) {
      dlog("[QUEUE] reconnected — verifying we're still in queue");
      const mySnap = await get(ref(db, `queue/${uid}`));
      if (!mySnap.exists()) {
        dlog("[QUEUE] entry was dropped by a disconnect — rejoining");
        await set(ref(db, `queue/${uid}`), { joinedAt: Date.now(), displayId: State.displayId })
          .catch((e) => dlog(`[QUEUE] rejoin failed: ${e?.message}`));
      }
    }
    wasConnected = connected;
  });

  // Fires the moment SOME client's matching check pairs us with someone
  // (could be triggered by our own check below, or anyone else's).
  const assignRef = ref(db, `matchAssignments/${uid}`);
  trackListener(assignRef, async (snap) => {
    const val = snap.val();
    if (val?.roomId) {
      dlog(`[MATCH] matchAssignment received, roomId=${val.roomId.slice(0, 8)}`);
      try {
        await remove(assignRef);
        dlog(`[MATCH] matchAssignments/${uid.slice(0,6)} cleared`);
        const roomSnap = await get(ref(db, `rooms/${val.roomId}`));
        if (roomSnap.exists()) {
          dlog(`[MATCH] room doc read OK, calling enterRoom`);
          await enterRoom(val.roomId, roomSnap.val());
        } else {
          dlog(`[MATCH] WARNING: roomId=${val.roomId.slice(0, 8)} does not exist or is unreadable`);
        }
      } catch (err) {
        dlog(`[MATCH] ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
        console.error("[MATCH] matchAssignment handling failed", err);
      }
    }
  });

  await checkQueueForMatch();
  // Safety-net poll: realtime should catch matches instantly, but in case a
  // listener is ever missed (flaky connection), keep nudging the queue.
  State.queuePoll = setInterval(checkQueueForMatch, 3000);
}

// The "server watches the queue" step. Any client calling this may end up
// pairing two OTHER users, not itself — that's expected and correct FIFO
// behavior.
//
// IMPORTANT: this used to run a single runTransaction() spanning the WHOLE
// /queue node (all waiting users at once). Debug logs proved that
// unreliable in practice — the transaction's callback would sometimes see
// current=null (empty) in the exact same instant a plain get() on the same
// path correctly returned real data. Root cause looks like a stale local
// synctree view interacting badly with the parallel onValue listener also
// registered on "/queue" for the UI counter.
//
// Fix: read the queue with a plain get() (always accurate, no transaction
// cache ambiguity), then atomically CLAIM each of the two chosen entries
// individually via a small transaction scoped to just that one leaf
// (queue/{uid}) — the standard, well-tested Firebase "claim/lock" pattern.
async function checkQueueForMatch() {
  const now = Date.now();
  const STALE_MS = 3 * 60 * 1000; // pure time-based ghost cleanup, no presence dependency

  let snap;
  try {
    snap = await get(ref(db, "queue"));
  } catch (err) {
    dlog(`[TRANSACTION] queue read ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
    return;
  }

  const current = snap.val();
  if (!current) {
    dlog("[TRANSACTION] saw 0 in queue, paired=no");
    return;
  }

  const prunedUids = [];
  const liveEntries = [];
  for (const [uid, entry] of Object.entries(current)) {
    const age = now - (entry?.joinedAt || 0);
    if (age > STALE_MS) prunedUids.push(uid);
    else liveEntries.push([uid, entry]);
  }
  if (prunedUids.length) {
    const updates = {};
    prunedUids.forEach((u) => { updates[`queue/${u}`] = null; });
    await update(ref(db), updates).catch((e) => dlog(`[QUEUE] prune write failed: ${e?.message}`));
    dlog(`[QUEUE] pruned ${prunedUids.length} stale entr${prunedUids.length === 1 ? "y" : "ies"} (>3min old): ${prunedUids.map((u) => u.slice(0, 6)).join(", ")}`);
  }

  liveEntries.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  dlog(`[TRANSACTION] saw ${liveEntries.length} in queue [${liveEntries.map(([u]) => u.slice(0, 8)).join(", ")}], paired=${liveEntries.length >= 2 ? "trying" : "no"}`);

  if (liveEntries.length < 2) return;

  const [idA, entryA] = liveEntries[0];
  const [idB] = liveEntries[1];

  const claimedA = await claimQueueEntry(idA);
  if (!claimedA) {
    dlog(`[PAIR] could not claim ${idA.slice(0, 6)} — someone else got there first`);
    return;
  }

  const claimedB = await claimQueueEntry(idB);
  if (!claimedB) {
    dlog(`[PAIR] could not claim ${idB.slice(0, 6)} — restoring ${idA.slice(0, 6)} to queue`);
    await set(ref(db, `queue/${idA}`), entryA).catch((e) => dlog(`[PAIR] restore failed: ${e?.message}`));
    return;
  }

  dlog(`[PAIR] claimed both ${idA.slice(0, 6)} + ${idB.slice(0, 6)}`);
  await createRoomForPair(idA, idB);
}

// Atomically claims (removes) a single queue entry. Scoped to ONE leaf path
// — much smaller and more reliable than a transaction spanning the entire
// /queue node. Returns true only if WE were the one who removed it.
async function claimQueueEntry(uid) {
  try {
    const result = await runTransaction(ref(db, `queue/${uid}`), (current) => {
      if (!current) return; // already gone (claimed by someone else) — abort
      return null; // claim = delete
    });
    return result.committed && result.snapshot.val() === null;
  } catch (err) {
    dlog(`[PAIR] claim transaction error for ${uid.slice(0, 6)}: ${err?.name} | ${err?.message}`);
    return false;
  }
}

async function createRoomForPair(idA, idB) {
  dlog(`[PAIR] createRoomForPair: pairing ${idA.slice(0, 6)} + ${idB.slice(0, 6)}`);
  try {
    // 62^20 keyspace (~7×10^35) — collision odds are astronomically
    // negligible, and checking for one would require reading a room we
    // don't belong to yet, which security rules correctly deny. Just use it.
    const roomId = generateRoomId();

    const roomData = {
      userA: idA,
      userB: idB,
      status: "active",
      createdAt: serverTimestamp(),
    };
    await set(ref(db, `rooms/${roomId}`), roomData);
    dlog(`[ROOM] room ${roomId} created OK`);
    // NOTE: we deliberately do NOT touch sessions/{idA} or sessions/{idB} here —
    // whichever client happens to run this pairing check might be neither A nor
    // B (it paired two OTHER waiting users), and the security rules only allow
    // a user to write their own sessions/$uid node. Each client marks its own
    // session "matched" itself, in enterRoom() below, once it receives the
    // assignment.
    await set(ref(db, `matchAssignments/${idA}`), { roomId });
    await set(ref(db, `matchAssignments/${idB}`), { roomId });
    dlog(`[ROOM] matchAssignments written for both ${idA.slice(0, 6)} and ${idB.slice(0, 6)}`);
  } catch (err) {
    dlog(`[ROOM] ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
    console.error("[ROOM] createRoomForPair failed", err, err?.stack);
  }
}

$("#btnCancelQueue")?.addEventListener("click", async () => {
  await leaveQueue();
  showScreen("screen-landing");
});

async function leaveQueue() {
  State.inQueue = false;
  clearInterval(State.queuePoll);
  State.queuePoll = null;
  clearListeners();
  if (State.uid) {
    await remove(ref(db, `queue/${State.uid}`));
    await remove(ref(db, `matchAssignments/${State.uid}`));
    await update(ref(db, `sessions/${State.uid}`), { status: "idle" });
  }
}

// ---------------- room / chat ----------------
async function enterRoom(roomId, room) {
  dlog(`[ENTER ROOM] start roomId=${roomId}`);
  try {
    State.inQueue = false;
    State.partnerLeftHandled = false;
    clearInterval(State.queuePoll);
    State.queuePoll = null;
    clearListeners();
    dlog("[ENTER ROOM] listeners cleared");

    const partnerId = room.userA === State.uid ? room.userB : room.userA;
    dlog(`[ENTER ROOM] partnerId=${partnerId.slice(0, 8)}, fetching partner displayId`);
    const partnerSnap = await get(ref(db, `sessions/${partnerId}/displayId`));
    dlog(`[ENTER ROOM] partner displayId fetched: ${partnerSnap.val()}`);

    State.room = { id: roomId, partnerId };
    $("#partnerId").textContent = partnerSnap.val() || "Anonim";
    $("#chatStatusLine").textContent = "Partner tersambung";
    $("#chatBody").innerHTML = `<div class="system-msg">Kamu sekarang terhubung dengan orang asing. Sapa dia 👋</div>`;
    Moderation.resetFloodWindow();

    await update(ref(db, `sessions/${State.uid}`), { status: "matched" });
    dlog("[ENTER ROOM] own session status set to matched");

    // Shareable/resumable URL — the room stays reachable at this URL for as
    // long as it's active, so a reload doesn't lose the chat.
    history.pushState({ roomId }, "", `/r/${roomId}`);

    showScreen("screen-chat");
    dlog("[ENTER ROOM] showScreen(screen-chat) called — UI should now show chat");

    // NOTE: room lifecycle is intentionally decoupled from connection blips.
    // A brief disconnect (screen lock, tab backgrounded, flaky network) only
    // toggles the "Partner keluar." / "Partner kembali online." indicator
    // below — it does NOT end the room. The room only ends via an explicit
    // "Akhiri Chat" click (leaveRoom) or a moderation violation.

    trackListener(ref(db, `messages/${roomId}`), (snap) => renderIncomingMessage(snap.val()), "child_added");

    // Room lifecycle listener: only reacts to an explicit end (status
    // "ended") or the room being deleted entirely (admin action / cleanup).
    trackListener(ref(db, `rooms/${roomId}`), (snap) => {
      const val = snap.val();
      if (!val && State.room?.id === roomId) {
        handlePartnerLeft("deleted");
        return;
      }
      if (val && val.status === "ended" && val.closedBy !== State.uid && State.room?.id === roomId) {
        handlePartnerLeft(val.closeReason);
      }
    });

    // Partner presence: shows "Partner keluar." / "Partner kembali online."
    // without ever touching the room itself. Debounced so a brief network
    // blip (a couple seconds of connectivity hiccup) never flashes a false
    // "keluar" — only a sustained absence counts as actually leaving.
    let firstPresenceSnapshot = true;
    let partnerWasOnline = true;
    let offlineDebounceTimer = null;
    trackListener(ref(db, `presence/${partnerId}`), (snap) => {
      const isOnline = snap.exists();
      if (firstPresenceSnapshot) { firstPresenceSnapshot = false; partnerWasOnline = isOnline; return; }

      if (isOnline) {
        clearTimeout(offlineDebounceTimer);
        if (partnerWasOnline) return; // was already considered online, nothing changed
        partnerWasOnline = true;
        $("#chatStatusLine").textContent = "Partner tersambung";
        const el = document.createElement("div");
        el.className = "system-msg";
        el.textContent = "Partner kembali online.";
        $("#chatBody").appendChild(el);
        $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
        return;
      }

      // Went offline — wait a few seconds before believing it, in case
      // they're just reconnecting (screen lock, app switch, flaky signal).
      clearTimeout(offlineDebounceTimer);
      offlineDebounceTimer = setTimeout(() => {
        if (!partnerWasOnline) return; // already marked offline
        partnerWasOnline = false;
        $("#chatStatusLine").textContent = "Partner keluar.";
        const el = document.createElement("div");
        el.className = "system-msg";
        el.textContent = "Partner keluar.";
        $("#chatBody").appendChild(el);
        $("#chatBody").scrollTop = $("#chatBody").scrollHeight;
      }, 5000);
    });

    trackListener(ref(db, `typing/${roomId}/${partnerId}`), (snap) => {
      const ts = snap.val();
      if (ts && Date.now() - ts < 2500) showTyping();
    });

    dlog("[ENTER ROOM] complete — chat listeners attached");
  } catch (err) {
    dlog(`[ENTER ROOM] FATAL ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
    console.error("[ENTER ROOM] failed", err, err?.stack);
    toast(`Gagal masuk ke room: ${err?.message || err}`, "danger");
    // Don't leave the user stranded on "Searching partner..." with a room
    // that's dead to them — send them back to try again.
    showScreen("screen-landing");
  }
}

function renderIncomingMessage(msg) {
  if (!msg || msg.senderId === State.uid) return; // we render our own optimistically
  appendBubble(msg.content, "them", msg.createdAt);
}

function appendBubble(text, who, ts) {
  const body = $("#chatBody");
  const el = document.createElement("div");
  el.className = `msg-bubble msg-${who}`;
  const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `${escapeHtml(text)}<span class="msg-time">${time}</span>`;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let typingHideTimer;
function showTyping() {
  $("#typingRow").hidden = false;
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => { $("#typingRow").hidden = true; }, 2000);
}

function handlePartnerLeft(reason) {
  if (State.partnerLeftHandled) {
    dlog(`[CHAT] handlePartnerLeft(${reason}) ignored — already handled`);
    return;
  }
  State.partnerLeftHandled = true;
  dlog(`[CHAT] handlePartnerLeft(${reason}) — will show Room Ended screen`);

  $("#chatStatusLine").textContent = "Partner terputus";
  const body = $("#chatBody");
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = reason === "next"
    ? "Orang asing klik Partner Baru dan keluar dari obrolan."
    : reason === "violation"
      ? "Obrolan diakhiri — pengguna lain melanggar aturan."
      : reason === "deleted"
        ? "Room ini telah dihapus."
        : "Orang asing telah terputus.";
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;

  // Show why for a moment, then present the explicit "Room telah berakhir"
  // screen rather than silently bouncing back to landing.
  setTimeout(async () => {
    try {
      clearInterval(State.queuePoll);
      State.queuePoll = null;
      State.inQueue = false;
      clearListeners();
      State.room = null;
      await update(ref(db, `sessions/${State.uid}`), { status: "idle" }).catch(() => {});
      history.pushState({}, "", "/");
      dlog("[CHAT] partner-left cleanup done, showing Room Ended screen");
      showScreen("screen-room-ended");
    } catch (err) {
      dlog(`[CHAT] partner-left cleanup ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
      showScreen("screen-room-ended");
    }
  }, 1400);
}

// ---------------- sending / moderation ----------------
$("#chatForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value;
  if (!text.trim() || !State.room) return;

  if (State.cooldownUntil && Date.now() < State.cooldownUntil) {
    const secs = Math.ceil((State.cooldownUntil - Date.now()) / 1000);
    toast(`Tunggu ${secs} detik lagi sebelum kirim pesan lagi.`, "danger");
    return;
  }

  // Quick local filter (spam/flood/rate-limit) — no network round-trip.
  const local = Moderation.localCheck(text);
  if (!local.ok) {
    toast(moderationMessage(local.reason), "danger");
    return;
  }

  // FAST LANE: no sensitive word/link found — send immediately, never call AI.
  if (!Moderation.containsSensitiveWord(text)) {
    input.value = "";
    appendBubble(text, "me");
    try {
      await push(ref(db, `messages/${State.room.id}`), {
        senderId: State.uid,
        content: text,
        createdAt: Date.now(),
      });
    } catch (err) {
      dlog(`[CHAT] send ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
      toast("Pesan gagal terkirim.", "danger");
    }
    return;
  }

  // SLOW LANE: sensitive word/link found — hold the message, wait for the
  // AI verdict (+ server-side strike escalation) before doing anything.
  const verdict = await Moderation.remoteCheck(text);

  if (verdict.held) {
    toast("Sistem moderasi sedang mengalami gangguan — pesan ditahan sementara.", "danger");
    return;
  }

  switch (verdict.action) {
    case "temporary_ban":
      toast("Pelanggaran ke-3 — kamu dibatasi sementara selama 10 menit.", "danger");
      await leaveRoom("violation");
      showScreen("screen-landing");
      return;

    case "warn": // 2nd strike: extra warning on top of ending the chat
      toast(`Peringatan ke-2: ${moderationMessage(verdict.reason || "flagged")} Chat diakhiri.`, "danger");
      await leaveRoom("violation");
      showScreen("screen-landing");
      return;

    case "disconnect": // any other violation (incl. 1st strike): chat ends
      toast(moderationMessage(verdict.reason || "flagged"), "danger");
      await leaveRoom("violation");
      showScreen("screen-landing");
      return;

    case "allow":
    default:
      break; // send normally
  }

  input.value = "";
  appendBubble(text, "me");
  await push(ref(db, `messages/${State.room.id}`), {
    senderId: State.uid,
    content: text,
    createdAt: Date.now(),
  });
});

function moderationMessage(reason) {
  const map = {
    links: "Link tidak diperbolehkan di chat.",
    spam: "Pesan itu kelihatan seperti spam.",
    flood: "Kamu mengirim pesan terlalu cepat — pelan-pelan aja.",
    repeated_messages: "Tolong jangan mengulang pesan yang sama.",
    empty: "Pesan tidak boleh kosong.",
    too_long: "Pesan terlalu panjang (maks 500 karakter).",
    harassment: "Pesan itu diblokir karena melanggar aturan keamanan.",
    explicit: "Konten eksplisit tidak diperbolehkan di sini.",
    threat: "Konten mengancam tidak diperbolehkan di sini.",
    scam: "Pesan itu terlihat seperti upaya penipuan dan diblokir.",
    illegal: "Konten itu tidak diperbolehkan di sini.",
    promo: "Promosi diri / link ke platform lain tidak diperbolehkan.",
  };
  return map[reason] || "Pesanmu diblokir oleh sistem moderasi.";
}

$("#chatInput")?.addEventListener("input", () => {
  const now = Date.now();
  if (now - State.typingSendAt < 1200 || !State.room) return;
  State.typingSendAt = now;
  set(ref(db, `typing/${State.room.id}/${State.uid}`), Date.now());
});

// ---------------- next / disconnect ----------------
async function leaveRoom(reason) {
  dlog(`[CHAT] leaveRoom(${reason}) called, roomId=${State.room?.id || "none"}`);
  clearListeners();
  if (State.room) {
    try {
      const roomRef = ref(db, `rooms/${State.room.id}`);
      const snap = await get(roomRef);
      const current = snap.val();
      if (current && current.status === "ended") {
        // partner already left first — safe to fully clean up now
        dlog("[CHAT] room already ended by partner — deleting room fully");
        await remove(roomRef);
        await remove(ref(db, `messages/${State.room.id}`));
        await remove(ref(db, `typing/${State.room.id}`));
      } else {
        dlog(`[CHAT] marking room ended (closedBy=${State.uid.slice(0,6)}, reason=${reason})`);
        await update(roomRef, {
          status: "ended", closedAt: serverTimestamp(), closedBy: State.uid, closeReason: reason,
        });
        await remove(ref(db, `typing/${State.room.id}/${State.uid}`));
      }
      dlog("[CHAT] leaveRoom cleanup OK");
    } catch (err) {
      // Cleanup failing (e.g. rules not yet deployed) must never trap the
      // user in the chat screen — log it and move on regardless.
      dlog(`[CHAT] leaveRoom cleanup ERROR: ${err?.name} | ${err?.code} | ${err?.message}`);
      console.error("leaveRoom cleanup error", err);
    }
  }
  State.room = null;
  history.pushState({}, "", "/");
}

// ---------------- confirm modal (used by Next / Disconnect) ----------------
function askConfirm(title, body) {
  return new Promise((resolve) => {
    $("#confirmTitle").textContent = title;
    $("#confirmBody").textContent = body;
    $("#confirmModal").hidden = false;

    const okBtn = $("#btnConfirmOk");
    const cancelBtn = $("#btnConfirmCancel");

    function cleanup(result) {
      $("#confirmModal").hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

$("#btnNext")?.addEventListener("click", async () => {
  const ok = await askConfirm("Cari partner baru?", "Kamu akan keluar dari obrolan ini dan dicarikan partner baru.");
  if (!ok) return;
  await leaveRoom("next");
  showScreen("screen-queue");
  await enterQueue();
});

$("#btnDisconnect")?.addEventListener("click", async () => {
  const ok = await askConfirm("Yakin akan mengakhiri obrolan?", "Kamu akan keluar dan kembali ke halaman utama.");
  if (!ok) return;
  await leaveRoom("disconnect");
  await update(ref(db, `sessions/${State.uid}`), { status: "idle" });
  showScreen("screen-landing");
});

// ---------------- report modal (stores last 20 messages as evidence) ----------------
$("#btnReport")?.addEventListener("click", () => {
  if (!State.room) return; // only reportable from an active chat
  State.reportReason = null;
  $all(".reason-chip").forEach((c) => c.classList.remove("selected"));
  $("#reportDetails").value = "";
  $("#btnSubmitReport").disabled = true;
  $("#reportModal").hidden = false;
});

$("#btnCancelReport")?.addEventListener("click", () => { $("#reportModal").hidden = true; });

$all(".reason-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $all(".reason-chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    State.reportReason = chip.dataset.reason;
    $("#btnSubmitReport").disabled = false;
  });
});

$("#btnSubmitReport")?.addEventListener("click", async () => {
  if (!State.reportReason || !State.room) return;

  const recentSnap = await get(query(ref(db, `messages/${State.room.id}`), limitToLast(20)));
  const evidenceMessages = [];
  recentSnap.forEach((child) => evidenceMessages.push({ id: child.key, ...child.val() }));

  await push(ref(db, "reports"), {
    roomId: State.room.id,
    reporterId: State.uid,
    reportedId: State.room.partnerId,
    reason: State.reportReason,
    details: $("#reportDetails").value.trim() || null,
    evidenceMessages,
    status: "open",
    createdAt: serverTimestamp(),
  });
  $("#reportModal").hidden = true;
  toast("Laporan terkirim. Makasih udah bantu jaga keamanan XRZ.", "success");
});

// ---------------- resume from shared URL (/r/{roomId}) ----------------
async function tryResumeFromUrl() {
  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{16,24})$/);
  if (!match) return;
  const roomId = match[1];
  dlog(`[URL] detected room link roomId=${roomId}`);
  try {
    const uid = await ensureSession();
    const roomSnap = await get(ref(db, `rooms/${roomId}`));
    const room = roomSnap.val();
    if (!room || (room.userA !== uid && room.userB !== uid) || room.status !== "active") {
      dlog("[URL] room not resumable (missing, not yours, or already ended)");
      history.replaceState({}, "", "/");
      showScreen("screen-room-ended");
      return;
    }
    dlog("[URL] resuming room");
    await enterRoom(roomId, room);
  } catch (err) {
    dlog(`[URL] resume ERROR: ${err?.name} | ${err?.message}`);
    history.replaceState({}, "", "/");
  }
}
tryResumeFromUrl();

// ---------------- online counter (Firebase presence) ----------------
async function initOnlineCounter() {
  await ensureSession().catch(() => {});
  onValue(ref(db, "presence"), (snap) => {
    const val = snap.val() || {};
    $("#onlineCount").textContent = Object.keys(val).length;
  });
}
initOnlineCounter();

setInterval(() => {
  if (State.uid) update(ref(db, `sessions/${State.uid}`), { lastSeenAt: serverTimestamp() });
}, 20000);

// Surfaces any promise rejection that wasn't explicitly caught anywhere else
// (e.g. a Firebase write failing on a fire-and-forget call) so nothing fails
// completely silently. This is a diagnostic net, not normal-path behavior.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const parts = [reason?.name, reason?.code, reason?.message].filter(Boolean);
  const detail = parts.length ? parts.join(" | ") : String(reason);
  // Always record it in the persistent log, even if we suppress the toast —
  // an earlier version of this filter silently dropped some real Firebase
  // errors whose stack didn't literally contain the word "firebase".
  dlog(`[UNHANDLED] ${detail}`);
  console.error("Unhandled rejection:", reason, reason?.stack);

  const looksLikeFirebase = reason?.name === "FirebaseError" || /firebase/i.test(reason?.stack || "") || /firebase/i.test(detail);
  if (looksLikeFirebase) {
    toast(`Error tak terduga: ${detail}`, "danger");
  }
});
