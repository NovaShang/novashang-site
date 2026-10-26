---
title: "BIM Components Are Functions, Not Data"
description: "A door, a steel beam, a duct fitting: each is a mapping from parameters to geometry. Make that mapping a first-class citizen and you get the family: three invariants, three tiers of components, Connectors, and a shared component library published by AI."
pubDate: 2026-05-22
tags: ["Tech", "BIM", "AI"]
lang: en
---

> This is a post about ideas. No implementation details, no class diagrams, no field lists. Its job is to give every future decision about "what a component looks like and where its geometry comes from" a shared frame of reference. It picks up where the [BimDown format](/en/posts/bimdown-format) post left off, and is about where components come from in the BimClaw editor.

## The core idea

**BIM components are not data. They are functions.**

A door, an I-beam, a duct fitting: at heart each one is a mapping from a set of parameters to geometry, not a static mesh or drawing. We store "geometry" in files as data because traditional CAD had no better option. Now that we have AI collaboration and modern scripting runtimes, the more direct expression is to make the mapping itself, that is, the code, a first-class citizen.

We call such a "parameters-to-geometry mapping" a **family**.

## Three invariants

1. **A project records only (family_id + parameters + placement)**, never the generated geometry. Geometry is the output of a family, not the content of the file.
2. **2D and 3D share one source.** A family is responsible for both its 2D and its 3D representation, using the same parameters and the same internal computation. The two can never drift apart.
3. **Interfaces are defined and promised by the family itself.** How a door or window hangs on a wall, how a duct mates with a piece of equipment, where a beam's endpoints are: the family decides all of this internally, and the editor only consumes the interface contract the family exposes.

Once these three hold, the question "what does this component look like" collapses entirely into the family. The outside world deals only with the family's parameters and interfaces.

## Why this path suits BimDown

