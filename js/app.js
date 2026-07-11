// ============================================================
// XRZ Anonymous Chat — app logic (Firebase Realtime Database)
// ============================================================
import { db, auth, authReady } from "./firebase-client.js";
import {
  ref, push, set, update, remove, get, onValue, onChildAdded, off,
  runTransaction, onDisconnect, serverTimestamp, query, orderByChild, equalTo,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const State = {
  uid: null,
  displayId: null,
  room: null,           // { id, token, partnerId }
  reportReason: null,
  listeners: [],         // [{ ref, cb, event }] for cleanup via off()
  typingSendAt: 0,
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

function toast(message, kind = "") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
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
async function ensureSession() {
  if (State.uid) return State.uid;
  await authReady;
  const uid = auth.currentUser.uid;
  State.uid = uid;
  State.displayId = randomId("Guest");

  await set(ref(db, `sessions/${uid}`), {
    displayId: State.displayId,
    status: "idle",
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  });

  // presence: mark online now, auto-remove on disconnect (tab close, network drop)
  const presenceRef = ref(db, `presence/${uid}`);
  await set(presenceRef, { displayId: State.displayId, at: serverTimestamp() });
  onDisconnect(presenceRef).remove();
  onDisconnect(ref(db, `sessions/${uid}/status`)).set("idle");

  setStatusOnline(true);
  return uid;
}

// ---------------- landing ----------------
$("#btnStartChat")?.addEventListener("click", () => showScreen("screen-consent"));
$("#btnConsentBack")?.addEventListener("click", () => showScreen("screen-landing"));

$("#btnPrivacy")?.addEventListener("click", () => toast("Privacy Policy — add your policy page/link here."));
$("#btnTerms")?.addEventListener("click", () => toast("Terms — add your terms page/link here."));
$("#linkTos1")?.addEventListener("click", (e) => { e.preventDefault(); toast("Terms — add your terms page/link here."); });
$("#linkPrivacy1")?.addEventListener("click", (e) => { e.preventDefault(); toast("Privacy Policy — add your policy page/link here."); });

$all(".consent-box").forEach((box) => {
  box.addEventListener("change", () => {
    const all = [...$all(".consent-box")].every((b) => b.checked);
    $("#btnConsentContinue").disabled = !all;
  });
});

$("#btnConsentContinue")?.addEventListener("click", async () => {
  showScreen("screen-queue");
  try {
    await ensureSession();
    await enterQueue();
  } catch (err) {
    console.error(err);
    toast(`Session error: ${err?.message || err}`, "danger");
    showScreen("screen-landing");
  }
});

// ---------------- queue / matching ----------------
// Model: rooms ARE the queue. Clicking Start either creates a fresh
// "waiting" room (if none exist) or claims someone else's waiting room
// directly. No separate /queue bookkeeping node — easy to eyeball in the
// Firebase console: every /rooms/{id} is either "waiting" (1 person) or
// "active" (2 people, chatting).
async function enterQueue() {
  const uid = await ensureSession();
  $("#queueSession").textContent = `session_${uid.slice(0, 7).toUpperCase()}`;
  $("#queueWait").textContent = "Estimated wait: a few seconds";
  await update(ref(db, `sessions/${uid}`), { status: "queued" });
  await findOrCreateRoom(uid);
}

async function findOrCreateRoom(uid) {
  // 1. Look for someone else's waiting room and try to claim it.
  const waitingQuery = query(ref(db, "rooms"), orderByChild("status"), equalTo("waiting"));
  const snap = await get(waitingQuery);
  const candidates = [];
  snap.forEach((child) => {
    const val = child.val();
    if (val.userA !== uid) candidates.push({ id: child.key, createdAt: val.createdAt || 0 });
  });
  candidates.sort((a, b) => a.createdAt - b.createdAt);

  for (const candidate of candidates) {
    const claimedRoom = await claimRoom(candidate.id, uid);
    if (claimedRoom) {
      await update(ref(db, `sessions/${uid}`), { status: "matched" });
      await update(ref(db, `sessions/${claimedRoom.userA}`), { status: "matched" });
      await enterRoom(candidate.id, claimedRoom);
      return;
    }
    // someone else claimed it first (or it's stale) — try the next candidate
  }

  // 2. Nothing available right now: create our own waiting room and listen
  // for someone to join it.
  const roomRef = push(ref(db, "rooms"));
  const roomId = roomRef.key;
  const roomData = {
    token: `room_${roomId.slice(0, 7).toUpperCase()}`,
    userA: uid,
    userB: null,
    status: "waiting",
    createdAt: Date.now(),
  };
  await set(roomRef, roomData);
  State.myWaitingRoomId = roomId;

  trackListener(ref(db, `rooms/${roomId}`), (roomSnap) => {
    const val = roomSnap.val();
    if (val && val.status === "active" && val.userB) {
      State.myWaitingRoomId = null;
      enterRoom(roomId, val);
    }
  });
}

// Atomic claim: a Firebase transaction scoped to this ONE room node means
// two people can't both claim the same waiting room, even if they search
// at the exact same instant.
async function claimRoom(roomId, uid) {
  const result = await runTransaction(ref(db, `rooms/${roomId}`), (current) => {
    if (!current || current.status !== "waiting" || current.userA === uid) {
      return; // undefined = abort transaction, no change made
    }
    current.userB = uid;
    current.status = "active";
    return current;
  });
  if (result.committed && result.snapshot.val()?.status === "active" && result.snapshot.val()?.userB === uid) {
    return result.snapshot.val();
  }
  return null;
}

$("#btnCancelQueue")?.addEventListener("click", async () => {
  await leaveQueue();
  showScreen("screen-landing");
});

async function leaveQueue() {
  clearListeners();
  if (State.myWaitingRoomId) {
    await remove(ref(db, `rooms/${State.myWaitingRoomId}`));
    State.myWaitingRoomId = null;
  }
  if (State.uid) {
    await update(ref(db, `sessions/${State.uid}`), { status: "idle" });
  }
}

// ---------------- room / chat ----------------
async function enterRoom(roomId, room) {
  clearListeners();
  const partnerId = room.userA === State.uid ? room.userB : room.userA;
  const partnerSnap = await get(ref(db, `sessions/${partnerId}/displayId`));

  State.room = { id: roomId, token: room.token, partnerId };
  $("#partnerId").textContent = partnerSnap.val() || "Anonymous";
  $("#chatStatusLine").textContent = "Partner connected";
  $("#chatBody").innerHTML = `<div class="system-msg">You're now chatting with a stranger. Say hi 👋</div>`;
  Moderation.resetFloodWindow();

  showScreen("screen-chat");

  // messages: only react to NEW children so we never re-render history
  trackListener(ref(db, `messages/${roomId}`), (snap) => renderIncomingMessage(snap.val()), "child_added");

  // room status (partner disconnects)
  trackListener(ref(db, `rooms/${roomId}/status`), (snap) => {
    if (snap.val() === "closed" && State.room?.id === roomId) handlePartnerLeft();
  });

  // typing indicator from partner
  trackListener(ref(db, `typing/${roomId}/${partnerId}`), (snap) => {
    const ts = snap.val();
    if (ts && Date.now() - ts < 2500) showTyping();
  });
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

function handlePartnerLeft() {
  $("#chatStatusLine").textContent = "Partner disconnected";
  const body = $("#chatBody");
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = "Stranger has disconnected.";
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}

$("#chatForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value;
  if (!text.trim() || !State.room) return;

  const local = Moderation.localCheck(text);
  if (!local.ok) {
    toast(moderationMessage(local.reason), "danger");
    return;
  }

  input.value = "";
  appendBubble(text, "me");

  const remote = await Moderation.remoteCheck(text);
  if (!remote.ok) {
    toast(moderationMessage(remote.reason || "flagged"), "danger");
    await push(ref(db, "violations"), {
      sessionId: State.uid,
      violationType: remote.reason || "flagged",
      severity: remote.severity || "low",
      evidence: text,
      createdAt: serverTimestamp(),
    });
    return; // blocked message is NOT persisted to the room
  }

  await push(ref(db, `messages/${State.room.id}`), {
    senderId: State.uid,
    content: text,
    createdAt: Date.now(),
  });
});

function moderationMessage(reason) {
  const map = {
    links: "Links aren't allowed in chat.",
    spam: "That looks like spam.",
    flood: "You're sending messages too fast — slow down.",
    repeated_messages: "Please don't repeat the same message.",
    empty: "Message can't be empty.",
    too_long: "Message is too long (max 500 characters).",
    harassment: "That message was blocked for violating our safety guidelines.",
    explicit: "Explicit content isn't allowed here.",
    threat: "Threatening content isn't allowed here.",
    scam: "That message looked like a scam attempt and was blocked.",
    illegal: "That content isn't allowed here.",
    promo: "Self-promotion / links to other platforms aren't allowed.",
  };
  return map[reason] || "Your message was blocked by moderation.";
}

$("#chatInput")?.addEventListener("input", () => {
  const now = Date.now();
  if (now - State.typingSendAt < 1200 || !State.room) return;
  State.typingSendAt = now;
  set(ref(db, `typing/${State.room.id}/${State.uid}`), Date.now());
});

// ---------------- next / disconnect ----------------
async function leaveRoom() {
  clearListeners();
  if (State.room) {
    await update(ref(db, `rooms/${State.room.id}`), { status: "closed", closedAt: serverTimestamp() });
    await remove(ref(db, `typing/${State.room.id}/${State.uid}`));
  }
  State.room = null;
}

$("#btnNext")?.addEventListener("click", async () => {
  await leaveRoom();
  showScreen("screen-queue");
  await enterQueue();
});

$("#btnDisconnect")?.addEventListener("click", async () => {
  await leaveRoom();
  await update(ref(db, `sessions/${State.uid}`), { status: "idle" });
  showScreen("screen-landing");
});

// ---------------- report modal ----------------
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
  await push(ref(db, "reports"), {
    roomId: State.room.id,
    reporterId: State.uid,
    reportedId: State.room.partnerId,
    reason: State.reportReason,
    details: $("#reportDetails").value.trim() || null,
    status: "open",
    createdAt: serverTimestamp(),
  });
  $("#reportModal").hidden = true;
  toast("Report submitted. Thank you for keeping XRZ safe.", "success");
});

// ---------------- online counter (Firebase presence) ----------------
async function initOnlineCounter() {
  await ensureSession().catch(() => {});
  onValue(ref(db, "presence"), (snap) => {
    const val = snap.val() || {};
    $("#onlineCount").textContent = Object.keys(val).length;
  });
}
initOnlineCounter();

// keep last_seen fresh
setInterval(() => {
  if (State.uid) update(ref(db, `sessions/${State.uid}`), { lastSeenAt: serverTimestamp() });
}, 20000);
