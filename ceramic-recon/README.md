# 陶瓷馆藏核对服务

市博物馆陶瓷馆藏核对的本地 HTTP 服务。数据来自三类来源，各自按本来源编号记录：

| source | 来源 | 说明 |
| --- | --- | --- |
| `registry` | 登记 | 品名优先取此来源 |
| `repair` | 修复记录 | 材质优先取此来源 |
| `inventory` | 旧清册 | 历史清册 |

技术栈：Node.js（CommonJS，JSDoc 类型注解）+ TypeScript `checkJs` 静态检查 + DuckDB 嵌入式库，全部数据保存在一个本地 `.duckdb` 文件，无需外部服务。

## 启动

```bash
npm install
npm start                 # 默认数据库 ./data/ceramic.duckdb，端口 8080
PORT=9000 CERAMIC_DB=/tmp/m.duckdb npm start
```

## 一条命令跑类型检查、测试与演示（要求 80 秒内）

```bash
npm run all
```

- `npm run typecheck`：TypeScript 对 `src/`、`scripts/` 做严格空值检查（不产出文件）。
- `npm test`：Node 内置 test runner，25 个用例（规范化、固定基准、撤回、审计、合并/拆分统计、逐边裁决、旧库升级、崩溃回滚、HTTP 端到端）。
- `npm run demo`：重放固定基准，并在加入 5 万条无关记录前后执行同一串 20 次小批变更，输出可核对归组与四项工作量（含审计增量）。

## 数据模型

- `record_versions`：来源记录的版本链（同一 `source+id` 自增 `seq`），撤回给对应版本打 `withdrawn_at`。整条更正发布后，**只采用未撤回的最新版本**。
- `heterology_edges`：异件判定（两端必须分属不同来源），可撤回。
- `batches`：所有导入/更正/判异/撤回批次及撤回状态，馆员可撤回任一导入批次或异件判定，其余有效提交继续参与。
- `block_name` / `block_mark`：按规范化品名、刻款维护的分块索引，支撑增量发布按索引定位候选而不扫描全库。
- `live_groups` / `live_members`：最新**完整发布**的物化当前态，所有查询只读到这里，未发布的工作区变更不可见。
- `group_events` / `membership_events` / `evidence_events`：只追加的历史事件，支持按版本回放、审计合并/拆分依据、旧馆藏逐条追查。
- `publications` / `recompute_log`：发布版本元数据与每次发布的工作量（读取来源记录数、匹配比较数、新增历史馆藏行数）。
- `group_lineage`：每个馆藏编号的诞生/关闭版本；成员未变的馆藏沿用原编号。

## 匹配规则（固定公开）

1. **规范化**：NFKC、去空白、转小写；异体字归一（如 `缾/甁 → 瓶`、`盞 → 盏`）。
2. **分块**：仅当规范化品名相同或规范化刻款相同，才进入候选比较，避免全库两两比较。
3. **相似度**：
   - 文本（品名、刻款）用编辑距离 `1 - distance/maxLen`；
   - 高度：差 ≤ 0.5cm 记 1，0.5–2cm 线性衰减，> 2cm 记 0；
   - 加权置信度：品名 0.6、刻款 0.2、高度 0.2，缺字段则按现有权重重归一化；
   - 置信度 ≥ **0.7** 判定为匹配。
4. **证据可串联归并**：匹配边可传递（A≈B、B≈C 则三者同组）。
5. **冲突按置信度优先**：匹配边按置信度降序处理；**同分固定规则**——按“边的最小端点编号降序，再最大端点编号降序”，再用并查集合并。
6. **异件判定凌驾匹配**：异件对的匹配边直接剪开；若合并会使某条有效异件判定两端同组，则跳过该边。异件两端因此必属不同馆藏。
7. 有效证据与判异相同 ⇒ 归组一致（纯函数、确定性，可复算）。

## 字段取值与出处（固定公开）

每个馆藏的展示字段按来源优先级取第一个非空值，**空值让位给有效值**：

| 字段 | 优先级（高 → 低） |
| --- | --- |
| 品名 name | registry → repair → inventory |
| 刻款 mark | registry → repair → inventory |
| 材质 material | repair → registry → inventory |
| 高度 height | registry → repair → inventory |

查询结果同时返回 `fieldSources`，标明每个字段实际取自哪个来源。

## HTTP 接口

所有写接口都是一个事务；变更先进工作区，调用 `POST /publications` 后才形成完整发布，查询随后读到新版本。

### 写操作

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/batches/imports` | 分批导入来源记录 |
| POST | `/batches/corrections` | 整条更正（未给字段继承当前有效版本，显式给值才覆盖） |
| POST | `/batches/heterologies` | 异件判定（两端须不同来源） |
| POST | `/batches/withdrawals` | 撤回任一导入/更正/判异批次 |
| POST | `/publications` | 发布当前工作区，产出新版本 |

导入请求体：

```json
{
  "batchId": "bA",
  "source": "registry",
  "records": [
    { "id": "A", "name": "青釉梅瓶", "mark": "甲款", "material": null, "height": 20 }
  ]
}
```

更正请求体（`fields` 只写需要改的字段，其余继承）：

```json
{ "batchId": "cB", "source": "repair", "id": "B",
  "fields": { "name": "黑釉茶盏", "mark": "乙款", "material": "炻器", "height": 8 } }
