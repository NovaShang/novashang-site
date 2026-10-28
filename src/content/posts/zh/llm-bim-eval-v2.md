---
title: "大模型能看懂施工图、建出 BIM 模型吗？四个模型在公开样例项目上的实测"
description: "四个大模型在 Autodesk Snowdon Towers 样例上读图、建模、深化和排 4D 进度的实测。"
pubDate: 2026-10-28
heroImage: "/media/blog/llm-bim-eval-v2/hero.jpg"
tags: ["技术", "BIM", "AI", "评测"]
lang: zh
---
# 大模型能看懂施工图、建出 BIM 模型吗？四个模型在公开样例项目上的实测

我测了四个大模型做 BIM 工作的能力：Opus 5.5、GPT-6 Astra、Kimi K3.1 Pro 和 DeepSeek V4.1 Flash。每个模型在各自的 agent 环境里看图、按图建模、按规则补深化构件、把施工进度挂到模型上。项目用的是 Autodesk 的公开样例 Snowdon Towers，所以图纸、题目和结果都可以完整展示。完整报告（英文）的下载链接在文末。

![Opus 5.5 根据 7 张图纸建出的模型](/media/blog/llm-bim-eval-v2/hero.jpg)

*Opus 5.5 根据 7 张图纸建出的模型（IFC 方式，隐藏楼板）。图纸与模型来自 Autodesk 的 Snowdon Towers 样例项目。*

## 怎么测的

- **被测对象**：四个模型分别在 Claude Code、Codex、Kimi Code、DeepSeek Harness 里运行。思考档位都设为 high，不联网，不开子代理。
- **三种操作方式**：每个建模任务按三种方式各做一次。
  - IFC：模型写 Python 调用 IfcOpenShell。
  - BimDown：一种面向 AI 的简化 BIM 格式，由 CSV 和 GeoJSON 文件组成，配命令行工具。
  - Revit：通过 MCP 操作 Revit 2026。
- **四类任务**：
  1. 读图：7 组问答。
  2. 建模：根据 7 张图纸建停车层、首层混凝土楼盖和二层钢框架。
  3. 深化：按规则表给 482 根钢托梁补水平支撑，给砌块墙门洞补过梁。
  4. 4D：编整栋楼的结构施工进度，并把每个构件挂到任务上。
- **运行与计费**：每个组合只用事先定好的那一次运行，不挑选。费用按 API 标价计。

## 建模：差距最大的一项

Opus 5.5 和 GPT-6 Astra 用三种方式都几乎完整、正确地建出了模型，得分都在 0.96 以上。Kimi K3.1 Pro 和 DeepSeek V4.1 Flash 在 0.50 到 0.80 之间。

![各模型建模得分](/media/blog/llm-bim-eval-v2/pt_r2.png)

| 标准答案 | Opus 5.5 | DeepSeek V4.1 Flash |
|---|---|---|
| ![标准答案](/media/blog/llm-bim-eval-v2/render_gt.jpg) | ![Opus](/media/blog/llm-bim-eval-v2/render_ifc_claude.jpg) | ![DeepSeek](/media/blog/llm-bim-eval-v2/render_ifc_dsh.jpg) |

较弱的两个模型主要错在三处：把柱放到了错误的轴线上；漏了墙和托梁；没有用梁旁边标注的钢梁顶标高。

![DeepSeek 的模型叠在 S103 图纸上](/media/blog/llm-bim-eval-v2/overlay_S103_dsh.jpg)

## 读图：单项信息读得准，需要组合时容易出错

Opus 5.5 和 GPT-6 Astra 都拿到约 69 分（满分 70），Kimi K3.1 Pro 62.45 分，DeepSeek V4.1 Flash 64.6 分。

错误都出在需要组合信息的地方：
- Kimi 读对了指北针的偏角，换算真方位时却转反了方向。
- 有一个房间的楼板标高，图上没有直接标注，要从梁顶标高加板厚推出来。8 份答案里有 7 份直接套用了图上唯一印出的那个楼板标高，而它们大多在前一题里刚推对过这个数。

![读图得分](/media/blog/llm-bim-eval-v2/pt_r1.png)

## 深化：规则写明的，四个模型都能做好

四个模型按规则表给 482 根托梁补支撑，几乎没有出错。12 次运行里有 11 次得分在 0.995 以上。

![深化得分](/media/blog/llm-bim-eval-v2/pt_r3.png)

## 4D：写明的规则都满足了，没写明的工程常识才拉开差距

所有进度计划都满足了题目写明的规则。题目没有写明的施工常识有 4 条，例如地下室外墙要等首层楼盖完成后才能回填：
- Opus 5.5 和 GPT-6 Astra 每次都做对了。
- DeepSeek V4.1 Flash 每次都回填过早。
- Kimi K3.1 Pro 的结果随操作方式而变。

![4D 中未写明的检查项通过比例](/media/blog/llm-bim-eval-v2/pt_r4.png)

## 操作方式与成本

两个较强的模型在 IFC、BimDown、Revit 上的得分基本相同。两个较弱的模型在不同方式之间差别较大，而且没有哪一种方式对它们俩都最好。

![各操作方式的得分](/media/blog/llm-bim-eval-v2/pt_tool.png)

建一次模型，Opus 5.5 约花 9.5 美元，GPT-6 Astra 约 9.3 美元，Kimi K3.1 Pro 约为它们的四分之一，DeepSeek V4.1 Flash 约 0.4 美元。

![单次建模费用](/media/blog/llm-bim-eval-v2/pt_cost.png)

## 局限性

- 每个组合只跑了一次。
- 深化题的范围和 4D 的评分口径是在两个模型试跑之后调整的；调整后所有模型都按最终版本重跑或重新计分。
- Snowdon Towers 是公开样例，可能出现在模型的训练数据里。

## 完整报告

27 页英文报告，包含方法、全部结果、题目原文和评分细则：[LLM BIM/CAD Evaluation v2（PDF）](/media/blog/llm-bim-eval-v2/llm-bim-eval-v2-report.pdf)。

样例文件不随报告分发，可以从 Autodesk 的 [Revit Sample Project Files](https://help.autodesk.com/cloudhelp/2027/ENU/Revit-GetStarted/files/GUID-61EF2F22-3A1F-4317-B925-1E85F138BE88.htm) 页面下载。
