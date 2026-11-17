# fuzz-scheduler-policy

JavaScript Fuzz 调度策略库：根据每个 seed 的覆盖率指纹、执行耗时、近期发现次数和队列年龄，
计算下一轮执行配额（energy）。稀有边与近期新覆盖获得更高能量，同时通过保底配额和
空闲轮次加成防止老 seed / 慢执行被无限饥饿。所有随机性都来自显式种子，结果可复现。

## 安装与测试

```bash
npm test        # 等价于 node --test
```

无第三方依赖，要求 Node.js >= 18（使用 `node:test`）。

## 快速上手

```js
const { FuzzScheduler } = require('./src');

const scheduler = new FuzzScheduler({
  seed: 42,        // 显式随机种子，相同输入必然复现相同配额
  budget: 1000,    // 本轮总执行配额
  floorQuota: 1,   // 每个 seed 的保底执行次数（预算不足时自动退化为 0）
  ageWeight: 0.25, // 空闲/排队轮数对能量的加成强度
});

const result = scheduler.schedule([
  { id: 'a', edges: ['e1', 'e2'], execTimeMs: 4,  recentDiscoveries: 3, queueAge: 0 },
  { id: 'b', edges: ['e1'],       execTimeMs: 40, recentDiscoveries: 0, queueAge: 12 },
]);

for (const alloc of result.allocations) {
  console.log(alloc.id, alloc.quota, alloc.breakdown.components);
  // => 每个 seed 的 rarity / novelty / speed 分量、ageBoost、能量份额、保底与配额的拆分
}
```

跨多轮复用同一个 `scheduler` 实例时，内部会跟踪每个 seed 的空闲轮数
（`roundsSinceSelected`），长期未被执行的 seed 会累积 `ageBoost` 最终重新获得配额。
`setBudget(n)` 可在运行中调整预算；`reset()` 清空调度状态。

## 调度模型

每个 seed 的能量为：

```
base   = wR * rarity + wN * novelty + wS * speed
energy = (base + epsilon) * (1 + ageWeight * log(1 + idleRounds + queueAge))
```

- **rarity**：取该 seed 指纹中"最稀有边"的稀有度，边稀有度为 `1 / (1 + ln(hits))`，
  `hits` 为覆盖该边的 seed 数。取最大值而非平均值，避免大量常见边稀释一条唯一边。
- **novelty**：`log1p(recentDiscoveries)` 按语料最大值归一；全部为零时该分量安全退化。
- **speed**：`minExecTime / execTimeMs`，越快能量越高，限制在 `[0, 1]`。
- **配额分配**：先发放 `floorQuota` 保底，剩余预算按能量占比用最大余数法取整，
  并列时由种子化 RNG（mulberry32）确定性打破。

## 模型局限

- **静态边视角**：稀有度按"覆盖该边的 seed 数"估计，不感知边的真实语义价值；
  一条被所有 seed 覆盖的关键路径边与一条无关紧要的常见边得分相同。
- **无反馈回路**：模型假设调用方如实回报 `recentDiscoveries`；它本身不维护覆盖率
  位图，也无法检测某条边是否已被"刷爆"（同一 seed 反复命中不增加其稀有度）。
- **max 聚合的副作用**：rarity 取最稀有边意味着"一条稀有边 + 大量垃圾边"的臃肿
  seed 不会被惩罚；如需惩罚大指纹，可在上层按边数缩减 `execTimeMs` 之外的输入。
- **速度代理粗糙**：`speed` 只用平均耗时，忽略执行耗时的方差与超时风险；
  慢但高产的 seed 仍可能被长期压低（仅靠 `ageBoost` 与保底兜底）。
- **配额是比例而非优先级**：输出为整数执行次数，不保证执行顺序；需要优先级队列的
  fuzzer 需自行按 `energy` 排序消费。
- **确定性不等于公平**：相同输入复现相同配额是特性，但 RNG 只用于并列打破，
  不提供探索性随机重启；长期收敛行为依赖 `ageWeight` / `floorQuota` 的调参。
- **单目标**：不建模 crash 去重、功耗或分布式 worker 均衡，多机场景需在上层
  先切分预算再分别调用。
