---
title: "Bypassing the Emulated CPU: D3D/OpenGL API Forwarding and an x87 Fast Path"
description: "Once browser XP had a virtual graphics card, the bottleneck became the graphics drivers running on the emulated CPU. I wrote two stand-in DLLs that hand Direct3D 9 and OpenGL calls straight to WebGL2 outside the emulator, and gave v86's x87 floating point a native f64 fast path."
pubDate: 2026-10-12
heroImage: "/media/blog/webulator-api-forwarding/irrlicht-forwarded-d3d9.jpg"
tags: ["Tech", "Emulation", "Webulator", "WebGL", "Windows XP"]
lang: en
---

The [previous post](/en/posts/webulator-xp-gpu/) covered adding a VMware SVGA II card to v86 and executing the XP driver's SVGA3D commands with WebGL2. With the card in place, OpenArena drew correctly but at only 13 fps, and the profile showed the GPU side was no longer the bottleneck.

This post covers the two things that came next: forwarding Direct3D and OpenGL calls straight out of the guest, so graphics drivers no longer run on the emulated CPU, and a fast path for v86's x87 floating point. All numbers come from my development notes, commits and screenshots; the test machine was headless Chromium on an Apple M2, at 640×480.

As before: **the 3D build is only on the `feat/demo-3d` branch; the public demo doesn't have it yet.**

## Where it started: Warcraft III and a 300 MHz CPU

The original goal of this round was Warcraft III on browser XP. XP on v86 runs at about 250 to 280 MIPS while busy, roughly a 300 to 500 MHz Pentium II or III. Warcraft III's minimum is a Pentium III 400, right on the line. My note at the time: the desktop is fine, heavy game scenes may not be; together with the quality of the 3D translation, that was the main risk.

So every emulated CPU cycle is expensive, and the VMware driver path runs a lot inside the guest:

- VMware's XP driver is a DDI 7 HAL: vertices arrive already transformed, because transform and lighting are done by the Direct3D runtime in the guest.
- OpenGL programs go through VMware's Mesa driver (`vmwogl32.dll`), which turns GL calls into SVGA3D commands inside the guest.
- Direct3D 8 and 9 programs add a WineD3D layer on top, translating to OpenGL first and then handing off to Mesa.

OpenArena's profile was blunt. Sampling the guest's user-mode EIP by module: the Mesa driver 2071 samples, the game 1605, system DLLs 391. The driver ate about as much emulated CPU as the game.

## The idea: replace d3d9.dll and opengl32.dll in the guest

I emulate the card and I execute the SVGA3D commands, so there's no need for a driver inside the guest to produce them. I wrote two user-mode runtimes:

- `d3d9.dll` (`d3d9fwd.c`, about 2,200 lines): a Direct3D 9 runtime.
- `opengl32.dll` (`glfwd.c`, about 2,000 lines): an OpenGL 1.x runtime.

You drop the DLL next to the application's exe. When the application calls Direct3D or OpenGL, the DLL writes SVGA3D commands directly in the application's own process, collects them in a buffer, and hands them to the emulator with one instruction:

```c
__asm__ volatile("outl %0, %w1" : : "a"(v), "Nd"(0x5680) : "memory");
```

`eax` holds the address of a small struct with the command buffer's address and length. While the emulator executes that `out`, it runs the whole batch on the existing WebGL2 renderer. The commands are ordinary SVGA3D commands, the same as the VMware driver sends through the FIFO (plus a few custom ones, such as a log command), so both paths share one renderer.

To make this work, v86 needed three changes:

1. **User mode can reach the port.** A normal application runs in ring 3, where `out` raises a protection fault. I opened up port 0x5680 in v86's I/O permission check, the same way VMware's backdoor port works.
2. **No copies.** Vertex, index and texel data are not copied into the command buffer. Commands carry the data's linear address in the application (I defined a pseudo-GMR, `0xFFFFFFFD`, meaning "this is a linear address"), and the emulator reads it through the guest's page tables. That needed a side-effect-free address translation: no page faults, no accessed/dirty bits.
3. **JIT invalidation when the emulator writes guest memory.** Operations like pixel read-backs write guest memory, so compiled code on those pages has to be dropped.

