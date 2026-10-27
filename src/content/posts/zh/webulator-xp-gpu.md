---
title: "在浏览器里给 Windows XP 装一块显卡：SVGA3D 到 WebGL2"
description: "v86 没有 3D 硬件。我在它里面实现了一块 VMware SVGA II 显卡和它的 SVGA3D 协议，用 WebGL2 执行 XP 驱动发来的命令，让浏览器里的 Windows XP 有了 Direct3D 和 OpenGL 加速，最后跑起了 OpenArena。"
pubDate: 2026-10-11T12:00:00Z
heroImage: "/media/blog/webulator-xp-gpu/openarena-xp.jpg"
tags: ["技术", "模拟器", "Webulator", "WebGL", "Windows XP"]
lang: zh
---

[Webulator](/zh/posts/webulator-intro/) 里的 PC 用的是 [v86](https://github.com/copy/v86)：一个 x86 模拟器，CPU 用 WebAssembly 即时编译，显示只有 VGA 和 VBE。跑 Windows 98 的桌面够用，但它没有任何 3D 硬件，所有画面都是 CPU 一个像素一个像素写出来的。

这篇记录我怎么在 v86 里加了一块虚拟显卡：VMware SVGA II，带它的老 3D 协议 SVGA3D，在浏览器这边用 WebGL2 执行。结果是浏览器里的 Windows XP 有了 Direct3D 和 OpenGL 加速，能跑 OpenArena。下文的数字都来自当时的开发笔记和提交记录，测试环境是 Apple M2 上的 headless Chromium。

先说清楚一件事：**带 3D 的版本目前只在仓库的 `feat/demo-3d` 分支上，还没有放到公开的 demo 页面里**，所以现在还没法在线试。

## 目标：浏览器里的 XP 加一块能用的显卡

这一轮工作的目标是我在 10 月 11 日定下的：在浏览器里的 Windows XP SP3 上跑 Warcraft III（一个 Direct3D 8 游戏），而且要有真正的 GPU 加速，不是软件渲染。

关键问题是选哪块显卡来模拟。要让 XP 上的 Direct3D 和 OpenGL 程序直接受益，最省事的是模拟一块 **XP 已经有驱动** 的显卡，这样驱动、DirectX 运行时都不用自己写。VMware 的 SVGA II 正好合适：

- VMware Tools 10.0.12 里有完整的 XP 驱动：`vmx_svga.sys`、`vmx_fb.dll`（Direct3D HAL），以及 `vmwogl32.dll`（一个 OpenGL ICD）。
- 它的 3D 协议 SVGA3D 是一个命令流，命令本身就是 Direct3D 9 级别的概念：surface、context、渲染状态、绘制、present、D3D9 着色器字节码。
- 协议有公开的头文件可查（Linux 内核 vmwgfx 驱动里的 `device_include`，MIT 许可），VirtualBox 有一套完整的实现，QEMU 有一个只做 2D 的版本，都可以参考。

我当时没找到任何用 WebGL 或 WebGPU 实现 SVGA3D 的项目，所以宿主这一侧要自己写。

## 第一步：XP 能不能在 v86 上跑

在动显卡之前，先确认 XP 本身能跑。我用 QEMU 的 TCG 模式（硬件配置尽量和 v86 一致）做了一次无人值守安装，大约 35 分钟，不需要手动操作。

第一个坑是 HAL：安装程序装上了 APIC HAL，在 v86 下内核会一直停在等中断的地方。离线把 `system32\hal.dll` 换成安装盘里的 Standard PC HAL 就好了。

在 v86 上的几个基础数字（本地磁盘）：

| 项目 | Windows XP SP3 | Windows 98（参照） |
|---|---|---|
| 冷启动到桌面稳定 | 40 秒（约 30 秒出现桌面） | 19 秒 |
| 忙时 CPU 吞吐 | 250 到 280 MIPS | 无数据 |
| 打开开始菜单 / 记事本 | 0.30 秒 / 0.19 秒 | 0.22 秒 / 0.13 秒 |
| 快照（256 MB 内存，gzip） | 57 MB，保存 2.3 秒 | 12.4 MB |
| 从快照恢复到第一帧（5 次） | 0.38 到 0.40 秒 | 0.14 到 0.17 秒 |

250 到 280 MIPS 大约相当于一颗 300 到 500 MHz 的 Pentium II 或 III。桌面使用没问题，但这个数字后面会一直压在头上。

## 第二步：在 v86 里加一块 SVGA II

SVGA II 是一个 PCI 设备（15AD:0405）：BAR0 是一组 I/O 端口（索引、数据、中断状态），BAR1 是显存，BAR2 是命令 FIFO。我在 v86 的 VGA 设备上面加了 `src/vmware_svga.js`，实现寄存器、FIFO 和 3D 能力的握手。显存和 FIFO 都直接放在 v86 的 wasm 内存里，分别占 VGA 显存的前后两半。VGA BIOS 用的是 QEMU 的 `vgabios-vmware.bin`，因为 BIOS 会检查 PCI ID 和显卡是否匹配。

XP 装上 VMware 自己的驱动之后，能以 1024×768×32 运行。dxdiag 里显示 "VMware SVGA II"，16 MB，DirectDraw 和 Direct3D 加速都是 **Enabled**，DDI 7。VMware 鼠标驱动 `vmmouse` 也一起装上了，鼠标变成绝对定位，点哪是哪。XP 这台机器也通过了 Webulator 的全部 12 项一致性测试。

真实驱动比文档"诚实"，有几个地方只能靠试出来：

- 驱动按 MAX_WIDTH 排列每一行（行距固定 6400 字节），从来不读 BYTES_PER_LINE 寄存器。
- 16 位色模式需要设备声明 `SVGA_CAP_8BIT_EMULATION`，否则 Direct3D 切到 640×480×16 时会失败。
- Standard PC HAL 下 PS/2 鼠标的设备 ID 是 `*PNP0F03`，不是 `*PNP0F13`。

## 先看驱动真正发什么

声明了 3D 能力之后（硬件版本 2.1，一份 D3D9 级别的能力表），在宿主还什么都不画的情况下，我先把 dxdiag 的 Direct3D 7 测试发出来的命令流录了下来。它每秒提交大约 1300 帧的命令：每帧 8 次 SETRENDERTARGET、一次 CLEAR、SETTEXTURESTATE，然后 6 组（两次 SURFACE_DMA 加一次 DRAW_PRIMITIVES），最后 PRESENT。

最有意思的发现是：**顶点到达时已经变换好了**（`POSITIONT`，屏幕坐标）。命令流里没有 SETTRANSFORM、SETLIGHT、SETMATERIAL，也没有着色器。DDI 7 的 HAL 把变换和光照留给了客户机里的 Direct3D 运行时。这意味着宿主只要做光栅化、纹理阶段的混合和各种渲染状态（混合、深度、alpha test、雾），不需要一整条固定管线；但代价是这部分计算挪到了模拟出来的 CPU 上。这一点后面会变得很重要。

## 第三步：用 WebGL2 执行 SVGA3D

渲染器在 `src/vmware_svga3d.js` 里，跑在模拟器的 worker 中。它要处理 surface 和各种格式（包括 DXT 压缩纹理）、context、清屏、绘制、present，以及后来加上的固定管线变换、光照和纹理混合器。Direct3D 9 的着色器字节码（SM 2 和 3）由 `src/vmware_svga3d_shader.js` 翻译成 GLSL ES 3.00。

D3D 和 WebGL2 之间有不少差距，开工前调研时我列了一张单子：

- WebGL2 没有固定管线，也没有 alpha test，都要在生成的着色器里模拟。
- BGRA、1555、4444 这类像素格式要重新打包；调色板纹理要自己处理；DXT 需要 `WEBGL_compressed_texture_s3tc` 扩展。
- 没有 clamp-to-border，没有用户裁剪平面。
- D3D 的深度范围、半像素偏移和 Y 轴方向都和 GL 不一样。
- DMA 回读和快照需要从 GPU 读回像素。

10 月 11 日晚上，第一个 Direct3D 7 立方体在 WebGL2 上画了出来。接着 VMware 的 Mesa OpenGL 驱动跑通了，然后是 Direct3D 8 和 9：这两者借用了 WineD3D 1.7.52，它把 D3D 调用翻译成 OpenGL，交给 Mesa 驱动，Mesa 再生成 SVGA3D 命令。

![d3d9spin 在浏览器里的 XP 上运行：Direct3D 9 经 WineD3D 变成 OpenGL，再经 VMware 的 Mesa 驱动变成 SVGA3D 命令，最后由 WebGL2 画出来](/media/blog/webulator-xp-gpu/d3d9spin-wined3d-mesa.jpg)

## 显存访问里的一个 Proxy

能画出来之后，d3d9spin 每秒只有约 6 次 present。原因在 v86 本身：`vga.svga_memory` 是一个 Proxy，每访问一个元素都会新建一个 typed array。改成 present 时直接读进一个普通的显存视图、每次屏幕刷新最多回读一次之后，d3d9spin 从每秒约 6 次 present 变成约 800 次，worker 的时间有三分之二花在了模拟 CPU 上。

## OpenArena：画对了，但慢

下一个测试是真正的游戏。我把 OpenArena 0.8.8 装进镜像，通过 VMware 的 Mesa OpenGL 驱动运行，纹理、模型和 HUD 都正确。

![OpenArena 0.8.8 走 VMware 的 Mesa OpenGL 驱动，在浏览器里的 XP 上运行](/media/blog/webulator-xp-gpu/openarena-mesa.jpg)

用 `timedemo 1; demo demo088-test1` 在 640×480 下跑一段固定录像，结果是 3398 帧、262.3 秒、**13.0 fps**。

接下来的 profile 说明了问题不在显卡这一侧。worker 的 CPU 时间：客户机 x86 的 JIT 代码 49%，x87 SoftFloat 30%，v86 运行时 12%，readPixels 3%，SVGA3D 的 JS 3%，显示拷贝 2%。WebGL2 这一侧已经不是瓶颈，瓶颈是模拟出来的 CPU。

再按模块统计客户机用户态的 EIP 采样：Mesa 驱动（`vmwogl32.dll`）2071 次，`openarena.exe` 1605 次，系统 DLL 391 次。**OpenGL 驱动本身在模拟 CPU 上花的时间和游戏差不多。** 这正是前面那个"顶点已经变换好"的发现的另一面：Mesa 和 WineD3D 在客户机里做的所有工作，都是在一颗约 300 MHz 的模拟 Pentium 上做的。

把这部分搬到模拟器外面，就是下一篇的内容：[绕过模拟 CPU：D3D/OpenGL API 转发与 x87 快速路径](/zh/posts/webulator-api-forwarding/)。这里先给最终的数字：

| 测试（640×480） | VMware 的 Mesa 驱动 | API 转发 |
|---|---|---|
| Irrlicht `02.Quake3Map`，OpenGL | 158 FPS，有黑块 | 329 FPS，正确 |
| Irrlicht `02.Quake3Map`，Direct3D 9 | 无数据 | 498 FPS，正确 |
| OpenArena timedemo | 14.0 fps | 16.9 fps |

OpenArena 那一栏的 14.0 fps 已经包含了 x87 快速路径的改进（从 13.0 提上来的），16.9 fps 就是之前说的"约 17 fps"。它依然被模拟 CPU 限制着。

## 放进 demo

10 月 16 日，我把它做成了 demo 里的第五台机器。页面先恢复一个 39 MB 的 XP 桌面快照，然后在客户机里打开"运行"对话框，输入命令启动 OpenArena。游戏加载时客户机要从磁盘流式读取约 130 MB 的数据（大约一分钟），之后循环播放一段录好的对局，渲染走转发的 OpenGL 路径。快照存的是桌面而不是游戏画面，因为宿主这一侧的 3D 状态目前不在快照里。

![demo 里的 OpenArena：XP 桌面快照恢复后，在客户机里启动游戏，经转发的 OpenGL 画到 WebGL2](/media/blog/webulator-xp-gpu/openarena-xp.jpg)

游戏窗口右上角的计数器是模拟机器的真实帧率。我做 demo 快照时截的几张图里，这个数字从 7 到 17 都有。demo 页面上写的预期是"个位数到十五帧左右"：限制在模拟出来的 Pentium，不在 GPU；而且在线页面还要同时画屏幕，会比 headless 测试的数字低一些。

再强调一次：这个 3D 版本在 `feat/demo-3d` 分支上，公开 demo 还没有更新。

## 改了 v86 的哪些地方

最后整理出来的是一个针对 v86 上游 `5f9a90f` 的补丁（补丁文件约 3000 行）：

| 文件 | 内容 |
|---|---|
| `src/vmware_svga.js` | SVGA II 设备：寄存器、FIFO、GMR/GMR2、3D 能力、hypercall 端口 |
| `src/vmware_svga3d.js` | WebGL2 上的 SVGA3D：surface 和格式、context、固定管线、着色器路径、流式缓冲、present |
| `src/vmware_svga3d_shader.js` | D3D9 着色器字节码（SM 2/3）到 GLSL ES 3.00 |
| `src/vmware.js` | VMware backdoor 的 GuestRPC（驱动日志，回答 `guestinfo.svga.enableOpenGL`） |
| `src/rust/cpu/cpu.rs`、`src/rust/js_api.rs` | 用户态访问 hypercall 端口；给 JS 用的无副作用地址翻译和 JIT 失效 |
| `src/rust/softfloat.rs` | x87 快速路径 |

后三行是为 API 转发和 x87 加的，下一篇再讲。构建放在 Docker 里，可复现：10 月 16 日的一次干净构建和部署的核心逐字节一致。

## 还没做的

- 3D 画面直接画进显存里窗口所在的区域，盖在 3D 窗口上面的其他窗口会被覆盖掉。
- 没有立方体纹理和体积纹理，没有用户裁剪平面，没有顶点混合；固定管线忽略纹理变换和 texgen；只有一个渲染目标。
- 需要 WebGL2（DXT 纹理还需要 `WEBGL_compressed_texture_s3tc`）。

从提交记录看，显卡这一侧推进得很快：从 XP 在 v86 上跑起来，到 Mesa、WineD3D 都能通过 WebGL2 出图，相关提交都在 10 月 11 日这一天。真正难的是另一边：显卡再快，也要等一颗 300 MHz 级别的模拟 CPU 把命令算出来。
