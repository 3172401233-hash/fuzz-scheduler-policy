'use strict';

// mulberry32: small, fast, deterministic PRNG.
// The scheduler never uses Math.random(); all randomness flows through
// an explicit seed so runs are reproducible.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed = 1) {
    if (!Number.isInteger(seed)) {
      throw new TypeError('rng seed must be an integer');
    }
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
    this.draws = 0;
  }

  // Uniform float in [0, 1).
  next() {
    this.draws += 1;
    return this._next();
  }

  // Uniform integer in [0, n).
  int(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError('int(n) requires a positive integer n');
    }
    return Math.floor(this.next() * n);
  }
}

module.exports = { Rng, mulberry32 };
