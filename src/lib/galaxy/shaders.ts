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
  vec3 base = vec3(0.035, 0.068, 0.110);
  vec3 near = vec3(0.100, 0.175, 0.270);
  outColor = vec4(mix(base, near, glow), 1.0);
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

// Shared by the bake pass and the ray marcher.
const common = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;

float n3(vec3 p) { return texture(uNoise, p).r; }
float fbm3(vec3 p) {
  return 0.5 * n3(p) + 0.25 * n3(p * 2.03 + 0.13) + 0.125 * n3(p * 4.11 + 0.37);
}
float fbm5(vec3 p) {
  return fbm3(p) + 0.0625 * n3(p * 8.3 + 0.71) + 0.03125 * n3(p * 16.7 + 0.29);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Two logarithmic spiral arms; 1 on an arm, 0 between arms.
float arms(float th, float r, float offset) {
  return 0.5 + 0.5 * cos(2.0 * (th + log(r + 0.04) * 2.0 + offset));
}

// Extent of the baked field in galaxy space.
const float FIELD_R = 1.25;
const float FIELD_H = 0.2;

// Dust density from the slow-varying fields; 'cloud' may carry runtime detail.
float dustShape(vec3 p, float big, float cloud) {
  float r = length(p.xz);
  float slab = abs(p.y - (big - 0.44) * 0.07);
  float thick = 0.008 + 0.045 * smoothstep(0.42, 0.75, cloud);
  float d = exp(-slab / thick);
  d *= smoothstep(0.1, 0.3, r) * exp(-r / 0.85) * 1.8;
  float ad = arms(atan(p.z, p.x), r, (big - 0.44) * 2.2 - 0.5);
  // denser and continuous inside, breaking into filaments further out
  float cut = 0.455 + 0.08 * smoothstep(0.35, 1.2, r);
  d *= mix(0.2, 1.0, ad) * smoothstep(cut, cut + 0.04, cloud);
  return d;
}

// Baked field lookup (see bakeFrag); outside it there's no dust.
uniform sampler3D uField;
vec4 field(vec3 p) {
  vec3 uvw = vec3(p.x / (2.0 * FIELD_R) + 0.5, p.z / (2.0 * FIELD_R) + 0.5, p.y / (2.0 * FIELD_H) + 0.5);
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return vec4(0.45, 1.0, 0.45, 0.44);
  return texture(uField, uvw);
}
`;

// Bakes the expensive noise into a 3D texture once, one layer per draw:
//   r = cloud field (domain-warped fbm), g = transmittance toward the core,
//   b = stellar clumping, a = large-scale irregularity
// The galaxy's stars, generated entirely on the GPU from gl_VertexID: a
// random position from the disk or bulge distribution, brightness shaped by
// the same arms and clumping as the volume, and dimmed by the dust between
// the star and the camera (a short march through the baked field).
export const galaxyStarsVert = /* glsl */ `#version 300 es
${common}
uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTan, uAspect, uDpr, uSpin, uCount;
uniform vec2 uShift;
out float vBright;
out vec3 vColor;
out float vSize;

uint hashu(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float rnd(uint id, uint k) { return float(hashu(id * 0x9e3779b9u + k * 0x85ebca6bu) & 0xffffffu) / 16777216.0; }
float gauss(uint id, uint k) {
  return sqrt(-2.0 * log(rnd(id, k) + 1e-7)) * cos(6.2831853 * rnd(id, k + 1u));
}

void main() {
  uint id = uint(gl_VertexID);
  bool isBulge = float(gl_VertexID) < uCount * 0.2;
  vec3 g;
  if (isBulge) {
    float rb = -0.075 * log((rnd(id, 1u) + 1e-7) * (rnd(id, 2u) + 1e-7) * (rnd(id, 3u) + 1e-7));
    vec3 dir = normalize(vec3(gauss(id, 4u), gauss(id, 6u), gauss(id, 8u)) + 1e-5);
    g = dir * rb * vec3(1.0, 0.7, 1.0);
  } else {
    float rr = -0.34 * log((rnd(id, 1u) + 1e-7) * (rnd(id, 2u) + 1e-7));
    float th = 6.2831853 * rnd(id, 3u);
    if (rnd(id, 12u) < 0.78) {
      // most disk stars sit along one of the two arms (the crest of arms()),
      // including the same large-scale warp, with some scatter
      float th0 = floor(rnd(id, 13u) * 2.0) * 3.14159265 - log(rr + 0.04) * 2.0;
      float warp = (fbm3(vec3(rr * cos(th0), 0.0, rr * sin(th0)) * 1.3 + 3.1) - 0.44) * 2.2;
      th = th0 - warp + gauss(id, 14u) * 0.22;
    }
    float hh = gauss(id, 4u) * (0.008 + 0.022 * smoothstep(0.2, 1.1, rr));
    g = vec3(rr * cos(th), hh, rr * sin(th));
  }
  float r = length(g.xz);

  float big = fbm3(g * 1.3 + 3.1);
  float a = arms(atan(g.z, g.x), r, (big - 0.44) * 2.2);
  float clump = fbm3(g * 7.0 + 7.0);
  float m = pow(rnd(id, 10u), 7.0);                    // a few bright stars, many faint ones
  float w = isBulge ? 1.0 : mix(0.3, 1.0, a * a) * (0.25 + 1.8 * clump * clump) * 1.2;
  w *= 1.0 - smoothstep(1.0, 1.5, r);

  // dust between the star and the camera, in galaxy space
  vec3 cam = uCamPos;
  cam.xz = rot(uSpin) * cam.xz;
  vec3 toCam = cam - g;
  float ty = abs(toCam.y) > 1e-4 ? (sign(toCam.y) * FIELD_H - g.y) / toCam.y : 1.0;   // where it leaves the slab
  float seg = clamp(ty, 0.0, 1.0) * length(toCam);
  vec3 dir = normalize(toCam);
  float stepLen = min(seg, 1.2) / 7.0;
  float od = 0.0;
  for (int i = 0; i < 7; i++) {
    vec3 q = g + dir * stepLen * (float(i) + 0.5);
    vec4 f = field(q);
    od += dustShape(q, f.a, f.r) * stepLen;
  }
  float trans = exp(-od * 60.0);

  // back to world space and onto the screen
  vec3 pw = g;
  pw.xz = rot(-uSpin) * pw.xz;
  vec3 d = pw - uCamPos;
  vec3 v = vec3(dot(d, uRight), dot(d, uUp), dot(d, uFwd));
  float bright = (0.32 + m * 3.6) * w * trans;
  if (v.z <= 0.0 || bright < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec2 ndc = vec2(v.x / (v.z * uTan * uAspect), v.y / (v.z * uTan)) + uShift;
  gl_Position = vec4(ndc, 0.0, 1.0);
  // nearer stars are a little bigger, so flying in has depth
  float near = clamp(3.0 / v.z, 0.7, 2.6);
  vSize = (0.55 + m * 1.6) * uDpr * near;
  gl_PointSize = vSize * 3.0;
  vBright = bright / pow(near, 1.4);       // bigger, not brighter, so close-ups don't blow out
  vec3 warm = vec3(1.0, 0.86, 0.62), white = vec3(0.95, 0.96, 1.0), blue = vec3(0.66, 0.79, 1.0);
  vColor = isBulge ? mix(warm, white, rnd(id, 11u) * 0.4)
                   : mix(mix(warm, white, smoothstep(0.05, 0.25, r)), blue, smoothstep(0.25, 0.7, r) * (0.6 + 0.4 * rnd(id, 11u)));
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


export const bakeFrag = /* glsl */ `#version 300 es
${common}
in vec2 vUv;
out vec4 outColor;
uniform float uY;             // galaxy-space height of this layer

float bigAt(vec3 p) { return fbm3(p * 1.3 + 3.1); }
float cloudAt(vec3 p) {
  vec3 w = vec3(fbm3(p * 1.7 + 1.3), fbm3(p * 1.7 + 4.7), fbm3(p * 1.7 + 9.1)) - 0.45;
  return fbm5(p * 5.2 + w * 2.1);
}

void main() {
  vec3 p = vec3((vUv.x - 0.5) * 2.0 * FIELD_R, uY, (vUv.y - 0.5) * 2.0 * FIELD_R);
  float big = bigAt(p);
  float cloud = cloudAt(p);
  // march toward the core to see how much dust shades this point
  float od = 0.0;
  float dist = length(p);
  vec3 l = -p / max(dist, 1e-4);
  float stepLen = min(dist, 0.5) / 12.0;
  for (int i = 1; i <= 12; i++) {
    vec3 q = p + l * stepLen * float(i);
    od += dustShape(q, bigAt(q), cloudAt(q)) * stepLen;
  }
  outColor = vec4(cloud, exp(-od * 30.0), fbm3(p * 7.0 + 7.0), big);
}`;

export const volumeFrag = /* glsl */ `#version 300 es
${common}
in vec2 vUv;
out vec4 outColor;

uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTan, uAspect;
uniform vec2 uShift;
uniform float uSpin;      // pattern rotation, radians
uniform int uSteps;
uniform float uFrame;     // golden-ratio sequence for temporal jitter
uniform vec2 uTexel;


vec3 emissionAt(vec3 p, float big, float clump) {
  float r = length(p.xz);
  float h = p.y;
  float a = arms(atan(p.z, p.x), r, (big - 0.44) * 2.2);

  // stellar disk: thin and blue-white, brightest along the arms
  float diskH = 0.010 + 0.022 * smoothstep(0.2, 1.1, r);
  float disk = exp(-r / 0.42) * exp(-abs(h) / diskH);
  disk *= mix(0.15, 1.0, a * a) * (0.4 + 1.2 * clump * clump);
  disk *= (1.0 - smoothstep(0.95, 1.5, r)) * mix(0.25, 1.0, smoothstep(0.06, 0.4, r));

  // bulge: hot core, cream bulge, and a soft glow rising off the plane
  float rb = length(vec3(p.x, h / 0.78, p.z));
  float core = exp(-rb / 0.045) * 3.0;
  float bulge = exp(-rb / 0.16) * 2.2;
  // the big cream glow sits mostly on the far side of the lane, as in the wallpaper
  float glow = exp(-length(vec3(p.x, h / 0.34, p.z)) / 0.37) * 0.55 * mix(0.3, 1.0, smoothstep(-0.12, 0.1, h));
  float halo = exp(-length(vec3(p.x, h / 0.35, p.z)) / 0.9) * 0.09;

  vec3 warm = vec3(1.0, 0.74, 0.36);
  vec3 cream = vec3(1.0, 0.91, 0.70);
  vec3 blue = vec3(0.56, 0.73, 1.0);
  vec3 diskCol = mix(cream, blue, smoothstep(0.08, 0.35, r));
  return core * warm + bulge * mix(warm, cream, 0.5) + glow * mix(warm, cream, 0.45)
       + disk * diskCol * (2.6 + 3.4 * smoothstep(0.25, 0.8, r)) + halo * vec3(0.32, 0.52, 0.95);
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
  float t = max(-b - sq, 0.0);
  float t1 = -b + sq;

  float j = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uSteps || t > t1 || T < 0.01) break;
    vec3 pw = ro + rd * t;
    // fine steps inside the dust slab, coarse steps far from the plane
    float dt = clamp(abs(pw.y) * 0.4, 0.008, 0.08);
    pw += rd * dt * j;
    vec3 p = pw;
    p.xz = rot(uSpin) * p.xz;
    vec4 f = field(p);
    vec3 src = emissionAt(p, f.a, f.b);
    float d = 0.0;
    if (abs(p.y) < FIELD_H) {
      // runtime detail breaks up the baked cloud edges
      float detail = (n3(p * 23.0) - 0.5) + 0.5 * (n3(p * 51.0 + 0.3) - 0.5);
      d = dustShape(p, f.a, f.r + detail * 0.1);
    }
    float sigma = d * 60.0;
    if (d > 0.001) {
      // Dust radiance: what a thick cloud looks like by itself. Lit faces that
      // see the bulge are blue-white, shadowed ones a deep navy.
      float r = length(p);
      float mu = dot(normalize(p), -rd);
      const float G = 0.6;                                 // forward scattering
      float hg = (1.0 - G * G) / pow(1.0 + G * G - 2.0 * G * mu, 1.5) * 0.25;
      vec3 key = vec3(0.82, 0.90, 1.0) * 3.2 * hg * f.g * f.g / (1.0 + pow(r / 0.32, 2.0));
      vec3 ambient = vec3(0.05, 0.09, 0.16) * (0.45 + 0.55 * f.g) * exp(-r / 1.1);
      src += sigma * (key + ambient);
    }
    float trans = exp(-sigma * dt);
    vec3 contrib = sigma > 1e-4 ? src * (1.0 - trans) / sigma : src * dt;
    col += T * contrib;
    T *= trans;
    t += dt;
  }

  // tone map on luminance so bright cream stays cream instead of going white
  col *= 2.0;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float mapped = 1.0 - exp(-lum * 1.1);
  col = lum > 1e-5 ? col * (mapped / lum) : col;
  col = mix(col, vec3(mapped), smoothstep(0.75, 1.0, mapped) * 0.6);   // highlights still roll off to white
  col = pow(min(col, vec3(1.0)), vec3(1.05));
  outColor = vec4(col, 1.0 - T);
}`;

// The magenta tile, as a textured quad in the scene. Corners are placed on
// the CPU each frame; this just projects them with the same camera as the stars.
export const tileVert = /* glsl */ `#version 300 es
in vec3 aPos;
in vec2 aUv;
uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTan, uAspect;
uniform vec2 uShift;
out vec2 vUv;
void main() {
  vec3 d = aPos - uCamPos;
  vec3 v = vec3(dot(d, uRight), dot(d, uUp), dot(d, uFwd));
  vec2 ndc = vec2(v.x / (v.z * uTan * uAspect), v.y / (v.z * uTan)) + uShift;
  vUv = aUv;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

export const tileFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uShade;      // a touch darker as it turns away from the camera
uniform float uAlpha;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb * uShade, c.a) * uAlpha;
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
