---
title: "BIM 构件不是数据，是函数"
description: "门、钢梁、风管接头的本质是参数到几何的映射。把这个映射本身当作一等公民，就得到了 family：三条不变量、三档构件、Connector，以及由 AI 来发布的共享构件库。"
pubDate: 2026-05-22
tags: ["技术", "BIM", "AI"]
lang: zh
---

> 这是一篇讲理念的文章。不写技术细节、不画类图、不列字段。它的作用是为未来所有关于"构件长什么样、几何怎么来"的决策提供一个公共参照系。它延续了 [BimDown 格式](/zh/posts/bimdown-format)那篇的思路，讨论的是 BimClaw 编辑器里构件的来源。

## 核心观点

**BIM 构件不是数据，是函数。**

一扇门、一个 I 字钢梁、一个风管接头，它们的本质是一组参数到几何的映射，不是一份静态的网格或图形。把"几何"当数据存进文件，是因为传统 CAD 还没有更好的办法；当我们有了 AI 协作和现代脚本运行时之后，更直接的表达是：把这个映射本身，也就是代码，作为一等公民。

我们把这样的"参数到几何的映射"叫做 **family**。

## 三条不变量

1. **项目里只记录 (family_id + 参数 + 放置位置)**，不记录生成出来的几何。几何是 family 的输出，不是文件的内容。
2. **2D 和 3D 同源**。一个 family 同时负责 2D 表达和 3D 表达，共享同一份参数与同一份内部计算。两边不会相互漂移。
3. **接口是 family 自己定义并对外承诺的**。门窗如何挂在墙上、风管如何咬合到设备、梁的端点在哪，都由 family 在自己内部决定，编辑器只消费 family 暴露出的接口契约。

满足这三条之后，"构件长什么样"这个问题完全收敛到 family 内部，外部世界只跟 family 的参数和接口打交道。

## 为什么这条路适合 BimDown

- **AI 原生**：写一段参数化生成代码，对 LLM 来说远比生成一份 GLB、配置一份约束草图自然。AI 不擅长的"在 3D 软件里点点点导出资源"被消除掉了。
- **Git 原生**：family 是文本，差异可读，可审，可 review。
- **可解释**：构件的几何来源是源代码，任何人（人或 AI）都能读懂为什么它长这样、改 width 会发生什么。
- **Revit 互通天然**：BimDown family 和 Revit Family 是同一层抽象。互通靠 family 提供自己的格式适配器（导出到 IFC / RFA / GLB 等都是 family 内部的职责），格式不需要发明一个公共的中间几何 IR。

## 三档构件，并不是所有构件都是 family

不过，"构件是函数"并不意味着所有东西都要塞进 family。我们明确把构件分成三档：

- **系统级（不是 family）**：墙、楼板、屋顶、空间。这些构件的几何来自路径/边界 + 邻居关系 + 开洞，是一种"网络解算"的结果，不是孤立的参数到几何的映射。它们留在编辑器的内置渲染路径里。
- **资源族**：门、窗、家具、设备、终端、MEP 接头、装饰。这是典型的 family 适用范围，参数化、点定位或 hosted。
- **截面扫掠族**：柱、梁、支撑。参数化截面 + 路径长度。Family 提供截面定义，编辑器沿路径扫掠。

第二、第三档统一通过 family 抽象描述；第一档不在 family 体系之内。

## Connector：family 与 family 之间的语言

Family 不只是几何，还要声明自己**有哪些接口**：

- 门有一个接口"附着到墙"。
- 风管末端有一个接口"接到风口"。
- 风管接头有两到四个接口"各自接到一段风管"。
- 梁两端各有一个接口"接到柱或墙"。

接口写在 family 自己内部，跟它的几何一同被参数化。两端接口对齐，就等于两个构件连接。这件事在 family 抽象里是天然的，不需要数据格式外加一套连接表。

## AI 的角色：library 的 publisher

如果构件是代码，那么谁来写这些代码？长期的愿景是这样的：

- 存在一个**共享 family 库**。
- 用户描述需求，AI 在库里检索；找不到就**写一个新 family**、自动验证、入库；下次同类需求 0 成本命中。
- 库会自然收敛到这个领域所有"常见构件"的集合，AI 写得越多，库越完整，未来项目越省。
- 这就是 BIM 世界的 npm，只是 publisher 不是人，是 AI。

