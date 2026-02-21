/**
 * server.js
 * Entry point – Express + Socket.io Real-Time Processing Engine.
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

const PORT = parseInt(process.env.PORT, 10) || 3001;
const PROXIMITY_THRESHOLD_M = parseInt(process.env.PROXIMITY_THRESHOLD_METERS, 10) || 500;
const TTI_THRESHOLD_SEC = parseInt(process.env.TTI_THRESHOLD_SECONDS, 10) || 20;
const SMOOTHING_WINDOW = parseInt(process.env.VELOCITY_SMOOTHING_WINDOW, 10) || 5;

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

let corridorEngine = null; // { processTelemetry, setRoute }

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
 */
app.post('/route', (req, res) => {
    if (!corridorEngine) return res.status(503).json({ error: 'Engine still loading' });

    let waypointsCoords = [];

    if (req.body.waypoints && Array.isArray(req.body.waypoints)) {
        waypointsCoords = req.body.waypoints;
    } else {
        const { srcLat, srcLon, dstLat, dstLon } = req.body;
        if ([srcLat, srcLon, dstLat, dstLon].some(v => v == null || isNaN(v))) {
            return res.status(400).json({ error: 'Body must include waypoints array OR srcLat, srcLon, dstLat, dstLon' });
        }
        waypointsCoords = [{ lat: srcLat, lon: srcLon }, { lat: dstLat, lon: dstLon }];
    }

    if (waypointsCoords.length < 2) {
        return res.status(400).json({ error: 'At least 2 waypoints are required' });
    }

    let totalDistanceM = 0;
    let allIntersections = [];
    let allWaypoints = [];
    let totalNodesCount = 0;

    for (let i = 0; i < waypointsCoords.length - 1; i++) {
        const p1 = waypointsCoords[i];
        const p2 = waypointsCoords[i + 1];

        const srcNode = findNearestNode(p1.lat, p1.lon);
        const dstNode = findNearestNode(p2.lat, p2.lon);

        if (!srcNode || !dstNode) {
            console.warn(`[route] No road nodes near ${p1.lat},${p1.lon} or ${p2.lat},${p2.lon}. Skipping graphml segment.`);
            continue;
        }

        console.log(`[route leg ${i + 1}] src node ${srcNode.id} → dst node ${dstNode.id}`);

        const route = findRoute(srcNode.id, dstNode.id);
        if (!route) {
            console.warn(`[route] No graphml path found between node ${srcNode.id} and ${dstNode.id}. Skipping segment.`);
            continue;
        }

        totalDistanceM += route.distanceM;
        allIntersections = allIntersections.concat(route.intersections);

        if (i > 0 && allWaypoints.length > 0 && route.waypoints.length > 0) {
            allWaypoints = allWaypoints.concat(route.waypoints.slice(1));
        } else {
            allWaypoints = allWaypoints.concat(route.waypoints);
        }
        totalNodesCount += route.path.length;
    }

    // ── Merge graphml intersections + managed signal intersections ─────────────
    const managedAsNodes = [
        { id: 'INT-MAIN', lat: 26.8860, lon: 75.7880, highway: 'traffic_signals' },   // C-Scheme Area
        { id: 'INT-NORTH', lat: 26.9350, lon: 75.7860, highway: 'traffic_signals' },   // Sindhi Camp
        { id: 'INT-EAST', lat: 26.9124, lon: 75.8050, highway: 'traffic_signals' },   // Jaipur Junction
    ];

    const graphmlIds = new Set(allIntersections.map(i => i.id));
    const mergedIntersections = [
        ...allIntersections,
        ...managedAsNodes.filter(mi => !graphmlIds.has(mi.id)),
    ];

    // Load merged intersections into the corridor engine
    corridorEngine.setRoute(mergedIntersections);

    // Broadcast to dashboard
    io.to('dashboard').emit('route_set', {
        distanceM: totalDistanceM,
        intersectionCount: mergedIntersections.length,
        intersections: mergedIntersections,
    });

    console.log(`[route total] Path: ${totalNodesCount} nodes | ${mergedIntersections.length} intersections (${allIntersections.length} graphml) | ${totalDistanceM.toFixed(0)} m`);

    res.json({
        distanceM: parseFloat(totalDistanceM.toFixed(2)),
        waypointCount: allWaypoints.length,
        intersectionCount: mergedIntersections.length,
        intersections: mergedIntersections,
        waypoints: allWaypoints,
    });
});

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

app.get('/map/nodes', (_req, res) => {
    const graph = getGraph();
    if (!graph) return res.status(503).json({ error: 'Map not loaded' });
    res.json({ count: graph.nodes.size, nodes: Array.from(graph.nodes.values()) });
});

app.get('/map/intersections', (_req, res) => {
    try { res.json({ nodes: getIntersectionNodes() }); }
    catch (e) { res.status(503).json({ error: e.message }); }
});

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

app.get('/map/nearest', (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon required' });
    res.json(findNearestNode(lat, lon) || { error: 'No node found' });
});

io.on('connection', (socket) => {
    console.log(`[WS] connected: ${socket.id}`);
    socket.on('join_dashboard', () => {
        socket.join('dashboard');
        socket.emit('joined', { message: 'Connected to Green Corridor Engine' });
        console.log(`[WS] ${socket.id} joined dashboard`);
    });
    socket.on('disconnect', () => console.log(`[WS] disconnected: ${socket.id}`));
});

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
