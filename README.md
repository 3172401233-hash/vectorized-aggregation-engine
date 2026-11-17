# vectorized-aggregation-engine

JavaScript 向量化聚合执行器：以**列批次（columnar batch）**为输入，通过 selection
vector、null bitmap 和开放寻址哈希分组表执行 `COUNT` / `SUM` / `MIN` / `MAX`，
在内存超预算时把分组状态写入 spill 分区文件，并支持撤回（retraction）更新。

所有结果与一个刻意逐行、逐虚调用的参考执行器 `ReferenceAggregation` 做差分校验。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `src/column.js` | selection vector 展开、null bitmap / nulls 数组解码 |
| `src/hash.js` | 确定性 64 位混合哈希、严格类型键相等（哈希冲突回退比较） |
| `src/table.js` | 开放寻址 + 线性探测哈希分组表，并行数组存储槽位元数据 |
| `src/states.js` | COUNT/SUM/MIN/MAX 状态机，撤回与状态合并共用同一语义 |
| `src/spill.js` | 分区 spill 文件的二进制帧编码、按需取回与合并 |
| `src/operator.js` | 列式算子主入口，两趟批次处理与最终结果输出 |
| `src/reference.js` | 逐行参考执行器（测试基准） |
| `test/` | node:test 测试与随机差分 fuzz |

## 安装与测试

```bash
node --test
# 或
npm test
```

无第三方运行时依赖，要求 Node.js >= 20（使用 ESM、`node:test`、`BigInt64Array`）。

## 列批次输入格式

`addBatch(batch)` 接收一个普通对象：

```js
{
  rowCount: 1024,                 // 可选；缺省取第一列 data.length
  sel: Uint32Array,              // 可选 selection vector，物理行号
  retract: Uint8Array | true,    // 可选撤回标志：逐行字节数组，或整批撤回
  columns: {
    order_id: {
      type: 'int32',             // int32 | int64 | float64 | string | boolean
      data: Int32Array,          // 类型化数组（string/boolean 用普通数组）
      bitmap: Uint8Array,        // 可选：打包位图，bit=1 表示非 NULL
      nulls: Uint8Array,         // 可选：与位图二选一，逐字节 1 表示 NULL
    },
    amount: { type: 'int64', data: BigInt64Array, bitmap: Uint8Array },
    price:  { type: 'float64', data: Float64Array },
  },
}
```

约定：

- **selection vector**：`sel` 存物理行号，所有 null 数组与位图均按物理行号存储；
  算子在入口把它们解码成与 `sel` 对齐的 `Uint8Array`，热循环内只做 O(1) 查表。
  缺省 `sel` 表示参与全部行。
- **NULL 编码二选一**：打包 bitmap（小端，每字节 8 行，bit=1 为非 NULL）或
  逐字节 `nulls`（1 为 NULL）。列上没有任一字段时视为全部非 NULL。
- **Int64** 列的 `data` 必须是 `BigInt64Array`，值为 `BigInt`。
- **撤回**：`retract` 为 `Uint8Array` 时按行标记（1 = 撤回此前插入的同键同值行），
  为 `true` 时整批均为撤回。算子必须以 `retractable: true` 构造，否则收到撤回行
  会立即抛错。

## 聚合计划

```js
const plan = {
  groupKeys: ['region', 'segment'],          // 空数组或缺省 = 全局聚合
  aggregates: [
    { func: 'count', name: 'rows' },          // COUNT(*)，column 缺省
    { func: 'count', column: 'amount', name: 'non_null_amount' },
    { func: 'sum',   column: 'amount', name: 'sum_amount' },
    { func: 'min',   column: 'price', name: 'min_price' },
    { func: 'max',   column: 'price', name: 'max_price' },
  ],
};

const operator = new AggregationOperator(plan, {
  retractable: false,
  memoryBudgetBytes: 8 * 1024 * 1024, // 内存上限，Infinity 表示永不 spill
  spillPartitions: 4,                 // 必须是 2 的幂，默认 4
  spillDirectory: '/var/tmp/agg',     // 可选，缺省使用 os.tmpdir() 唯一目录
  forceHashCollisions: false,         // 测试开关：强制所有组哈希相同
});

for (const batch of stream) operator.addBatch(batch);
const rows = operator.finish();
// [{ keys: ['east', 'smb'], aggregates: { rows: 12n, sum_amount: 340n, ... } }, ...]
```

