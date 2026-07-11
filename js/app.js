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
  roomDisconnectRef: null,
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

  const presenceRef = ref(db, `presence/${uid}`);
  await set(presenceRef, { displayId: State.displayId, at: serverTimestamp() });
  onDisconnect(presenceRef).remove();
  onDisconnect(ref(db, `sessions/${uid}/status`)).set("idle");
  // if the tab dies while queued, don't leave a ghost entry blocking FIFO
  onDisconnect(ref(db, `queue/${uid}`)).remove();

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
    const uid = await ensureSession();

    const banSnap = await get(ref(db, `bans/${uid}`));
    const ban = banSnap.val();
    if (ban && ban.bannedUntil && ban.bannedUntil > Date.now()) {
      const until = new Date(ban.bannedUntil).toLocaleTimeString();
      toast(`You're temporarily restricted until ${until}.`, "danger");
      showScreen("screen-landing");
      return;
    }

    await enterQueue();
  } catch (err) {
    console.error(err);
    toast(`Session error: ${err?.message || err}`, "danger");
    showScreen("screen-landing");
  }
});

// ---------------- queue (FIFO) / matching ----------------
async function enterQueue() {
  const uid = await ensureSession();
  $("#queueSession").textContent = `session_${uid.slice(0, 7).toUpperCase()}`;
  $("#queueWait").textContent = "Estimated wait: a few seconds";

  await update(ref(db, `sessions/${uid}`), { status: "queued" });
  await set(ref(db, `queue/${uid}`), { joinedAt: Date.now(), displayId: State.displayId });

  trackListener(ref(db, "queue"), (snap) => {
    const n = snap.exists() ? Object.keys(snap.val()).length : 0;
    $("#queueWait").textContent = `${n} ${n === 1 ? "person" : "people"} in queue right now`;
  });

  // Fires the moment SOME client's matching check pairs us with someone
  // (could be triggered by our own check below, or anyone else's).
  const assignRef = ref(db, `matchAssignments/${uid}`);
  trackListener(assignRef, async (snap) => {
    const val = snap.val();
    if (val?.roomId) {
      await remove(assignRef);
      const roomSnap = await get(ref(db, `rooms/${val.roomId}`));
      if (roomSnap.exists()) enterRoom(val.roomId, roomSnap.val());
    }
  });

  await checkQueueForMatch();
  // Safety-net poll: realtime should catch matches instantly, but in case a
  // listener is ever missed (flaky connection), keep nudging the queue.
  State.queuePoll = setInterval(checkQueueForMatch, 3000);
}

// The "server watches the queue" step. Any client calling this may end up
// pairing two OTHER users, not itself — that's expected and correct FIFO
// behavior. Atomic via a transaction scoped to /queue.
async function checkQueueForMatch() {
  await pruneStaleQueueEntries();

  let pair = null;

  await runTransaction(ref(db, "queue"), (current) => {
    if (!current) return; // nobody waiting — abort, no write
    const entries = Object.entries(current).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    if (entries.length < 2) return; // fewer than 2 waiting — abort, no write

    const [idA] = entries[0];
    const [idB] = entries[1];
    pair = [idA, idB];
    delete current[idA];
    delete current[idB];
    return current;
  });

  if (!pair) return;
  await createRoomForPair(pair[0], pair[1]);
}

// Ghost-entry cleanup: a queue entry whose owner is no longer in /presence
// (tab closed without onDisconnect finishing, old test session, etc.) would
// otherwise sit at the front of the FIFO line forever and block real users
// from ever being paired. Safe to run redundantly — removing an
// already-removed key is a no-op.
async function pruneStaleQueueEntries() {
  const [queueSnap, presenceSnap] = await Promise.all([
    get(ref(db, "queue")),
    get(ref(db, "presence")),
  ]);
  const queueVal = queueSnap.val();
  if (!queueVal) return;
  const presenceVal = presenceSnap.val() || {};
  const updates = {};
  for (const uid of Object.keys(queueVal)) {
    if (!presenceVal[uid]) updates[`queue/${uid}`] = null;
  }
  if (Object.keys(updates).length) await update(ref(db), updates);
}

async function createRoomForPair(idA, idB) {
  const roomRef = push(ref(db, "rooms"));
  const roomId = roomRef.key;
  const roomData = {
    token: `room_${roomId.slice(0, 7).toLowerCase()}`,
    userA: idA,
    userB: idB,
    status: "active",
    createdAt: serverTimestamp(),
  };
  await set(roomRef, roomData);
  // NOTE: we deliberately do NOT touch sessions/{idA} or sessions/{idB} here —
  // whichever client happens to run this pairing check might be neither A nor
  // B (it paired two OTHER waiting users), and the security rules only allow
  // a user to write their own sessions/$uid node. Each client marks its own
  // session "matched" itself, in enterRoom() below, once it receives the
  // assignment.
  await set(ref(db, `matchAssignments/${idA}`), { roomId });
  await set(ref(db, `matchAssignments/${idB}`), { roomId });
}

