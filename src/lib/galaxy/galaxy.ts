import { Director, type Pose, type Shot } from './director';
import { brandTarget } from '../brandTarget';
import { accumFrag, bakeFrag, blitFrag, fullscreenVert, galaxyStarsVert, skyFrag, starsFrag, starsVert, tileFrag, tileVert, volumeFrag } from './shaders';

export interface GalaxyOptions {
  /** How much of galaxy space spans the screen width, by aspect ratio. */
  frameWidth?: (aspect: number) => number;
  /** Called once the first frame is on screen. */
  onReady?: () => void;
  /** Play the reveal once the first frame is up (landing page only). */
  intro?: boolean;
  /** Shot for the page the background first appears on. */
  shot?: Shot;
}

// The field of view is fixed from the home shot's distance, so moving the
// camera closer really is a dolly rather than a zoom.
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
  gl.bindAttribLocation(prog, 1, 'aUv');
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
    data.set([s * Math.cos(a), z, s * Math.sin(a), 0.8 + m * 2.6, 0.6 + m * 3.0 + rand() * 0.7, rand()], i * 6);
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

/** The magenta tile with its <N> mark, drawn once into a texture. */
function tileTexture(gl: WebGL2RenderingContext) {
  const N = 512, pad = 6;                 // transparent rim keeps the edges smooth
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  // rounded like the nav tab (14px on a 104px tile)
  g.fillStyle = '#e74dae';
  g.beginPath();
  g.roundRect(pad, pad, N - 2 * pad, N - 2 * pad, (N - 2 * pad) * (14 / 104));
  g.fill();
  const k = (N * 0.46) / 32;              // mark is ~46% of the tile, like the avatar
  g.translate(N / 2 - 14.8 * k, N / 2 - 16 * k);
  g.scale(k, k);
  g.fillStyle = '#fff';
  for (const d of [
    'M18.5282 0V18.441L11.3612 11.3286L9.20972 12.2401V30.1502L11.0737 32V13.6578L18.4017 20.9297L20.3921 20.0863V1.84979L18.5282 0Z',
    'M5.06732 11.0215L0 16.0485L5.06732 21.0773V19.4429L1.6474 16.0485L5.06732 12.6555V11.0215Z',
    'M24.5682 11.055V12.6903L27.9526 16.0503L24.5682 19.409V21.0439L29.6 16.0485L24.5682 11.055Z',
  ]) g.fill(new Path2D(d));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

type V3 = number[];
const add = (a: V3, b: V3, k = 1) => a.map((v, i) => v + b[i] * k);
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((v) => v / l); };

function cameraBasis(view: Pose) {
  const { azimuth: az, elevation: el, distance: D } = view;
  const pos = [D * Math.cos(el) * Math.sin(az), D * Math.sin(el), D * Math.cos(el) * Math.cos(az)];
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
  const c = Math.cos(view.roll), s = Math.sin(view.roll);
  const r2 = right.map((v, i) => c * v + s * up[i]);
  up = up.map((v, i) => -s * right[i] + c * v);
  return { pos, fwd, right: r2, up };
}

