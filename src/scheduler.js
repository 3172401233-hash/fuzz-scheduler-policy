'use strict';

const { Rng } = require('./rng');

const DEFAULT_WEIGHTS = Object.freeze({
  rarity: 2.0, // rare-edge coverage is the primary signal
  novelty: 1.5, // recently discovered coverage keeps a seed hot
  speed: 1.0, // faster inputs get more executions per time unit
});

const DEFAULTS = Object.freeze({
  budget: 100,
  seed: 1,
  weights: DEFAULT_WEIGHTS,
  floorQuota: 1, // guaranteed minimum executions per seed per round
  ageWeight: 0.25, // multiplier growth per round a seed goes unselected
  epsilon: 1e-3, // keeps every energy strictly positive
});

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function normalizeSeed(raw, index) {
  if (raw == null || typeof raw !== 'object') {
    throw new TypeError(`seed at index ${index} must be an object`);
  }
  const id = raw.id != null ? String(raw.id) : `seed-${index}`;
  const edges = Array.isArray(raw.edges) ? raw.edges.map(String) : [];
  const execTimeMs = Number.isFinite(raw.execTimeMs) && raw.execTimeMs > 0 ? raw.execTimeMs : 1;
  const recentDiscoveries =
    Number.isFinite(raw.recentDiscoveries) && raw.recentDiscoveries > 0
      ? raw.recentDiscoveries
      : 0;
  const queueAge = Number.isFinite(raw.queueAge) && raw.queueAge > 0 ? raw.queueAge : 0;
  return { id, edges, execTimeMs, recentDiscoveries, queueAge };
}

