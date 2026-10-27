---
title: "把一张截图变成一台活电脑：我为什么做 Webulator"
description: "Webulator 把 v86、Mini vMac、Basilisk II、SheepShaver 这几个浏览器模拟器包成一套 API：同样的输入、同样的快照、同样的一致性测试。四台老电脑从快照里醒来，第一帧和存档时逐像素一致。"
pubDate: 2026-10-11T00:00:00Z
heroImage: "/media/blog/webulator-intro/demo-page.png"
tags: ["技术", "模拟器", "WebAssembly", "Webulator"]
lang: zh
---

在线演示：[novashang.github.io/webulator](https://novashang.github.io/webulator/) · 源码：[NovaShang/webulator](https://github.com/NovaShang/webulator)

## 起因：一个操作系统博物馆

我一直想做一个能亲手操作的操作系统博物馆，工作名叫 OS Museum：按"时间 × 组件"把几十年来各代系统的界面摆在一起，比如 1984 年到今天的文本编辑器，Mac 和 Windows 并排对比。我手上有一批现成的收藏：VMware 格式的 x86 虚拟机、Mini vMac 格式的经典 Mac 镜像，还有按组件和系统两个维度整理过的几百张截图。

同类项目各擅一面。PCjs、v86、Infinite Mac 解决了"在浏览器里跑老系统"，另一些网站解决了"把截图陈列出来"。我想要的是把两件事合在一起：页面上看到的是一张窗口截图，点一下，它就在原地活过来，光标开始闪，可以打字、开菜单。窗口外面仍然是网页，不弹出一整块桌面。

这个效果背后只有一个前提：**截图就是快照恢复后的第一帧**。每个展品在生产时同时导出虚拟机快照和恢复后的首帧截图，页面先显示截图，点击后在后台恢复快照，再把活的画布换上来。两者必须像素级一致，否则切换的那一下就会跳。

所以整件事落到几个很具体的技术问题上：

- 浏览器里恢复一台机器的快照要多久？快照有多大？
- 恢复后的第一帧能不能和存档时的画面完全一样？
- 经典 Mac 的几个模拟器本身没有存档功能，能不能给它们加上？
- Mac 和 Windows 用的是完全不同的模拟器，上层代码能不能不管这些差别？

最后这个问题的答案就是 Webulator。

## 一套 API，严格一致

Webulator 把多个 WebAssembly 模拟器包成一套浏览器 API。第一个使用方是 OS Museum，但 API 本身不依赖博物馆。用起来是这样的：

```ts
const m = await Machine.create({
  profile: await loadProfile(".../sheepshaver-g3bw-macos904.json"),
  disks: [{ id: "hd0", source: { manifest: ".../macos904.manifest.json" } }],
  snapshot: { url: ".../finder.webusnap" },   // 从存档启动，而不是冷启动
  display: canvas,
});
m.input.pointer.moveTo(20, 8);                 // 按客户机像素精确落点
m.input.pointer.button(0, true);
const state = await m.saveState();             // 之后可以在一个全新的页面里恢复
```

换成 Windows 98，只需要换一个 profile，其余代码不变。写规格的时候我给自己定了几条原则，后面所有的取舍都从这里来：

1. **能力严格一致，不做最小公约数。** 契约里的每一项能力，每个核心都必须完整实现，并通过同一套一致性测试。有核心做不到的，就不进当前版本，等所有核心都能做到再一起加。没有"可选能力"。
2. **能力和硬件属性分开。** "能不能存档""鼠标能不能精确落点"是能力，必须一致；"是 68k 还是 x86""有几个鼠标键""有没有滚轮"是被模拟机器的属性，API 统一暴露，取值可以不同。在单键 Mac 上按右键会直接报错，不做静默映射。
3. **快照是一等公民。** "一张截图瞬间变成活的机器"是这个库存在的首要理由。
4. **尽量不改模拟器源码。** 优先用编译参数和宿主层实现契约。必须改的时候，只加一小叠补丁，锁定上游版本。

第一版契约有八项能力：生命周期、画面、键盘、指针、磁盘、快照、虚拟时钟、无头运行。音频、运行中换盘、网络、剪贴板都没进 v1，原因都是"至少有一个核心目前做不到，或者还没验证"。比如 Mini vMac 没有以太网，所以网络只能等下一版。

## 四个核心，三种 CPU

| 核心 | 架构 | 机型 | 系统 | 许可证 |
|---|---|---|---|---|
| v86 | x86 | PC | Windows 98 | BSD-2-Clause |
| Mini vMac | 68k | Macintosh Plus | System 6.0.8 | GPL-2.0 |
| Basilisk II | 68k | Quadra 650 | System 7.5.3 | GPL-2.0 |
| SheepShaver | PowerPC | Power Macintosh G3 | Mac OS 9.0.4 | GPL-2.0 |

v86 直接用上游的 npm 包。三个 Mac 核心用的是 Infinite Mac 项目的 Emscripten 构建，Mac 的磁盘镜像也来自 Infinite Mac，Windows 98 镜像来自 v86 的演示站。

每台机器独占一个 Worker。Mac 模拟器的主循环会阻塞 Worker 线程，运行中收不到 `postMessage`，所以主线程到 Worker 的实时控制（暂停、存档请求、输入）全部走 SharedArrayBuffer 里的一块控制区和一个输入环形缓冲。这要求页面处于 cross-origin isolated 状态。

磁盘镜像按 256 KB 切块、按内容哈希命名，按需从网络读取；客户机的写入进入一个 4 KB 粒度的覆盖层，可以导出、导入，也会被打进快照。

## 为什么 x86 选 v86

做之前我先比了一下浏览器里能跑 x86 的两个选择：v86 和 qemu-wasm，再拿原生 QEMU（纯 TCG 翻译，没有硬件虚拟化）做参照。测试机是 Apple M2，无头 Chromium，客户机是 v86 演示站的那张 Windows 98 盘，128 MB 内存。

CPU 微基准用同一张 512 字节的启动软盘，跑一个固定的 8 条指令循环，按客户机时钟计时（数值越大越好）：

| 引擎 | 32 位保护模式 | 相对原生 QEMU |
|---|---|---|
| 原生 QEMU（TCG） | 1,413,264 | 1.00× |
| v86 | 718,185 | 0.51× |
| qemu-wasm | 353,178 | 0.25× |

Windows 98 实测（秒，中位数，越小越好）：

| 引擎 | 开机到桌面 | 开始菜单打开 | 记事本打开 | 快照恢复 |
|---|---|---|---|---|
| 原生 QEMU（TCG） | 13.71 | 0.51 | 0.43 | 0.04 |
| v86 | 13.89 | 0.22 | 0.13 | 0.04 |
| qemu-wasm | 32.95 | 1.75 | 1.74 | 0.29 |

引擎本身的下载体积，v86 gzip 后 0.4 MB，qemu-wasm 是 14.8 MB。

结论很清楚：v86 的 CPU 循环大约是原生 QEMU 的一半，Win98 开机时间基本打平（开机主要耗在磁盘和定时器上），下载小 35 倍。界面操作的数字 v86 甚至比原生 QEMU 还快，一部分原因是读 v86 的画布比 QEMU 的 `screendump` 便宜，这个不能算 v86 真的更快。另外一点让我很放心：v86 和原生 QEMU 在进程内恢复快照都只要 40 ms 左右，一旦状态在内存里，唤醒一个展品基本是瞬间的事。真正的成本在于把快照传过来。

qemu-wasm 当时还不适合做主力：为了拿到画面要重编两次，最后只能通过监视器命令读屏。我把它留在研究线上，留给 v86 做不到的事。

## 快照：四台机器瞬间醒来

演示页上有四台机器。默认不是冷启动，而是下载一份存档，在一个全新的 WebAssembly 实例里恢复。下面是一致性测试里的实测（无头 Chromium，Apple M2）：

| profile | 冷启动 | 快照（gzip） | 恢复到首帧 | 首帧与存档 |
|---|---|---|---|---|
| Mini vMac · System 6.0.8 | 2.7 s | 0.57 MB | 46 到 85 ms | 一致 |
| Basilisk II · System 7.5.3 | 4.0 s | 2.0 MB | 77 到 140 ms | 一致 |
| SheepShaver · Mac OS 9.0.4 | 27.9 s | 11.1 MB | 158 到 217 ms | 一致 |
| v86 · Windows 98 | 19.1 s | 12.4 MB | 137 到 170 ms | 一致 |

Mac OS 9 冷启动要将近半分钟，从快照恢复不到 0.25 秒，而且第一帧和存档时的画面 0 像素差。这正是 OS Museum 需要的"截图原地活过来"。

v86 自带 `save_state()`，接上就行。难的是三个 Mac 核心：它们都是阻塞式主循环，本来没有存档功能。存档这件事最后没改它们的源码，只改了编译参数，用 Emscripten 的 Asyncify 在输入轮询处把调用栈展开到线性内存里，再把整块内存存下来。过程中还发现，如果客户机能"看到"存档和恢复之间流逝的时间，Basilisk II 恢复后会慢到打开计算器要 5 到 8 秒，所以必须给它一个虚拟时钟。这部分细节比较多，单独写了一篇：[给经典 Mac 模拟器加存档](/zh/posts/webulator-mac-snapshots/)。

快照文件绑定核心的构建哈希，恢复时构建不同就直接拒绝，不尝试兼容。内存布局和回卷入口都和某一次具体的构建绑定，兼容是做不到的；而展品本来就是脚本生成的，核心一重编，快照全部重新生成即可。

## 一致性测试：让五个系统打同一行字

"严格一致"如果只写在文档里，是没有意义的。所以每个 profile 都必须通过同一套测试，测试在 Playwright 驱动的无头 Chromium 里运行：

| # | 测什么 |
|---|---|
| T1 | 冷启动到桌面稳定 |
| T2 | 存档 → 销毁 → 在新 Worker 里恢复，首帧 0 像素差，连续 5 次 |
| T3 | 恢复后可用：菜单能开，程序能开 |
| T4 | 存档后隔至少 60 秒再恢复，响应和刚恢复时一样 |
| T5 | 暂停 10 秒，客户机时钟不走，也不出帧 |
| T6 | `moveTo` 到 20 个随机点，光标全部精确落点 |
| T7 | `type()` 打出全部 95 个可打印 ASCII 字符，和金图对比 |
| T8 | 导出磁盘覆盖层，在一台新机器里启动，写过的文件还在 |
| T9 | 客户机忙着开机时请求存档，仍能完成并恢复 |
| T10 | T7 的约 380 个按键事件连续发送，一个不丢 |
| T11 | 不接画布，T1 到 T3 照样通过 |
| T12 | 每次取盘块延迟 400 ms，指针移动时帧间隔不能到 200 ms |

四个 profile 全部通过十二项。

我最喜欢的是 T7。每个系统都打开一个文本编辑器，用同一个 `type()` 打同一串字符：从 `!` 到 `~` 的全部可打印 ASCII。然后只比较 1.5 秒内保持不动的像素（这样闪烁的插入符不算），和事先录好、人工核对过的金图逐像素对比。下面就是五张金图：System 6 用的是 TeachText，System 7.5 和 Mac OS 9 用便笺（Stickies），Windows 98 和 XP 用记事本。记事本默认不自动换行，所以那边每 32 个字符换一行。

![System 6.0.8（Mini vMac）](/media/blog/webulator-intro/t7-minivmac-plus-system608.png)

![System 7.5.3（Basilisk II）](/media/blog/webulator-intro/t7-basilisk2-quadra650-system753.png)

![Mac OS 9.0.4（SheepShaver）](/media/blog/webulator-intro/t7-sheepshaver-g3bw-macos904.png)

![Windows 98（v86）](/media/blog/webulator-intro/t7-v86-win98.png)

![Windows XP（v86）](/media/blog/webulator-intro/t7-v86-winxp.png)

看起来平平无奇，但要让它通过，键盘这一层得做不少事。API 用 W3C 的 `KeyboardEvent.code` 表示物理键，Mac 核心需要一张转 ADB 键码的表；需要 Shift 的字符要自动补 Shift；而且 Basilisk II 和 SheepShaver 每个 60 Hz 中断只缓冲 16 个 ADB 事件，Windows 98 的键盘缓冲也会溢出。所以适配器按客户机时间每 8 ms 送一个按键事件，队列保序，T10 就是专门检查这件事的。

T6 也有意思。它在纯色区域里比较移动前后的两帧，找出光标的包围盒，要求 20 个点的偏移全部相同。如果有缩放或取整误差，偏移就会随位置变化，测试就会失败。Mac 核心原生支持绝对坐标；v86 这边要给 Windows 98 装一个绝对鼠标驱动（VBADOS 里的 VBMOUSE），而且客户机驱动只在收到 PS/2 中断时才读位置，所以每次移动前还要先发一个非零的相对位移把中断"敲"出来。

## 一路上的几个坑

测试跑通之前，也碰到一些只有真跑起来才会发现的问题，记几个：

- **鼠标在 Mac OS 9 上发黏。** 鼠标悬停移动时 SheepShaver 只有 7 帧每秒，延迟中位数 303 ms，但拖动时很顺。原因是 SheepShaver 每执行 5 万条指令才检查一次 60 Hz 的 tick（它驱动屏幕刷新和光标），而客户机空闲时 Worker 每次空闲等待最多阻塞 8 ms，tick 被拖到大约 160 ms 一次。拖动时客户机在忙，不走空闲路径，所以不卡。改成空闲等待在下一次刷新到期时结束之后，帧率到 46，延迟中位数降到 35 ms。
- **v86 不能画得更勤。** 我把所有核心的出帧下限从 16 ms 降到 12 ms，免得稍早到的一帧被推到下一个周期。但 v86 不行：它渲染时也会翻转垂直回扫位，阈值改成 14 ms 后，Windows 98 在 8 次冷启动里有 3 次卡在开机画面。
- **Windows 98 偶尔卡在开机画面。** 装了 VBMOUSE 之后，大约 12 次冷启动有 1 次挂住。挂住时 IDE 已经完成一次传输，但中断一直没送达；同一个运行时启动不带 VBMOUSE 的镜像 12 次全部正常。比较可能的原因是 VBMOUSE 初始化时一个过早的 PS/2 鼠标中断没有被确认，挡住了优先级更低的磁盘中断。从快照恢复不受影响，这也是快照的另一个好处。
- **磁盘一慢，整台机器就停。** 磁盘放到对象存储之后每块要 0.4 到 0.5 秒，最初的实现在核心线程里同步取块，取块期间客户机整个停住，连光标都不动。真机不是这样的：磁盘忙的时候 CPU 照常跑、照常响应中断。T12 就是为这个加的，修法在[第二篇](/zh/posts/webulator-mac-snapshots/)里。

## 下一站：Windows XP 和魔兽争霸 III

四台机器跑通以后，我开始往更新的系统推。上面那张 Windows XP 的金图就是后来加进来的第五个 profile。

做 XP 的时候，我给自己定了一个更具体的目标：**在浏览器里的 Windows XP 上跑魔兽争霸 III。** 先量了一下 CPU：XP 在 v86 上忙碌时大约 250 到 280 MIPS，相当于一颗 300 到 500 MHz 的 Pentium II/III，正好卡在魔兽争霸 III 的最低配置（PIII 400）附近。日常操作没问题，重一点的游戏场景就难说了。

更大的问题是图形。v86 的显示只有 VGA 和 VBE，没有任何 3D 硬件，而魔兽争霸 III 是 Direct3D 8 游戏。要让 XP 有一块"显卡"，就得在 v86 里实现一块客户机驱动认识的虚拟 GPU，再把它的 3D 命令翻译成 WebGL2。这件事和后面绕过模拟 CPU 的尝试，我分成两篇写：

- [在浏览器里给 Windows XP 装一块显卡：SVGA3D 到 WebGL2](/zh/posts/webulator-xp-gpu/)
- [绕过模拟 CPU：D3D/OpenGL API 转发与 x87 快速路径](/zh/posts/webulator-api-forwarding/)
