/**
 * config/intersections.js
 * ─────────────────────────────────────────────────────────────
 * Defines the physical layout of each managed intersection.
 *
 * Each intersection has four directional signal heads:
 *   N  → North
 *   S  → South
 *   E  → East
 *   W  → West
 *
 * CONFLICT GROUPS (Safety Interlock)
 * ───────────────────────────────────
 * When a signal goes GREEN all signals in its conflict group
 * MUST immediately be set to HARD_RED to prevent collisions.
 *
 * Straight-through conflict pairs at a 4-way crossing:
 *   • N and S share the same green phase (N-S corridor).
 *     Conflicting signals: E and W.
 *   • E and W share the same green phase (E-W corridor).
 *     Conflicting signals: N and S.
 *
 * A signal is never its own conflict — only perpendicular
 * directions are listed.
 * ─────────────────────────────────────────────────────────────
 */

const INTERSECTIONS = {

    // ── Intersection 1: JLN Marg / Tonk Road junction ───────────
    // Sits on the SMS Hospital → Tonk Road route (lat ~26.869)
    "INT-MAIN": {
        id: "INT-MAIN",
        name: "C-Scheme Area Crossing",
        location: { lat: 26.8860, lng: 75.7880 },
        signals: {
            N: { direction: "North", default_state: "RED" },
            S: { direction: "South", default_state: "RED" },
            E: { direction: "East", default_state: "RED" },
            W: { direction: "West", default_state: "RED" },
        },
        conflict_groups: {
            N: ["E", "W"],
            S: ["E", "W"],
            E: ["N", "S"],
            W: ["N", "S"],
        },
    },

    // ── Intersection 2: Dravyavati River crossing ────────────────
    // Mid-point on the standard route (lat ~26.865)
    "INT-NORTH": {
        id: "INT-NORTH",
        name: "Sindhi Camp Bus Stand Crossing",
        location: { lat: 26.9350, lng: 75.7860 },
        signals: {
            N: { direction: "North", default_state: "RED" },
            S: { direction: "South", default_state: "RED" },
            E: { direction: "East", default_state: "RED" },
            W: { direction: "West", default_state: "RED" },
        },
        conflict_groups: {
            N: ["E", "W"],
            S: ["E", "W"],
            E: ["N", "S"],
            W: ["N", "S"],
        },
    },

    // ── Intersection 3: Tonk Road / Sanganer approach ────────────
    // Near route destination zone (lat ~26.862)
    "INT-EAST": {
        id: "INT-EAST",
        name: "Jaipur Junction Stn Crossing",
        location: { lat: 26.9124, lng: 75.8050 },
        signals: {
            N: { direction: "North", default_state: "RED" },
            S: { direction: "South", default_state: "RED" },
            E: { direction: "East", default_state: "RED" },
            W: { direction: "West", default_state: "RED" },
        },
        conflict_groups: {
            N: ["E", "W"],
            S: ["E", "W"],
            E: ["N", "S"],
            W: ["N", "S"],
        },
    },
};


/**
 * Return a lightweight summary of all registered intersections.
 * Used by the listing endpoint for the frontend.
 * @returns {Object[]}
 */
const getAllIntersections = () =>
    Object.values(INTERSECTIONS).map(({ id, name, location, signals }) => ({
        id,
        name,
        location,
        signal_directions: Object.keys(signals),
    }));

/**
 * Return the intersection config object. Defaults to "INT-MAIN".
 *
 * @param {string} [intersection_id="INT-MAIN"]
 * @returns {Object|null}
 */
const getIntersection = (intersection_id = "INT-MAIN") =>
    INTERSECTIONS[intersection_id] || null;

/**
 * Return the valid signal IDs for an intersection.
 * @param {string} [intersection_id="INT-MAIN"]
 * @returns {string[]}
 */
const getSignalIds = (intersection_id = "INT-MAIN") => {
    const intersection = getIntersection(intersection_id);
    return intersection ? Object.keys(intersection.signals) : [];
};

module.exports = { INTERSECTIONS, getAllIntersections, getIntersection, getSignalIds };
