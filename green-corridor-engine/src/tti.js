/**
 * tti.js
 * Time-to-Intersection (TTI) Engine.
 *
 * Given:
 *  - The ambulance's current position
 *  - The signal (intersection) coordinate
 *  - The ambulance's smoothed velocity (m/s)
 *
 * This module computes:
 *  1. distanceToSignal  – straight-line haversine distance to the signal (m)
 *  2. tti               – estimated seconds until the ambulance reaches the signal
 *  3. shouldTrigger     – boolean: within proximity AND tti ≤ threshold
 */

const { getDistanceMeters } = require('./haversine');

/**
 * @typedef {Object} TTIResult
 * @property {number}  distanceToSignalM  - Distance to signal in metres
 * @property {number}  ttiSeconds         - Estimated time to intersection (seconds)
 * @property {boolean} shouldTrigger      - True when both thresholds are breached
 */

/**
 * Evaluate TTI and trigger condition.
 *
 * @param {{ lat: number, lon: number }} ambulancePos   - Current ambulance position
 * @param {{ lat: number, lon: number }} signalCoord    - Static signal/intersection position
 * @param {number} smoothedVelocityMs                   - Smoothed speed in m/s
 * @param {number} proximityThresholdM                  - Distance threshold (default 500 m)
 * @param {number} ttiThresholdSec                      - TTI threshold (default 20 s)
 * @returns {TTIResult}
 */
function evaluateTTI(
    ambulancePos,
    signalCoord,
    smoothedVelocityMs,
    proximityThresholdM = 500,
    ttiThresholdSec = 20
) {
    const distanceToSignalM = getDistanceMeters(ambulancePos, signalCoord);

    // Avoid division by zero / stationary vehicle
    const ttiSeconds =
        smoothedVelocityMs > 0
            ? distanceToSignalM / smoothedVelocityMs
            : Infinity;

    const withinProximity = distanceToSignalM <= proximityThresholdM;
    const withinTTI = ttiSeconds <= ttiThresholdSec;
    const shouldTrigger = withinProximity && withinTTI;

    return {
        distanceToSignalM: parseFloat(distanceToSignalM.toFixed(2)),
        ttiSeconds: ttiSeconds === Infinity ? null : parseFloat(ttiSeconds.toFixed(2)),
        shouldTrigger,
    };
}

module.exports = { evaluateTTI };
