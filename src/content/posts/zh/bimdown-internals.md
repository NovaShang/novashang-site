---
title: "BimDown 内部机制：从 CSV+SVG 到几何推理引擎的工程实现"
description: "BimDown 系列的续篇，只讲实现：Schema 继承、CSV+SVG 合成为 DuckDB 表、用 DCEL 推导房间边界、重建 MEP 拓扑，以及与 Revit 的增量回写。"
pubDate: 2026-04-06
tags: ["技术", "BIM", "AI"]
lang: zh
---

[前一篇](/zh/posts/bimdown-format/)讲了为什么选 CSV+SVG 做 AI-native BIM 格式。这篇只讲实现细节：从一堆分散的 CSV/SVG 文件，到一个可以被 LLM 用 SQL 查询、能自动推导房间边界、能解析 MEP 拓扑的建筑图数据库，中间发生了什么。

## 一、Schema 的 YAML 继承系统

BimDown 没有硬编码 schema。`spec/csv-schema/` 下是一组 YAML 文件，支持继承：

```
base/
  element.yaml                 # id, name, level_id, mesh_file
  materialized.yaml            # extends element + material
  line_element.yaml            # extends materialized + computed: length, start_x/y, end_x/y
  hosted_element.yaml          # extends element + host_id, position
architecture/
  wall.yaml                    # extends line_element + thickness, height
  door.yaml                    # extends hosted_element + width, height, operation
```

每个 schema 声明 `extends: base/line_element` 和自己独有的字段。`resolveFields()` 做一次拓扑排序，按继承链合并，结果是一张扁平字段表：

```typescript
registry.set('wall', {
  prefix: 'w',
  csvFields: [id, name, level_id, material, thickness, height, ...],
  computedFields: [length, start_x, start_y, end_x, end_y],  // 从 SVG 算
});
```

`csvFields` 是 CSV 的列，`computedFields` 是需要从 SVG 几何里提取的。这个分离是 hydrate 阶段的基础。

## 二、Hydrate：CSV + SVG → DuckDB 的列合成

核心挑战：CSV 和 SVG 是两种完全不同的数据形态，但在 SQL 查询里必须表现为一张表。

`hydrate()` 的实现（`cli/src/duckdb/hydrate.ts`）分三步：

### Step 1. CSV union 到表

每个 element type 在多个 level 目录下都有一份 CSV（`lv-1/wall.csv`, `lv-2/wall.csv`, ...）。全部读出，加一列 `_partition` 记录来源目录，union 到一张 `wall` 表：

```typescript
for (const { dir: dirName, fullPath } of csvFiles) {
  const data = readCsv(fullPath);
  for (const row of data.rows) {
    allRows.push({ ...row, _partition: dirName });
  }
}
```

### Step 2. SVG 几何提取

遍历所有 level 的 `wall.svg`，解析每个 `<path>` / `<rect>` / `<polygon>` / `<circle>`，按 SVG element 的 `id` 属性索引：

```typescript
const geometries = new Map<string, Record<string, number | string>>();
for (const el of svg.elements) {
  if (el.tag === 'path') geometries.set(el.id, extractLineGeometry(el));
  else if (el.tag === 'rect') geometries.set(el.id, extractRectGeometry(el));
  // ...
}
```

`extractLineGeometry` 对 `<path d="M 0,0 L 10,0">` 算出 `{start_x: 0, start_y: 0, end_x: 10, end_y: 0, length: 10}`。注意这里只支持 M/L/A 命令，不支持贝塞尔曲线，因为 LLM 对贝塞尔控制点做不出稳定的空间推理。

### Step 3. 动态 ALTER TABLE 注入几何列

```typescript
for (const col of allKeys) {
  const sqlType = col === 'points' ? 'VARCHAR' : 'DOUBLE';
  await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "${col}" ${sqlType}`);
}
for (const [id, geo] of geometries) {
  await runQuery(conn, `UPDATE "${tableName}" SET ${sets} WHERE id = ${escapeSql(id)}`);
}
```

结果：`wall` 表同时有 CSV 的 `material, thickness`，又有 SVG 合成出来的 `length, start_x, start_y, end_x, end_y`。LLM 写 `SELECT id, length FROM wall WHERE thickness > 0.3` 时，`length` 列是**运行时合成的**：CSV 里根本没有这个字段。

这个设计的一个副作用是 schema 即文档：`bimdown schema wall` 会同时列出 CSV 字段和 computed 字段，LLM 一眼就知道哪些能查。

## 三、房间边界计算：DCEL 半边结构

BimDown 的 space（房间）在 CSV 里只存一个种子点 `(x, y)` 和名字。真正的房间多边形边界是 `bimdown build` 命令算出来的。算法核心是 **DCEL（Doubly-Connected Edge List）半边结构**。

- **输入**：所有 `wall.svg` / `structure_wall.svg` / `curtain_wall.svg` / `room_separator.svg` 里的线段
- **输出**：每个 space 种子点对应的最小围合多边形

### Phase 1. 顶点吸附

两条墙的端点如果差距 < 1cm，视为同一顶点：

```typescript
function findOrCreateVertex(x: number, y: number): Vertex {
  for (const v of vertices) {
    if (Math.abs(v.x - x) < TOLERANCE && Math.abs(v.y - y) < TOLERANCE) return v;
  }
  // 新建...
}
```

O(n²) 的朴素实现，实际建筑几千个节点够用。如果要优化就加一个空间哈希网格。

### Phase 2. 半边构造

每条墙生成两条相反方向的半边（he1 和 he2），它们互为 twin：

```
墙 w-1 从 A 到 B:
  he1: A → B  (属于 w-1 左侧的 face)
  he2: B → A  (属于 w-1 右侧的 face)
