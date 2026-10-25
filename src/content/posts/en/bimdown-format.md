---
title: "How to Make AI Agents Truly Understand Buildings? Building an AI-Native BIM Data Structure"
description: "Exploring the pure technical details and design trade-offs behind the BimDown format, bringing AI back to resolving architectural scenarios using approaches it finds most familiar."
pubDate: 2026-04-10
tags: ["Tech", "AI", "BIM"]
lang: en
---

# How to Make AI Agents Truly Understand Buildings? Building an AI-Native BIM Data Structure

> **Open Source Project:** [BimDown (GitHub)](https://github.com/NovaShang/BimDown)
> 
> **TL;DR:** 
> This article explores the pure technical details and design trade-offs behind the BimDown format. It does not include demonstrations (Demo). If you are more interested in the practical application and visual results of an AI Agent (like OpenClaw) manipulating building structures, please skip this article and read the second post in this series on practical applications.

## Background and Problem

In recent months, integrating various AI Agents into existing engineering workflows has become a hot trend. In the architecture domain, the most natural idea is to let Agents directly operate and generate BIM models. However, in practical testing, we typically encounter many issues. There are currently two mainstream technical paths:

*   **Path 1: Directly Read/Write IFC Format**
    IFC is plain text, which seems suitable for Large Language Models (LLMs) to write, but this is entirely unfeasible in reality. To describe a wall containing doors and windows, IFC uses complex Boundary Representation (B-Rep), which requires generating massive interleaved nodes and reference relationships.
    Not only does it **quickly consume the model's token context**, but more fatally, current LLMs struggle to understand complex 3D geometry and topological nesting. If any intermediate reference node (like `#123`) suffers from hallucination or calculation error, the entire geometric model will simply crash and fail to open.

*   **Path 2: Call Revit API via MCP Protocol**
    The main issue with this approach is that the execution mechanism is somewhat hostile to LLMs:
    1.  **Excessive Tool Calling and Token Consumption**: Driving a Revit model via API requires highly fragmented tool calling. Without a robust KV Cache mechanism, multi-turn round trips will drain Input Tokens excessively.
    2.  **Fragmented Model Attention**: The model is forced to allocate a massive amount of attention towards "confirming tool call logic and processing return structures", which severely degrades its core reasoning abilities for the main spatial modeling tasks.
    
    Additionally, circumventing the need to rely on and install expensive Revit desktop software is a significant side benefit.

## Solution: BimDown's Format Design and Trade-offs

If we want AI to smoothly understand buildings, we need a paradigm shift: building an **AI-native** intermediate data structure. This is why I named it **BimDown**, encapsulating two core design philosophies:

*   On one hand, it's a **Down-dimensioned BIM**. It eliminates mathematical hurdles by down-dimensioning the 3D geometric features that LLMs are bad at handling.
*   On the other hand, I hope it becomes the **Markdown** for the architectural engineering field—lightweight, plain text, and incredibly accessible for LLM read/write operations.

Constrained by the current spatial computing capabilities of AI, BimDown does not seek to aggressively replace mainstream, deep-engineering formats. It chooses to actively sacrifice certain niche use cases, completely decoupling "geometry" from "attributes" to return AI to its most comfortable operating zone for describing buildings.

### 1. Data Structure Carrier

**Why use CSV for attributes?**
CSV is extremely token-efficient and avoids nested tree hierarchies; it is the data table format both AI and developers are most familiar with. Its biggest advantage is that it can be directly consumed by lightweight analytical databases like DuckDB to perform complex SQL queries and filtering, making it exceptionally friendly for AI to later write automated data-cleaning scripts.

**Why use SVG for geometry?**
SVG is rarely used as primary engineering data in the AEC industry, but BimDown chooses to down-dimension 3D building blocks into 2D SVG outlines. The reason is simple: SVG is the dominant vector format in Web development. Pre-trained models have encountered oceans of SVG code text in their training corpora. Major tech companies currently use UI and SVG generation quality as core long-term metrics to demonstrate their models' spatial reasoning capabilities. The engineering industry's influence is limited, and tech giants are unlikely to fine-tune models specifically for IFC or DXF structures. However, for web interactivity, they will continuously optimize SVG generation. By adopting this format, we are essentially riding this trend.

Ultimately, the architecture model presents itself with a directory structure similar to a standard software engineering project. A model organizes a series of plain text files using a system directory tree (e.g., `wall.csv` and `wall.svg` under a specific floor folder). Each file handles one specific concern, perfectly matching how Coding Agents operate today.

### 2. AI-Centric Schema Optimization

When defining the schema, BimDown introduced targeted design optimizations focusing on LLM weaknesses in numerical computation and 3D geometry processing:

*   **Computed Field Isolation Mechanism**: LLMs are typically poor at precise floating-point arithmetic. Therefore, the specification explicitly dictates that derived data like component length (`length`), room area (`area`), and bounding boxes (`bbox`) are strictly set as `computed: true` (read-only auto-calculated fields). The Agent only needs to input basic parameters or provide a base SVG path. Subsequent area and topological computations are handed entirely to the CLI engine to generate automatically during the `build` phase. This entirely prevents numerical hallucinations when the model generates plain text.
*   **2D Coordinate Attachment for Doors/Windows**: In traditional 3D operations, placing doors/windows on a wall usually involves splitting walls or executing Boolean operations, which is highly unfriendly to code-generating AI. BimDown dictates that walls must remain contiguous line segments in SVG. Doors and windows indicate location solely by providing their center point coordinates (`host_x, host_y`) or 1D relative distance along the wall (`position`) in the CSV. Actual Boolean solid deductions are deferred to the rendering and translation pipeline.
*   **Seed Point Based Space Boundary Generation**: Requiring a text model to perfectly close a complex polygon vertex sequence often results in coordinate drift. BimDown simplifies Space unit generation. The Agent only needs to drop a 2D seed coordinate (Seed Point X/Y) inside the room in `space.csv`. During the build, the CLI automatically traces outward using algorithms against surrounding physical walls to extract an accurate, completely enclosed room boundary.

There are many similar targeted optimizations. These constraints were distilled through iterative testing, pinpointing boundary conditions where LLMs frequently became confused or made errors.

Currently, the BimDown schema covers the vast majority of common building structure and MEP analysis scenarios, supporting over 30 core entity types:
> `beam`, `brace`, `cable_tray`, `ceiling`, `column`, `conduit`, `curtain_wall`, `door`, `duct`, `equipment`, `foundation`, `grid`, `level`, `mep_node`, `mesh`, `opening`, `pipe`, `railing`, `ramp`, `roof`, `room_separator`, `slab`, `space`, `stair`, `structure_column`, `structure_slab`, `structure_wall`, `terminal`, `wall`, `window`.

For complete type definition trees and specific field extraction rules for each component, refer to the YAML configuration files under the `/spec` directory in the open-source repository.

### 3. Format Positioning and Revit Interaction

I know it is impossible to introduce a new format that seamlessly gains universal industry consensus, and objectively, BimDown cannot satisfy the complex component characteristics found in backend IFC and RVT ecosystems. I position it as an intermediate format used only when a specific business node requires bulk AI automation, or when lightweight loading of building structural data is needed on the web.

Suitable scenarios include early energy modeling analysis, dynamic flow segment scheduling during construction, etc. In these scenarios, the heavy dependency of Revit is too cumbersome, and IFC's tree parsing is overly complex.

For workflow integration, I developed companion Revit plugins to facilitate data syncing between BimDown and Revit models. This mechanism ensures that if a model is exported from Revit to BimDown, modified via Web tools or AI Agents, and then re-imported into Revit, parameter differences are applied as incremental updates rather than blunt overwrites. When confronting minority complex Revit family traits that BimDown currently doesn't support, deep associative data might be lost, and geometric elements will fallback-downgraded to pure mesh models incapable of parameterized secondary editing (**for a detailed audit of unsupported features, see the Appendix**).

Export needs are also accommodated: the Web editor supports exporting base IFC model files for external use. However, given the extreme complexity of IFC file trees, there is currently no plan to support reverse importing of IFC.

### 4. CLI-based Coding Workflow

The overall BimDown procedure mimics standard software development paradigms as closely as possible. Current AI Agents, including OpenClaw and Claude Cowork, even when built for non-programming purposes, fundamentally operate on Coding Agent architectures. Therefore, the architectural modeling process is adapted to mimic software development.

Recently, encapsulating software into CLIs for system invocation has proven to be the best extension mechanism for modern AI Agents. These CLI tools serve as the Agent's "hands and feet". Following this trend, I developed the comprehensive `BimDown CLI` to support this workflow. It abstracts all foundational capabilities an AI requires to utilize BIM, essentially acting as a Revit built specifically for AI. For the Agent:

*   **Creation and Verification**: The workflow initiates by running `bimdown init`. When confronting unfamiliar components, `spec` commands are queried for field rules. Post-modification, `bimdown build` triggers compiler rule validation against the model. Boundaries, errors, and clash reports generated by the local engine are fed back to the Agent via Standard Error (Stderr), prompting self-directed code modification and topological iteration.
*   **Multi-modal Feedback Inspection Loop (Render Mechanism)**: Agents arbitrarily execute `bimdown render` to generate preview images. This isn't meant for human consumption; it's for the AI. While current AI has severe limitations in deep text comprehension of vector graphics, multi-modal models (e.g. Qwen, Gemini) possess robust visual perception. They verify layout correctness directly by analyzing the rendered PNG. In testing, even the strongest Gemini-3.1-Pro model produces errors on its first zero-shot generation of floor plans from drawings. But within this feedback loop, viewing render results and iterating 2-3 times allows even lightweight "Flash" tier models to accurately extract and represent small-scale building layouts.
*   **SQL Spatial Data Cleansing and Querying**: For complex structural traversals or filtering demands, `bimdown query` utilizes the embedded DuckDB spatial extension to instantly execute advanced scalar and compound geometric queries. By leveraging pre-maintained MEP node topological rules, an LLM can effortlessly draft a recursive Common Table Expression (CTE) SQL query on the fly, swiftly resolving network routing and MEP system tracing issues that are typically nightmares to penetrate using conventional approaches.
*   **Extensible Custom Processing**: For slightly more complex pure-computation logic scenarios: because foundational info is now a unified frontend structure, I exposed external interfaces capable of loading/parsing JS and wrapping equivalent data into open-source polygon libraries. This ensures that when confronted with spatial splitting rules or bounding grid segmentations, agents achieve smooth teardowns using simple geometry scripts, bypassing the nightmares of traditional 3D Boolean intersections entirely.

## Horizontal Benchmarking Evaluation

To quantify how AI models perform across different BIM data formats, I ran a comprehensive benchmark test under Gemini-3.1-Flash utilizing the Revit Advanced Sample Project. The test covered three core workflows: Greenfield Creation (Model), Complex Attribute Queering (Query), and Deep Component Modification (Modify). The testing matrix incorporated BimDown sub-formats, IFC, and direct Revit underlying API hooks. The aggregated results are below:

| Format | Tool Config | Create (Model) | Query | Modify | Aggregate Score | Token Consumption | Total Cost |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| **bd-csv-svg** | With bimdown-cli | 8/8 | 4/5 | 5/5 | **89%** | 760k | **$0.304** |
| bd-csv-geojson | Bare (No tools) | 8/8 | 3.5/5 | 5/5 | 87% | 712k | $0.285 |
| bd-csv-svg | Bare (No tools) | 8/8 | 2.5/5 | 5/5 | 83% | 799k | $0.467 |
| bd-csv | Bare (No tools) | 6/6 | 4/5 | 3/5 | 80% | 1,385k | $0.453 |
| **Revit MCP** | Wrapped Underlying API | 5/6 | 2.5/5 | 2/5 | **59%** | 1,458k | **$0.467** |
| ifc-webIfc | With web-ifc library | 6/6 | 1/5 | 0/5 | 40% | 1,543k | $0.498 |
| ifc-text | Pure Text Hard Read/Write | 4/6 | 0/5 | 0/5 | 13% | 9,198k | $1.318 |

From the data above, several explicit technical conclusions manifest:

1. **Current tier AI struggles to effectively process IFC formats**: Even with sophisticated external parsing libraries, open-source models deeply struggle against IFC entity trees composed of massive nested features. Direct text manipulation testing shows models not only hemorrhage astronomical Token budgets but severely suffer from dangerous code hallucinations where they falsely log "Execution Successful" on deep-reference tasks without altering any underlying data.
2. **Direct Revit API performance is strictly limited by task type**: Directly exposing proprietary Revit APIs to models performs incredibly well in greenfield geometry Creation (Model) tasks. However, deficient prior knowledge of internal Revit Core Type vs. Instance taxonomies guarantees logical failures in cross-level queries. Furthermore, models frequently trap themselves in endless crash-loops when dynamically compiling C# scripts attempting to access functionality absent from predefined interfaces.
3. **BimDown's decoupled execution combined with CLI effectively lowers costs**: Conventional wisdom implies recurrent invocation of external CLI translations will dramatically inflate conversation turns and push up total costs. Benchmark data disproves this: because underlying toolkits hijack low-value XML/Tree regex dismantling, the model preserves invaluable contextual Attention. The BimDown + CLI trajectory not only secures chart-topping completion rates but compresses Token expenditure and cost to a stark fraction compared to pure document manipulation methods.

## Conclusion

The relationship between BimDown, IFC, and Revit is highly analogous to Markdown, LaTeX, and Word.

Revit is like a comprehensive Word: intuitive UI, exceptionally potent, but traps data within a proprietary ecosystem. IFC is akin to an immaculate LaTeX: boasting rigorous unified standards, but presently, tasking laymen or AI to directly decipher and draft its source code is an excruciating and error-prone endeavor.

BimDown represents the Markdown I aim to supply to the AEC and spatial engineering community.

Years ago, while internet forums fiercely debated "the world's greatest programming language", few could have predicted that in the AI explosion era, the single most utilized protocol generated by LLMs daily would be Markdown—a minimalist text-markup initially deemed too infantile for anything beyond blogging.

This maps squarely to BimDown's core philosophy. Rather than chasing bloated, all-encompassing paradigms, it offers simplicity: a frictionless, plain-text intermediary format readily parsed, altered, and understood by both human operators and AI engines today.

---

## Appendix: Complete List of Unsupported Revit Features in BimDown

Unsupported items will fallback constraint-free as exported mesh models. Thus, they are difficult to edit but will not impact visual display.

**1. Geometry Abstraction Limitations**
* **Free-form Surfaces/NURBS**: Conceptual masses, adaptive components, complex in-place families.
* **Non-Strict Arcs & Curves**: Elliptical arcs and spline walls are unsupported (Note: Standard circular arcs are fully supported).
* **Sloped Slabs**: Floor sub-element shape editing, slope arrows, and variable thickness floors.
* **Edited Wall Profiles**: Non-rectangular wall elevation profile boundaries (e.g., gable walls with pitched roofs).
* **Curtain Wall Sub-division Details**: Independent uniquely matched panel materials, panels harboring nested doors/windows, and non-rectangular panels.

**2. Data Structure Limitations**
* **Multi-layer Compound Structures**: Material strata compositions within walls, floors, and roofs (e.g., differentiating core layers, finish layers, thermal layers).
* **Family Types and Calculated Formulas**: Revit's complete type system, instance parameters, formula-driven constraints, and system lock relationships.
* **Modification and Phasing Consoles**: Engineering Phases (e.g., Existing/Demolish/New Construction) and multiple Design Options.
* **Reuse and Organizational References**: Parameterized Groups, Arrays, Nested Families, along with Worksets and Linked Models.

**3. Discipline Depth Limitations**
* **Structural Analytics**: Load cases, specialized boundary conditions, and detailed rebar schedules.
* **MEP Physical Computations**: Attributes involving airflow metrics, pipe water pressure drop, electrical loads, and HVAC thermal calculations.
* **Energy Simulation Foundations**: Exhaustive material thermal properties (U-value, SHGC), and hourly occupancy/equipment operation schedules.
* **Project Sites and Property Lines**: Toposolid terrain entities, property line demarcations, and non-parametric site vegetation components.
* **Furniture and Plumbing Fixtures**: Stripped of dynamic parameter adjustment capabilities, uniformly downgraded to fixed-mesh GLB entities.
* **Sheets and Annotation Views**: Section views, elevation views, callout details, all drafting text and dimension annotations, as well as reporting Schedules.
