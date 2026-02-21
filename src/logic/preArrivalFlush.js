/**
 * logic/preArrivalFlush.js
 * ─────────────────────────────────────────────────────────────
 * PRE-ARRIVAL FLUSH TIMER
 *
 * Manages the timing strategy for activating the priority
 * green signal relative to the ambulance's ETA.
 *
 * STRATEGY:
 * ─────────
 *   The green light must be active BEFORE the ambulance
 *   reaches the intersection so that stationary vehicles
 *   have time to clear the path.
 *
 *   We apply a 10-second early-activation buffer:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  ETA ≤ 20 s  →  Activate GREEN immediately       │
 *   │               (ambulance is already close; no    │
 *   │                time to wait — flush NOW)          │
 *   │                                                  │
 *   │  ETA > 20 s  →  Schedule activation at           │
 *   │               (ETA − 10) seconds from now        │
 *   │               (give standing traffic time to     │
 *   │                clear before the ambulance hits)  │
 *   └──────────────────────────────────────────────────┘
 *
 * The function itself does NOT block — it schedules the
 * override with setTimeout and returns immediately so the
 * API can respond to the caller right away with the planned
 * activation time.
 * ─────────────────────────────────────────────────────────────
 */

const { applyPriorityOverride } = require("./signalController");

/**
 * Schedule or immediately execute the priority signal override
 * based on the ambulance's estimated arrival time.
 *
 * @param {string} signal_id              - Target signal direction (N/S/E/W)
 * @param {number} estimated_arrival_time - Seconds until ambulance arrives
 * @param {string} [intersection_id]      - Defaults to "INT-MAIN"
 * @returns {{
 *   flush_status: "IMMEDIATE" | "SCHEDULED",
 *   activation_delay_seconds: number,
 *   activation_at_iso: string,
 *   intersection_state: Object
 * }}
 */
const schedulePreArrivalFlush = (
    signal_id,
    estimated_arrival_time,
    intersection_id = "INT-MAIN"
) => {
    // ── Threshold constants ──────────────────────────────────────
    const EARLY_ACTIVATION_BUFFER_SECONDS = 10; // activate this many seconds early
    const IMMEDIATE_THRESHOLD_SECONDS = 20;     // if ETA is at or below this → immediate

    // ── Determine activation delay ───────────────────────────────
    let activationDelayMs;
    let flush_status;

    if (estimated_arrival_time <= IMMEDIATE_THRESHOLD_SECONDS) {
        // Ambulance is 20 s or less away — activate GREEN right now.
        activationDelayMs = 0;
        flush_status = "IMMEDIATE";
    } else {
        // Ambulance is more than 20 s away — schedule activation
        // 10 seconds before it arrives, giving traffic time to clear.
        const delaySeconds = estimated_arrival_time - EARLY_ACTIVATION_BUFFER_SECONDS;
        activationDelayMs = delaySeconds * 1000;
        flush_status = "SCHEDULED";
    }

    // ── Calculate the wall-clock activation timestamp ────────────
    const activationAt = new Date(Date.now() + activationDelayMs);

    // Schedule a log for the deferred flush; no-op for immediate activation.
    if (activationDelayMs > 0) {
        setTimeout(() => {
            console.log(
                `[PRE-ARRIVAL FLUSH] Signal ${signal_id} set to GREEN at ` +
                `${new Date().toISOString()} (ETA was ${estimated_arrival_time}s, ` +
                `intersection: ${intersection_id})`
            );
        }, activationDelayMs);
    }

    // ── Build the current intersection state snapshot ────────────
    // applyPriorityOverride is called ONCE here to produce the
    // authoritative state that is returned to the caller.
    // Both the IMMEDIATE and SCHEDULED paths rely on this single call.
    const overrideResult = applyPriorityOverride(signal_id, intersection_id);

    return {
        flush_status,
        activation_delay_seconds: activationDelayMs / 1000,
        activation_at_iso: activationAt.toISOString(),
        ...overrideResult,
    };
};

module.exports = { schedulePreArrivalFlush };
