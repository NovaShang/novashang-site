---
title: "BimDown Internals: Engineering the Path from CSV+SVG to a Geometric Reasoning Engine"
description: "A sequel to the BimDown format post, about implementation only: schema inheritance, merging CSV and SVG into DuckDB tables, deriving room boundaries with a DCEL, rebuilding MEP topology, and incremental round-trips with Revit."
pubDate: 2026-04-06
tags: ["Tech", "BIM", "AI"]
lang: en
---

The [previous post](/en/posts/bimdown-format/) explained why CSV+SVG was chosen as an AI-native BIM format. This one is only about implementation details: what happens between a pile of scattered CSV/SVG files and a building graph database that an LLM can query with SQL, that derives room boundaries automatically, and that resolves MEP topology.

## 1. A YAML Inheritance System for the Schema

BimDown does not hard-code its schema. Under `spec/csv-schema/` there is a set of YAML files that support inheritance:

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

Each schema declares `extends: base/line_element` plus its own fields. `resolveFields()` does a topological sort and merges along the inheritance chain, producing a flat field table:

```typescript
registry.set('wall', {
  prefix: 'w',
  csvFields: [id, name, level_id, material, thickness, height, ...],
  computedFields: [length, start_x, start_y, end_x, end_y],  // computed from SVG
});
```

`csvFields` are the CSV columns; `computedFields` have to be extracted from the SVG geometry. This separation is the foundation of the hydrate stage.

## 2. Hydrate: Synthesizing Columns from CSV + SVG into DuckDB

The core challenge: CSV and SVG are two completely different shapes of data, yet in a SQL query they have to behave as a single table.

`hydrate()` (`cli/src/duckdb/hydrate.ts`) works in three steps.

### Step 1. Union the CSVs into a table

Each element type has a CSV under several level directories (`lv-1/wall.csv`, `lv-2/wall.csv`, ...). All of them are read, a `_partition` column is added to record the source directory, and they are unioned into one `wall` table:

```typescript
for (const { dir: dirName, fullPath } of csvFiles) {
  const data = readCsv(fullPath);
  for (const row of data.rows) {
    allRows.push({ ...row, _partition: dirName });
  }
}
```

### Step 2. Extract SVG geometry

Walk every level's `wall.svg`, parse each `<path>` / `<rect>` / `<polygon>` / `<circle>`, and index them by the SVG element's `id` attribute:

```typescript
const geometries = new Map<string, Record<string, number | string>>();
for (const el of svg.elements) {
  if (el.tag === 'path') geometries.set(el.id, extractLineGeometry(el));
  else if (el.tag === 'rect') geometries.set(el.id, extractRectGeometry(el));
  // ...
}
```

For `<path d="M 0,0 L 10,0">`, `extractLineGeometry` yields `{start_x: 0, start_y: 0, end_x: 10, end_y: 0, length: 10}`. Note that only the M/L/A commands are supported, not Bézier curves, because LLMs cannot do stable spatial reasoning about Bézier control points.

### Step 3. Inject geometry columns with dynamic ALTER TABLE

