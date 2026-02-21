/**
 * routes/signal.js
 * ─────────────────────────────────────────────────────────────
 * SIGNAL PRIORITY ROUTE
 *
 * Exposes:
 *   POST /api/v1/signal/priority-request
 *
 * Request body (JSON):
 *   {
 *     "signal_id":             "N" | "S" | "E" | "W",
 *     "ambulance_id":          "AMB-001",
 *     "estimated_arrival_time": 15       // seconds
 *   }
 *
 * Required header:
 *   SecurityToken: <your secure token from .env>
 *
 * Flow:
 *   1. securityHandshake middleware validates token + vehicle
 *   2. Body fields are validated
 *   3. schedulePreArrivalFlush calculates timing + applies override
 *   4. Full intersection state snapshot is returned as JSON
 * ─────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

const securityHandshake = require("../middleware/securityHandshake");
const { schedulePreArrivalFlush } = require("../logic/preArrivalFlush");
const { getAllIntersections, getSignalIds, INTERSECTIONS } = require("../config/intersections");

/**
 * POST /api/v1/signal/priority-request
 *
 * Body params:
 *   signal_id             {string}  — Target signal direction (N/S/E/W)
 *   ambulance_id          {string}  — Vehicle identifier (validated by middleware)
 *   estimated_arrival_time {number} — ETA in seconds
 *
 * Optional body params:
 *   intersection_id       {string}  — One of: INT-MAIN | INT-NORTH | INT-EAST (default: INT-MAIN)
 */

/**
 * GET /api/v1/signal/intersections
 *
 * Public — no auth required.
 * Returns the list of all managed intersections with their
 * IDs, names, coordinates, and available signal directions.
 * The frontend can use this to populate a dropdown/map layer.
 */
router.get("/intersections", (_req, res) => {
    const intersections = getAllIntersections();
    res.json({ success: true, count: intersections.length, intersections });
});
router.post(
    "/priority-request",

    // ── Middleware: Secure Handshake ─────────────────────────────
    // Validates SecurityToken header AND cross-checks ambulance_id
    // against the authorized fleet. Attaches req.vehicleInfo on pass.
    securityHandshake,

    // ── Route Handler ────────────────────────────────────────────
    (req, res) => {
        const { signal_id, ambulance_id, estimated_arrival_time, intersection_id } =
            req.body;

        // ── Field presence validation ──────────────────────────────
        if (signal_id === undefined || estimated_arrival_time === undefined) {
            return res.status(400).json({
                success: false,
                error: "MISSING_FIELDS",
                message:
                    "Request body must include 'signal_id' and 'estimated_arrival_time'.",
            });
        }

        // ── intersection_id validation ──────────────────────────────
        const resolvedIntersectionId = intersection_id || "INT-MAIN";
        if (!INTERSECTIONS[resolvedIntersectionId]) {
            const validIds = Object.keys(INTERSECTIONS).join(", ");
            return res.status(400).json({
                success: false,
                error: "INVALID_INTERSECTION_ID",
                message: `Unknown intersection '${resolvedIntersectionId}'. ` +
                    `Valid IDs are: ${validIds}.`,
            });
        }

        // ── signal_id format validation ────────────────────────────
        const validSignals = getSignalIds(resolvedIntersectionId);
        const normalizedSignalId = String(signal_id).toUpperCase();

        if (!validSignals.includes(normalizedSignalId)) {
            return res.status(400).json({
                success: false,
                error: "INVALID_SIGNAL_ID",
                message: `'signal_id' must be one of: ${validSignals.join(", ")}. ` +
                    `Received: '${signal_id}'.`,
            });
        }

        // ── ETA validation ─────────────────────────────────────────
        const eta = Number(estimated_arrival_time);

        if (isNaN(eta) || eta < 0) {
            return res.status(400).json({
                success: false,
                error: "INVALID_ETA",
                message:
                    "'estimated_arrival_time' must be a non-negative number (seconds).",
            });
        }

        // ── Apply Pre-Arrival Flush + Safety Interlock ─────────────
        let flushResult;
        try {
            flushResult = schedulePreArrivalFlush(
                normalizedSignalId,
                eta,
                resolvedIntersectionId
            );
        } catch (err) {
            return res.status(500).json({
                success: false,
                error: "SIGNAL_OVERRIDE_FAILED",
                message: err.message,
            });
        }

        // ── Build & return response ────────────────────────────────
        const requestId = uuidv4();
        const timestamp = new Date().toISOString();

        console.log(
            `[PRIORITY REQUEST] id=${requestId} vehicle=${ambulance_id} ` +
            `signal=${normalizedSignalId} eta=${eta}s ` +
            `flush=${flushResult.flush_status} at=${timestamp}`
        );

        return res.status(200).json({
            success: true,
            request_id: requestId,
            timestamp,

            // ── Vehicle details (from middleware) ────────────────────
            vehicle: req.vehicleInfo,

            // ── Priority request params ──────────────────────────────
            priority_request: {
                signal_id: normalizedSignalId,
                estimated_arrival_time_seconds: eta,
            },

            // ── Pre-Arrival Flush details ────────────────────────────
            flush_status: flushResult.flush_status,
            activation_delay_seconds: flushResult.activation_delay_seconds,
            activation_at_iso: flushResult.activation_at_iso,

            // ── Safety Interlock summary ─────────────────────────────
            safety_interlock: {
                green_signal: flushResult.activated_signal,
                hard_red_signals: flushResult.hard_red_signals,
                intersection_id: flushResult.intersection_id,
                intersection_name: flushResult.intersection_name,
            },

            // ── Full intersection state for Frontend Lead ────────────
            // Each direction reports its current state:
            //   GREEN    → ambulance corridor
            //   HARD_RED → safety-locked perpendicular signals
            //   RED      → normal hold
            intersection_state: flushResult.intersection_state,
        });
    }
);

module.exports = router;
