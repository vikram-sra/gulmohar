/** Fixed animation cadence without slowing time on 30/60/120 Hz displays. */
export function createAnimationClock(fps = 24) {
    const step = 1 / fps;
    let remainder = 0;
    let time = 0;
    return {
        advance(dt) {
            remainder += Math.max(0, dt);
            const ticks = Math.floor((remainder + 1e-9) / step);
            if (!ticks) return null;
            const delta = ticks * step;
            remainder = Math.max(0, remainder - delta);
            time += delta;
            // Skip missed poses rather than running a burst of updates.
            return { time, delta };
        }
    };
}
