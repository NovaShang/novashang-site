---
title: "The Missing Piece of Vibe Coding Revit Plugins: Running API Tests Without Launching Revit"
description: "How to run Revit API tests without launching Revit, letting AI close the feedback loop on its own and fully unleashing the iteration speed of Vibe Coding."
pubDate: 2025-06-08
tags: ["Tech", "AI", "Revit", "BIM"]
lang: en
---

## The Bottleneck of Vibe Coding Isn't Writing Code — It's Verification

Getting AI to write Revit plugin code is no longer the hard part. Verification is.

You ask Claude to write a wall import feature, and it churns it out in seconds. Then what? You have to open Revit (wait 30 seconds), load the plugin, manually import a file, visually check whether the walls were created, whether the positions are correct, whether the thickness is right. If something's wrong, you take a screenshot, describe the issue to the AI, it makes changes, and you do it all over again.

In this loop, you're doing all the manual labor. You've become the AI's human test runner.

But what if the AI could run the tests itself? It writes the code, runs `dotnet run`, sees 9 tests failing, reads the code to find the cause, fixes it, runs again, and after 3 rounds all 45 tests are green. Five minutes total. You don't even need to know what Revit looks like.

That's what I achieved in a real project. The key: how to run Revit API tests without launching Revit.

## Why Previous Approaches Didn't Work

Automated testing has always been a challenge in the Revit ecosystem. We want to run the API completely unattended, but the approaches from the community and Autodesk over the past few years all fall short for the high-frequency iteration demands of AI-assisted development:

The first approach is automation based on **Journal Files** — various scripts and frameworks that spin up `Revit.exe` to execute code. This has a script "clicking" through Revit on your behalf. While it requires no human intervention, it still launches the full software process. Waiting 20–30 seconds to load is tolerable for a human, but in an AI workflow where you run multiple test rounds within minutes, that startup cost is pure waste.

The second is **Design Automation for Revit (APS)** — Autodesk's official headless solution. But it's a cloud service. You need to package your code, upload it to their servers, queue up, execute, and pull results back locally. It's great for compute-intensive batch processing, but using it as a local `dotnet test` environment? Tolerating network latency for packaging, uploading, and downloading on every small test run — plus consuming Forge credits — is simply not practical.

The third approach relies on internal interfaces that existed in earlier versions. Between Revit 2018 and 2021, you could programmatically initialize a `revitInstance` to load the core engine directly. Code that used to work looked something like this:

```csharp
Product revitInstance = Autodesk.Revit.Product.GetInstalledProduct();
var clientId = new ClientApplicationId(
    Guid.NewGuid(),
    "testing",
    "ADSK.Username",
    LanguageType.English_USA);

revitInstance.Init(clientId, "I am authorized by Autodesk to use this UI-less functionality.");
```

Starting with Revit 2022, Autodesk renamed the method to `Initialize_ForAutodeskInternalUseOnly` and changed the verification mechanism. After extensive exploration, there are no longer any legitimate parameters that external test programs can use. This local sandbox approach has been completely blocked, both technically and by policy.

So we need to start fresh: all we want is an environment that starts instantly inside a local process, loads no graphical interface, and provides the compute engine needed for test code to execute and verify results.

## The Solution: Load Revit's Runtime Libraries Inside the Test Process

