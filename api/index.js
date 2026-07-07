// Vercel serverless entry point. Vercel treats files under `api/` as functions;
// this re-exports the Express app so every `/api/*` request (routed here by the
// rewrite in vercel.json) is handled by the existing server.
import app from "../server/index.js";

export default app;
