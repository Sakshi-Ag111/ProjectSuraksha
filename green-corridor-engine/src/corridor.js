/**
 * corridor.js
 * Green Corridor orchestrator.
 *
 * Handles a SEQUENCE of intersections along the route.
 * As the ambulance approaches each one (≤ proximityM AND TTI ≤ ttiSec),
 * a priority_signal_change event fires for that intersection.
 * Once passed, the engine moves to the next one.
 *
 * Exported factory: createCorridorEngine(io, config) → { processTelemetry, setRoute }
 */

const { getVelocity } = require('./haversine');
const JitterSmoother = require('./jitter');
const { evaluateTTI } = require('./tti');
const { triggerSignalOverride } = require('./signalBridge'); // ← integration bridge

/**
 * @param {import('socket.io').Server} io
 * @param {Object} config
 * @param {{ lat, lon }}  config.signalCoord           - Fallback single signal (used if no route set)
 * @param {number}        config.proximityThresholdM   - Default 500 m
 * @param {number}        config.ttiThresholdSec       - Default 20 s
 * @param {number}        config.smoothingWindow        - Default 5
 */
function createCorridorEngine(io, config = {}) {
    const {
        signalCoord = { lat: 26.9124, lon: 75.7873 },
        proximityThresholdM = 500,
        ttiThresholdSec = 20,
        smoothingWindow = 5,
    } = config;

    // Per-ambulance state
    const ambulanceState = new Map();

    // Active route intersections (set via setRoute)
    // Each entry: { id, lat, lon, highway, triggered: bool }
    let routeIntersections = [];

    /**
     * Set the ordered list of intersections for the active route.
     * Call this after computing a route via the router.
     * @param {Object[]} intersections - Array of { id, lat, lon, highway }
     */
    function setRoute(intersections) {
        routeIntersections = intersections.map(n => ({ ...n, triggered: false }));
        console.log(`[corridor] Route set with ${routeIntersections.length} intersection(s) to green`);
    }

    /**
     * Process a single telemetry payload.
     * @param {{ id, lat, lon, timestamp }} payload
     */
    function processTelemetry(payload) {
        const { id, lat, lon, timestamp } = payload;

        // ── Per-ambulance state ─────────────────────────────────────────────
        if (!ambulanceState.has(id)) {
            ambulanceState.set(id, { lastPoint: null, smoother: new JitterSmoother(smoothingWindow) });
        }
        const state = ambulanceState.get(id);
        const newPoint = { lat, lon, timestamp };

        // ── Velocity ────────────────────────────────────────────────────────
        let smoothVelocityMs = 0, velocityKmh = 0;
        if (state.lastPoint) {
            const vel = getVelocity(state.lastPoint, newPoint);
            smoothVelocityMs = state.smoother.push(vel.ms);
            velocityKmh = parseFloat((smoothVelocityMs * 3.6).toFixed(2));
        }
        state.lastPoint = newPoint;

        // ── Evaluate each un-triggered intersection on the route ────────────
        const signalEvents = [];

        const targets = routeIntersections.length > 0
            ? routeIntersections.filter(n => !n.triggered)
            : [{ ...signalCoord, id: 'default', highway: 'signal', triggered: false }];

        for (const intersection of targets) {
            const tti = evaluateTTI(
                { lat, lon },
                { lat: intersection.lat, lon: intersection.lon },
                smoothVelocityMs,
                proximityThresholdM,
                ttiThresholdSec
            );

            if (tti.shouldTrigger) {
                // Mark as triggered so we don't keep re-firing
                intersection.triggered = true;

                const event = {
                    ambulanceId: id,
                    intersectionId: intersection.id,
                    intersectionType: intersection.highway,
                    lat: intersection.lat,
                    lon: intersection.lon,
                    distanceToSignalM: tti.distanceToSignalM,
                    ttiSeconds: tti.ttiSeconds,
                    velocityKmh,
                    triggeredAt: new Date().toISOString(),
                };

                io.to('dashboard').emit('priority_signal_change', event);
                signalEvents.push(event);

                console.log(
                    `🚨 [GREEN] ${id} → node ${intersection.id} (${intersection.highway})` +
                    ` | dist: ${tti.distanceToSignalM}m | TTI: ${tti.ttiSeconds}s`
                );

                // ── INTEGRATION BRIDGE ───────────────────────────────────────
                // Call the Signal Priority API to physically flip the signals.
                // triggerSignalOverride figures out which direction (N/S/E/W)
                // the ambulance is heading and which managed intersection to
                // apply the override to, then POSTs to port 3000.
                triggerSignalOverride({
                    ambulanceId: id,
                    ambulancePos: { lat, lon },
                    intersectionPos: { lat: intersection.lat, lon: intersection.lon },
                    ttiSeconds: tti.ttiSeconds ?? 5,
                }).catch(err => console.error('[corridor] Bridge error:', err.message));
                // ─────────────────────────────────────────────────────────────
            }
        }

        // ── Build nearest-signal stats (first un-triggered intersection) ───
        const nextTarget = targets[0];
        const nextTTI = nextTarget
            ? evaluateTTI({ lat, lon }, nextTarget, smoothVelocityMs, proximityThresholdM, ttiThresholdSec)
            : { distanceToSignalM: null, ttiSeconds: null, shouldTrigger: false };

        const stats = {
            ambulanceId: id,
            timestamp,
            position: { lat, lon },
            smoothVelocityMs: parseFloat(smoothVelocityMs.toFixed(3)),
            velocityKmh,
            nextIntersection: nextTarget ? { id: nextTarget.id, lat: nextTarget.lat, lon: nextTarget.lon } : null,
            distanceToSignalM: nextTTI.distanceToSignalM,
            ttiSeconds: nextTTI.ttiSeconds,
            shouldTrigger: nextTTI.shouldTrigger,
            remainingIntersections: targets.length,
            triggeredIntersections: routeIntersections.filter(n => n.triggered).length,
            signalEvents,
        };

        io.to('dashboard').emit('current_stats', stats);
        return stats;
    }

    return { processTelemetry, setRoute };
}

module.exports = { createCorridorEngine };
