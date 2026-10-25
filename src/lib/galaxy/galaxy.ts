import { accumFrag, blitFrag, diskStarsVert, fullscreenVert, skyFrag, starsFrag, starsVert, volumeFrag } from './shaders';

export interface GalaxyOptions {
  /** Galaxy centre on screen, in NDC (-1..1). */
  center?: (aspect: number) => [number, number];
  /** Called once the first frame is on screen. */
  onReady?: () => void;
}

export interface GalaxyView {
  /** Orbit around the disk normal, radians. */
  azimuth: number;
  /** Camera height above the disk plane, radians. */
  elevation: number;
}

const BASE: GalaxyView = { azimuth: 0.35, elevation: 0.15 };
const ROLL = -0.52;          // tilts the major axis from lower-left to upper-right
const DIST = 3.0;
const FOV_TAN = Math.tan((28 * Math.PI) / 180 / 2);

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 0, 'aDir');
  gl.bindAttribLocation(prog, 1, 'aProps');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  const u = new Proxy({} as Record<string, WebGLUniformLocation | null>, {
    get: (cache, name: string) => (name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(prog, name))),
  });
  return { prog, u };
}

/** Seeded PRNG so the star field is the same on every visit. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 64³ tileable value noise; trilinear filtering does the interpolation. */
function noiseTexture(gl: WebGL2RenderingContext) {
  const N = 64;
  const rand = mulberry32(7);
  const raw = new Float32Array(N * N * N);
  for (let i = 0; i < raw.length; i++) raw[i] = rand();
  // one box-blur pass per axis softens the trilinear creases
  const blur = (src: Float32Array, stride: number) => {
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const x = Math.floor(i / stride) % N;
      const prev = i + (((x - 1 + N) % N) - x) * stride;
      const next = i + (((x + 1) % N) - x) * stride;
      dst[i] = (src[prev] + 2 * src[i] + src[next]) / 4;
    }
    return dst;
  };
  let f = blur(blur(blur(raw, 1), N), N * N);
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const bytes = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) bytes[i] = Math.round(((f[i] - lo) / (hi - lo)) * 255);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  return tex;
}

function starField(gl: WebGL2RenderingContext, count: number) {
  const rand = mulberry32(42);
  const data = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    const m = Math.pow(rand(), 9);                    // most stars faint, a few bright
    data.set([s * Math.cos(a), z, s * Math.sin(a), 0.75 + m * 2.2, 0.45 + m * 2.6 + rand() * 0.5, rand()], i * 6);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);
  return vao;
}

/** Stars inside the disk, sampled from the same exponential disk and arms as the volume. */
function diskStars(gl: WebGL2RenderingContext, count: number) {
  const rand = mulberry32(1234);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  const data = new Float32Array(count * 6);
  let i = 0;
  while (i < count) {
    // exponential disk in r (gamma(2) sample), uniform angle, then thin out between arms
    const r = -0.34 * Math.log((rand() + 1e-9) * (rand() + 1e-9));
    if (r > 1.35 || r < 0.06) continue;
    const th = rand() * Math.PI * 2;
    const arm = 0.5 + 0.5 * Math.cos(2 * (th + Math.log(r + 0.04) * 3.4));
    if (rand() > 0.25 + 0.75 * arm * arm) continue;
    const h = gauss() * (0.010 + 0.02 * Math.min(1, r));
    const m = Math.pow(rand(), 6);
    const warm = Math.max(0, 1 - r / 0.45) * 0.8 + rand() * 0.2;
    const fade = 1 - Math.min(1, Math.max(0, (r - 0.7) / 0.6));
    data.set([r * Math.cos(th), h, r * Math.sin(th), 0.45 + m * 1.4, (0.08 + m * 0.9) * (0.35 + 0.65 * fade), warm], i * 6);
    i++;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);
  return vao;
}

function cameraBasis(view: GalaxyView) {
  const { azimuth: az, elevation: el } = view;
  const pos = [DIST * Math.cos(el) * Math.sin(az), DIST * Math.sin(el), DIST * Math.cos(el) * Math.cos(az)];
  const len = Math.hypot(pos[0], pos[1], pos[2]);
  const fwd = pos.map((v) => -v / len);
  // right = fwd × worldUp, up = right × fwd
  let right = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(right[0], right[2]);
  right = right.map((v) => v / rl);
  let up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const c = Math.cos(ROLL), s = Math.sin(ROLL);
  const r2 = right.map((v, i) => c * v + s * up[i]);
  up = up.map((v, i) => -s * right[i] + c * v);
  return { pos, fwd, right: r2, up };
}

