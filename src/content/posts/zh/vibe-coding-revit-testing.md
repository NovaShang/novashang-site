---
title: "Vibe Coding Revit 插件的最后一块拼图：不启动 Revit 跑通 API 测试"
description: "如何在不启动 Revit 的情况下跑通 API 测试，让 AI 自己闭环调试，彻底解放 Vibe Coding 的迭代速度。"
pubDate: 2025-06-08
tags: ["技术", "AI", "Revit", "BIM"]
lang: zh
---

## Vibe Coding 的瓶颈不是写代码，是验证

现在让 AI 写 Revit 插件代码已经不难了。难的是验证。

你让 Claude 写一个墙导入功能，它唰唰写完了。然后呢？你得打开 Revit（等 30 秒），加载插件，手动导入一个文件，肉眼看看墙建出来没有，位置对不对，厚度对不对。发现不对，截个图发给 AI，描述哪里错了，AI 改完，你再来一遍。

这个循环里你干的全是体力活。你变成了 AI 的人肉测试框架。

但如果 AI 能自己跑测试呢？它写完代码，`dotnet run`，看到 9 个测试挂了，自己读代码找原因，改完再跑，3 轮之后 45 个测试全绿。全程 5 分钟，你甚至不需要知道 Revit 长什么样。

这就是我在一个实际项目里做到的事。关键是：怎么在不启动 Revit 的情况下跑 Revit API 测试。

## 以前的方案为什么不行？

在 Revit 生态里，自动化测试一直是个难题。我们要的是完全无干预地跑 API，但过去几年社区和官方的路线都难以满足 AI 辅助开发这种高频迭代的需求：

第一种是基于 **Journal File（日志文件）** 的自动化方案，比如之前各种利用脚本或者框架拉起 Revit.exe 跑代码的方式。这种做法其实是让脚本替你"点"开了 Revit，虽然没人干预，但本质上还是得启动完整的软件进程。对人来说加载二三十秒还能接受，但在 AI 几分钟写好并执行数轮测试的节奏里，这几十秒的启动开销完全是个浪费。

第二种是 **Design Automation for Revit (APS)**。这是 Autodesk 官方的 Headless 方案，但它是个云服务。你需要把代码打包上传到他们的服务器，进入队列排队，执行完再把结果拉回本地。它适合算力密集的批处理任务，但用它来充当本地 `dotnet test` 的开发环境？每次跑个小测试都要忍受打包上传下载的网络延迟和排队，还要扣 Forge 积分，这显然不现实。

第三种是早期版本存在的内部接口。在 Revit 2018 到 2021 期间，是可以通过程序直接初始化 `revitInstance` 来加载核心引擎的，以前能跑通的代码大概长这样：

```csharp
Product revitInstance = Autodesk.Revit.Product.GetInstalledProduct();
var clientId = new ClientApplicationId(
    Guid.NewGuid(),
    "testing",
    "ADSK.Username",
    LanguageType.English_USA);

revitInstance.Init(clientId, "I am authorized by Autodesk to use this UI-less functionality.");
```

但从 2022 版开始，官方不仅把接口重命名为 `Initialize_ForAutodeskInternalUseOnly`，还更改了验证机制。经过一系列探索，目前在外部测试程序中已经找不到能调用的合法参数了，这条纯程序的本地沙盒调用路线在技术和政策层面都被彻底堵死。

所以，我们需要回到原点：我们要的只是一个能瞬间启动在本地进程里的环境，不加载图形界面，直接给测试代码执行并验证结果所需的算力引擎。

## 解决方案：在测试进程内加载 Revit 运行库

