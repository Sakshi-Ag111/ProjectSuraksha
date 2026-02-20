/**
 * signalBridge.js
 * ─────────────────────────────────────────────────────────────
 * INTEGRATION BRIDGE — Green Corridor Engine → Signal Priority API
 *
 * HOW IT WORKS (plain English):
 * ──────────────────────────────
 *   1. Member1's corridor engine watches the ambulance move on a
 *      real Jaipur road map. When the ambulance is close enough
 *      (≤ 500 m) AND will arrive within 20 s (TTI), it fires a
 *      trigger for that intersection.
 *
 *   2. THIS module is called at that exact moment. It:
 *       a. Figures out which DIRECTION (N/S/E/W) the ambulance is
 *          approaching from (using GPS bearing math).
 *       b. Finds the closest of our 3 managed intersections
 *          (INT-MAIN / INT-NORTH / INT-EAST) to the triggered node.
 *       c. Calls YOUR backend's POST /api/v1/signal/priority-request
 *          with those details.
 *
 *   3. YOUR backend then:
 *       a. Validates the security token + ambulance ID.
 *       b. Sets the approach signal to GREEN.
 *       c. Hard-locks all perpendicular signals to HARD_RED.
 *       d. Returns the full intersection state (for the frontend).
 *
 * BEARING → DIRECTION MAPPING:
 * ──────────────────────────────
 *   The "bearing" is the compass angle from the ambulance to the
 *   intersection. That tells us which way the ambulance is heading:
 *
 *       NW   N   NE
 *        \   ↑   /
 *    W ← ambulance → E
 *        /   ↓   \
 *       SW   S   SE
 *
 *   Bearing 0°/360°  = heading North  → signal_id = "N"
 *   Bearing 90°      = heading East   → signal_id = "E"
 *   Bearing 180°     = heading South  → signal_id = "S"
 *   Bearing 270°     = heading West   → signal_id = "W"
 * ─────────────────────────────────────────────────────────────
 */

// Node 18+ has built-in fetch — no extra package needed
const SIGNAL_API_URL = process.env.SIGNAL_API_URL || 'http://localhost:3000';
const SECURITY_TOKEN = process.env.SECURITY_TOKEN || 'SURAKSHA_SECURE_TOKEN_2024';
// The vehicle ID sent to the Signal Priority API.
// Must be in the authorized fleet. Override via BRIDGE_VEHICLE_ID in .env.
const BRIDGE_VEHICLE_ID = process.env.BRIDGE_VEHICLE_ID || 'AMB-001';

// ── Our 3 managed intersections (Jaipur coordinates) ────────────
// These must match the coordinates in config/intersections.js
const MANAGED_INTERSECTIONS = [
    { id: 'INT-MAIN', lat: 26.9124, lon: 75.7873 },   // Civil Lines
    { id: 'INT-NORTH', lat: 26.9300, lon: 75.7873 },   // Sindhi Camp area
    { id: 'INT-EAST', lat: 26.9124, lon: 75.8050 },   // Jaipur Junction area
];

// ── Utility: Haversine distance (metres) ────────────────────────
function distanceM(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const sin2 = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(sin2), Math.sqrt(1 - sin2));
}

// ── Utility: Compass bearing (degrees 0-360) from A → B ─────────
function bearingDeg(from, to) {
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const dLon = (to.lon - from.lon) * Math.PI / 180;
    const x = Math.sin(dLon) * Math.cos(lat2);
    const y = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

// ── Utility: Convert bearing angle → signal direction ────────────
function bearingToSignalId(degrees) {
    // 45° slices centred on each cardinal direction
    if (degrees >= 315 || degrees < 45) return 'N';
    if (degrees >= 45 && degrees < 135) return 'E';
    if (degrees >= 135 && degrees < 225) return 'S';
    return 'W';
}

// ── Utility: Find which of our intersections is nearest ──────────
function findNearestManagedIntersection(lat, lon) {
    let nearest = null, minDist = Infinity;
    for (const intx of MANAGED_INTERSECTIONS) {
        const d = distanceM({ lat, lon }, intx);
        if (d < minDist) { minDist = d; nearest = intx; }
    }
    return { intersection: nearest, distanceM: minDist };
}

/**
 * Call the Signal Priority API to override the intersection signals.
 *
 * @param {Object} params
 * @param {string} params.ambulanceId        - e.g. "AMB-001"
 * @param {{ lat: number, lon: number }} params.ambulancePos  - current GPS
 * @param {{ lat: number, lon: number }} params.intersectionPos - triggered node GPS
 * @param {number} params.ttiSeconds         - seconds until arrival
 * @returns {Promise<Object>}                - API response JSON
 */
async function triggerSignalOverride({ ambulanceId, ambulancePos, intersectionPos, ttiSeconds }) {
    // ── Step 1: Which managed intersection is this? ──────────────
    const { intersection, distanceM: dist } = findNearestManagedIntersection(
        intersectionPos.lat, intersectionPos.lon
    );

    // ── Step 2: Which direction is the ambulance heading? ────────
    const bearing = bearingDeg(ambulancePos, intersectionPos);
    const signalId = bearingToSignalId(bearing);

    console.log(
        `[bridge] Ambulance ${ambulanceId} → ${intersection.id} | ` +
        `bearing: ${bearing.toFixed(1)}° → signal: ${signalId} | ` +
        `dist: ${dist.toFixed(0)}m | TTI: ${ttiSeconds}s`
    );

    // ── Step 3: Call your Signal Priority API ────────────────────
    const body = {
        ambulance_id: BRIDGE_VEHICLE_ID,
        signal_id: signalId,
        estimated_arrival_time: Math.ceil(ttiSeconds),
        intersection_id: intersection.id,
    };

    try {
        const response = await fetch(`${SIGNAL_API_URL}/api/v1/signal/priority-request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'SecurityToken': SECURITY_TOKEN,
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`[bridge] Signal API error ${response.status}:`, data.message);
            return { bridgeError: data.message };
        }

        // Log the resulting signal states for visibility
        const state = data.intersection_state || {};
        const stateStr = Object.entries(state)
            .map(([dir, s]) => `${dir}:${s?.state}`)
            .join(' | ');
        console.log(`[bridge] ✅ Override applied → ${stateStr}`);

        return data;
    } catch (err) {
        console.error('[bridge] Could not reach Signal Priority API:', err.message);
        return { bridgeError: err.message };
    }
}

module.exports = { triggerSignalOverride };