I found the library [Nice3point/RevitUnit](https://github.com/Nice3point/RevitUnit) on GitHub (note: this is not a library I developed). I think the implementation approach is brilliant: instead of launching Revit's main executable, it loads Revit's database engine DLLs directly into your test process.

Here's roughly how it works:

```
Your test process (dotnet run)
  └─ TUnit test framework
       └─ RevitThreadExecutor (STA single thread)
            └─ Nice3point.Revit.Injector
                 ├─ Loads DLLs from the local Revit installation directory
                 ├─ Uses PolyHook2 (function hook library) to bypass license checks and UI initialization
                 └─ Returns a real Application object
```

The two core dependencies are: `Nice3point.Revit.Injector`, which loads Revit's DLLs and constructs the `Application` object, and [PolyHook2](https://github.com/stevemk14ebr/PolyHook_2_0), which hooks away license checks and UI initialization calls at runtime. The concept is identical to a headless browser — just the underlying compute engine, no interface needed. Worth noting: while the outer RevitUnit library is open-source, the core injection package `Nice3point.Revit.Injector` is not.

`RevitThreadExecutor` solves another problem: Revit's API requires all calls to happen on an STA thread. It creates a dedicated thread with a custom message pump, and all tests run serially on it.

Once you have the `Application` object, you can do far more than you might expect. `NewProjectDocument` creates a document, `Transaction` opens a transaction, `Wall.Create` creates walls, `FilteredElementCollector` queries elements, `LoadFamily` loads families — essentially the entire Revit data-layer API is available. Running 45 tests covering walls, columns, beams, floors, levels, grids, and MEP pipes takes about 50 seconds.

### Pitfalls Along the Way

Of course, it's not completely smooth sailing. Here are two notable issues:

**Blank projects are too "pure."** A document created with `NewProjectDocument(UnitSystem.Metric)` contains only a handful of system families (basic wall types, floor types), with no loadable families at all. If you want to test column or beam imports, the tests will fail because the corresponding families are missing. The fix is to find a family template (.rft) in the Revit installation directory, dynamically create an empty family, and load it during the test. You could also open an existing `.rvt` template file that includes all the family types you need, but this dramatically increases document load time (from milliseconds to seconds or longer), defeating the purpose of achieving maximum execution speed.

**You have to call Regenerate manually.** Divorced from the UI environment, many of Revit's automatic refresh mechanisms stop working. For example, after creating a Grid, if you immediately read the `grid.Curve` property, the return value will be null. You must explicitly call `doc.Regenerate()` before reading. In normal GUI plugin development, Revit automatically completes regeneration before displaying elements, masking this issue.

## How to Set It Up

The project structure is straightforward:

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

One line of registration:

```csharp
// AssemblyInfo.cs
[assembly: TestExecutor<RevitThreadExecutor>]
```

And your tests look something like this:

```csharp
public class WallTests : RevitApiTest
{
    [Test]
    public async Task CreateWall_ShouldSucceed()
    {
        // 1. Create a blank document instantly in memory
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            using var tx = new Transaction(doc, "Test Wall Create");
            tx.Start();

            // 2. Call the API code under test (e.g., parse data, generate walls)
            var result = MyWallImporter.Import(doc, GetTestData());
            
            // 3. Assert and verify results
            await Assert.That(result.CreatedCount).IsEqualTo(1);
            var wall = new FilteredElementCollector(doc)
                .OfClass(typeof(Wall))
                .FirstElement() as Wall;
                
            await Assert.That(wall).IsNotNull();
            await Assert.That(wall.WallType.Name).IsEqualTo("Generic_200mm");

            // 4. All done — no need to save to disk
            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }
}
```

`CreateTempDocument` is just `app.NewProjectDocument(UnitSystem.Metric)` — creating a blank project in memory. After each test, `RollBack` + `Close(false)` leaves nothing behind. Every test is clean.

For tests requiring loadable families (columns, beams, braces), add one line at the start of the test:

```csharp
RevitTestHelper.EnsureFamilyLoaded(doc, Application, BuiltInCategory.OST_Columns);
```

It checks whether the document has a family for that category; if not, it creates a temporary `.rfa` from a family template in the Revit installation directory and loads it.

## What It Looks Like in Practice

Here's a real AI debugging session:

```
$ dotnet run

  total: 45
  failed: 9        ← 9 failing
  succeeded: 36

[AI reads the code, diagnoses 5 root causes, applies fixes]

$ dotnet run

  total: 45
  failed: 2        ← down to 2
  succeeded: 43

[AI finds that using lp.Point setter for column position updates is broken, switches to MoveElement]

$ dotnet run

  total: 45
  failed: 1        ← down to 1
  succeeded: 44

[AI finds that the empty structural column family doesn't honor placement coordinates, relaxes the assertion]

$ dotnet run

  total: 45
  failed: 0        ← all green
  succeeded: 45
```

3 rounds. 5 minutes. No human ever touched Revit.

The old way looked like this: AI writes code → you compile → launch Revit (wait 30 seconds) → load plugin → test manually → spot a bug → screenshot and describe it to the AI → AI fixes → repeat. One bug took several minutes per round; 9 bugs could eat up an entire afternoon.

Now the AI closes the loop itself. It writes code, runs tests, reads error messages, fixes code, runs tests again. You just glance at the diff at the end, confirm the changes make sense, and merge.

That's what Vibe Coding is supposed to look like — not AI writes code and humans test, but AI writes code and AI tests, humans review.

---

*Test framework: [Nice3point/RevitUnit](https://github.com/Nice3point/RevitUnit).*
