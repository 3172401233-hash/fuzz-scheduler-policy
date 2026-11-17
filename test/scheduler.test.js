'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FuzzScheduler, Rng } = require('../src/index');

function makeSeed(overrides = {}) {
  return {
    id: 's',
    edges: ['e1'],
    execTimeMs: 10,
    recentDiscoveries: 0,
    queueAge: 0,
    ...overrides,
  };
}

function quotaOf(result, id) {
  return result.allocations.find((a) => a.id === id).quota;
}

test('cold start: uniform quotas, no NaN, sums to budget', () => {
  const scheduler = new FuzzScheduler({ seed: 7, budget: 60 });
  const seeds = Array.from({ length: 6 }, (_, i) =>
    makeSeed({ id: `s${i}`, edges: [`edge-${i}`] }),
  );
  const result = scheduler.schedule(seeds);

  const total = result.allocations.reduce((acc, a) => acc + a.quota, 0);
  assert.equal(total, 60);
  for (const alloc of result.allocations) {
    assert.ok(Number.isFinite(alloc.energy));
    assert.ok(Number.isFinite(alloc.breakdown.base));
    assert.ok(alloc.quota >= 1, 'floor quota keeps every seed alive');
  }
  // Symmetric inputs -> identical energies.
  const energies = new Set(result.allocations.map((a) => a.energy));
  assert.equal(energies.size, 1);
});

test('cold start: empty corpus and zero budget are safe', () => {
  const scheduler = new FuzzScheduler({ seed: 1, budget: 10 });
  assert.deepEqual(scheduler.schedule([]).allocations, []);
  const result = scheduler.schedule([makeSeed({ id: 'a' })], { budget: 0 });
  assert.equal(quotaOf(result, 'a'), 0);
});

test('hot edges: rare-edge seed dominates common-edge seeds', () => {
  const scheduler = new FuzzScheduler({ seed: 3, budget: 100 });
  const common = ['c1', 'c2', 'c3'];
  const seeds = [
    makeSeed({ id: 'rare', edges: [...common, 'unique-edge'] }),
    ...Array.from({ length: 9 }, (_, i) =>
      makeSeed({ id: `common-${i}`, edges: common }),
    ),
  ];
  const result = scheduler.schedule(seeds);
  const rare = result.allocations.find((a) => a.id === 'rare');
  const commonQuotas = result.allocations
    .filter((a) => a.id !== 'rare')
    .map((a) => a.quota);
  const maxCommon = Math.max(...commonQuotas);

  assert.ok(
    rare.quota >= maxCommon * 1.5,
    `rare=${rare.quota} maxCommon=${maxCommon}`,
  );
  assert.ok(rare.quota === Math.max(...result.allocations.map((a) => a.quota)));
  assert.ok(rare.breakdown.components.rarity > 0.4);
  const commonAlloc = result.allocations.find((a) => a.id === 'common-0');
  assert.ok(commonAlloc.breakdown.components.rarity < rare.breakdown.components.rarity);
});

test('hot edges: recent discoveries raise novelty and quota', () => {
  const scheduler = new FuzzScheduler({ seed: 11, budget: 100 });
  const seeds = [
    makeSeed({ id: 'hot', edges: ['e1'], recentDiscoveries: 25 }),
    makeSeed({ id: 'cold', edges: ['e2'], recentDiscoveries: 0 }),
  ];
  const result = scheduler.schedule(seeds);
  const hot = result.allocations.find((a) => a.id === 'hot');
  assert.ok(hot.breakdown.components.novelty === 1);
  assert.ok(quotaOf(result, 'hot') > quotaOf(result, 'cold'));
});

test('discovery exhaustion: all-zero discoveries fall back to rarity/speed', () => {
  const scheduler = new FuzzScheduler({ seed: 5, budget: 50 });
  const seeds = [
    makeSeed({ id: 'fast', edges: ['e1'], execTimeMs: 1, recentDiscoveries: 0 }),
    makeSeed({ id: 'slow', edges: ['e2'], execTimeMs: 100, recentDiscoveries: 0 }),
  ];
  const result = scheduler.schedule(seeds);
  for (const alloc of result.allocations) {
    assert.equal(alloc.breakdown.components.novelty, 0);
    assert.ok(Number.isFinite(alloc.energy));
  }
  assert.ok(quotaOf(result, 'fast') > quotaOf(result, 'slow'));
  assert.equal(
    result.allocations.reduce((acc, a) => acc + a.quota, 0),
    50,
  );
});

test('huge corpus: 20k seeds schedule quickly and conserve budget', () => {
  const n = 20000;
  const seeds = Array.from({ length: n }, (_, i) =>
    makeSeed({
      id: `s${i}`,
      edges: [`edge-${i % 500}`, `edge-${i % 5000}`],
      execTimeMs: 1 + (i % 50),
      recentDiscoveries: i % 7,
    }),
  );
  const scheduler = new FuzzScheduler({ seed: 99, budget: 100000, floorQuota: 1 });
  const start = performance.now();
  const result = scheduler.schedule(seeds);
  const elapsed = performance.now() - start;

  assert.equal(result.allocations.length, n);
  assert.equal(
    result.allocations.reduce((acc, a) => acc + a.quota, 0),
    100000,
  );
  assert.ok(elapsed < 2000, `scheduling took ${elapsed.toFixed(0)}ms`);
});