- **AI-native**: for an LLM, writing a piece of parametric generation code is far more natural than producing a GLB or configuring a constrained sketch. The thing AI is bad at, "clicking around in 3D software and exporting assets", is eliminated.
- **Git-native**: a family is text. Diffs are readable, auditable, reviewable.
- **Explainable**: a component's geometry comes from source code, so anyone (human or AI) can read why it looks the way it does and what happens when you change `width`.
- **Revit interop comes naturally**: a BimDown family and a Revit Family sit at the same level of abstraction. Interop is handled by each family providing its own format adapters (exporting to IFC / RFA / GLB and so on is the family's own responsibility), so the format does not need to invent a shared intermediate geometry IR.

## Three tiers: not every component is a family

"Components are functions" does not mean everything has to be squeezed into a family, though. We explicitly sort components into three tiers:

- **System-level (not families)**: walls, floors, roofs, spaces. Their geometry comes from paths/boundaries + neighbor relationships + openings. It is the result of a kind of "network solve", not an isolated parameters-to-geometry mapping. These stay on the editor's built-in rendering path.
- **Asset families**: doors, windows, furniture, equipment, terminals, MEP fittings, decoration. This is the classic territory of families: parametric, point-placed or hosted.
- **Section-sweep families**: columns, beams, braces. A parametric cross-section + a path length. The family supplies the section definition; the editor sweeps it along the path.

The second and third tiers are both described through the family abstraction; the first tier is outside the family system.

## Connectors: the language between families

A family is not just geometry. It also has to declare **which interfaces it has**:

- A door has one interface: "attach to a wall".
- The end of a duct has one interface: "connect to a diffuser".
- A duct fitting has two to four interfaces, "each connects to a run of duct".
- A beam has one interface at each end: "connect to a column or wall".

Interfaces live inside the family and are parameterized together with its geometry. Two interfaces lining up means two components are connected. This falls out of the family abstraction naturally; the data format does not need a separate connection table bolted on.

## The role of AI: publisher of the library

If components are code, who writes the code? The long-term vision:

- There is a **shared family library**.
- A user describes what they need, and AI searches the library. If nothing fits, it **writes a new family**, validates it automatically and adds it to the library. The next time a similar need comes up, it is a hit at zero cost.
- The library naturally converges on the set of all "common components" in the domain. The more AI writes, the more complete the library, and the cheaper future projects become.
- This is npm for the BIM world, except the publisher is not a person. It is AI.

Once this flywheel starts turning, the complexity of individual projects gets absorbed into shared infrastructure, and every new project starts out with an unprecedented breadth of families. That is the real reason this approach is worth pursuing.

## The constraints of the current implementation

That is the vision. Today we are **not** building the shared library, and we are not building "dynamic loading/unloading of families" either.

The facts at this stage:

- All families are written by AI and go straight into the editor's source code, compiled and released together with the editor.
- Families are conceptually independent, but physically they share a source with the editor: one codebase, one build.
- The editor's existing element-module architecture (one file per component, each carrying its own schema / geometry / draw2D / draw3D / propertyFields) **is very nearly an implementation of families**. Every module is a "built-in family".

This means every element module we write today is, in essence, a sample for the future family library. The remaining distance is mainly:

- Having the CSV reference a family explicitly through `family_id`, instead of implicitly treating the tableName as the family.
- Letting family modules physically exist independently of the editor (external directories, remote libraries, dynamic loading).
- Making the library protocol (search, versioning, validation, caching) a first-class citizen.

All of that is for later. Not now.

## Today's work = writing families under another name

For the work in front of us, none of this adds any overhead. We keep writing new components in the element-module pattern, filling in fields, and adjusting 2D/3D rendering. That *is* writing families; they just happen to be called element modules for now and to ship bundled inside the editor.

When we move from built-in to a library, every line of element-module code written today becomes the first version of the library's contents. **The architectural debt is zero.**

## An example that already exists

These ideas already have a concrete shape in the open-source editor [BimEditor](https://github.com/NovaShang/BimEditor).

Start with the first invariant. Here are the first two lines of `door.csv` for one level of the BimDown sample data:

```csv
id,number,mesh_file,host_id,position,material,width,height,operation,hinge_position,swing_side
d-1,122,,w-5,0.709,composite,0.915,2.134,single_swing,end,right
```

The file holds only parameters (width, height, operation, hinge position) and placement (which wall it hangs on via `host_id`, and `position` along that wall). There is not a single vertex in it. Both the door's 2D symbol and its 3D model are computed from that row by the `door` element module: its `geometry()` first resolves the parameters into one intermediate result, and `draw2D()` and `draw3D()` both start from that same result. The family here is still implicit, determined by the table name `door`, which is exactly the "tableName as the family" gap mentioned above.

Now the third tier. Column and beam cross-sections have already been split out into standalone **section families**, and the source comment calls them “the first concrete instance of the BimDown ‘family’ concept”. Each section family looks roughly like this:

```ts
interface SectionFamily {
  id: string;                    // 'rect' | 'round' | 'i_shape' | ...
  params: SectionParamDef[];     // its own parameter schema
  resolveParams(attrs): SectionParams;
  outline2D(p): Point[];         // plan outline
  shape3D(p): Shape2D;           // 3D extrusion profile
  bbox(p): { w: number; d: number };
}
```

The built-ins are rectangular, round, I, T, L, C and cross shapes. The I-shape declares its own four parameters: flange width, total depth, flange thickness and web thickness. A column or beam CSV just names the section family in its `shape` column and supplies those parameters. A column's plan outline and its 3D profile come from the same family; a beam takes its plan width from it too, and in 3D the editor extrudes the section along the beam's axis. That is "the family supplies the section definition; the editor sweeps it along the path".

## What this post does not decide

- It does not prescribe a family's concrete interface, file structure or directory layout.
- It does not prescribe the library's network protocol, versioning format or search algorithm.
- It does not prescribe which element module should be migrated first, or in what order.

These are all "implementation details", left to be settled when they are actually needed. This post pins down one thing only: **what we are building is a family system, whatever it is called today and wherever it gets compiled.**