export function mountGalaxy(canvas: HTMLCanvasElement, opts: GalaxyOptions = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
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
  const bake = compile(gl, fullscreenVert, bakeFrag);
  const noise = noiseTexture(gl);
  const STAR_COUNT = 14000;
  const starVao = starField(gl, STAR_COUNT);
  const mobile = matchMedia('(pointer: coarse)').matches;
  const galaxyStars = compile(gl, galaxyStarsVert, starsFrag);
  const GALAXY_STARS = mobile ? 200000 : 420000;
  const emptyVao = gl.createVertexArray();      // stars come from gl_VertexID

  // The tile floats just in front of the core (toward the home camera). It
  // turns to face the camera, but slowly, so camera moves show it's a real
  // object in the scene. Tilted like the avatar.
  const tileProg = compile(gl, tileVert, tileFrag);
  const tileTex = tileTexture(gl);
  const tileVao = gl.createVertexArray();
  const tileBuf = gl.createBuffer();
  gl.bindVertexArray(tileVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, tileBuf);
  gl.bufferData(gl.ARRAY_BUFFER, 4 * 5 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);
  const TILE_TILT = (10 * Math.PI) / 180;   // top edge rising to the right
  // Pinned to the core so camera moves and parallax never slide it onto an arm.
  // For hiding stars it counts as this far in front, so the bulge stays
  // behind it and only a few disk stars pass over.
  const TILE_POS = [0, 0, 0];
  const TILE_DEPTH_BIAS = 0.7;
  let tileR: V3 | null = null, tileU: V3 | null = null;
  let tileAlpha = 0;

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

  // Baked dust field (see bakeFrag). Built a few layers per frame so the
  // page never stalls; the volume pass waits until it's complete.
  const FW = mobile ? 256 : 384, FL = 40, FIELD_H = 0.2;
  const field = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, field);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, FW, FW, FL, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);   // x, z, y
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
  const bakeFbo = gl.createFramebuffer();
  let baked = 0;
  function bakeLayers(n: number) {
    const g = gl!;
    g.bindFramebuffer(g.FRAMEBUFFER, bakeFbo);
    g.viewport(0, 0, FW, FW);
    g.disable(g.BLEND);
    g.useProgram(bake.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_3D, noise);
    g.uniform1i(bake.u.uNoise, 0);
    g.bindVertexArray(tri);
    for (let k = 0; k < n && baked < FL; k++, baked++) {
      // each layer is one height; its image axes are x and z
      g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, field, 0, baked);
      g.uniform1f(bake.u.uY, ((baked + 0.5) / FL * 2 - 1) * FIELD_H);
      g.drawArrays(g.TRIANGLES, 0, 3);
    }
    g.bindFramebuffer(g.FRAMEBUFFER, null);
  }

  let scale = 0.5;   // volume pixels per CSS pixel; the stars carry the fine detail
  let steps = mobile ? 160 : 220;
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
  function render(view: Pose, time: number, spin: number, blend: number) {
    resize();
    const aspect = canvas.width / canvas.height;
    const sx = view.cx, sy = view.cy;
    // frame the galaxy by width: nearly all of it on wide screens, the core and
    // inner arms crossing the screen diagonally on phones
    const width = opts.frameWidth?.(aspect) ?? (aspect > 1.2 ? 2.2 : 1.25);
    const fovTan = Math.max(FOV_TAN * 0.6, width / (2 * DIST * aspect));
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
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_3D, field);
    g.uniform1i(volume.u.uField, 1);
    g.activeTexture(g.TEXTURE0);
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

    // galaxy over everything: premultiplied colour, alpha = dust opacity
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.useProgram(blit.prog);
    g.bindTexture(g.TEXTURE_2D, next.tex);
    g.uniform1i(blit.u.uTex, 0);
    g.bindVertexArray(tri);
    g.drawArrays(g.TRIANGLES, 0, 3);

    // the tile writes depth so only the stars in front of it cover it
    g.clear(g.DEPTH_BUFFER_BIT);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LESS);
    drawTile(cam, aspect, fovTan, sx, sy, dtTile, next.tex);
    g.blendFunc(g.ONE, g.ONE);

    // the galaxy's own stars on top, each already dimmed by the dust in front of it
    g.depthMask(false);
    g.useProgram(galaxyStars.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_3D, noise);
    g.uniform1i(galaxyStars.u.uNoise, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_3D, field);
    g.uniform1i(galaxyStars.u.uField, 1);
    g.activeTexture(g.TEXTURE0);
    g.uniform3fv(galaxyStars.u.uCamPos, cam.pos);
    g.uniform3fv(galaxyStars.u.uRight, cam.right);
    g.uniform3fv(galaxyStars.u.uUp, cam.up);
    g.uniform3fv(galaxyStars.u.uFwd, cam.fwd);
    g.uniform1f(galaxyStars.u.uTan, fovTan);
    g.uniform1f(galaxyStars.u.uAspect, aspect);
    g.uniform1f(galaxyStars.u.uDpr, dpr);
    g.uniform1f(galaxyStars.u.uSpin, spin);
    g.uniform1f(galaxyStars.u.uCount, GALAXY_STARS);
    g.uniform2f(galaxyStars.u.uShift, sx, sy);
    g.bindVertexArray(emptyVao);
    g.drawArrays(g.POINTS, 0, GALAXY_STARS);
    g.depthMask(true);
    g.disable(g.DEPTH_TEST);
    g.disable(g.BLEND);
  }

  let dtTile = 0;
  function drawTile(cam: ReturnType<typeof cameraBasis>, aspect: number, fovTan: number, sx: number, sy: number, dt: number, vol: WebGLTexture) {
    const g = gl!;
    // target orientation: facing the camera, rolled by the tilt
    const c = Math.cos(TILE_TILT), s = Math.sin(TILE_TILT);
    const tr = add(cam.right.map((v) => v * c), cam.up, s);
    const tu = add(cam.up.map((v) => v * c), cam.right, -s);
    const k = tileR ? 1 - Math.exp(-dt * 1.1) : 1;
    tileR = norm(add(tileR ?? tr, add(tr, tileR ?? tr, -1), k));
    tileU = norm(add(tileU ?? tu, add(tu, tileU ?? tu, -1), k));
    tileU = norm(add(tileU, tileR, -dot3(tileU, tileR)));     // keep it square

    // about 65px on a desktop screen, 50px on a phone, at the home shot
    const h = (aspect > 1.2 ? 0.1 : 0.16) / 2;
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) =>
      add(add(TILE_POS, tileR!, a * h), tileU!, b * h));

    // project the corners the way the shader does, for the DOM hand-off
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const scr = corners.map((p) => {
      const d = add(p, cam.pos, -1);
      const z = dot3(d, cam.fwd);
      const nx = dot3(d, cam.right) / (z * fovTan * aspect) + sx;
      const ny = dot3(d, cam.up) / (z * fovTan) + sy;
      return [(nx * 0.5 + 0.5) * W, (0.5 - ny * 0.5) * H];
    });
    const cxp = (scr[0][0] + scr[3][0]) / 2, cyp = (scr[0][1] + scr[3][1]) / 2;
    const top = [scr[3][0] - scr[2][0], scr[3][1] - scr[2][1]];
    const size = (Math.hypot(top[0], top[1]) + Math.hypot(scr[3][0] - scr[1][0], scr[3][1] - scr[1][1])) / 2;
    const onHome = director.isHome();
    brandTarget.scene = onHome ? { x: cxp, y: cyp, size, angle: (Math.atan2(top[1], top[0]) * 180) / Math.PI } : null;

    // fade out while the DOM tile has it, or away from the landing page
    const want = onHome && !brandTarget.docked ? 1 : 0;
    tileAlpha = want > tileAlpha ? want : tileAlpha + (want - tileAlpha) * Math.min(1, dt * 30);
    if (tileAlpha < 0.01) return;

    const uv = [[0, 1], [1, 1], [0, 0], [1, 0]];
    g.bindBuffer(g.ARRAY_BUFFER, tileBuf);
    g.bufferSubData(g.ARRAY_BUFFER, 0, new Float32Array(corners.flatMap((p, i) => [...p, ...uv[i]])));
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.useProgram(tileProg.prog);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, tileTex);
    g.uniform1i(tileProg.u.uTex, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, vol);
    g.uniform1i(tileProg.u.uVol, 1);
    g.activeTexture(g.TEXTURE0);
    g.uniform2f(tileProg.u.uView, canvas.width, canvas.height);
    g.uniform3fv(tileProg.u.uCamPos, cam.pos);
    g.uniform3fv(tileProg.u.uRight, cam.right);
    g.uniform3fv(tileProg.u.uUp, cam.up);
    g.uniform3fv(tileProg.u.uFwd, cam.fwd);
    g.uniform1f(tileProg.u.uTan, fovTan);
    g.uniform1f(tileProg.u.uAspect, aspect);
    g.uniform2f(tileProg.u.uShift, sx, sy);
    g.uniform1f(tileProg.u.uDepthBias, TILE_DEPTH_BIAS);
    const facing = Math.abs(dot3(norm([tileR![1] * tileU![2] - tileR![2] * tileU![1], tileR![2] * tileU![0] - tileR![0] * tileU![2], tileR![0] * tileU![1] - tileR![1] * tileU![0]]), cam.fwd));
    g.uniform1f(tileProg.u.uShade, 0.8 + 0.2 * facing);
    g.uniform1f(tileProg.u.uAlpha, tileAlpha);
    g.bindVertexArray(tileVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- input ----------
  // Only ambient input: the page's scroll position and a little parallax.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const director = new Director();
  if (opts.shot) director.jump(opts.shot);

  const onMouse = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    director.pointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
  };

  let gyro: { b: number; g: number } | null = null;
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    if (!gyro) gyro = { b: e.beta, g: e.gamma };
    // drift the neutral pose toward how the phone is held now
    gyro.b += (e.beta - gyro.b) * 0.01;
    gyro.g += (e.gamma - gyro.g) * 0.01;
    director.pointer(clamp((e.gamma - gyro.g) / 24, -1, 1), clamp(-(e.beta - gyro.b) / 24, -1, 1));
  };
  // iOS asks for permission, and only from inside a user gesture
  const askGyro = () => {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then((s) => { if (s === 'granted') addEventListener('deviceorientation', onOrient); }).catch(() => {});
    }
  };

  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    director.setScroll(max > 0 ? scrollY / max : 0);
    settle = 30;
    kick();
  };

  if (!reduced) {
    addEventListener('pointermove', onMouse, { passive: true });
    addEventListener('deviceorientation', onOrient, { passive: true });
    addEventListener('touchend', askGyro, { once: true, passive: true });
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });

  // ---------- loop ----------
  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(canvas);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);

  let raf = 0, last = performance.now(), spin = 0, ready = false;
  let slow = 0, fast = 0;
  let settle = 30;        // frames left to converge after a change (reduced motion only animates this long)
  let skip = false, skipped = false;
  let view: Pose = { azimuth: 0.35, elevation: 0.115, distance: 3, roll: -0.52, cx: 0, cy: 0 };
  function frame(now: number) {
    raf = 0;
    if (!visible || document.hidden) return;      // kick() restarts it
    const dt = Math.min(0.1, (now - last) / 1000);
    // a still camera only needs half the frames: the spin is very slow
    if (skip && settle <= 0) { skip = false; skipped = true; raf = requestAnimationFrame(frame); return; }
    last = now;
    if (baked < FL) { bakeLayers(mobile ? 3 : 4); raf = requestAnimationFrame(frame); return; }

    spin += dt * 0.012;
    director.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    // with reduced motion, pages still get their shot, just without the flight
    const out = director.update(reduced ? 10 : dt);
    view = out.view;
    // accumulate harder when the camera is still, less while it moves
    const blend = Math.min(0.5, 0.08 + out.speed * 120);
    dtTile = dt;
    render(view, now / 1000, spin, blend);
    if (!ready) {
      ready = true;
      opts.onReady?.();
      if (opts.intro && !reduced) director.intro();
    }

    // adaptive quality: keep frames under ~20 ms (a skipped frame isn't a slow one)
    if (skipped) { skipped = false; } else if (dt > 0.024) { slow++; fast = 0; } else if (dt < 0.012) { fast++; slow = 0; }
    if (slow > 20 && scale > 0.3) { scale -= 0.06; steps = Math.max(120, steps - 20); slow = 0; }
    if (fast > 120 && scale < 0.8) { scale += 0.04; fast = 0; }

    skip = out.speed < 1e-4;
    if (out.speed > 1e-4) settle = 30;
    if (!reduced || settle-- > 0) raf = requestAnimationFrame(frame);
  }
  /** Start the loop if it isn't running. */
  function kick() {
    if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  onScroll();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('pointermove', onMouse);
      removeEventListener('deviceorientation', onOrient);
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      removeEventListener('touchend', askGyro);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
    director,
    /** GPU cost of one frame in ms at the current quality (for tuning). */
    bench(n = 20) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) render(view, i / 60, spin, 0.1);
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return { ms: (performance.now() - t0) / n, scale, steps, w: vw, h: vh };
    },
    /** Fly to a page's shot. */
    setShot(shot: Shot) { director.setShot(shot, !reduced); onScroll(); },
    /** Jump to a page's shot (for screenshots and tuning). */
    jump(shot: Shot) { director.jump(shot); },
  };
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