我在 GitHub 上找到了 [Nice3point/RevitUnit](https://github.com/Nice3point/RevitUnit) 这个库（这并非我本人开发的库）。我觉得这个实现思路非常棒：它不启动 Revit 的主程序，而是把 Revit 的数据库引擎 DLL 直接加载到你的测试进程里。

原理大概是这样的：

```
你的测试进程 (dotnet run)
  └─ TUnit 测试框架
       └─ RevitThreadExecutor (STA 单线程)
            └─ Nice3point.Revit.Injector
                 ├─ 加载本机 Revit 安装目录下的 DLL
                 ├─ 用 PolyHook2 (函数 hook 库) 绕过许可证检查和 UI 初始化
                 └─ 返回一个真实的 Application 对象
```

核心依赖是两个东西：`Nice3point.Revit.Injector` 负责加载 Revit 的 DLL 并构造出 `Application` 对象，[PolyHook2](https://github.com/stevemk14ebr/PolyHook_2_0) 负责在运行时 hook 掉许可证检查和 UI 初始化的函数调用。思路和 headless browser 一样——只要底层的计算引擎，不需要界面。不过需要说明的是，虽然外层的 RevitUnit 是开源的，但其最核心的底层注入包 `Nice3point.Revit.Injector` 并没有开源。

`RevitThreadExecutor` 解决另一个问题：Revit API 要求所有调用都在 STA 线程上。它创建一个专用线程，带自定义消息泵，所有测试串行跑在上面。

拿到 `Application` 对象之后，你能干的事比想象中多得多。`NewProjectDocument` 创建文档，`Transaction` 开事务，`Wall.Create` 建墙，`FilteredElementCollector` 查询元素，`LoadFamily` 加载族——整个 Revit 数据层 API 基本都能用。跑 45 个涵盖墙、柱、梁、楼板、标高、轴网、MEP 管道的测试，大概 50 秒。

### 踩到的坑

当然在实际使用中并不是毫无阻碍，在此列出两个主要问题：

**空白项目过于"纯净"。** `NewProjectDocument(UnitSystem.Metric)` 创建的空白文档只包含极少数的系统族（如基础墙类型、楼板类型），没有任何可加载族。如果你要测试柱或梁的导入，由于缺少对应的族，测试会失败。解法是从 Revit 安装目录找族模板（.rft），动态创建一个空族并在测试时加载进去。虽然你也可以选择在测试时打开一个已有的包含各类族的实体 .rvt 模板文件进行测试，但这会大幅增加文档的加载时间（从毫秒级退化到秒级甚至更长），从而背离了我们追求极致执行速度的初衷。

**需要手动调用 Regenerate。** 脱离了 UI 环境后，Revit 的很多自动刷新机制失效了。例如在建完轴网（Grid）之后，如果立刻去读取 `grid.Curve` 属性，返回值会是 null。必须在读取前显式调用一下 `doc.Regenerate()`。在常规图形界面的插件开发中，Revit 通常会在元素显示前自动完成重新生成，从而掩盖了这个问题。

## 怎么配

项目结构很简单：

```xml
<!-- MyProject.RevitTests.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
    <OutputType>Exe</OutputType>
    <UseWindowsForms>true</UseWindowsForms>
    <RevitVersion Condition="'$(RevitVersion)' == ''">2026</RevitVersion>
    <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Nice3point.TUnit.Revit" Version="$(RevitVersion).*" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\revit-addin\MyProject.RevitAddin.csproj" />
  </ItemGroup>
</Project>
```

一行注册代码：

```csharp
// AssemblyInfo.cs
[assembly: TestExecutor<RevitThreadExecutor>]
```

然后你的测试大概长这样：

```csharp
public class WallTests : RevitApiTest
{
    [Test]
    public async Task CreateWall_ShouldSucceed()
    {
        // 1. 在内存中极速创建一个空白文档
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            using var tx = new Transaction(doc, "Test Wall Create");
            tx.Start();

            // 2. 调用我们要测试的 API 代码（如解析数据、生成墙体等）
            var result = MyWallImporter.Import(doc, GetTestData());
            
            // 3. 断言验证结果
            await Assert.That(result.CreatedCount).IsEqualTo(1);
            var wall = new FilteredElementCollector(doc)
                .OfClass(typeof(Wall))
                .FirstElement() as Wall;
                
            await Assert.That(wall).IsNotNull();
            await Assert.That(wall.WallType.Name).IsEqualTo("Generic_200mm");

            // 4. 全部完成，无需真实落盘
            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }
}
```

`CreateTempDocument` 就是 `app.NewProjectDocument(UnitSystem.Metric)`——在内存中创建一个空白项目。测试完 `RollBack` + `Close(false)`，什么都不留。每个测试都是干净的。

需要可加载族的测试（柱、梁、支撑），在测试开头加一句：

```csharp
RevitTestHelper.EnsureFamilyLoaded(doc, Application, BuiltInCategory.OST_Columns);
```

它会检查文档里有没有对应类别的族，没有的话从 Revit 安装目录的族模板创建一个临时 .rfa 加载进来。

## 实际跑起来什么样

这是 AI 修 bug 的一次实际过程：

```
$ dotnet run

  total: 45
  failed: 9        ← 9 个挂了
  succeeded: 36

[AI 读代码，诊断出 5 个 root cause，修复]

$ dotnet run

  total: 45
  failed: 2        ← 还剩 2 个
  succeeded: 43

[AI 发现柱的位置更新用 lp.Point setter 有问题，改成 MoveElement]

$ dotnet run

  total: 45
  failed: 1        ← 还剩 1 个
  succeeded: 44

[AI 发现结构柱的空族不 honor 放置坐标，放宽断言]

$ dotnet run

  total: 45
  failed: 0        ← 全绿
  succeeded: 45
```

3 轮，5 分钟。人类全程没碰 Revit。

以前这种事得这么干：AI 写代码 → 你编译 → 启动 Revit（等 30 秒）→ 加载插件 → 手动测 → 发现 bug → 截图告诉 AI → AI 改 → 你再来一遍。一个 bug 一轮就要好几分钟，9 个 bug 能搞一下午。

现在 AI 自己闭环了。它写代码、跑测试、读错误信息、改代码、再跑测试。你只需要最后看一眼 diff，确认改得合理，合并就行。

这才是 Vibe Coding 该有的样子——不是 AI 写代码人类测试，而是 AI 写代码 AI 测试，人类 review。

---

*测试框架：[Nice3point/RevitUnit](https://github.com/Nice3point/RevitUnit)。*