test('budget changes: shrink below seed count and grow again', () => {
  const scheduler = new FuzzScheduler({ seed: 2, budget: 100 });
  const seeds = Array.from({ length: 10 }, (_, i) =>
    makeSeed({ id: `s${i}`, edges: [`e${i}`] }),
  );

  const full = scheduler.schedule(seeds);
  assert.equal(full.allocations.reduce((acc, a) => acc + a.quota, 0), 100);

  // Budget smaller than n * floorQuota: floor degrades, sum still exact.
  scheduler.setBudget(4);
  const tight = scheduler.schedule(seeds);
  assert.equal(tight.allocations.reduce((acc, a) => acc + a.quota, 0), 4);
  for (const alloc of tight.allocations) assert.ok(alloc.quota >= 0);

  scheduler.setBudget(1000);
  const grown = scheduler.schedule(seeds);
  assert.equal(grown.allocations.reduce((acc, a) => acc + a.quota, 0), 1000);

  scheduler.setBudget(0);
  const zero = scheduler.schedule(seeds);
  assert.ok(zero.allocations.every((a) => a.quota === 0));

  assert.throws(() => scheduler.setBudget(-1), /budget/);
});

test('determinism: same seed reproduces, different seed only moves ties', () => {
  const seeds = Array.from({ length: 8 }, (_, i) =>
    makeSeed({ id: `s${i}`, edges: [`e${i}`] }),
  );
  const run = (seed) =>
    new FuzzScheduler({ seed, budget: 50 })
      .schedule(seeds)
      .allocations.map((a) => a.quota);

  assert.deepEqual(run(42), run(42));
  // Symmetric inputs: every quota differs from the mean by at most one,
  // regardless of how the RNG breaks ties.
  for (const quota of run(1234)) {
    assert.ok(Math.abs(quota - 50 / 8) <= 1.5);
  }
});

test('anti-starvation: idle seeds accumulate boost and recover quota', () => {
  const scheduler = new FuzzScheduler({
    seed: 8,
    budget: 3,
    floorQuota: 0,
    ageWeight: 0.5,
  });
  const strong = makeSeed({ id: 'strong', edges: ['rare'], recentDiscoveries: 10 });
  const weak = makeSeed({ id: 'weak', edges: ['common'], execTimeMs: 500 });

  let weakGotQuota = false;
  for (let round = 0; round < 30; round += 1) {
    const result = scheduler.schedule([strong, weak]);
    if (quotaOf(result, 'weak') > 0) {
      weakGotQuota = true;
      break;
    }
  }
  assert.ok(weakGotQuota, 'weak seed never received quota within 30 rounds');
});

test('explainability: breakdown exposes every score component', () => {
  const scheduler = new FuzzScheduler({ seed: 1, budget: 20 });
  const result = scheduler.schedule([
    makeSeed({ id: 'a', edges: ['x', 'y'], recentDiscoveries: 3, queueAge: 5 }),
    makeSeed({ id: 'b', edges: ['x'], execTimeMs: 40 }),
  ]);
  const a = result.allocations.find((alloc) => alloc.id === 'a');
  const b = a.breakdown;

  assert.deepEqual(Object.keys(b.components).sort(), ['novelty', 'rarity', 'speed']);
  assert.ok(b.ageBoost > 1, 'queueAge contributes to the boost');
  assert.ok(b.energyShare > 0 && b.energyShare < 1);
  assert.equal(a.quota, b.floorQuota + b.energyQuota);
  const expectedBase =
    b.weights.rarity * b.components.rarity +
    b.weights.novelty * b.components.novelty +
    b.weights.speed * b.components.speed;
  assert.ok(Math.abs(b.base - expectedBase) < 1e-12);
});

test('rng: explicit seed is required and reproducible', () => {
  const a = new Rng(123);
  const b = new Rng(123);
  const seqA = Array.from({ length: 5 }, () => a.next());
  const seqB = Array.from({ length: 5 }, () => b.next());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  assert.throws(() => new Rng('nope'), /integer/);
});

test('input validation: rejects malformed seeds and budgets', () => {
  const scheduler = new FuzzScheduler({ seed: 1 });
  assert.throws(() => scheduler.schedule('nope'), /array/);
  assert.throws(() => scheduler.schedule([null]), /object/);
  assert.throws(() => scheduler.schedule([makeSeed()], { budget: -5 }), /budget/);
  // Degenerate numeric fields fall back to safe defaults instead of NaN.
  const result = scheduler.schedule([
    makeSeed({ id: 'bad', execTimeMs: -1, recentDiscoveries: NaN, queueAge: -3 }),
  ]);
  assert.ok(Number.isFinite(result.allocations[0].energy));
});
