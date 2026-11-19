// ============================================================
// SUPABASE CONFIG — CONNECTED (v2 shared team database)
// The app stores its whole state in one row of the public
// .app_state table in this Supabase project, so every team
// member sees and edits the SAME live data. localStorage on
// each device is kept only as an offline cache.
//
// The key below is the project's PUBLISHABLE (anon/public)
// key. It is public by design — safe to embed in browser
// code and share with the app link. Row Level Security
// policies on app_state are what control access.
//
// NEVER put the Supabase SECRET key (sb_secret_… /
// service_role key) or the database password in this file —
// those give full admin access and must never ship in
// browser code.
// ============================================================
window.RP_CONFIG = {
  SUPABASE_URL: "https://tcvcirrpomlrirkbgikw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_voPefd8q8EdfuSDUsNjdLQ_lHqWs4J-",
};