One more detail: if the emulator can't read or write a page (for example, it isn't in memory at the moment), it can't service the page fault on the guest's behalf. Instead it stops and reports the faulting address and how many bytes it got through; the DLL in the guest touches that address (reading, or writing if needed) so Windows pages it in, then resubmits the rest.

The renderer also gained what the VMware driver path never needed: fixed-function transform and lighting (world/view/projection matrices, 8 lights, material sources, vertex fog). The guest used to compute all that; now the host does.

## Direct3D: start with the simplest test

The first test program is d3d9spin: a spinning cube, one draw per frame.

| Test | WineD3D + Mesa | Forwarded |
|---|---|---|
| d3d9spin (one draw per frame) | ~800 presents/s | ~23,000/s |
| d3d8spin | no data | ~19,000/s |

I didn't write a Direct3D 8 runtime. crosire's [d3d8to9](https://github.com/crosire/d3d8to9) turns D3D8 calls into D3D9, which land on my `d3d9.dll`. My only patch to it removes a dialog about a missing `d3dx9_43.dll`.

A more realistic scene: the `02.Quake3Map` example from Irrlicht 1.8.5. On the Mesa driver it ran at 158 FPS with large black patches; the first forwarded Direct3D 9 version ran at 389 FPS and rendered correctly; by the time OpenGL forwarding was also done, that number was 498 FPS.

![Irrlicht's Quake 3 map example on VMware's Mesa OpenGL driver: the title bar shows OpenGL 2.1 and 158 FPS, with large black patches](/media/blog/webulator-api-forwarding/irrlicht-mesa-gl.jpg)

![The same example on forwarded Direct3D 9: the title bar shows 498 FPS, rendered correctly](/media/blog/webulator-api-forwarding/irrlicht-forwarded-d3d9.jpg)

## OpenGL: a state machine translated into D3D-style commands

OpenGL is more work, because OpenGL is a state machine and SVGA3D follows Direct3D's model. `glfwd.c` tracks all GL state in the DLL and, before each draw, translates what changed into SVGA3D render and texture states; the renderer does the fixed-function work.

It implements all 336 OpenGL 1.1 exports (every one must exist with the right stack size; the stubs are generated from mingw-w64's `GL/gl.h`), plus WGL, multitexture, `texture_env_combine`, `compiled_vertex_array`, vertex buffer objects, S3TC and BGRA vertex arrays. A few conventions:

- The host renders in Direct3D's orientation (row 0 at the top) and expects clip-space z in [0, w].
- OpenGL matrices are passed through unchanged: a column-major OpenGL matrix and a row-vector Direct3D matrix have the same memory layout, so only the projection's z needs remapping.
- Viewports, scissors and read-backs flip y.

As with D3D, vertex data avoids copies where possible: the host reads client arrays and indices straight from the application's memory, one hypercall per draw. Only `glBegin`/`glEnd`, which submits vertex by vertex, goes through a buffer in the DLL first.

To check the many vertex-array combinations I wrote a small program, `glarrays`: 12 cells, each drawing the same quad with a different vertex-array setup (separate arrays, interleaved arrays, BGRA colours, 16- and 8-bit indices, indices with an offset, two texture units, `glBegin`/`glEnd`, buffer objects and so on). Every cell should show red at the top left, green at the top right, blue at the bottom right and white at the bottom left.

![glarrays on VMware's Mesa driver](/media/blog/webulator-api-forwarding/glarrays-mesa.jpg)

![glarrays on the forwarded opengl32.dll](/media/blog/webulator-api-forwarding/glarrays-forwarded.jpg)

All 12 cells draw on both, with matching corner colours. The one visible difference is the 8th cell (`GL_QUADS` drawn with `glBegin`/`glEnd`): on Mesa the colour gradient runs along the other diagonal. OpenGL doesn't specify which diagonal a quad is split along, so I didn't treat it as a bug.

## Two renderer bugs along the way

With OpenArena hooked up, the forwarded version first ran at 2 fps. I had been putting small streamed pieces of vertex data into one large GL buffer and updating a small range at a time; but when queued draws still used that buffer, the browser copied the whole thing. Giving each piece its own GL buffer took it from 2 to 15 fps.

The other bug was occasional half-drawn frames. Presents used to be read back from the back buffer at the next screen refresh, by which time the application had often started drawing the next frame into the same back buffer. Presents now copy into a front texture immediately.

## The x87 fast path

The x87 fast path actually came one step before forwarding. In the profile from the previous post, the biggest item after guest JIT code was x87 SoftFloat, at 30% of worker time.

v86 computes every x87 operation with an 80-bit SoftFloat software implementation. But many Windows programs don't use 80-bit precision: x87 has a precision-control field, and MSVC and Windows default to 53 bits, while Direct3D sets 24 bits by default.

The fast path applies when the rounding mode is round-to-nearest, precision control is 53 or 24 bits, both operands are exactly representable as doubles, and the result is a normal number. Then:

- 53-bit rounding is IEEE double rounding, so native f64 add, subtract, multiply and divide give the same result as SoftFloat.
- At 24 bits, computing in double and then rounding to float also gives the correctly rounded single-precision result, because 53 ≥ 2×24+2.
- Everything else (other rounding modes, 80-bit precision, denormals, infinities, NaNs, overflow, underflow) falls back to SoftFloat.

Float loads and stores (conversions between f32, f64 and 80-bit) follow the same idea. One caveat: the fast path does not raise the inexact status flag. Checked against SoftFloat on 168 million random cases, across all precision and rounding combinations, the results were bit-identical.

The gain on OpenArena was small: the timedemo went from 13.0 to 14.0 fps. OpenArena is built with MinGW and runs at 80-bit precision, so its arithmetic can't take the fast path; it mostly gains from faster float loads and stores.

Around the same time I also tried polling the FIFO with the hardware timers. That gave 12.6 fps, slower than without it, so I reverted it.

## Results

![The result lines of three OpenArena timedemo runs, top to bottom: Mesa driver, Mesa driver with the x87 fast path, forwarded opengl32.dll. The numbers are frames, seconds, average fps, and min/avg/max/std-dev frame time in ms](/media/blog/webulator-api-forwarding/timedemo-results.png)

| Test (640×480) | VMware's Mesa driver | Forwarded |
|---|---|---|
| d3d9spin | ~800 presents/s (WineD3D + Mesa) | ~23,000/s |
| Irrlicht `02.Quake3Map`, OpenGL | 158 FPS, black patches | 329 FPS, correct |
| Irrlicht `02.Quake3Map`, Direct3D 9 | no data | 498 FPS, correct |
| OpenArena `demo088-test1` | 14.0 fps | 16.9 fps |

The same 3398-frame OpenArena recording:

| Build | Total time | Average | Frame time min / avg / max |
|---|---|---|---|
| Mesa driver | 262.3 s | 13.0 fps | 27.0 / 77.2 / 211.0 ms |
| Mesa driver + x87 fast path | 242.8 s | 14.0 fps | 24.0 / 71.5 / 164.0 ms |
| Forwarded + x87 fast path | 201.6 s | 16.9 fps | 19.0 / 59.3 / 131.0 ms |

The Irrlicht example gets a multiple; OpenArena only goes from 14.0 to 16.9 fps. The conclusion in my notes: OpenArena is now bound by the emulated CPU, specifically its own x87 maths, built with MinGW at 80-bit precision, which is exactly what the fast path can't help.

![OpenArena in the demo, rendered through the forwarded opengl32.dll](/media/blog/webulator-api-forwarding/openarena-xp.jpg)

## What about Warcraft III?

My records from these days have no Warcraft III result. It is a fixed-function Direct3D 8 game, so by design it would take the d3d8to9 plus forwarded `d3d9.dll` path, but I have no measurements, so I won't guess here. What went into the demo is OpenArena: the page restores the XP desktop snapshot, starts the game in the guest, and renders through forwarded OpenGL, with the frame rate shown at the top right of the game window. That demo is also only on the `feat/demo-3d` branch for now.

## What's missing

- `d3d9.dll`: no cube or volume textures, no `ProcessVertices`, patches, or swap chains beyond the implicit one; shader model 2.0 caps. D3D8 applications with shaders need `d3dx9_43.dll` next to them, because d3d8to9 uses it to assemble shaders.
- `opengl32.dll`: OpenGL 1.5 without GLSL; no texgen, texture matrices, clip planes, display lists (compiled lists are dropped), `glCopyTexImage`, cube maps or framebuffer objects.
- The 3D frame is drawn straight into VRAM over the window's area, so windows on top of it get painted over.
