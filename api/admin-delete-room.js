// ============================================================
// POST /api/admin-delete-room  { roomId: string }
// Header: x-admin-password: <ADMIN_PASSWORD>
//
// Removes a room and its messages/typing state entirely. The connected
// client's `rooms/{roomId}` listener will see the node vanish and show
// "Room telah berakhir." automatically — no separate notification needed.
// ============================================================
import { getAdminApp } from "./_firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const password = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { roomId } = req.body || {};
  if (!roomId || !/^[A-Za-z0-9]{16,24}$/.test(roomId)) {
    res.status(400).json({ error: "Valid roomId required" });
    return;
  }

  try {
    const app = getAdminApp();
    const db = app.database();
    await Promise.all([
      db.ref(`rooms/${roomId}`).remove(),
      db.ref(`messages/${roomId}`).remove(),
      db.ref(`typing/${roomId}`).remove(),
    ]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-delete-room error", err);
    res.status(500).json({ error: "Failed to delete room" });
  }
}
