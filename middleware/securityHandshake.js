/**
 * middleware/securityHandshake.js
 * ─────────────────────────────────────────────────────────────
 * SECURE HANDSHAKE MIDDLEWARE
 *
 * This middleware performs a two-factor identity check before
 * any priority-override request is allowed to proceed:
 *
 *   Step 1 — SecurityToken validation
 *     The caller must supply a `SecurityToken` header whose
 *     value matches the server-side secret stored in .env.
 *     A missing or incorrect token results in HTTP 401.
 *
 *   Step 2 — Ambulance ID cross-check
 *     The `ambulance_id` from the request body is validated
 *     against the authorizedVehicles mock database.
 *     An unrecognised vehicle results in HTTP 403.
 *
 * Only requests that pass BOTH checks are forwarded to the
 * signal-override route handler.
 * ─────────────────────────────────────────────────────────────
 */

const { isAuthorized, getVehicleInfo } = require("../config/authorizedVehicles");

/**
 * Express middleware — validates SecurityToken header and
 * cross-checks ambulance_id against the authorised vehicle list.
 *
 * On success, attaches `req.vehicleInfo` (full fleet record)
 * so downstream handlers can use it without re-querying.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
const securityHandshake = (req, res, next) => {
    // ── Step 1: SecurityToken header check ──────────────────────
    const providedToken = req.headers["securitytoken"];
    const expectedToken = process.env.SECURITY_TOKEN;

    if (!providedToken) {
        return res.status(401).json({
            success: false,
            error: "MISSING_SECURITY_TOKEN",
            message:
                "Request rejected: 'SecurityToken' header is required. " +
                "All priority-override requests must carry a valid security token.",
        });
    }

    if (providedToken !== expectedToken) {
        return res.status(401).json({
            success: false,
            error: "INVALID_SECURITY_TOKEN",
            message:
                "Request rejected: The provided SecurityToken does not match. " +
                "Access denied.",
        });
    }

    // ── Step 2: Ambulance ID cross-check ────────────────────────
    const { ambulance_id } = req.body;

    if (!ambulance_id) {
        return res.status(400).json({
            success: false,
            error: "MISSING_AMBULANCE_ID",
            message: "Request body must include 'ambulance_id'.",
        });
    }

    if (!isAuthorized(ambulance_id)) {
        return res.status(403).json({
            success: false,
            error: "UNAUTHORIZED_VEHICLE",
            message: `Vehicle '${ambulance_id}' is NOT in the authorized emergency fleet. ` +
                "Signal override denied.",
        });
    }

    // ── Both checks passed: enrich request and proceed ──────────
    req.vehicleInfo = getVehicleInfo(ambulance_id);
    next();
};

module.exports = securityHandshake;
