/**
 * tti.js
 * Time-to-Intersection (TTI) Engine.
 */

const { getDistanceMeters } = require('./haversine');

/**
 * @typedef {Object} TTIResult
 * @property {number}  distanceToSignalM  - Distance to signal in metres
 * @property {number}  ttiSeconds         - Estimated time to intersection (seconds)
 * @property {boolean} shouldTrigger      - True when both thresholds are breached
 */

/**
 * @param {{ lat: number, lon: number }} ambulancePos
 * @param {{ lat: number, lon: number }} signalCoord
 * @param {number} smoothedVelocityMs
 * @param {number} proximityThresholdM
 * @param {number} ttiThresholdSec
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