export function mountGalaxy(canvas: HTMLCanvasElement, opts: GalaxyOptions = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;

  const tri = gl.createVertexArray();
  gl.bindVertexArray(tri);
  const tb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const sky = compile(gl, fullscreenVert, skyFrag);
  const stars = compile(gl, starsVert, starsFrag);
  const volume = compile(gl, fullscreenVert, volumeFrag);
  const blit = compile(gl, fullscreenVert, blitFrag);
  const accum = compile(gl, fullscreenVert, accumFrag);
  const noise = noiseTexture(gl);
  const STAR_COUNT = 9000;
  const starVao = starField(gl, STAR_COUNT);
  const disk = compile(gl, diskStarsVert, starsFrag);
  const mobileCount = matchMedia('(pointer: coarse)').matches;
  const DISK_COUNT = mobileCount ? 40000 : 90000;
  const diskVao = diskStars(gl, DISK_COUNT);

  // Volume targets: the current frame plus two history buffers that we
  // ping-pong between, so per-frame jitter noise averages out over time.
  const half = !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float');
  const targets = [0, 1, 2].map(() => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, fbo: gl.createFramebuffer()! };
  });
  let histIdx = 1;
  let fresh = true;

  const mobile = matchMedia('(pointer: coarse)').matches;
  let scale = mobile ? 0.6 : 0.6;   // volume pixels per CSS pixel            // volume resolution relative to the canvas
  let steps = mobile ? 110 : 170;
  let vw = 0, vh = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const nw = Math.max(1, Math.round(canvas.clientWidth * scale)), nh = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (nw !== vw || nh !== vh) {
      vw = nw; vh = nh;
      for (const t of targets) {
        gl!.bindTexture(gl!.TEXTURE_2D, t.tex);
        if (half) gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA16F, vw, vh, 0, gl!.RGBA, gl!.HALF_FLOAT, null);
        else gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, vw, vh, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, t.fbo);
        gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, t.tex, 0);
      }
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      fresh = true;
    }
  }

  let frameNo = 0;
  function render(view: GalaxyView, time: number, spin: number, blend: number) {
    resize();
    const aspect = canvas.width / canvas.height;
    const [sx, sy] = opts.center?.(aspect) ?? [0, 0];
    // frame the galaxy by width: nearly all of it on wide screens, the core and
    // inner arms crossing the screen diagonally on phones
    const fovTan = Math.max(FOV_TAN * 0.6, (aspect > 1.2 ? 2.2 : 1.25) / (2 * DIST * aspect));
    const cam = cameraBasis(view);
    const g = gl!;

    // volume at reduced resolution
    const cur = targets[0], prev = targets[histIdx], next = targets[3 - histIdx];
    g.bindFramebuffer(g.FRAMEBUFFER, cur.fbo);
    g.viewport(0, 0, vw, vh);
    g.disable(g.BLEND);
    g.useProgram(volume.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_3D, noise);
    g.uniform1i(volume.u.uNoise, 0);
    g.uniform3fv(volume.u.uCamPos, cam.pos);
    g.uniform3fv(volume.u.uRight, cam.right);
    g.uniform3fv(volume.u.uUp, cam.up);
    g.uniform3fv(volume.u.uFwd, cam.fwd);
    g.uniform1f(volume.u.uTan, fovTan);
    g.uniform1f(volume.u.uAspect, aspect);
    g.uniform2f(volume.u.uShift, sx, sy);
    g.uniform1f(volume.u.uTime, time);
    g.uniform1f(volume.u.uSpin, spin);
    g.uniform1i(volume.u.uSteps, steps);
    g.uniform1f(volume.u.uOctaves, mobile ? 4 : 5);
    g.uniform1f(volume.u.uFrame, frameNo++ % 4096);
    g.uniform2f(volume.u.uTexel, 1 / vw, 1 / vh);
    g.bindVertexArray(tri);
    g.drawArrays(g.TRIANGLES, 0, 3);

    // temporal accumulation into the other history buffer
    g.bindFramebuffer(g.FRAMEBUFFER, next.fbo);
    g.useProgram(accum.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, cur.tex);
    g.uniform1i(accum.u.uCur, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, prev.tex);
    g.uniform1i(accum.u.uHist, 1);
    g.uniform1f(accum.u.uBlend, fresh ? 1 : blend);
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.activeTexture(g.TEXTURE0);
    histIdx = 3 - histIdx;
    fresh = false;

    // sky
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, canvas.width, canvas.height);
    g.useProgram(sky.prog);
    g.uniform2f(sky.u.uCenter, sx * 0.5 + 0.5, sy * 0.5 + 0.5);
    g.uniform1f(sky.u.uAspect, aspect);
    g.drawArrays(g.TRIANGLES, 0, 3);

    // stars, additive
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE);
    g.useProgram(stars.prog);
    g.uniform3fv(stars.u.uRight, cam.right);
    g.uniform3fv(stars.u.uUp, cam.up);
    g.uniform3fv(stars.u.uFwd, cam.fwd);
    g.uniform1f(stars.u.uTan, fovTan);
    g.uniform1f(stars.u.uAspect, aspect);
    g.uniform1f(stars.u.uDpr, dpr);
    g.uniform2f(stars.u.uShift, sx, sy);
    g.bindVertexArray(starVao);
    g.drawArrays(g.POINTS, 0, STAR_COUNT);

    // disk stars; the volume drawn next dims them where dust is in the way
    g.useProgram(disk.prog);
    g.uniform3fv(disk.u.uCamPos, cam.pos);
    g.uniform3fv(disk.u.uRight, cam.right);
    g.uniform3fv(disk.u.uUp, cam.up);
    g.uniform3fv(disk.u.uFwd, cam.fwd);
    g.uniform1f(disk.u.uTan, fovTan);
    g.uniform1f(disk.u.uAspect, aspect);
    g.uniform1f(disk.u.uDpr, dpr);
    g.uniform1f(disk.u.uSpin, spin);
    g.uniform2f(disk.u.uShift, sx, sy);
    g.bindVertexArray(diskVao);
    g.drawArrays(g.POINTS, 0, DISK_COUNT);

    // galaxy over everything: premultiplied colour, alpha = dust opacity
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.useProgram(blit.prog);
    g.bindTexture(g.TEXTURE_2D, next.tex);
    g.uniform1i(blit.u.uTex, 0);
    g.bindVertexArray(tri);
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.disable(g.BLEND);
  }

  // ---------- interaction ----------
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const target = { ...BASE };
  const view = { ...BASE };
  const clampView = () => {
    target.azimuth = Math.max(BASE.azimuth - 0.6, Math.min(BASE.azimuth + 0.6, target.azimuth));
    target.elevation = Math.max(0.08, Math.min(0.42, target.elevation));
  };

  const onMouse = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const nx = (e.clientX / innerWidth) * 2 - 1;
    const ny = (e.clientY / innerHeight) * 2 - 1;
    target.azimuth = BASE.azimuth + nx * 0.28;
    target.elevation = BASE.elevation - ny * 0.08;
  };

  let drag: { x: number; y: number; az: number; el: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    drag = { x: e.clientX, y: e.clientY, az: target.azimuth, el: target.elevation };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerType === 'mouse') return;
    target.azimuth = drag.az + (e.clientX - drag.x) * 0.006;
    target.elevation = drag.el - (e.clientY - drag.y) * 0.003;
    clampView();
  };
  const onUp = () => { drag = null; };

  let gyro: { b: number; g: number } | null = null;
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null || drag) return;
    if (!gyro) gyro = { b: e.beta, g: e.gamma };
    // drift the neutral pose toward how the phone is held now
    gyro.b += (e.beta - gyro.b) * 0.01;
    gyro.g += (e.gamma - gyro.g) * 0.01;
    target.azimuth = BASE.azimuth + ((e.gamma - gyro.g) * Math.PI) / 180 * 1.2;
    target.elevation = BASE.elevation + ((e.beta - gyro.b) * Math.PI) / 180 * 0.6;
    clampView();
  };
  // iOS asks for permission, and only from inside a user gesture
  const askGyro = () => {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then((s) => { if (s === 'granted') addEventListener('deviceorientation', onOrient); }).catch(() => {});
    }
  };

  const host = canvas.parentElement ?? canvas;
  if (!reduced) {
    addEventListener('pointermove', onMouse, { passive: true });
    host.addEventListener('pointerdown', onDown, { passive: true });
    addEventListener('pointermove', onMove, { passive: true });
    addEventListener('pointerup', onUp, { passive: true });
    addEventListener('pointercancel', onUp, { passive: true });
    addEventListener('deviceorientation', onOrient, { passive: true });
    host.addEventListener('touchend', askGyro, { once: true });
  }

  // ---------- loop ----------
  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(canvas);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);

  let raf = 0, last = performance.now(), spin = 0, ready = false;
  let slow = 0, fast = 0;
  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const k = 1 - Math.exp(-dt * 2.5);
    view.azimuth += (target.azimuth - view.azimuth) * k;
    view.elevation += (target.elevation - view.elevation) * k;
    spin += dt * 0.012;
    const drift = reduced ? 0 : Math.sin(now / 1000 * 0.07) * 0.05;
    // accumulate harder when the camera is still, less while it moves
    const speed = Math.abs(target.azimuth - view.azimuth) + Math.abs(target.elevation - view.elevation);
    const blend = Math.min(0.35, 0.08 + speed * 3);
    render({ azimuth: view.azimuth + drift, elevation: view.elevation }, now / 1000, spin, blend);
    if (!ready) { ready = true; opts.onReady?.(); }

    // adaptive quality: keep frames under ~20 ms
    if (dt > 0.024) { slow++; fast = 0; } else if (dt < 0.012) { fast++; slow = 0; }
    if (slow > 20 && scale > 0.28) { scale -= 0.06; steps = Math.max(70, steps - 15); slow = 0; }
    if (fast > 120 && scale < 0.8) { scale += 0.04; fast = 0; }

    if (!reduced) kick();
  }
  function kick() {
    if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  kick();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('pointermove', onMouse);
      host.removeEventListener('pointerdown', onDown);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      removeEventListener('deviceorientation', onOrient);
      host.removeEventListener('touchend', askGyro);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
    /** For screenshots and tuning. */
    setView(v: Partial<GalaxyView>) { Object.assign(target, v); Object.assign(view, v); },
  };
}