输出按组键排序（NULL 排在最前），`keys` 与计划的 `groupKeys` 同序。

## 语义说明

- `COUNT(*)` 统计所有行；`COUNT(column)` 跳过该列 NULL 行。
- `SUM/MIN/MAX` 全部跳过 NULL 输入；组内全为 NULL 时 `MIN/MAX` 返回 `null`、
  `SUM` 返回 `0`（整数为 `0n`）。
- 整数 `SUM` 状态统一提升为 **BigInt**，`Int32` 与 `Int64` 求和都不会溢出；
  `Float64` 的 `SUM` 保持 `Number`。
- 分组键严格区分类型：`1`、`1n`、`"1"` 是三个不同的组；`null` 键彼此相等，
  形成一个 NULL 分组。
- 分组聚合中净行数归零的组在结果里删除；全局聚合保留该组并输出零值。

## 执行模型（两趟批次处理）

1. **第一趟 — 定位/建组**：为 selection vector 中每行计算哈希并探测分组表，
   产出一个 `Uint32Array` 槽位向量。新组在超预算时触发 spill flush，随后
   从头重跑本趟；因为此时新表没有任何状态，重放不会重复计数。若该键此前已被
   spill，先从分区文件把历史状态取回内存再继续。
2. **第二趟 — 向量化更新**：遍历槽位向量更新状态，聚合函数指针在行间循环外
   提升，NULL 判断与撤回判断均为内联分支，避免逐行虚调用与逐行对象分配。

哈希冲突走线性探测，并以 `hash.js` 的严格键相等做“分组回退”比较；
`forceHashCollisions: true` 可强制所有组共享哈希以专门覆盖该路径。

## 内存上限与 spill

- 每个活动分组按 `96 + 48 * 聚合数` 字节加上字符串/标量键的估算长度计费，
  实时累计在 `table.memoryBytes`。
- 插入新组会使累计值超过 `memoryBudgetBytes` 时，把当前整张分组表写入
  `spillPartitions` 个分区文件（分区号取哈希低位，同组永远落在同一分区），
  然后清空内存表并继续处理后续批次。
- 单个分组本身超过预算时，flush 一次后强制保留，不会无限 flush。
- 后续批次遇到已 spill 的组会按需把该组从分区文件**取回**，因此撤回、MIN/MAX
  极值删除等更新与无 spill 时完全等价。
- `finish()` 把残余内存表并入分区，再逐分区读出、按键合并，产出与
  `ReferenceAggregation` 一致的结果，最后删除 spill 目录。
- spill 帧为小端二进制：帧版本、净行数、组键（带类型标签，Int64 用
  `BigInt64`）、各聚合状态；可撤回的 MIN/MAX 以值频次表完整序列化。

## 撤回（retraction）

以 `retractable: true` 构造后：

- `COUNT/SUM` 直接做反向加减。
- `MIN/MAX` 维护“值 -> 频次”映射，撤回当前极值时从剩余频次重算极值；
  普通（不可撤回）模式只保留标量极值，零额外分配。
- 撤回与插入可在同一批次、同一组内交错，spill 往返后语义不变。

## 测试覆盖

`node --test` 覆盖：空批次与空 selection、全 NULL 分组、Int32/Int64 溢出、
严格键类型、自然与强制哈希冲突、线性探测扩容、逐行与整批撤回、极值撤回重算、
spill 多轮 flush 与文件往返、spill 目录清理，以及 25 组随机场景的
列式/逐行差分 fuzz（含随机 NULL、selection、撤回与内存预算）。
