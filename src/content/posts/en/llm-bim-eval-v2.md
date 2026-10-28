---
title: "Can AI agents read construction drawings and build BIM models? Four models on a real sample project"
description: "Four LLMs (Opus 5.5, GPT-6 Astra, Kimi K3.1 Pro, DeepSeek V4.1 Flash) read drawings, model, detail and schedule the Autodesk Snowdon Towers sample."
pubDate: 2026-10-28
heroImage: "/media/blog/llm-bim-eval-v2/hero.jpg"
tags: ["Tech", "BIM", "AI", "Evaluation"]
lang: en
---
# Can AI agents read construction drawings and build BIM models? Four models on a real sample project

I tested four language models on BIM work: Opus 5.5, GPT-6 Astra, Kimi K3.1 Pro and DeepSeek V4.1 Flash. Each one ran in its own agent harness. They read drawings, built a model from them, added detailing by rule, and linked a construction schedule to the model. The project is Autodesk's Snowdon Towers sample, so every drawing, prompt and result can be shown. The full report is linked at the end.

![Model built by Opus 5.5 from seven drawing sheets](/media/blog/llm-bim-eval-v2/hero.jpg)

*Model built by Opus 5.5 from seven drawing sheets (IFC toolchain, slabs hidden). Drawings and models: Snowdon Towers sample project, courtesy of Autodesk, Inc.*

## How I tested

- **Models and harnesses.** The four models ran in Claude Code, Codex, Kimi Code and DeepSeek Harness, all at high reasoning effort, with no web access and no sub-agents.
- **Three toolchains.** Every modeling task ran three times per model:
  - IFC: the model writes Python with IfcOpenShell.
  - BimDown: a simplified BIM format designed for AI agents, made of CSV and GeoJSON files with a CLI.
  - Revit: a live Revit 2026 session over MCP.
- **Four tasks:**
  1. Reading: 7 groups of questions on the drawings.
  2. Modeling: build the parking level, the L1 concrete deck and the L2 steel frame from 7 sheets.
  3. Detailing: add joist bridging to 482 joists, plus lintels over the CMU door openings, following a rule table.
  4. 4D: schedule the whole structure and link every element to a task.
- **One run per combination.** The run counted is the first one, with no cherry-picking. Costs are at API list prices.

## Modeling separates the models

Opus 5.5 and GPT-6 Astra built the building almost completely and correctly with all three toolchains, scoring at least 0.96. Kimi K3.1 Pro and DeepSeek V4.1 Flash scored between 0.50 and 0.80.

![R2 modeling score by model](/media/blog/llm-bim-eval-v2/pt_r2.png)

| Reference | Opus 5.5 | DeepSeek V4.1 Flash |
|---|---|---|
| ![reference](/media/blog/llm-bim-eval-v2/render_gt.jpg) | ![Opus](/media/blog/llm-bim-eval-v2/render_ifc_claude.jpg) | ![DeepSeek](/media/blog/llm-bim-eval-v2/render_ifc_dsh.jpg) |

The weaker models put columns on the wrong grid lines and left out walls and joists. They also ignored the top-of-steel elevations written next to the beams.

![DeepSeek model overlaid on sheet S103](/media/blog/llm-bim-eval-v2/overlay_S103_dsh.jpg)

## Reading is reliable until information has to be combined

Opus 5.5 and GPT-6 Astra scored about 69 of 70, Kimi K3.1 Pro 62.45 and DeepSeek V4.1 Flash 64.6. The mistakes came from combining information. Kimi read the north arrow correctly and then rotated it the wrong way. Seven of eight answers took the only slab level printed on the sheet for a room whose level had to be derived from beam top plus slab thickness. Most of them had derived that same level correctly one question earlier.

![R1 reading score](/media/blog/llm-bim-eval-v2/pt_r1.png)

## Detailing by explicit rules is solved

All four models followed the bridging table on 482 joists almost without error. 11 of 12 runs scored at least 0.995.

![R3 detailing score](/media/blog/llm-bim-eval-v2/pt_r3.png)

## 4D: the written rules are easy, unwritten practice is not

Every schedule met the written rules. The prompt did not mention four points of construction practice, for example backfilling the basement walls only after the L1 deck is in place. Opus 5.5 and GPT-6 Astra followed all four in every run. DeepSeek V4.1 Flash backfilled too early in every run, and Kimi K3.1 Pro's result depended on the toolchain.

![R4 unstated checks passed](/media/blog/llm-bim-eval-v2/pt_r4.png)

## Toolchain and cost

The two strong models scored the same with IFC, BimDown and Revit. For the two weaker models the scores varied between toolchains, and no toolchain was best for both.

![Score by toolchain](/media/blog/llm-bim-eval-v2/pt_tool.png)

One modeling run cost about $9.5 with Opus 5.5 and $9.3 with GPT-6 Astra. Kimi K3.1 Pro cost about a quarter of that and DeepSeek V4.1 Flash about $0.40.

![Cost per modeling run](/media/blog/llm-bim-eval-v2/pt_cost.png)

## Limitations

- Each combination ran once.
- The detailing scope and the 4D scoring were adjusted after a pilot with two models, and every model was then run or rescored on the final version.
- Snowdon Towers is a public sample and may appear in training data.

## Full report

The 27-page report covers the method, all results, the full prompts and the grading rubric: [LLM BIM/CAD Evaluation v2 (PDF)](/media/blog/llm-bim-eval-v2/llm-bim-eval-v2-report.pdf).

The sample files are not redistributed. You can download them from Autodesk's [Revit Sample Project Files](https://help.autodesk.com/cloudhelp/2027/ENU/Revit-GetStarted/files/GUID-61EF2F22-3A1F-4317-B925-1E85F138BE88.htm) page.
