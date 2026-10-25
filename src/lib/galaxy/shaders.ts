// GLSL for the real-time galaxy. Three passes:
//   1. sky: dark navy gradient, full resolution
//   2. stars: background star field as point sprites, full resolution
//   3. volume: ray-marched disk, bulge and dust at reduced resolution,
//      then upscaled and blended over the sky (premultiplied alpha)

export const fullscreenVert = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const skyFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uCenter;   // galaxy centre in uv
uniform float uAspect;
void main() {
  vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
  float glow = exp(-dot(d, d) * 1.6);
  vec3 base = vec3(0.027, 0.050, 0.078);
  vec3 near = vec3(0.075, 0.125, 0.185);
  outColor = vec4(mix(base, near, glow * 0.85), 1.0);
}`;

export const starsVert = /* glsl */ `#version 300 es
in vec3 aDir;
in vec3 aProps;          // size px, brightness, colour temperature 0..1
uniform vec3 uRight, uUp, uFwd;
uniform float uTan, uAspect, uDpr;
uniform vec2 uShift;
out float vBright;
out vec3 vColor;
out float vSize;
void main() {
  vec3 v = vec3(dot(aDir, uRight), dot(aDir, uUp), dot(aDir, uFwd));
  if (v.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 ndc = vec2(v.x / (v.z * uTan * uAspect), v.y / (v.z * uTan)) + uShift;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vSize = aProps.x * uDpr;
  gl_PointSize = vSize * 4.0;
  vBright = aProps.y;
  vColor = mix(vec3(0.80, 0.87, 1.0), vec3(1.0, 0.93, 0.82), aProps.z);
}`;

export const diskStarsVert = /* glsl */ `#version 300 es
in vec3 aDir;            // position in galaxy space
in vec3 aProps;          // size px, brightness, colour 0..1 (0 blue, 1 warm)
uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTan, uAspect, uDpr, uSpin;
uniform vec2 uShift;
out float vBright;
out vec3 vColor;
out float vSize;
void main() {
  vec3 p = aDir;
  float c = cos(-uSpin), s = sin(-uSpin);
  p.xz = mat2(c, -s, s, c) * p.xz;
  vec3 d = p - uCamPos;
  vec3 v = vec3(dot(d, uRight), dot(d, uUp), dot(d, uFwd));
  if (v.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 ndc = vec2(v.x / (v.z * uTan * uAspect), v.y / (v.z * uTan)) + uShift;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vSize = aProps.x * uDpr;
  gl_PointSize = vSize * 4.0;
  vBright = aProps.y;
  vColor = mix(vec3(0.70, 0.82, 1.0), vec3(1.0, 0.90, 0.72), aProps.z);
}`;

export const starsFrag = /* glsl */ `#version 300 es
precision highp float;
in float vBright;
in vec3 vColor;
in float vSize;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c) * 4.0;            // in units of the star's size
  float core = exp(-r * r * 2.2);
  float halo = exp(-r * 2.2) * 0.12 * smoothstep(2.0, 5.0, vSize);
  float a = (core + halo) * vBright;
  outColor = vec4(vColor * a, 0.0);
}`;

export const volumeFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

uniform sampler3D uNoise;
uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTan, uAspect;
uniform vec2 uShift;
uniform float uTime;
uniform float uSpin;      // pattern rotation, radians
uniform int uSteps;
uniform float uOctaves;
uniform float uFrame;     // golden-ratio sequence for temporal jitter
uniform vec2 uTexel;

const float PI = 3.14159265;

float n3(vec3 p) { return texture(uNoise, p).r; }

float fbm3(vec3 p) {
  return 0.5 * n3(p) + 0.25 * n3(p * 2.03 + 0.13) + 0.125 * n3(p * 4.11 + 0.37);
}
float fbm5(vec3 p) {
  float s = fbm3(p);
  if (uOctaves > 3.5) s += 0.0625 * n3(p * 8.3 + 0.71) + 0.03125 * n3(p * 16.7 + 0.29);
  return s;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Two logarithmic spiral arms; 1 on an arm, 0 between arms.
float arms(float th, float r, float offset) {
  return 0.5 + 0.5 * cos(2.0 * (th + log(r + 0.04) * 3.4 + offset));
}

// Emitted light (rgb) and dust density (a) at a point in galaxy space.
vec4 sampleGalaxy(vec3 pw) {
  vec3 p = pw;
  p.xz = rot(uSpin) * p.xz;
  float r = length(p.xz);
  float h = p.y;
  float th = atan(p.z, p.x);

  float big = fbm3(p * 1.3 + 3.1);            // large-scale irregularity
  float warp = (big - 0.44) * 2.2;

  // stellar disk
  float a = arms(th, r, warp);
  float diskH = 0.013 + 0.028 * smoothstep(0.2, 1.1, r);
  float disk = exp(-r / 0.40) * exp(-abs(h) / diskH);
  float clump = fbm3(p * 7.0 + 7.0);
  disk *= mix(0.35, 1.0, a * a) * (0.35 + 1.3 * clump * clump);
  disk *= 1.0 - smoothstep(0.9, 1.45, r);

  // bulge: bright compact core plus a broad soft glow that rises off the plane
  float rb = length(vec3(p.x, h / 0.6, p.z));
  float core = exp(-rb / 0.045) * 2.6;
  float bulge = exp(-rb / 0.13) * 1.5;
  float glow = exp(-length(vec3(p.x, h / 0.7, p.z)) / 0.3) * 0.28;

  // faint blue stellar halo
  float halo = exp(-length(vec3(p.x, h / 0.38, p.z)) / 0.8) * 0.03;

  vec3 warm = vec3(1.0, 0.80, 0.48);
  vec3 cream = vec3(0.95, 0.92, 0.80);
  vec3 blue = vec3(0.52, 0.68, 1.0);
  vec3 diskCol = mix(cream, blue, smoothstep(0.1, 0.6, r));
  vec3 emit = core * warm + bulge * mix(warm, cream, 0.6) + glow * mix(warm, cream, 0.7)
            + disk * diskCol * (2.4 + 2.2 * smoothstep(0.25, 0.8, r)) + halo * vec3(0.42, 0.56, 0.85);

  // dust: billowing clouds trailing the arms. Domain-warped fbm gives
  // coherent cloud shapes instead of per-pixel grain.
  float slab = abs(h - (big - 0.44) * 0.07);
  if (slab > 0.14) return vec4(emit, 0.0);
  float ad = arms(th, r, warp - 0.5);
  vec3 w = vec3(fbm3(p * 1.7 + 1.3), fbm3(p * 1.7 + 4.7), fbm3(p * 1.7 + 9.1)) - 0.45;
  float cloud = fbm5(p * 4.0 + w * 1.8);
  float thick = 0.014 + 0.075 * smoothstep(0.38, 0.7, cloud);
  float dust = exp(-slab / thick);
  dust *= smoothstep(0.1, 0.3, r) * (1.0 - smoothstep(0.85, 1.35, r));
  dust *= mix(0.05, 1.0, ad * ad) * smoothstep(0.5, 0.6, cloud);
  return vec4(emit, dust);
}

// interleaved gradient noise: even, static dither for the ray start
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec2 jit = fract(vec2(0.7548777, 0.5698403) * uFrame) - 0.5;
  vec2 ndc = (vUv + jit * uTexel) * 2.0 - 1.0 - uShift;
  vec3 rd = normalize(uFwd + ndc.x * uTan * uAspect * uRight + ndc.y * uTan * uUp);
  vec3 ro = uCamPos;

  // bounding sphere
  float R = 1.55;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) { outColor = vec4(0.0); return; }
  float sq = sqrt(disc);
  float t0 = max(-b - sq, 0.0);
  float t1 = -b + sq;

  float j = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float t = t0;
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps || t > t1 || T < 0.015) break;
    vec3 p = ro + rd * t;
    // fine steps near the disk plane, coarse steps far from it
    float dt = clamp(abs(p.y) * 0.4, 0.009, 0.08);
    p += rd * dt * j;                       // jittered sample position inside the step
    vec4 s = sampleGalaxy(p);
    float r = length(p);
    // dust is lit by the core: bright rims close in, dark blue-grey further out
    // Henyey-Greenstein forward scattering of core light toward the camera:
    // dust sitting in front of the bulge gets bright, silvery edges
    float mu = dot(normalize(p), -rd);
    float g = 0.55;
    float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.25;
    vec3 lit = vec3(1.0, 0.93, 0.82) * 2.2 * hg / (1.0 + pow(r / 0.2, 2.0))
             + vec3(0.40, 0.52, 0.70) * 0.6 * exp(-r / 0.6);
    vec3 src = s.rgb + s.a * lit;
    float sigma = s.a * 45.0;
    float trans = exp(-sigma * dt);
    // energy-conserving integration of emission over the step
    vec3 contrib = sigma > 1e-4 ? src * (1.0 - trans) / sigma : src * dt;
    col += T * contrib;
    T *= trans;
    t += dt;
  }

  col *= 1.8;
  col = 1.0 - exp(-col);                      // soft filmic roll-off
  col = pow(col, vec3(0.92));
  outColor = vec4(col, 1.0 - T);
}`;

export const accumFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform float uBlend;
void main() { outColor = mix(texture(uHist, vUv), texture(uCur, vUv), uBlend); }`;

export const blitFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = texture(uTex, vUv); }`;
