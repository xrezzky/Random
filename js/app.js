// ============================================================
// XRZ Anonymous Chat — app logic
// ============================================================

const State = {
  session: null,        // { id, display_id }
  room: null,            // { id, room_token, partnerId }
  queueRow: null,
  matchChannel: null,
  roomChannel: null,
  typingTimeout: null,
  reportReason: null,
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

// ---------------- session bootstrap ----------------
async function ensureSession() {
  if (State.session) return State.session;
  const display_id = randomId("Guest");
  const { data, error } = await sb
    .from("sessions")
    .insert({ display_id, status: "idle" })
    .select()
    .single();
  if (error) {
    console.error(error);
    toast("Could not start a session. Check your Supabase config.", "danger");
    throw error;
  }
  State.session = data;
  setStatusOnline(true);
  return data;
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
  } catch {
    showScreen("screen-landing");
  }
});

// ---------------- queue / matching ----------------
async function enterQueue() {
  const session = await ensureSession();
  $("#queueSession").textContent = `session_${session.id.slice(0, 7).toUpperCase()}`;
  $("#queueWait").textContent = "Estimated wait: a few seconds";

  await sb.from("sessions").update({ status: "queued" }).eq("id", session.id);

  const { data: qRow, error } = await sb
    .from("waiting_queue")
    .insert({ session_id: session.id })
    .select()
    .single();
  if (error) { toast("Could not join the queue.", "danger"); showScreen("screen-landing"); return; }
  State.queueRow = qRow;

  // Try to find an existing waiting partner right away.
  const matched = await tryMatch();
  if (matched) return;

  // Otherwise, listen for someone creating a room with us as user_a/user_b.
  State.matchChannel = sb
    .channel(`match-${session.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "rooms", filter: `user_b=eq.${session.id}` },
      (payload) => enterRoom(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "rooms", filter: `user_a=eq.${session.id}` },
      (payload) => enterRoom(payload.new)
    )
    .subscribe();

  // Fallback poll every 2.5s in case realtime insert events are delayed/missed,
  // and to keep trying to match us against other waiters.
  State._queuePoll = setInterval(tryMatch, 2500);
}

async function tryMatch() {
  if (!State.session || !State.queueRow) return false;

  const { data: others } = await sb
    .from("waiting_queue")
    .select("session_id, joined_at")
    .neq("session_id", State.session.id)
    .order("joined_at", { ascending: true })
    .limit(1);

  if (!others || others.length === 0) return false;

  const partnerSessionId = others[0].session_id;
  const room_token = `room_${randomId("").slice(1)}`;

  // Best-effort room creation. NOTE: without a Postgres RPC/transaction this
  // has a small race window if two clients match the same partner at once —
  // acceptable for a first version, but move this into a `match_users()`
  // Postgres function (SECURITY DEFINER) before a real public launch.
  const { data: room, error } = await sb
    .from("rooms")
    .insert({ user_a: State.session.id, user_b: partnerSessionId, room_token })
    .select()
    .single();

  if (error) return false; // partner likely already matched by someone else

  await sb.from("waiting_queue").delete().eq("session_id", State.session.id);
  await sb.from("waiting_queue").delete().eq("session_id", partnerSessionId);
  await sb.from("sessions").update({ status: "matched" }).in("id", [State.session.id, partnerSessionId]);

  await enterRoom(room);
  return true;
}

$("#btnCancelQueue")?.addEventListener("click", async () => {
  await leaveQueue();
  showScreen("screen-landing");
});

async function leaveQueue() {
  clearInterval(State._queuePoll);
  if (State.matchChannel) sb.removeChannel(State.matchChannel);
  State.matchChannel = null;
  if (State.session) {
    await sb.from("waiting_queue").delete().eq("session_id", State.session.id);
    await sb.from("sessions").update({ status: "idle" }).eq("id", State.session.id);
  }
  State.queueRow = null;
}

// ---------------- room / chat ----------------
async function enterRoom(room) {
  clearInterval(State._queuePoll);
  if (State.matchChannel) { sb.removeChannel(State.matchChannel); State.matchChannel = null; }

  const partnerSessionId = room.user_a === State.session.id ? room.user_b : room.user_a;
  const { data: partner } = await sb.from("sessions").select("display_id").eq("id", partnerSessionId).single();

  State.room = { id: room.id, room_token: room.room_token, partnerId: partnerSessionId };
  $("#partnerId").textContent = partner?.display_id || "Anonymous";
  $("#chatStatusLine").textContent = "Partner connected";
  $("#chatBody").innerHTML = `<div class="system-msg">You're now chatting with a stranger. Say hi 👋</div>`;
  Moderation.resetFloodWindow();

  showScreen("screen-chat");

  State.roomChannel = sb
    .channel(`room-${room.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${room.id}` },
      (payload) => renderIncomingMessage(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
      (payload) => { if (payload.new.status === "closed") handlePartnerLeft(); }
    )
    .on("broadcast", { event: "typing" }, (msg) => {
      if (msg.payload.sender !== State.session.id) showTyping();
    })
    .subscribe();
}

function renderIncomingMessage(row) {
  if (row.sender_id === State.session.id) return; // we render our own optimistically
  appendBubble(row.content, "them", row.created_at);
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
    await sb.from("violations").insert({
      session_id: State.session.id,
      violation_type: remote.reason || "flagged",
      severity: remote.severity || "low",
      evidence: text,
    });
    return; // blocked message is NOT persisted to the room
  }

  await sb.from("messages").insert({
    room_id: State.room.id,
    sender_id: State.session.id,
    content: text,
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
  };
  return map[reason] || "Your message was blocked by moderation.";
}

let lastTypingSent = 0;
$("#chatInput")?.addEventListener("input", () => {
  const now = Date.now();
  if (now - lastTypingSent < 1200 || !State.roomChannel) return;
  lastTypingSent = now;
  State.roomChannel.send({ type: "broadcast", event: "typing", payload: { sender: State.session.id } });
});

// ---------------- next / disconnect ----------------
async function leaveRoom(closeStatus = "closed") {
  if (State.roomChannel) { sb.removeChannel(State.roomChannel); State.roomChannel = null; }
  if (State.room) {
    await sb.from("rooms").update({ status: closeStatus, closed_at: new Date().toISOString() }).eq("id", State.room.id);
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
  await sb.from("sessions").update({ status: "idle" }).eq("id", State.session.id);
  showScreen("screen-landing");
});

// ---------------- report modal ----------------
$("#btnReport")?.addEventListener("click", () => {
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
  await sb.from("reports").insert({
    room_id: State.room.id,
    reporter_id: State.session.id,
    reported_id: State.room.partnerId,
    reason: State.reportReason,
    details: $("#reportDetails").value.trim() || null,
  });
  $("#reportModal").hidden = true;
  toast("Report submitted. Thank you for keeping XRZ safe.", "success");
});

// ---------------- online counter (best-effort presence) ----------------
async function refreshOnlineCount() {
  const { count } = await sb
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .in("status", ["idle", "queued", "matched"])
    .gt("last_seen_at", new Date(Date.now() - 60_000).toISOString());
  $("#onlineCount").textContent = count ?? "—";
}
setInterval(refreshOnlineCount, 15000);
refreshOnlineCount();

// keep last_seen_at fresh while tab is open
setInterval(() => {
  if (State.session) sb.from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", State.session.id);
}, 20000);
