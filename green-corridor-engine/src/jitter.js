/**
 * jitter.js
 * Simple fixed-size circular-buffer moving average to smooth GPS velocity spikes.
 *
 * Each ambulance gets its own JitterSmoother instance (keyed by ambulance ID
 * in the main corridor orchestrator), so that smoothing state is isolated
 * per vehicle.
 */

class JitterSmoother {
    /**
     * @param {number} windowSize - Number of samples to average (default 5)
     */
    constructor(windowSize = 5) {
        this.windowSize = windowSize;
        this.buffer = [];   // rolling buffer of raw velocity samples (m/s)
    }

    /**
     * Push a new raw velocity sample and return the smoothed value.
     *
     * @param {number} rawVelocityMs - Instantaneous velocity in m/s
     * @returns {number} Smoothed velocity in m/s
     */
    push(rawVelocityMs) {
        this.buffer.push(rawVelocityMs);

        // Keep only the last `windowSize` samples
        if (this.buffer.length > this.windowSize) {
            this.buffer.shift();
        }

        return this.average();
    }

    /**
     * Return the current moving average without adding a new sample.
     * @returns {number}
     */
    average() {
        if (this.buffer.length === 0) return 0;
        const sum = this.buffer.reduce((acc, v) => acc + v, 0);
        return sum / this.buffer.length;
    }

    /**
     * Reset the buffer (e.g. when a vehicle goes offline).
     */
    reset() {
        this.buffer = [];
    }
}

module.exports = JitterSmoother;
