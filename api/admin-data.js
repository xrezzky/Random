// ============================================================
// GET /api/admin-data
// Header: x-admin-password: <ADMIN_PASSWORD env var>
//
// Reads the tables the public database.rules.json locks down
// (reports, violations, bans) using the Firebase Admin SDK, which
// bypasses rules via a service account — never exposed to the browser.
//
// Env vars needed on Vercel:
//   FIREBASE_DATABASE_URL         (same as the client config)
//   FIREBASE_SERVICE_ACCOUNT      (paste the full service-account JSON, as one line)
//   ADMIN_PASSWORD                (any password you choose for the dashboard)
// ============================================================
import { getAdminApp } from "./_firebaseAdmin.js";

export default async function handler(req, res) {
  const password = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const app = getAdminApp();
    const db = app.database();

    const [sessionsSnap, queueSnap, roomsSnap, messagesSnap, reportsSnap, violationsSnap, bansSnap, aiLogsSnap] =
      await Promise.all([
        db.ref("sessions").once("value"),
        db.ref("queue").once("value"),
        db.ref("rooms").orderByChild("status").equalTo("active").once("value"),
        db.ref("messages").once("value"),
        db.ref("reports").limitToLast(30).once("value"),
        db.ref("violations").limitToLast(30).once("value"),
        db.ref("bans").limitToLast(30).once("value"),
        db.ref("moderationLogs").limitToLast(30).once("value"),
      ]);

    const sessions = sessionsSnap.val() || {};
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    let messagesToday = 0;
    const messagesRoot = messagesSnap.val() || {};
    Object.values(messagesRoot).forEach((room) => {
      Object.values(room).forEach((m) => {
        if ((m.createdAt || 0) >= todayStart.getTime()) messagesToday++;
      });
    });

    res.status(200).json({
      onlineUsers: Object.values(sessions).filter((s) => s.status !== "banned").length,
      waitingUsers: Object.keys(queueSnap.val() || {}).length,
      activeRooms: Object.keys(roomsSnap.val() || {}).length,
      messagesToday,
      reports: toList(reportsSnap.val()),
      violations: toList(violationsSnap.val()),
      bans: toList(bansSnap.val()),
      aiLogs: toList(aiLogsSnap.val()),
    });
  } catch (err) {
    console.error("admin-data error", err);
    res.status(500).json({ error: "Failed to load admin data. Check FIREBASE_SERVICE_ACCOUNT / FIREBASE_DATABASE_URL." });
  }
}

function toList(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
