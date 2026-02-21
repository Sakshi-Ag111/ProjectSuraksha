/**
 * logic/signalController.js
 * ─────────────────────────────────────────────────────────────
 * SAFETY INTERLOCK — Signal State Controller
 *
 * This module contains the core safety logic that governs how
 * signals change state during an emergency priority request.
 *
 * RULES (non-negotiable, safety-critical):
 * ──────────────────────────────────────────
 *   1. The requested signal_id is set to GREEN.
 *   2. ALL signals in its conflict group are immediately set
 *      to HARD_RED — this is a hard safety lockout that
 *      cannot be overridden by any other process.
 *   3. Signals NOT in the conflict group (i.e., signals that
 *      run parallel to the ambulance route) are set to RED
 *      (normal red, waiting for their turn after the flush).
 *   4. A full snapshot of all 4 directional signals is
 *      returned so the frontend can render the intersection
 *      state in real time.
 *
 * SIGNAL STATE VOCABULARY:
 *   GREEN     — vehicles may proceed
 *   RED       — vehicles must stop (normal cycle)
 *   HARD_RED  — vehicles must stop; safety interlock active,
 *               signal CANNOT turn green until lockout is lifted
 * ─────────────────────────────────────────────────────────────
 */

const { getIntersection } = require("../config/intersections");

/**
 * Apply the priority signal override to the intersection.
 *
 * Sets `signal_id` to GREEN and forces all conflicting signals
 * to HARD_RED. Returns a complete intersection state snapshot.
 *
 * @param {string} signal_id        - The signal direction to set GREEN (N/S/E/W)
 * @param {string} [intersection_id="INT-MAIN"]
 * @returns {{ intersection_state: Object, activated_signal: string, hard_red_signals: string[] }}
 * @throws {Error} If signal_id or intersection_id is invalid
 */
const applyPriorityOverride = (signal_id, intersection_id = "INT-MAIN") => {
    const intersection = getIntersection(intersection_id);

    if (!intersection) {
        throw new Error(`Unknown intersection: '${intersection_id}'`);
    }

    const validSignals = Object.keys(intersection.signals);

    if (!validSignals.includes(signal_id)) {
        throw new Error(
            `Invalid signal_id '${signal_id}'. ` +
            `Valid directions for ${intersection_id} are: ${validSignals.join(", ")}`
        );
    }

    // ── Determine conflict group for the requested signal ───────
    const conflictingSignals = intersection.conflict_groups[signal_id];

    // ── Build the full intersection state snapshot ───────────────
    // We iterate over every signal direction and assign state.
    const intersection_state = {};

    for (const direction of validSignals) {
        if (direction === signal_id) {
            // ✅ Ambulance route — set to GREEN
            intersection_state[direction] = {
                direction: intersection.signals[direction].direction,
                state: "GREEN",
                note: "Priority override — emergency vehicle corridor active",
            };
        } else if (conflictingSignals.includes(direction)) {
            // 🚨 SAFETY INTERLOCK — set to HARD_RED
            // This is a perpendicular signal that would create a collision
            // risk if allowed to proceed concurrently.
            intersection_state[direction] = {
                direction: intersection.signals[direction].direction,
                state: "HARD_RED",
                note:
                    "Safety interlock active — perpendicular to emergency corridor. " +
                    "Signal locked out until priority request is cleared.",
            };
        } else {
            // 🔴 Non-conflicting parallel signals — set to normal RED
            // (These share the same axial direction as the ambulance
            // and are simply held at red during the flush window.)
            intersection_state[direction] = {
                direction: intersection.signals[direction].direction,
                state: "RED",
                note: "Held at red during emergency flush window",
            };
        }
    }

    return {
        activated_signal: signal_id,
        hard_red_signals: conflictingSignals,
        intersection_id,
        intersection_name: intersection.name,
        intersection_state,
    };
};

module.exports = { applyPriorityOverride };
