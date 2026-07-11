// ============================================================
// GET /api/config
// Returns the Firebase *client* config (apiKey, databaseURL, etc).
//
// Note: Firebase's client config is not a secret the way an API key is —
// it's designed to be shipped to browsers, and real protection comes from
// your Realtime Database security rules (see firebase/database.rules.json),
// not from hiding this object. We still serve it from env vars instead of
// hardcoding it in the repo, per your request, so it's one place to change
// per environment (dev/staging/prod) without touching code.
// ============================================================
export default function handler(req, res) {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };

  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    res.status(500).json({ error: `Missing Firebase env vars on Vercel: ${missing.join(", ")}` });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(config);
}