这条飞轮一旦转起来，单个项目的复杂度被吸入到共享基础设施里，新项目从一开始就站在前所未有的家族广度上。这才是这个方案值得做的真正理由。

## 当前实现的现实约束

愿景归愿景，我们现在**不**实现共享库，也不实现"动态加载/卸载 family"。

现阶段的事实是：

- 所有 family 都由 AI 来写，写完直接放进编辑器源码里，跟编辑器一起编译发布。
- Family 在概念上是独立的，但在物理上和编辑器同源：一份代码、一次构建。
- 编辑器现有的 element module 架构（每个构件一个文件、自带 schema / geometry / draw2D / draw3D / propertyFields）**几乎就是 family 的实现**。每个 module 都是一个"内置 family"。

这意味着今天我们写的每一个 element module，本质上都是在为未来的 family library 做样本。它们之间的距离主要是：

- 让 CSV 用 `family_id` 显式引用，而不是隐式把 tableName 当 family。
- 让 family 模块在物理上可以独立于编辑器存在（外部目录、远程库、动态加载）。
- 让 library 协议（检索、版本、验证、缓存）成为一等公民。

这些都是未来的事，现在不做。

## 现在的实际工作 = 写 family，只是叫别的名字

对眼下的工作来说，这没有任何额外开销。我们继续按 element module 模式写新构件、补字段、改 2D/3D 渲染，这些就是在写 family，只是它们现阶段被命名为 element module、被打包在编辑器里。

未来从内置走向 library 的时候，今天写下的每一行 element module 代码都直接是 library 的初版内容。**架构债是零**。

## 一个已经存在的例子

这些说法在开源编辑器 [BimEditor](https://github.com/NovaShang/BimEditor) 里已经有了具体的样子。

先看第一条不变量。下面是 BimDown 示例数据里一个楼层的 `door.csv` 的前两行：

```csv
id,number,mesh_file,host_id,position,material,width,height,operation,hinge_position,swing_side
d-1,122,,w-5,0.709,composite,0.915,2.134,single_swing,end,right
```

文件里只有参数（宽、高、开启方式、铰链位置）和放置位置（挂在哪面墙 `host_id`、沿墙的 `position`），没有一个顶点。门的 2D 符号和 3D 模型都是 `door` 这个 element module 从这一行算出来的：它的 `geometry()` 先把参数解析成一份中间结果，`draw2D()` 和 `draw3D()` 都从这同一份结果出发。这里的 family 还是隐式的，由表名 `door` 决定，也就是上面说的"把 tableName 当 family"。

再看第三档。柱和梁的截面已经被拆成了独立的 **section family**，源码注释里写着它们是 “the first concrete instance of the BimDown ‘family’ concept”。每个截面族的形状大致是：

```ts
interface SectionFamily {
  id: string;                    // 'rect' | 'round' | 'i_shape' | ...
  params: SectionParamDef[];     // 自己声明的参数表
  resolveParams(attrs): SectionParams;
  outline2D(p): Point[];         // 平面轮廓
  shape3D(p): Shape2D;           // 3D 拉伸截面
  bbox(p): { w: number; d: number };
}
```

内置的有矩形、圆形、I 形、T 形、L 形、C 形和十字形。I 形截面自己声明翼缘宽、总高、翼缘厚、腹板厚四个参数；柱和梁的 CSV 只用 `shape` 列指明用哪个截面族，再给出这些参数。柱在平面图上的轮廓和 3D 里的截面出自同一个 family；梁在平面上的宽度同样取自它，3D 里则由编辑器把这个截面沿梁的轴线拉伸出来。这正是"Family 提供截面定义，编辑器沿路径扫掠"。

## 这篇文章的边界

- 不规定 family 的具体接口、文件结构、目录布局。
- 不规定 library 的网络协议、版本格式、检索算法。
- 不规定哪个 element module 应该先迁、按什么顺序迁。

这些都属于"实现细节"，留给未来需要它们的时刻去定。这里只钉死一件事：**我们在做的是一个 family 体系，无论现在它叫什么名字、放在哪里编译**。