```

判异请求体：

```json
{ "batchId": "hAC", "source1": "registry", "id1": "A", "source2": "inventory", "id2": "C" }
```

撤回请求体：`{ "batchId": "cB" }`。

### 查询与审计（只读完整发布）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/groups` | 当前全部馆藏、成员、字段与出处 |
| GET | `/groups/:gid` | 单个馆藏及匹配证据 |
| GET | `/records/:source\|:id` | 单条记录当前归属；已撤回返回 `status=withdrawn` |
| GET | `/versions` | 发布版本列表与工作量 |
| GET | `/versions/:v` | 任一版的馆藏、字段出处、合并/拆分统计、逐边裁决（见下） |
| GET | `/audit/groups/:gid?atVersion=:v` | 旧馆藏逐条成员的当前归属/撤回状态与跨版本归属链 |
| GET | `/audit/workload` | 每次发布的四项工作量（含审计行数） |
| GET | `/audit/lineage` | 馆藏编号诞生/关闭版本 |
| GET | `/health` | 健康检查与当前版本号 |

`/groups` 响应示例：

```json
{
  "published": true,
  "version": 2,
  "groups": [
    {
      "gid": "G000003",
      "members": ["registry|A", "repair|B"],
      "fields": { "name": "青釉梅瓶", "mark": "甲款", "material": "瓷", "height": 20 },
      "fieldSources": { "name": "registry", "mark": "registry", "material": "repair", "height": "registry" }
    }
  ]
}
```

### `/versions/:v` 核对本次发布

馆员用 `/versions/:v` 核对第 `v` 版（相对第 `v-1` 版）的合并与拆分数量。所有依据都由**只追加事件**（`group_events` / `membership_events` / `evidence_events` / `heterology_events`）回放，撤回判异或在同一数据库重开局后仍可复核旧版本。

- **合并/拆分按成员去向统计**（`mergeSplit`）：
  - **合并**：某新馆藏的成员来自 ≥2 个旧馆藏；
  - **拆分**：某旧馆藏的幸存成员流向 ≥2 个新馆藏；
  - **扩员**（整组吸收全新记录）或**仅撤回成员**（幸存者仍聚在一起）都**不算拆分**；
  - 交叉重组（旧馆藏被拆到多处，新馆藏又由多处汇入）**可同时计入两类**。
  - 每个馆藏另带 `lineageBasis.kind`：`new` / `unchanged` / `expanded` / `contracted` / `changed` / `merge` / `split` / `merge+split`。
- **明细可独立复算**：`groups[].lineageBasis.predecessors`（来自哪些旧馆藏、共享哪些成员）、`mergeSplit.merges[].contributors`、`mergeSplit.splits[].destinations` 与 `affectedKeys` 列出全部依据键；`edgeOrder` 给出每条匹配边的处理次序与裁决，按其 `seq` 逐边做并查集（`connected` 合并、`redundant`/`cut` 不合并）即可独立重现归组。
- **逐边裁决**（`edges`）区分：
  - `connected`：实际连通（该边第一次把两个组件合并）；
  - `redundant`：冗余匹配（两端此前已同组，成环，不改变归组）；
  - `cut`：被异件判定拦下，带 `blockedByBatch`（哪个判异批次拦下）、`blockedPair`（会冲突的异件对）与 `reason`。
  - `heterology` 为当版有效异件判定快照（`k1/k2/batch_id`）。
- **旧库缺失标注**：升级前的版本在库中没有逐边区分与判异快照，`audit.missing` 会逐项列出无法可靠还原的依据（如 `edgeDisposition`、`heterologyBasis`），绝不臆造；旧证据归入 `edges.unknown` 并保留原始 `legacyOutcome`。升级后新发布的版本 `audit.complete=true`。
- **规模无关**：审计增量（`recompute_log.audit_rows`）只覆盖受影响子图，加入无关馆藏后同一小批变更的审计行数保持逐次不变。

## 增量与规模无关性

每次发布只重算受影响子图：

1. 由 outbox 得到变更键，异件边端点纳入；
2. 沿上一版馆藏做组件闭包扩展；
3. 经分块索引取出共享品名/刻款的候选（无关分块完全不读）；
4. 只在受影响子图内比较、分区；无关馆藏的 `live_*` 行原样保留。

因此小批变更的**读取来源记录数、匹配比较数、新增历史馆藏数据量与审计行数只取决于受影响组件大小，不随全库规模增长**。演示在干净库与含 5 万无关记录的大库上执行同一串 20 次变更，四项逐次完全相同。

## 崩溃恢复

所有写操作与发布在单个数据库事务内提交。发布在提交前崩溃会整体回滚，用同一数据库文件重启后，当前馆藏、版本号与审计事件保持崩溃前一致；工作区变更仍在，重新发布即可正常完成（见测试“发布中断回滚”）。

## 固定基准（演示与测试重放）

- 登记 A「青釉梅瓶」、修复 B 与旧清册 C「青釉梅缾」，均甲款，高度 20 / 20 / 20.4cm，B 材质瓷 ⇒ 三条同组；
- 判 A 与 C 异件 ⇒ 拆为 AB 与 C；
- B 更正为乙款、8cm 黑釉茶盏、材质炻器；C 更正材质为陶 ⇒ B 脱离，C 仍保留原品名/刻款/高度且材质为陶；
- 撤回 B 的更正 ⇒ 恢复 AB 与 C，AB 材质瓷、C 仍陶；
- 撤回异件判定 ⇒ 三条重新同组。