```typescript
for (const col of allKeys) {
  const sqlType = col === 'points' ? 'VARCHAR' : 'DOUBLE';
  await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "${col}" ${sqlType}`);
}
for (const [id, geo] of geometries) {
  await runQuery(conn, `UPDATE "${tableName}" SET ${sets} WHERE id = ${escapeSql(id)}`);
}
```

The result: the `wall` table has both the CSV's `material, thickness` and the SVG-synthesized `length, start_x, start_y, end_x, end_y`. When an LLM writes `SELECT id, length FROM wall WHERE thickness > 0.3`, the `length` column is **synthesized at runtime**: the CSV has no such field at all.

A side effect of this design is that the schema is the documentation: `bimdown schema wall` lists both the CSV fields and the computed fields, so the LLM can see at a glance what it can query.

## 3. Computing Room Boundaries: a DCEL Half-Edge Structure

In the CSV, a BimDown space (room) stores only a seed point `(x, y)` and a name. The actual room polygon is computed by the `bimdown build` command. The core of the algorithm is a **DCEL (Doubly-Connected Edge List) half-edge structure**.

- **Input**: all line segments in `wall.svg` / `structure_wall.svg` / `curtain_wall.svg` / `room_separator.svg`
- **Output**: for each space seed point, the smallest enclosing polygon

### Phase 1. Vertex snapping

If the endpoints of two walls are less than 1 cm apart, they are treated as the same vertex:

```typescript
function findOrCreateVertex(x: number, y: number): Vertex {
  for (const v of vertices) {
    if (Math.abs(v.x - x) < TOLERANCE && Math.abs(v.y - y) < TOLERANCE) return v;
  }
  // otherwise create a new one...
}
```

It is a naive O(n²) implementation, which is enough for real buildings with a few thousand nodes. If it ever needs optimizing, add a spatial hash grid.

### Phase 2. Building half-edges

Each wall produces two half-edges in opposite directions (he1 and he2), which are each other's twin:

```
Wall w-1 from A to B:
  he1: A → B  (belongs to the face on w-1's left)
  he2: B → A  (belongs to the face on w-1's right)
```

### Phase 3. Polar-angle sorting + next pointers

The key to a DCEL is linking each half-edge's `next`: continuing from the current half-edge's end point, which half-edge comes next?

At each vertex v, sort all outgoing half-edges by polar angle. For a half-edge `he` arriving at v, its next (in the same face) is the one just before `he.twin` in the outgoing list:

```typescript
for (const he of halfEdges) {
  const v = he.to;
  const twinIdx = v.outgoing.indexOf(he.twin);
  const prevIdx = (twinIdx - 1 + v.outgoing.length) % v.outgoing.length;
  he.next = v.outgoing[prevIdx];
}
```

This "previous CW neighbor of the twin" rule is a classic DCEL operation, equivalent to "turn left along the face boundary".

### Phase 4. Face tracing

Starting from each unvisited half-edge, follow `next` until you return to the start, which gives a closed polygon. Compute its signed area with the shoelace formula:

- **Positive area** = CCW winding = an interior room
- **Negative area** = CW winding = the exterior envelope face

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

### Phase 5. Seed point matching

Each space seed point `(seed_x, seed_y)` gets a point-in-polygon test and is matched to **the smallest positive-area face that contains it**:

```typescript
for (const face of faces) {
  if (face.signedArea <= 0) continue;  // skip exterior faces
  if (face.signedArea < bestArea && pointInPolygon(seedX, seedY, face.polygon)) {
    bestFace = face;
    bestArea = face.signedArea;
  }
}
```

"Smallest area" matters: when a corridor wraps around rooms, a seed can fall inside both the corridor and a room, and we want the innermost one.

The result is written back to `space.svg` as a polygon, and the hydrate stage then injects an `area` field into the space table. The whole chain: **CSV seed point → geometry algorithm → SVG polygon → SQL-queryable area field**.

## 4. Resolving MEP Topology: Free Endpoints + BBox Containment

The connections between ducts, pipes, cable trays and conduits (CURVE_TABLES) and equipment and terminals (NODE_TABLES) are explicit connectors in Revit, but they get lost on export. The job of `bimdown resolve-topology` is to rebuild this **bipartite graph**.

### Phase 1. Collect free endpoints

Walk the SVG geometry of every curve to get each curve's start/end 3D points (z comes from the CSV's elevation field). A **free endpoint** is one that is not connected to another curve of the same system:

```typescript
interface CurveEndpoint {
  curveId: string;
  side: 'start' | 'end';
  point: Point3D;
  systemType: string;
}
```

If two curve endpoints coincide within the 1 cm tolerance, a placeholder `mep_node` is generated automatically to connect them.

### Phase 2. BBox containment for nodes

Equipment has a width and height (read from the CSV's width/height/length) and is treated as a bbox with volume. For each free endpoint, find **the nearest node that contains it**:

```typescript
function insideBBox(point: Point3D, node: NodeEntry): boolean {
  const dz = Math.abs(point.z - node.pos.z);
  if (dz > TOLERANCE) return false;
  const dx = Math.abs(point.x - node.pos.x);
  const dy = Math.abs(point.y - node.pos.y);
  return dx <= node.halfW + TOLERANCE && dy <= node.halfH + TOLERANCE;
}
```

Why a bbox and not distance? Because the connection point of a terminal device (a diffuser, an outlet) can be anywhere inside the device body. Revit connectors have an offset to begin with, and on export we don't know which direction that offset points. BBox containment is a conservative but reliable heuristic.

### Phase 3. Write back to CSV

Matched connections are written straight into the `start_node_id` / `end_node_id` columns of the curve CSV. Free endpoints that didn't match are reported as warnings for a person or an LLM to handle by hand.

This process reflects one of BimDown's engineering principles: **topology is derivable and should not be a first-class field in the CSV**. If people write `start_node_id` by hand, they get it wrong; if an LLM writes it, it hallucinates. Letting the geometry speak is the most reliable option.

## 5. Dehydrate: Writing DuckDB Back to CSV/SVG

The inverse of hydrate. Two subtle points:

**1. Don't write computed fields back.** `length`, `start_x`, `area` and the like are derived from SVG; writing them back to the CSV would create two sources of truth. Dehydrate uses `table.csvFields` to filter out computed fields and serializes only the original columns.

**2. The `_partition` column decides where a row goes.** Each row is written back to the `lv-N/wall.csv` given by its own `_partition` value. So after an LLM runs `UPDATE wall SET thickness = 0.3 WHERE material = 'concrete'` in DuckDB, `bimdown sync` can put everything back into exactly the right files.

## 6. The ID Map for the Revit Round-Trip

`global/_IdMap.csv` maps BimDown IDs to Revit ElementIds. This file is committed to git along with everything else.

```csv
bimdown_id,revit_element_id,element_type
w-1,123456,wall
d-1,234567,door
```

When importing into Revit, the plugin:

1. Reads the IdMap and finds the Revit element for each BimDown ID
2. Compares the current BimDown CSV values with the current Revit values and computes a diff
3. Applies only the changed fields and leaves everything else alone

This means an LLM's edits **don't destroy information in Revit that BimDown doesn't cover**: layered wall assemblies, family parameters, construction phases and so on all stay untouched. BimDown is a projected view of Revit, not a replacement for it.

## 7. Why Not a Graph Database, PostGIS, or IFC

People have asked about these alternatives, so briefly:

- **Graph databases (Neo4j, etc.)**: most of BimDown's geometric relationships are derivable, and storing them would just let them go stale. Cypher is also less LLM-friendly than SQL.
- **PostGIS**: too heavy. BimDown needs to run in CI and be called directly by LLM agents, and nothing beats DuckDB's embedded experience. Besides, most BIM geometry is 2D plus elevation and doesn't need R-tree-grade spatial indexing.
- **IFC**: covered in the previous post; its indirect references are unfriendly to LLMs. The two do different jobs: IFC is suited to long-term archiving and exchange between tools, BimDown to AI operations and git version control. So BimDown can export basic IFC, but there are no plans to import IFC back.

## 8. Pitfalls

A few real engineering lessons:

**Pitfall 1: the SVG Y axis.** SVG's Y axis points down by default; in the building industry Y points north. Every BimDown SVG is wrapped in `<g transform="scale(1,-1)">`, so the Y values in the path data stay in normal mathematical coordinates. LLMs understand the transform when they see it.

**Pitfall 2: floating-point tolerance.** The default tolerance is 1 cm. Too tight (1 mm) and snapping fails, so a room's area comes up short; too loose (10 cm) and endpoints from the neighboring wall get snapped in, wrecking the polygon. 1 cm is the balance point between Revit's export precision and engineering sense.

**Pitfall 3: don't auto-repair dangling endpoints.** Early versions tried to connect single-degree vertices (degree = 1) to the nearest other endpoint. The result was "virtual walls" in the wrong places and garbled room boundaries. Now it only warns and never patches holes automatically. A person or an LLM reads the warning and decides.

**Pitfall 4: CSV and SVG ids out of sync.** The CSV has id=w-5 but the SVG has no path id="w-5": the validator has to catch that kind of mismatch, and the reverse too. `validate/references.ts` checks both directions.

## 9. Code Size

The CLI is currently about 4,000 lines of TypeScript:

```
schema/      ~400 lines   YAML schema inheritance resolution
duckdb/      ~500 lines   hydrate / dehydrate / query
build/       ~400 lines   space boundary (DCEL)
validate/    ~600 lines   CSV/SVG/ID/reference validation
commands/    ~1200 lines  CLI subcommands
utils/       ~400 lines   SVG/CSV parsing
render.ts    ~300 lines   rendering to a readable blueprint SVG
```

You can read the whole core format implementation in a week. That is deliberate: **the format should be simple enough that every serious integrator can write their own implementation**.

---

- GitHub: [github.com/NovaShang/BimDown](https://github.com/NovaShang/BimDown)
- SaaS platform: [BimClaw](https://bim-claw.com)
