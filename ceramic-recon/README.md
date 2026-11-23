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
- `npm test`：Node 内置 test runner，23 个用例（规范化、固定基准、撤回、审计、证据历史与间接阻断、按版本字段回放、旧库升级缺证、崩溃回滚、HTTP 端到端）。
- `npm run demo`：重放固定基准，并在加入 5 万条无关记录前后执行同一串 20 次小批变更，输出可核对归组与工作量（含新增证据事件数）。

## 数据模型

- `record_versions`：来源记录的版本链（同一 `source+id` 自增 `seq`），撤回给对应版本打 `withdrawn_at`。整条更正发布后，**只采用未撤回的最新版本**。
- `heterology_edges`：异件判定（两端必须分属不同来源），可撤回。
- `batches`：所有导入/更正/判异/撤回批次及撤回状态，馆员可撤回任一导入批次或异件判定，其余有效提交继续参与。
- `block_name` / `block_mark`：按规范化品名、刻款维护的分块索引，支撑增量发布按索引定位候选而不扫描全库。
- `live_groups` / `live_members`：最新**完整发布**的物化当前态，所有查询只读到这里，未发布的工作区变更不可见。
- `group_events` / `membership_events` / `evidence_events`：只追加的历史事件，支持按版本回放、审计合并/拆分依据、旧馆藏逐条追查。
  - `evidence_events` 只记**发生变化的边**：每条边在某版的有效证据 = `version ≤ 该版` 的最新事件，因此证据历史不随无关发布增长。`outcome` 为 `joined`（实际促成归并，`contributed=true`）/ `cut`（被拒匹配边）/ `removed`（边消失或低于阈值）。
  - `cut` 行同时记录阻断它的判异批次：`block_kind=direct`（该边两端就被判异）或 `indirect`（合并会使另一条有效异件判定两端同组），`block_batches` 给出当时起作用的异件对与批次编号。
- `group_evidence_state`：每个馆藏证据历史被完整跟踪的起始版本。升级前已存在、未被完整跟踪的馆藏，其旧版解释标为缺证（`evidenceStatus.complete=false`），但仍可查询。
- `publications` / `recompute_log`：发布版本元数据与每次发布的工作量（读取来源记录数、匹配比较数、新增历史馆藏行数、**新增证据事件数**）。`publications.format_version` 标记该版是否具备完整证据历史（旧库迁移后既有版本为 1）。
- `group_lineage`：每个馆藏编号的诞生/关闭版本；成员未变的馆藏沿用原编号。新编号取自已分配最大编号之后（不依赖序列，迁移/重启后不会冲突）。

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
| GET | `/groups/:gid?atVersion=:v` | 单人馆藏复核：实际促成归并的匹配边、与该馆藏成员相接的被拒匹配边及阻断它的判异批次；可指定历史版 |
| GET | `/records/:source\|:id` | 单条记录当前归属；已撤回返回 `status=withdrawn` |
| GET | `/versions` | 发布版本列表与工作量（含 `evidenceComplete`） |
| GET | `/versions/:v` | 任一版的馆藏、字段出处、合并/拆分依据、逐馆藏证据解释与被剪开边 |
| GET | `/audit/groups/:gid?atVersion=:v` | 旧馆藏逐条成员的当前归属/撤回状态与跨版本归属链，附该版证据解释 |
| GET | `/audit/workload` | 每次发布的工作量（含新增证据事件数 `evidence_changes`） |
| GET | `/audit/lineage` | 馆藏编号诞生/关闭版本 |
| GET | `/health` | 健康检查与当前版本号 |

`/groups/:gid` 响应中的证据解释（`/records/:source|:id`、`/versions/:v` 同样给出）：

- `contributingEdges`：该馆藏内**实际促成归并**的匹配边（`contributed=true`），附置信度与各字段相似度。
- `rejectedEdges`：与该馆藏成员相接、但被拒的匹配边；`blockKind=direct/indirect`；`blockedBy.pairs` 与 `blockedByBatches` 给出**当时阻断它的判异批次**，间接阻断也可核查。
- `evidenceStatus.complete`：false 表示该版/该馆藏升级前无法证实的部分（缺证），`reasons` 说明原因；此类历史仍可查询。

证据解释按版本回放：某版某条边的有效证据取该版及之前的最新事件。因此馆藏编号沿用、后续证据消失或判异撤回后，各版解释都按**当时结果**显示。

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

## 增量与规模无关性

每次发布只重算受影响子图：

1. 由 outbox 得到变更键，异件边端点纳入；
2. 沿上一版馆藏做组件闭包扩展；
3. 经分块索引取出共享品名/刻款的候选（无关分块完全不读）；
4. 只在受影响子图内比较、分区；无关馆藏的 `live_*` 行原样保留。

因此小批变更的**读取来源记录数、匹配比较数、新增历史馆藏数据量、新增证据事件数只取决于受影响组件大小，不随全库规模增长**。演示在干净库与含 5 万无关记录的大库上执行同一串 20 次变更，工作量逐次完全相同。

证据历史同样按增量维护：每次发布只读取“至少一端落在受影响子图内”的边的最新快照，只追加**发生变化的边**。单馆藏复核（`/groups/:gid`、`/audit/groups/:gid`）按该馆藏成员过滤后取每边最新事件，读取量只随该馆藏相关边增长，不随无关发布增长（测试断言无关发布前后 `historyRowsRead` 不变）。

## 崩溃恢复

所有写操作与发布在单个数据库事务内提交。发布在提交前崩溃会整体回滚（含当版证据事件与新馆藏编号），用同一数据库文件重启后，当前馆藏、版本号、解释与审计事件保持崩溃前一致；工作区变更仍在，重新发布成功后才可查到对应新版的证据解释（见测试“发布中断重启后解释一致”）。

## 固定基准（演示与测试重放）

- 登记 A「青釉梅瓶」、修复 B 与旧清册 C「青釉梅缾」，均甲款，高度 20 / 20 / 20.4cm，B 材质瓷 ⇒ 三条同组；
- 判 A 与 C 异件 ⇒ 拆为 AB 与 C；
- B 更正为乙款、8cm 黑釉茶盏、材质炻器；C 更正材质为陶 ⇒ B 脱离，C 仍保留原品名/刻款/高度且材质为陶；
- 撤回 B 的更正 ⇒ 恢复 AB 与 C，AB 材质瓷、C 仍陶；
- 撤回异件判定 ⇒ 三条重新同组。
