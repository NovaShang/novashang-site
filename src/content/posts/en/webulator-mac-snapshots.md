---
title: "Save States for Classic Mac Emulators: Asyncify, a Virtual Clock, and \"Disk Busy\""
description: "Mini vMac, Basilisk II and SheepShaver have no save state. For the save states themselves I changed only build flags: I used Asyncify to unwind the call stack at the input poll, so all three classic Macs can be saved and restored in a fresh page with a pixel-identical first frame. Plus why a virtual clock is required, and how to keep the guest running while the disk is slow."
pubDate: 2026-10-02
heroImage: "/media/blog/webulator-mac-snapshots/os9-restored-calculator.png"
tags: ["Tech", "Emulation", "WebAssembly", "Asyncify", "Classic Mac"]
lang: en
---

The [previous post](/en/posts/webulator-intro/) described what Webulator is for: a screenshot on a page that, when clicked, turns into a running computer where it stands. That needs every machine to save state and to restore into a brand-new page with a first frame identical to the saved screen.

On the x86 side, v86 has `save_state()` built in. The trouble is the Mac. The three classic Mac emulators I use (Mini vMac, Basilisk II and SheepShaver, all from the Infinite Mac project's Emscripten builds) have no save state at all. If this failed, "instant wake" on the Mac side would need a different design, so it was the riskiest item in the whole plan, and the first thing I did.

This is the record of that experiment. Host: Apple M2, headless Chromium 153, Emscripten 4.0.22.

## Why you can't just save the memory

In an Emscripten build, everything about the guest (memory, CPU registers, device state) lives in wasm linear memory. It looks as if copying that memory out and writing it into a new instance would do.

The problem is that all three emulators run a blocking main loop. Once `main()` starts it never returns to JS; when the emulator wants input, it calls a global `workerApi` object from C++ through `EM_ASM`. And **the wasm call stack is not in linear memory.** You can copy the whole memory from any callback, but a new instance holding that memory has no idea which function, at which line, to continue from.

After reading the source I had two options:

- **Option A, build flags only:** turn on Emscripten's Asyncify, but instrument only a very narrow call path. At the callback, unwind the stack into linear memory and save; in a new instance, rewind back. No source changes, but the instrumentation's speed cost had to be measured.
- **Option B, a source patch:** export a `resume()` that skips initialisation and re-enters the CPU loop. My estimate was 30 to 60 lines for Mini vMac, 50 to 100 for Basilisk II, and 80 to 150 for SheepShaver (nested execution depth and 68k/PPC mode switching).

I tried A first.

## Asyncify on one path only

Asyncify is a compile-time transform in Emscripten. An instrumented function can save its locals and its position into a buffer in linear memory and return, level by level (unwinding). When it is called again, it follows the saved record back to where it was (rewinding). It exists to let synchronous C code wait for asynchronous JS, but it also happens to solve "the call stack is not in memory": after an unwind, the whole machine is in linear memory.

Full Asyncify instruments every function that can reach JS, which is expensive. I only need one path: from `main` to the callback that polls input. For Mini vMac that path is:

```
main → ProgramMain → MainEventLoop → WaitForNextTick → ReadJSInput
```

The build flags:

```
-sASYNCIFY
-sASYNCIFY_IMPORTS=["env.emscripten_asm_const_int"]
-sASYNCIFY_ONLY=["main", …, "ProgramMain", "MainEventLoop", "WaitForNextTick", "ReadJSInput"]
```

`ASYNCIFY_IMPORTS` tells Asyncify that the `EM_ASM` import (where `workerApi` is called) may unwind the stack. The CPU core is not on the list and is not instrumented, so speed does not change. A 9-line `--pre-js` exposes the Asyncify object, the wasm exports and the stack-pointer helpers to the host JS.

### Saving

To save, the page sets a flag in a SharedArrayBuffer. The emulator calls `workerApi.acquireInputLock` once per tick to fetch input, and the host checks the flag there:

```ts
acquireInputLock() {
  const A = asyncify();
  if (A && A.state === REWINDING) return A.handleSleep(() => {});   // end of a rewind
  const { snapshot } = env.poll(true);
  if (snapshot && A && atSafePoint()) {
    return A.handleSleep(wake => {
      setTimeout(() => {   // the wasm stack is unwound: the whole machine is in linear memory
        env.sendSnapshot(captureCore(A));
        wake(0);
      }, 0);
    });
  }
  return stageInput();
}
```

`Asyncify.handleSleep` unwinds the call stack into linear memory and the worker returns to its event loop. Four things are enough to copy at that point: the whole wasm memory, the stack pointer, the address of Asyncify's data buffer, and the export to re-enter when rewinding. Disk writes are tracked separately in 4 KB chunks and only written chunks are saved; Mini vMac wrote just 1 here. After saving, `wake(0)` lets the original machine carry on.

### Restoring

A new worker instantiates the module with `noInitialRun` (the runtime is up, `main` is not called), then:

1. writes the memory back;
2. restores the stack pointer;
3. rebuilds Asyncify's JS-side rewind table: in a new instance it is empty, so the saved rewind id is mapped back to its function using the export name recorded in the snapshot;
4. calls `asyncify_start_rewind` and `doRewind`.

The emulator re-enters `main`, runs down the saved stack to the input poll, and carries on as if nothing happened. The base disk image is loaded separately (it is shared and cacheable), with the written chunks applied on top.

The first frame doesn't wait for the emulator to redraw. The snapshot records where the frame buffer sits in linear memory, so once the memory is back, the picture at that address is the first frame.

## Mini vMac: it works

| | |
|---|---|
| Source changes | none |
| Build changes | Asyncify on 5 outer-loop functions, plus a 9-line `--pre-js` |
| wasm size | 264,457 → 275,480 bytes (+4%) |
| Boot to Finder, median of 10 | 0.487 s without Asyncify, 0.463 s with it (no measurable slowdown) |
| Save (request → snapshot in hand) | 27–63 ms (unwind 2–4 ms, memory copy 17–43 ms) |
| Snapshot file | 48.0 MB raw; gzip 562 KB, zstd -3 441 KB, zstd -19 327 KB |
| Restore in a fresh page (worker start → first frame), median of 5 | 37 ms (raw file), 39 ms (gzip) |
| First frame vs screen at save time | 0 pixels differ, 10 of 10 runs |
| Alive after restore | 10 of 10 runs: Apple menu opens, Calculator opens |

![Mini vMac restored from a snapshot in a fresh page, with Calculator opened. Calculator's code was read from the restored disk](/media/blog/webulator-mac-snapshots/minivmac-restored-calculator.png)

A Mac Plus saved in one worker was restored into a brand-new worker on a freshly loaded page, and kept running. Not one line of emulator source changed.

The 48 MB raw size comes from `INITIAL_MEMORY` (the build script sets 50331648 bytes). It is mostly zeros, which is why it compresses to a few hundred KB. What goes over the network is the compressed size.

A snapshot is tied to one exact build: the memory layout and the rewind ids must match. So Webulator stores a hash of the core's wasm in every snapshot and refuses to restore into a different build.

One open issue on the side: Mini vMac only works built at -O0. At -O1, -O2 and -O3, with or without Asyncify, System 6 bombs at boot ("error type 7"). Adding `-fno-strict-aliasing -fwrapv` doesn't help, and Infinite Mac also ships -O0 builds. Most likely undefined behaviour in the CPU core, unrelated to snapshots; I didn't chase it.

![With an -O1 build, System 6 stops at boot with error type 7](/media/blog/webulator-mac-snapshots/minivmac-O1-error-type-7.png)

## Basilisk II: nested CPU loops

Basilisk II (Quadra 650, 68040, 32 MB guest RAM, System 7.5.3) is built at -O3, exactly as Infinite Mac ships it. Same host code, still no source change, and only 3 instrumented functions: `main`, `m68k_execute()` and `ReadJSInput(long long)`.

| | base | full Asyncify | 3 functions |
|---|---|---|---|
| wasm size | 1,713,959 | 2,552,713 (+49%) | 1,747,136 (+2%) |
| Boot to a settled desktop, median | 1.48 s | 1.66 s (+12%) | 1.47 s (same) |

The comparison is stark: full Asyncify is half again as big and 12% slower; one narrow path costs almost nothing.

Snapshot size is mostly decided by `INITIAL_MEMORY`. Infinite Mac's default is 288 MB, far more than a 32 MB guest needs. At 80 MB, the gzip size drops from 2.2 MB to 2.0 MB, and a fresh page goes from the gzip file to the first frame in 157 ms (fetch 10 ms, gunzip 51 ms, restore 79 ms).

Basilisk II raised a new problem: **the CPU loop nests.** When native code needs to call 68k code (`Execute68k`), it enters `m68k_execute` again. Asyncify only covers the outer path, so those nested frames cannot unwind. The host therefore looks at the JS stack trace: `m68k_execute` must appear exactly once, otherwise the snapshot is deferred to the next input poll. At an idle desktop it was never deferred.

## The virtual clock: without it, restores crawl

Basilisk II exposed a subtler problem too. Restore right after saving and everything is fine. **Restore a minute or more later and the machine is painfully slow:** Calculator takes 5 to 8 seconds to open instead of about 15 ms.

The cause is in `cpu_do_check_ticks` in `main_unix.cpp`. Roughly every 166 ms, Basilisk II recalibrates how many instructions to run between clock checks, as instructions divided by elapsed time. The gap between save and restore counts as elapsed time, the quantum collapses to nearly 0, and it checks the clock on almost every instruction.

The fix needs no source change. All of Emscripten's clock imports (`emscripten_date_now`, `emscripten_get_now`, `clock_time_get`) end up in `Date.now` and `performance.now`, so the worker replaces those two before any core code loads:

```ts
export const realDate = Date.now.bind(Date);
export const realPerf = performance.now.bind(performance);

let offDate = realDate() - realPerf();   // guest date = realPerf() + offDate
let offPerf = 0;                         // guest perf = realPerf() + offPerf
let frozenAt: number | null = null;

const nowReal = () => (frozenAt ?? realPerf());
export const guestDate = () => nowReal() + offDate;
export const guestPerf = () => nowReal() + offPerf;

Date.now = guestDate;
performance.now = guestPerf;
```

On pause it records when the pause began; on resume it subtracts the pause from the offsets. On save, both clocks' current values go into the snapshot; on restore, the offsets are set to "saved value minus the real time now". The guest sees start time plus actual running time, and neither pauses nor the gap between save and restore are visible.

The same snapshot, 90 seconds old: Calculator opens in 12–23 ms with the virtual clock and in 5.7–7.7 s without.

This turned "pausing freezes the guest clock" from a tidiness rule into a correctness requirement. Mini vMac reacts differently: after a restore it sees a large time jump, treats it as "emulation interrupted" and skips it (`UpdateTrueEmulatedTime` in `OSGLUESC.c`), and the Mac's date jumps to the host's current date. Classic Mac timekeeping has another quirk: after a pause it doesn't catch up on ticks, but it re-reads the date from the host every second, so overdue Time Manager tasks fire at once. All three Mac cores therefore use the same virtual clock. v86 does too: its `microtick` binds `performance.now` when the module loads, which is why the replacement has to happen before loading.

## SheepShaver: a 15% cost

SheepShaver (Power Macintosh 9500 ROM, 64 MB guest RAM, System 7.5.3 PPC) shares its JS glue with Basilisk II, so the host works unchanged. Four instrumented functions: `main`, `powerpc_cpu::execute(unsigned int)`, `CheckTicks()` and `ReadJSInput(long long)`. Saved, then restored 60 seconds later in fresh pages: 5 of 5 identical first frames, Apple menu and Calculator working, still no source change.

| | base | full Asyncify | 4 functions |
|---|---|---|---|
| wasm size | 715,546 | 810,946 (+13%) | 718,964 (+0.5%) |
| Boot to a settled desktop, median | 8.04 s | 9.46 s | 9.34 s (+16%) |

This time there is a real speed cost, about 15%. SheepShaver polls input in `CheckTicks()`, which is called from inside `powerpc_cpu::execute`, the PPC interpreter loop itself. That function is always on the stack, so it has to be instrumented, and instrumenting the hottest loop costs speed. In Basilisk II and Mini vMac the instrumented functions sit outside the per-instruction path, hence no cost. If the 15% ever matters, a small patch could make `execute` return to an outer loop every N instructions so only the outer loop needs instrumenting. For now I accept it.

SheepShaver also has two more paths into JS: input is polled from the idle path (`execute_sheep → idle_wait → ReadJSInput`), and the CPU loop re-enters itself through `execute_macos_code`, `interrupt` and `execute_68k`. So the safe-point check became per emulator: the stack must contain the CPU loop exactly once and none of the listed frames (`execute_sheep|idle_wait` for SheepShaver, `idle_wait` for Basilisk II, none for Mini vMac). At an idle desktop it never had to defer either.

I tested Mac OS 9.0.4 (New World ROM) too. Cold boot to a settled Finder takes 21–25 seconds; saving takes 89 ms. After a restore, Calculator opens in 12 ms and finishes drawing in 0.73–0.83 s, the same as after a cold boot (0.67–0.74 s, mostly the window-opening animation). The restore inside the worker takes only 58–81 ms.

## How big are the snapshots

| Profile | Raw | gzip | zstd -19 |
|---|---|---|---|
| Mini vMac · System 6.0.8 | 48 MB | 562 KB | 327 KB |
| Basilisk II · System 7.5.3 (32 MB guest RAM) | 80 MB | 2.0 MB | 1.65 MB |
| SheepShaver · System 7.5.3 PPC (64 MB) | 128 MB | 6.4 MB | 4.8 MB |
| SheepShaver · Mac OS 9.0.4 (64 MB) | 128 MB | 11.4 MB | 8.4 MB |

The raw size is the whole wasm memory, mostly zeros. zstd is 15% to 35% smaller than gzip, but the browser would need an extra wasm decoder, while gzip works with the native `DecompressionStream`. So every section of Webulator's snapshot container (core memory, disk overlays, last frame) is gzipped. In the conformance runs, the settled-desktop snapshots for System 6, System 7.5 and Mac OS 9 come to 0.57, 2.0 and 11.1 MB.

## "Disk busy": where I did change the source

Up to this point, snapshots really did take zero lines of source changes. But once the disk images moved to object storage, another problem appeared, and this one had no way around it.

The disk images are cut into 256 KB chunks on object storage and read on demand, at about 0.4 to 0.5 seconds per chunk. The first implementation fetched chunks with a synchronous XHR on the core's thread, and the whole guest stood still during each fetch. A classic Mac draws its own cursor, so the mouse froze too. With a cold cache, every action stuttered.

A real machine doesn't behave like that: while the disk is busy the CPU keeps running and taking interrupts, and the cursor keeps moving. That was the behaviour I wanted.

The runtime side is straightforward. The block device gains `ready(offset, length)`, and a core asks it before reading; if the data isn't there, a background fetch worker (8 slots of 1 MB) is asked to get it. The catch is that the Mac cores' thread never returns to the event loop and cannot receive messages. So the fetch worker writes the data straight into a SharedArrayBuffer and wakes any idle wait on the core's thread with `Atomics.notify`; the core thread collects finished chunks at its next poll or `ready()` call.

On the emulator side, the guest's disk driver has to be able to say "busy, come back later" when the data hasn't arrived. Basilisk II and SheepShaver share one `disk.cpp`: `DiskPrime` now calls `Sys_ready` first and returns 1 if the data isn't there. That alone isn't enough; the guest must retry. In these two emulators the disk driver is a small piece of 68k code in the ROM patches, whose `Prime` entry calls into the emulator and then branches straight to `IOReturn`. I inserted two instructions in between:

```
Prime:
    M68K_EMUL_OP_DISK_PRIME
    cmp.w   #1,d0       ; 1 = data not fetched yet
    beq.s   Prime       ; retry; interrupts are taken in between
    bra     IOReturn
```

The offsets of the driver's later entry points shift accordingly. Mini vMac's `.Sony` driver uses the same idea, placed differently: so that nothing inside the driver moves, the `Prime` with the retry loop is appended after the call block that follows the driver, and the original `Prime` entry becomes a `bra.w` to it.

The two patch files total 211 lines including context. They are the only source patches the three Mac cores carry.

A new conformance test pins down the effect: T12. Every chunk fetch is delayed by an extra 400 ms, the cache starts empty, the desktop snapshot is restored, the pointer moves in a circle at 60 Hz, and the profile runs a disk-heavy action (on the Macs, opening four items from the Apple menu) while frame gaps are measured. It needs at least 3 fetches and no frame gap of 200 ms or more.

Before the patch, the three Mac cores showed longest gaps of 416 to 836 ms in this test: the guest stood still for every fetch. After:

| Profile | Fetches | Longest frame gap |
|---|---|---|
| Mini vMac · System 6.0.8 | 4 | 33 ms |
| Basilisk II · System 7.5.3 | 18 | 37 ms |
| SheepShaver · Mac OS 9.0.4 | 28 | 59 ms |

![Basilisk II at the end of T12: every fetch delayed 400 ms, the items opened from the Apple menu are up, and the cursor kept moving throughout](/media/blog/webulator-mac-snapshots/basilisk-t12-after.png)

This approach also gets along well with snapshots. If you save while a disk request is pending, the pending request is just a retry loop inside the guest; after a restore it is simply issued again. The Mac cores need nothing special for it.

## Why the pointer felt sticky

One last Mac-core problem was in SheepShaver's idle path. On Mac OS 9, hovering the mouse ran at 7 frames per second with a 303 ms median latency, yet dragging was smooth.

SheepShaver checks its 60 Hz tick only every 50,000 instructions, and that tick drives the screen refresh and the cursor. When the guest is idle it calls the host's `idleWait`, and the host blocked up to 8 ms per call, so ticks came only about every 160 ms. While dragging, the guest is busy and never takes the idle path, so it stayed smooth.

The fix is to wait only until the next refresh is due (Infinite Mac does the same):

```ts
idleWait() {
  env.poll(true, false);
  const wait = Math.min(8, lastBlit + 16.7 - performance.now() - 1);
  if (wait > 0) env.idle(wait);
  return env.hasInput() ? 1 : 0;
}
```

The frame floor for all cores also went from 16 ms to 12 ms. Guests refresh at about 60 Hz with jitter, and a 16 ms floor pushed every slightly early frame to the next cycle, which looks like a cursor that stutters. Afterwards SheepShaver hovers at 46 frames per second with a 35 ms median latency.

## Takeaways

- **First ask where the call stack lives.** An emulator with a blocking main loop can't be saved not because its memory is out of reach, but because its call stack isn't in memory. Instrumenting just the path from `main` to the input poll with Asyncify moves the stack into memory.
- **Where you instrument decides the cost.** If the instrumented functions sit outside the per-instruction path, the cost is near zero (Mini vMac, Basilisk II). Inside the interpreter loop, you pay 15% (SheepShaver).
- **Time is state too.** Not only memory and disks: the time the guest perceives has to be saved as well. Otherwise Basilisk II counts the gap as running time and tunes itself down to a crawl.
- **A busy disk should behave like real hardware.** Letting the driver say "busy" and the guest retry is much better than blocking in the host, and it fits snapshots naturally. This is the only place that needed a source change, and the patch is small.

Not done yet: all exhibits of one system could share a single boot snapshot, with each exhibit storing only the memory pages that differ from it. That should shrink Mac OS 9's 11 MB a good deal further. It's planned for the next version.