$("#btnCancelQueue")?.addEventListener("click", async () => {
  await leaveQueue();
  showScreen("screen-landing");
});

async function leaveQueue() {
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
  clearInterval(State.queuePoll);
  State.queuePoll = null;
  clearListeners();

  const partnerId = room.userA === State.uid ? room.userB : room.userA;
  const partnerSnap = await get(ref(db, `sessions/${partnerId}/displayId`));

  State.room = { id: roomId, token: room.token, partnerId };
  $("#partnerId").textContent = partnerSnap.val() || "Anonymous";
  $("#chatStatusLine").textContent = "Partner connected";
  $("#chatBody").innerHTML = `<div class="system-msg">You're now chatting with a stranger. Say hi 👋</div>`;
  Moderation.resetFloodWindow();
  await update(ref(db, `sessions/${State.uid}`), { status: "matched" });

  showScreen("screen-chat");

  // If the tab dies mid-chat, mark the room closed so the partner is told.
  State.roomDisconnectRef = ref(db, `rooms/${roomId}`);
  onDisconnect(State.roomDisconnectRef).update({
    status: "closed", closedAt: serverTimestamp(), closedBy: State.uid, closeReason: "disconnect",
  });

  trackListener(ref(db, `messages/${roomId}`), (snap) => renderIncomingMessage(snap.val()), "child_added");

  trackListener(ref(db, `rooms/${roomId}`), (snap) => {
    const val = snap.val();
    if (val && val.status === "closed" && val.closedBy !== State.uid && State.room?.id === roomId) {
      handlePartnerLeft(val.closeReason);
    }
  });

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

function handlePartnerLeft(reason) {
  $("#chatStatusLine").textContent = "Partner disconnected";
  const body = $("#chatBody");
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = reason === "next"
    ? "Stranger clicked Next and left the chat."
    : reason === "violation"
      ? "Stranger was disconnected by the moderation system."
      : "Stranger has disconnected.";
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}

// ---------------- sending / moderation ----------------
$("#chatForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value;
  if (!text.trim() || !State.room) return;

  if (State.cooldownUntil && Date.now() < State.cooldownUntil) {
    const secs = Math.ceil((State.cooldownUntil - Date.now()) / 1000);
    toast(`Please wait ${secs}s before sending another message.`, "danger");
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
    await push(ref(db, `messages/${State.room.id}`), {
      senderId: State.uid,
      content: text,
      createdAt: Date.now(),
    });
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
      toast("You've been temporarily restricted for repeated violations.", "danger");
      await leaveRoom("violation");
      showScreen("screen-landing");
      return;

    case "disconnect":
      toast("Chat ended due to repeated violations.", "danger");
      await leaveRoom("violation");
      showScreen("screen-landing");
      return;

    case "cooldown":
      State.cooldownUntil = Date.now() + 20000;
      toast("Warning threshold reached — 20s cooldown before you can send again.", "danger");
      return;

    case "block":
      toast(moderationMessage(verdict.reason || "flagged"), "danger");
      return; // not sent

    case "warn":
      toast(`${moderationMessage(verdict.reason || "flagged")} (warning — message still sent)`, "danger");
      break; // falls through to send below

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
async function leaveRoom(reason) {
  clearListeners();
  if (State.roomDisconnectRef) {
    await onDisconnect(State.roomDisconnectRef).cancel().catch(() => {});
    State.roomDisconnectRef = null;
  }
  if (State.room) {
    try {
      const roomRef = ref(db, `rooms/${State.room.id}`);
      const snap = await get(roomRef);
      const current = snap.val();
      if (current && current.status === "closed") {
        // partner already left first — safe to fully clean up now
        await remove(roomRef);
        await remove(ref(db, `messages/${State.room.id}`));
        await remove(ref(db, `typing/${State.room.id}`));
      } else {
        await update(roomRef, {
          status: "closed", closedAt: serverTimestamp(), closedBy: State.uid, closeReason: reason,
        });
        await remove(ref(db, `typing/${State.room.id}/${State.uid}`));
      }
    } catch (err) {
      // Cleanup failing (e.g. rules not yet deployed) must never trap the
      // user in the chat screen — log it and move on regardless.
      console.error("leaveRoom cleanup error", err);
    }
  }
  State.room = null;
}

$("#btnNext")?.addEventListener("click", async () => {
  await leaveRoom("next");
  showScreen("screen-queue");
  await enterQueue();
});

$("#btnDisconnect")?.addEventListener("click", async () => {
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

setInterval(() => {
  if (State.uid) update(ref(db, `sessions/${State.uid}`), { lastSeenAt: serverTimestamp() });
}, 20000);