class FuzzScheduler {
  constructor(options = {}) {
    const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    for (const [key, value] of Object.entries(weights)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`weight "${key}" must be a non-negative number`);
      }
    }
    this.weights = weights;
    this.budget = Number.isInteger(options.budget) && options.budget >= 0
      ? options.budget
      : DEFAULTS.budget;
    this.floorQuota = Number.isInteger(options.floorQuota) && options.floorQuota >= 0
      ? options.floorQuota
      : DEFAULTS.floorQuota;
    this.ageWeight = Number.isFinite(options.ageWeight) && options.ageWeight >= 0
      ? options.ageWeight
      : DEFAULTS.ageWeight;
    this.epsilon = Number.isFinite(options.epsilon) && options.epsilon > 0
      ? options.epsilon
      : DEFAULTS.epsilon;
    this.rng = new Rng(options.seed != null ? options.seed : DEFAULTS.seed);
    this.round = 0;
    // id -> rounds since the seed last received a non-zero quota
    this.roundsSinceSelected = new Map();
  }

  setBudget(budget) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new RangeError('budget must be a non-negative integer');
    }
    this.budget = budget;
  }

  reset() {
    this.round = 0;
    this.roundsSinceSelected.clear();
  }

  // Edge rarity: an edge hit by every seed in the corpus carries no signal;
  // an edge hit by one seed is maximally rare. Log damping avoids extreme
  // ratios on huge corpora while still separating 1 hit from 10 clearly.
  _edgeRarityTable(seeds) {
    const hits = new Map();
    for (const seed of seeds) {
      for (const edge of new Set(seed.edges)) {
        hits.set(edge, (hits.get(edge) || 0) + 1);
      }
    }
    const rarity = new Map();
    for (const [edge, count] of hits) {
      rarity.set(edge, 1 / (1 + Math.log(count)));
    }
    return rarity;
  }

  _scoreSeed(seed, ctx) {
    const { rarityTable, maxDiscoveries, minExecTime } = ctx;

    // A seed is as valuable as its rarest edge: averaging over the whole
    // fingerprint would let a pile of common edges dilute one unique hit.
    let rarity = 0;
    for (const edge of new Set(seed.edges)) {
      const value = rarityTable.get(edge) || 0;
      if (value > rarity) rarity = value;
    }

    const novelty =
      maxDiscoveries > 0
        ? Math.log1p(seed.recentDiscoveries) / Math.log1p(maxDiscoveries)
        : 0;

    const speed = clamp(minExecTime / seed.execTimeMs, 0, 1);

    const idleRounds = this.roundsSinceSelected.get(seed.id) || 0;
    // Queue age (rounds since the seed joined) also feeds the boost so
    // long-queued newcomers are not drowned out by established seeds.
    const ageBoost =
      1 + this.ageWeight * Math.log1p(idleRounds + seed.queueAge);

    const base =
      this.weights.rarity * rarity +
      this.weights.novelty * novelty +
      this.weights.speed * speed;

    const energy = (base + this.epsilon) * ageBoost;

    return {
      rarity,
      novelty,
      speed,
      idleRounds,
      ageBoost,
      base,
      energy,
    };
  }

  // Largest-remainder apportionment with deterministic RNG tie-breaking.
  _apportion(energies, total) {
    const n = energies.length;
    const quotas = new Array(n).fill(0);
    if (total <= 0 || n === 0) return quotas;

    const sum = energies.reduce((acc, e) => acc + e, 0);
    const remainders = [];
    let assigned = 0;
    for (let i = 0; i < n; i += 1) {
      const share = sum > 0 ? (energies[i] / sum) * total : total / n;
      const floor = Math.floor(share);
      quotas[i] = floor;
      assigned += floor;
      remainders.push({ index: i, frac: share - floor, tie: this.rng.next() });
    }
    let leftover = total - assigned;
    remainders.sort((a, b) => b.frac - a.frac || a.tie - b.tie);
    for (let i = 0; leftover > 0 && i < remainders.length; i += 1) {
      quotas[remainders[i].index] += 1;
      leftover -= 1;
    }
    return quotas;
  }

  /**
   * Compute the next round of execution quotas.
   *
   * @param {Array} rawSeeds seeds with { id, edges, execTimeMs,
   *   recentDiscoveries, queueAge }
   * @param {object} [opts] per-call overrides: { budget }
   * @returns {{round:number, budget:number, allocations:Array}}
   */
  schedule(rawSeeds, opts = {}) {
    if (!Array.isArray(rawSeeds)) {
      throw new TypeError('seeds must be an array');
    }
    const budget = opts.budget != null ? opts.budget : this.budget;
    if (!Number.isInteger(budget) || budget < 0) {
      throw new RangeError('budget must be a non-negative integer');
    }

    const seeds = rawSeeds.map(normalizeSeed);
    const n = seeds.length;
    this.round += 1;

    if (n === 0 || budget === 0) {
      return {
        round: this.round,
        budget,
        allocations: seeds.map((s) => ({
          id: s.id,
          quota: 0,
          energy: 0,
          breakdown: null,
        })),
      };
    }

    const rarityTable = this._edgeRarityTable(seeds);
    let maxDiscoveries = 0;
    let minExecTime = Infinity;
    for (const seed of seeds) {
      if (seed.recentDiscoveries > maxDiscoveries) maxDiscoveries = seed.recentDiscoveries;
      if (seed.execTimeMs < minExecTime) minExecTime = seed.execTimeMs;
    }
    const ctx = { rarityTable, maxDiscoveries, minExecTime };

    const scores = seeds.map((seed) => this._scoreSeed(seed, ctx));

    // Anti-starvation floor: only applied when the budget can actually
    // cover it; otherwise the floor silently degrades to zero and energy
    // apportionment decides everything.
    const floor = n * this.floorQuota <= budget ? this.floorQuota : 0;
    const remaining = budget - floor * n;

    const energyQuotas = this._apportion(
      scores.map((s) => s.energy),
      remaining,
    );

    const totalEnergy = scores.reduce((acc, s) => acc + s.energy, 0);
    const allocations = seeds.map((seed, i) => {
      const quota = floor + energyQuotas[i];
      return {
        id: seed.id,
        quota,
        energy: scores[i].energy,
        breakdown: {
          inputs: {
            edgeCount: new Set(seed.edges).size,
            execTimeMs: seed.execTimeMs,
            recentDiscoveries: seed.recentDiscoveries,
            queueAge: seed.queueAge,
          },
          components: {
            rarity: scores[i].rarity,
            novelty: scores[i].novelty,
            speed: scores[i].speed,
          },
          weights: { ...this.weights },
          base: scores[i].base,
          idleRounds: scores[i].idleRounds,
          ageBoost: scores[i].ageBoost,
          energyShare: totalEnergy > 0 ? scores[i].energy / totalEnergy : 0,
          floorQuota: floor,
          energyQuota: energyQuotas[i],
        },
      };
    });

    for (let i = 0; i < n; i += 1) {
      if (allocations[i].quota > 0) {
        this.roundsSinceSelected.set(seeds[i].id, 0);
      } else {
        this.roundsSinceSelected.set(
          seeds[i].id,
          (this.roundsSinceSelected.get(seeds[i].id) || 0) + 1,
        );
      }
    }

    return { round: this.round, budget, allocations };
  }
}

module.exports = { FuzzScheduler, DEFAULT_WEIGHTS };
