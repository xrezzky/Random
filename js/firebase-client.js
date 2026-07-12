// ============================================================
// Firebase client bootstrap (ES module).
// Config values (apiKey, databaseURL, etc.) are NOT hardcoded here —
// they're fetched at runtime from /api/config, which reads them out of
// Vercel Environment Variables. This keeps every secret in one place
// (Vercel dashboard) instead of committed to the repo.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  connectDatabaseEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

async function loadConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Could not load Firebase config from /api/config");
  return res.json();
}

const firebaseConfig = await loadConfig();
export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

// Anonymous auth gives every visitor a stable uid the database rules can
// check (see firebase/database.rules.json) without any login screen.
export const authReady = signInAnonymously(auth).catch((err) => {
  console.error("Anonymous auth failed", err);
  throw err;
});