```

### Phase 3. 极角排序 + next 指针

DCEL 的关键是给每个半边链接 `next`：从当前半边的终点继续走，下一条半边是谁？

在每个顶点 v，把所有 outgoing 半边按极角排序。对于到达 v 的半边 `he`，它的下一条（同属一个 face）是 `he.twin` 在 outgoing 列表中前一位：

```typescript
for (const he of halfEdges) {
  const v = he.to;
  const twinIdx = v.outgoing.indexOf(he.twin);
  const prevIdx = (twinIdx - 1 + v.outgoing.length) % v.outgoing.length;
  he.next = v.outgoing[prevIdx];
}
```

这个 "twin 的前一个 CW 邻居" 的规则是 DCEL 的经典操作，等价于"沿着 face 的边界左转"。

### Phase 4. Face tracing

从每条未访问的半边出发，沿 next 走到回到起点，得到一个闭合多边形。用 shoelace 公式算 signed area：

- **正面积** = CCW 绕向 = 内部房间
- **负面积** = CW 绕向 = 外部包络面

```typescript
do {
  current.visited = true;
  polygon.push({ x: current.from.x, y: current.from.y });
  current = current.next;
} while (current !== startHe);

let signedArea = 0;
for (let i = 0; i < polygon.length; i++) {
  const j = (i + 1) % polygon.length;
  signedArea += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
}
signedArea /= 2;
```

### Phase 5. 种子点匹配

每个 space 种子点 `(seed_x, seed_y)` 做 point-in-polygon 测试，匹配**包含它的最小正面积 face**：

```typescript
for (const face of faces) {
  if (face.signedArea <= 0) continue;  // 跳过外部 face
  if (face.signedArea < bestArea && pointInPolygon(seedX, seedY, face.polygon)) {
    bestFace = face;
    bestArea = face.signedArea;
  }
}
```

“最小面积”很重要：走廊套房间的情况下，seed 会同时落在走廊和某个房间内，我们要的是最内层那个。

产物写回 `space.svg` 作为 polygon，然后 hydrate 阶段再把 `area` 字段注入到 space 表。整个链路：**CSV 种子点 → 几何算法 → SVG 多边形 → SQL 可查的 area 字段**。

## 四、MEP 拓扑解析：自由端点 + bbox 包含

风管、水管、桥架、线管（CURVE_TABLES）和设备、末端（NODE_TABLES）之间的连接关系，在 Revit 里是显式 connector，但导出时会丢。`bimdown resolve-topology` 的任务是重建这张**二部图**。

### Phase 1. 收集自由端点

遍历所有曲线的 SVG 几何，得到每条曲线的 start/end 3D 点（z 从 CSV 的 elevation 字段取）。**自由端点** = 没有被同系统的其他曲线连上的端点：

```typescript
interface CurveEndpoint {
  curveId: string;
  side: 'start' | 'end';
  point: Point3D;
  systemType: string;
}
```

曲线之间如果两个端点在 1cm 容差内重合，自动生成一个 `mep_node` 占位节点连接它们。

### Phase 2. 节点的 bbox 包含判断

设备有宽高（从 CSV 的 width/height/length 读），视为一个带体积的 bbox。对每个自由端点，查找**包含它的最近节点**：

```typescript
function insideBBox(point: Point3D, node: NodeEntry): boolean {
  const dz = Math.abs(point.z - node.pos.z);
  if (dz > TOLERANCE) return false;
  const dx = Math.abs(point.x - node.pos.x);
  const dy = Math.abs(point.y - node.pos.y);
  return dx <= node.halfW + TOLERANCE && dy <= node.halfH + TOLERANCE;
}
```

为什么是 bbox 而不是距离？因为末端设备（散流器、插座）的连接点可能落在设备体内任意位置。Revit 的 connector 本来就有 offset，导出时我们不知道 offset 的方向。bbox 包含是保守但可靠的启发式。

### Phase 3. 写回 CSV

匹配成功的连接关系直接更新到曲线 CSV 的 `start_node_id` / `end_node_id` 列。没匹配上的自由端点会在警告里报出，让人/LLM 手动处理。

这个流程体现了 BimDown 的一个工程哲学：**拓扑是可推导的，不应该成为 CSV 的一等字段**。如果让人手写 `start_node_id`，他们会写错；如果让 LLM 写，它会幻觉。让几何说话最可靠。

## 五、Dehydrate：DuckDB → CSV/SVG 的回写

Hydrate 的反向操作。两个微妙点：

**1. 不要回写 computed 字段**。`length`, `start_x`, `area` 这些是从 SVG 派生的，回写到 CSV 会造成双真相。dehydrate 用 `table.csvFields` 过滤掉 computed 字段，只序列化原始列。

**2. `_partition` 列决定去向**。每一行根据自己的 `_partition` 值，被写回对应的 `lv-N/wall.csv`。这让 LLM 在 DuckDB 里做 `UPDATE wall SET thickness = 0.3 WHERE material = 'concrete'` 之后，`bimdown sync` 能精确地回到正确的文件。

## 六、Revit round-trip 的 ID Map

`global/_IdMap.csv` 是 BimDown ID ↔ Revit ElementId 的映射。这个文件在 git 里一起 commit。

```csv
bimdown_id,revit_element_id,element_type
w-1,123456,wall
d-1,234567,door
```

导入 Revit 时插件流程：

1. 读 IdMap，对每个 BimDown ID 找到对应 Revit element
2. 对比 BimDown CSV 当前值 vs Revit 当前值，计算 diff
3. 只 apply 变化的字段，不动其他

这让 LLM 的修改**不会破坏 Revit 里 BimDown 未涵盖的信息**：多层墙构造、族参数、施工阶段等，都原封不动。BimDown 只是 Revit 的一个投影视图，不是替代品。

## 七、为什么不用图数据库、不用 PostGIS、不用 IFC

有人问过这些替代方案，简单答一下：

- **图数据库（Neo4j 等）**：BimDown 的几何关系大部分是"可推导的"，存下来反而会过期。Cypher 对 LLM 也没有 SQL 友好。
- **PostGIS**：太重。BimDown 要能在 CI 里跑、能被 LLM agent 直接调用，DuckDB 的嵌入式体验无可替代。况且 BIM 的几何大部分是 2D 加 elevation，不需要 R-tree 那种级别的空间索引。
- **IFC**：前文讲过了，它的间接引用对 LLM 不友好。两者分工不同：IFC 适合长期存档和跨工具交换，BimDown 适合 AI 操作和 git 版本控制。所以 BimDown 可以导出基础的 IFC，但没有反向导入 IFC 的计划。

## 八、踩过的坑

几个真实的工程教训：

**坑 1：SVG 的 Y 轴**。SVG 默认 Y 轴朝下，建筑业默认 Y 轴朝北。所有 BimDown SVG 都包一层 `<g transform="scale(1,-1)">`，让 path 数据里的 Y 仍是正常的数学坐标。LLM 看到 transform 就懂。

**坑 2：浮点 tolerance**。1cm 是默认容差。太紧（1mm）会让吸附失败，房间面积少算一块；太松（10cm）会把隔壁墙的端点吸附过来，多边形崩坏。1cm 是 Revit 导出精度 + 工程合理性的平衡点。

**坑 3：dangling endpoint 不要自动修复**。早期版本会把单度顶点（degree=1 的顶点）尝试连接到最近的其他端点。结果是在错误的地方生成了"虚拟墙"，房间边界乱七八糟。现在只告警、不自动补洞。人类或 LLM 看警告自己决定。

**坑 4：CSV 和 SVG 的 id 不一致**。CSV 有 id=w-5，SVG 里没有 path id="w-5"，validator 必须抓到这种不一致。反之亦然。`validate/references.ts` 做了双向检查。

## 九、代码规模

目前 CLI 大约 4000 行 TypeScript：

```
schema/      ~400 行   YAML schema 继承解析
duckdb/      ~500 行   hydrate / dehydrate / query
build/       ~400 行   space boundary (DCEL)
validate/    ~600 行   CSV/SVG/ID/reference 校验
commands/    ~1200 行  CLI 子命令
utils/       ~400 行   SVG/CSV 解析
render.ts    ~300 行   渲染成可视蓝图 SVG
```

整个核心格式的实现可以在一周内读完。这是刻意的：**格式的复杂度应该让每个严肃的集成方都能独立实现一版**。

---

- GitHub: [github.com/NovaShang/BimDown](https://github.com/NovaShang/BimDown)
- SaaS 平台: [BimClaw](https://bim-claw.com)
