/**
 * jitter.js
 * Simple fixed-size circular-buffer moving average to smooth GPS velocity spikes.
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
     * @param {number} rawVelocityMs
     * @returns {number}
     */
    push(rawVelocityMs) {
        this.buffer.push(rawVelocityMs);

        // Keep only the last `windowSize` samples
        if (this.buffer.length > this.windowSize) {
            this.buffer.shift();
        }

        return this.average();
    }

    average() {
        if (this.buffer.length === 0) return 0;
        const sum = this.buffer.reduce((acc, v) => acc + v, 0);
        return sum / this.buffer.length;
    }

    reset() {
        this.buffer = [];
    }
}

module.exports = JitterSmoother;
