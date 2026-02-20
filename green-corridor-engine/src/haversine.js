/**
 * haversine.js
 * Wrapper around the `haversine-distance` npm package.
 * Provides distance (meters) and velocity (m/s and km/h) calculations
 * between two GPS coordinate pairs.
 */

const haversine = require('haversine-distance');

/**
 * Calculate the straight-line distance (in meters) between two GPS points.
 *
 * @param {{ lat: number, lon: number }} p1 - First GPS point
 * @param {{ lat: number, lon: number }} p2 - Second GPS point
 * @returns {number} Distance in metres
 */
function getDistanceMeters(p1, p2) {
  // haversine-distance expects { latitude, longitude }
  const a = { latitude: p1.lat, longitude: p1.lon };
  const b = { latitude: p2.lat, longitude: p2.lon };
  return haversine(a, b); // returns metres
}

/**
 * Calculate velocity between two telemetry points.
 *
 * @param {{ lat: number, lon: number, timestamp: number }} p1 - Older point  (Unix seconds)
 * @param {{ lat: number, lon: number, timestamp: number }} p2 - Newer point  (Unix seconds)
 * @returns {{ ms: number, kmh: number, deltaMeters: number, deltaSec: number }}
 */
function getVelocity(p1, p2) {
  const deltaMeters = getDistanceMeters(p1, p2);
  const deltaSec = p2.timestamp - p1.timestamp;

  if (deltaSec <= 0) {
    return { ms: 0, kmh: 0, deltaMeters, deltaSec: 0 };
  }

  const ms  = deltaMeters / deltaSec;
  const kmh = ms * 3.6;

  return { ms, kmh, deltaMeters, deltaSec };
}

module.exports = { getDistanceMeters, getVelocity };
