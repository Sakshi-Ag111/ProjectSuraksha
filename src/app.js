/**
 * app.js
 * PROJECT SURAKSHA — Signal Priority Override Backend
 */

require("dotenv").config();

const express  = require("express");
const http     = require("http");
const path     = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app    = express();
const PORT   = process.env.PORT || 3000;
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,SecurityToken');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── PROXY: Corridor Engine (port 3001) through port 3000 ──────
// This lets the ambulance app (and ngrok) use ONE URL for everything.
//
//   /corridor/route      → http://localhost:3001/route
//   /corridor/telemetry  → http://localhost:3001/telemetry
//   /socket.io/...       → ws://localhost:3001/socket.io/... (WebSocket)
//
const corridorProxy = createProxyMiddleware({
    target: 'http://localhost:3001',
    changeOrigin: true,
    ws: true,           // ← enables WebSocket (Socket.io) proxying
});

// HTTP proxy for REST calls  (/corridor/route, /corridor/telemetry, etc.)
app.use('/corridor', createProxyMiddleware({
    target: 'http://localhost:3001',
    changeOrigin: true,
    pathRewrite: { '^/corridor': '' },  // strip /corridor prefix
}));

// WebSocket proxy for Socket.io (/socket.io/ path)
app.use('/socket.io', corridorProxy);

// ── Body parser ───────────────────────────────────────────────
app.use(express.json());

// ── Request logger ────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now()-start}ms)`);
    });
    next();
});

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../dashboard')));
app.use('/ambulance-app', express.static(path.join(__dirname, '../ambulance-app')));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'Project Suraksha — Signal Priority Backend', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────
const signalRoutes = require("./routes/signal");
app.use("/api/v1/signal", signalRoutes);

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ success: false, error: "NOT_FOUND", message: "The requested endpoint does not exist." });
});

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error("[UNHANDLED ERROR]", err);
    res.status(500).json({ success: false, error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." });
});

// ── Start server (use http.Server so WS upgrade works) ───────
server.on('upgrade', corridorProxy.upgrade); // forward WS upgrades to port 3001
server.listen(PORT, async () => {
    console.log("─────────────────────────────────────────────");
    console.log("    Project Suraksha Backend is running");
    console.log(`  ➜  http://localhost:${PORT}`);
    console.log(`  ➜  Ambulance App: http://localhost:${PORT}/ambulance-app/`);
    console.log("─────────────────────────────────────────────");

    // ── Auto-start ngrok tunnel for phone access ──────────────
    if (process.env.NGROK_AUTHTOKEN) {
        try {
            const ngrok = require('@ngrok/ngrok');
            const listener = await ngrok.forward({
                addr: PORT,
                authtoken: process.env.NGROK_AUTHTOKEN,
            });
            const url = listener.url();
            console.log("");
            console.log("  ┌─────────────────────────────────────────┐");
            console.log("  │  📱 PHONE URL (open this on your phone): │");
            console.log(`  │  ${url}/ambulance-app/`);
            console.log("  │                                          │");
            console.log("  │  💻 Dashboard also works at:             │");
            console.log(`  │  ${url}/`);
            console.log("  └─────────────────────────────────────────┘");
            console.log("");
        } catch (e) {
            console.log("  [ngrok] Could not start tunnel:", e.message);
            console.log("  [ngrok] Use your laptop IP instead for phone access.");
        }
    }
});

module.exports = app;

