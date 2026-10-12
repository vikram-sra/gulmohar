import assert from 'node:assert/strict';
import { createAnimationClock } from '../src/utils/animationClock.js';
for (const hz of [24, 30, 60, 90, 120, 144]) {
    const clock = createAnimationClock(24);
    let count = 0, last;
    for (let i = 0; i < hz * 5; i++) {
        const tick = clock.advance(1 / hz);
        if (tick) { count++; last = tick; }
    }
    assert.equal(count, 120, `${hz} Hz display gets 24 animation updates per second`);
    assert.ok(Math.abs(last.time - 5) < 1e-8, 'animation speed stays in real seconds');
}
const clock = createAnimationClock();
assert.equal(clock.advance(1 / 120), null, 'pose holds between ticks');
const tick = clock.advance(0.1);
assert.ok(Math.abs(tick.delta - 2 / 24) < 1e-8, 'slow frames skip poses without slowing animation');
assert.equal(clock.advance(0), null, 'missed ticks never cause update bursts');
console.log('24 fps animation cadence verified at 24–144 Hz and across slow frames.');
