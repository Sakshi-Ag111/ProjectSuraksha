/**
 * app.js
 * ─────────────────────────────────────────────────────────────
 * PROJECT SURAKSHA — Signal Priority Override Backend
 * Main Express application entry point.
 *
 * Initialises:
 *   • Environment variables (dotenv)
 *   • JSON body parser
 *   • Global request logger
 *   • API routes
 *   • Health check endpoint
 *   • Global error handler
 *   • HTTP server
 * ─────────────────────────────────────────────────────────────
 */

require("dotenv").config();

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware: CORS — allow the local dashboard (file://) to call this API ──
// file:// pages send Origin: null — browsers only accept '*' for null origins,
// not the literal string 'null'. Using '*' is safe for this dev environment.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,SecurityToken');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Middleware: parse JSON request bodies ─────────────────────
app.use(express.json());

// ── Middleware: simple request logger ────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        const duration = Date.now() - start;
        console.log(
            `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ` +
            `→ ${res.statusCode} (${duration}ms)`
        );
    });
    next();
});

// ── Serve the dashboard UI (same-origin → no CORS issues) ────
// Access at: http://localhost:3000
const path = require('path');
app.use(express.static(path.join(__dirname, '../dashboard')));

// ── Health check (no auth required) ──────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'Project Suraksha — Signal Priority Backend',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

// ── API Routes ────────────────────────────────────────────────
const signalRoutes = require("./routes/signal");
app.use("/api/v1/signal", signalRoutes);

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "The requested endpoint does not exist.",
    });
});

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error("[UNHANDLED ERROR]", err);
    res.status(500).json({
        success: false,
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred. Please try again.",
    });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log("─────────────────────────────────────────────");
    console.log("    Project Suraksha Backend is running");
    console.log(`  ➜  http://localhost:${PORT}`);
    console.log(`  ➜  Health: http://localhost:${PORT}/health`);
    console.log(
        `  ➜  API:    http://localhost:${PORT}/api/v1/signal/priority-request`
    );
    console.log("─────────────────────────────────────────────");
});

module.exports = app; // exported for testing
