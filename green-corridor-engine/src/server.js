/**
 * server.js
 * Entry point – Express + Socket.io Real-Time Processing Engine.
 *
 * Startup:
 *   1. Parse Data/jaipur_small.graphml
 *   2. Build adjacency list for routing
 *   3. Start listening
 *
 * REST API:
 *   GET  /health
 *   POST /route                        – find road path + auto-extract intersections
 *   POST /telemetry                    – receive ambulance GPS tick
 *   GET  /map/nodes                    – all road nodes (for dashboard map render)
 *   GET  /map/intersections            – only highway-tagged nodes
 *   GET  /map/intersections/nearby     – filtered by proximity
 *   GET  /map/nearest?lat&lon          – snap any coordinate to road network
 *
 * Socket.io (server → client):
 *   current_stats          – every telemetry tick
 *   priority_signal_change – when an intersection is greened
 *   route_set              – when a new route is loaded
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const { createCorridorEngine } = require('./corridor');
const { loadGraph, getGraph, findNearestNode,
    getIntersectionNodes } = require('./mapLoader');
const { buildAdjacency, findRoute } = require('./router');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
const PROXIMITY_THRESHOLD_M = parseInt(process.env.PROXIMITY_THRESHOLD_METERS, 10) || 500;
const TTI_THRESHOLD_SEC = parseInt(process.env.TTI_THRESHOLD_SECONDS, 10) || 20;
const SMOOTHING_WINDOW = parseInt(process.env.VELOCITY_SMOOTHING_WINDOW, 10) || 5;

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Engine state ──────────────────────────────────────────────────────────────
let corridorEngine = null;   // { processTelemetry, setRoute }

// ─────────────────────────────────────────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    res.json({
        status: corridorEngine ? 'ready' : 'loading',
        service: 'green-corridor-engine',
        thresholds: { proximityM: PROXIMITY_THRESHOLD_M, ttiSec: TTI_THRESHOLD_SEC },
        timestamp: new Date().toISOString(),
    });
});

/**
 * POST /route
 * Find the road-network path and extract all intersections along it.
 *
 * Body: { "srcLat": 26.92, "srcLon": 75.787, "dstLat": 26.91, "dstLon": 75.787 }
 *
 * Response: {
 *   distanceM, waypointCount,
 *   intersections: [{ id, lat, lon, highway }, ...],
 *   waypoints:     [{ id, lat, lon }, ...]
 * }
 *
 * Also calls setRoute() on the corridor engine so telemetry immediately
 * starts triggering against the new intersections.
 */
app.post('/route', (req, res) => {
    if (!corridorEngine) return res.status(503).json({ error: 'Engine still loading' });

    const { srcLat, srcLon, dstLat, dstLon } = req.body;
    if ([srcLat, srcLon, dstLat, dstLon].some(v => v == null || isNaN(v))) {
        return res.status(400).json({ error: 'Body must include srcLat, srcLon, dstLat, dstLon (numbers)' });
    }

    // Snap src/dst to nearest road nodes
    const srcNode = findNearestNode(srcLat, srcLon);
    const dstNode = findNearestNode(dstLat, dstLon);

    if (!srcNode || !dstNode) {
        return res.status(404).json({ error: 'Could not find road nodes near src/dst' });
    }

    console.log(`[route] src node ${srcNode.id} → dst node ${dstNode.id}`);

    const route = findRoute(srcNode.id, dstNode.id);
    if (!route) {
        return res.status(404).json({ error: 'No path found between src and dst in the road network' });
    }

    // Load intersections into the corridor engine
    corridorEngine.setRoute(route.intersections);

    // Broadcast to dashboard
    io.to('dashboard').emit('route_set', {
        distanceM: route.distanceM,
        intersectionCount: route.intersections.length,
        intersections: route.intersections,
    });

    console.log(`[route] Path: ${route.path.length} nodes | ${route.intersections.length} intersections | ${route.distanceM.toFixed(0)} m`);

    res.json({
        distanceM: parseFloat(route.distanceM.toFixed(2)),
        waypointCount: route.waypoints.length,
        intersectionCount: route.intersections.length,
        intersections: route.intersections,
        waypoints: route.waypoints,
    });
});

/**
 * POST /telemetry
 * Body: { "id": "AMB_01", "lat": 26.91, "lon": 75.78, "timestamp": 1700000000 }
 */
app.post('/telemetry', (req, res) => {
    if (!corridorEngine) return res.status(503).json({ error: 'Engine still loading' });

    const { id, lat, lon, timestamp } = req.body;

    if (!id || lat == null || lon == null || timestamp == null) {
        return res.status(400).json({ error: 'id, lat, lon, timestamp required' });
    }
    if (typeof lat !== 'number' || typeof lon !== 'number') {
        return res.status(400).json({ error: 'lat and lon must be numbers' });
    }

    try {
        const stats = corridorEngine.processTelemetry({ id, lat, lon, timestamp });
        return res.json({ success: true, stats });
    } catch (err) {
        console.error('[/telemetry]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

/** GET /map/nodes */
app.get('/map/nodes', (_req, res) => {
    const graph = getGraph();
    if (!graph) return res.status(503).json({ error: 'Map not loaded' });
    res.json({ count: graph.nodes.size, nodes: Array.from(graph.nodes.values()) });
});

/** GET /map/intersections */
app.get('/map/intersections', (_req, res) => {
    try { res.json({ nodes: getIntersectionNodes() }); }
    catch (e) { res.status(503).json({ error: e.message }); }
});

/** GET /map/intersections/nearby?lat&lon&radius */
app.get('/map/intersections/nearby', (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 1000;
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon required' });
    try {
        const nearby = getIntersectionNodes().filter(n => {
            const dLat = (n.lat - lat) * Math.PI / 180;
            const dLon = (n.lon - lon) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * Math.PI / 180) * Math.cos(n.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
            return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radius;
        });
        res.json({ count: nearby.length, nodes: nearby });
    } catch (e) { res.status(503).json({ error: e.message }); }
});

/** GET /map/nearest?lat&lon */
app.get('/map/nearest', (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon required' });
    res.json(findNearestNode(lat, lon) || { error: 'No node found' });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.io
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] connected: ${socket.id}`);
    socket.on('join_dashboard', () => {
        socket.join('dashboard');
        socket.emit('joined', { message: 'Connected to Green Corridor Engine' });
        console.log(`[WS] ${socket.id} joined dashboard`);
    });
    socket.on('disconnect', () => console.log(`[WS] disconnected: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Startup
// ─────────────────────────────────────────────────────────────────────────────
loadGraph()
    .then((graph) => {
        buildAdjacency();

        corridorEngine = createCorridorEngine(io, {
            proximityThresholdM: PROXIMITY_THRESHOLD_M,
            ttiThresholdSec: TTI_THRESHOLD_SEC,
            smoothingWindow: SMOOTHING_WINDOW,
        });

        server.listen(PORT, () => {
            console.log(`[server] Green Corridor Engine → http://localhost:${PORT}`);
            console.log(`[server] Map: ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
            console.log(`[server] POST /route  to set the corridor`);
            console.log(`[server] POST /telemetry  to move the ambulance`);
        });
    })
    .catch(err => {
        console.error('[server] Startup failed:', err);
        process.exit(1);
    });

module.exports = { app, server, io };
