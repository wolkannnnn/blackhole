/* ==========================================================================
 *  blackhole.frag.js  —  the heart of the project
 *
 *  A single full-screen fragment shader that ray-marches CURVED light rays
 *  from the camera through a 5D-flavoured black hole spacetime.
 *
 *  ── THE 5D IDEA (how the "5th dimension" is faked) ───────────────────────
 *  A 5D spacetime has 4 spatial dimensions (x, y, z, w). We can only render a
 *  3D slice of it. The slider uniform `uW` (0..1) chooses WHICH slice of the
 *  4D-space horizon we are looking at:
 *
 *     uW = 0.0   → slice through a 4-ball        → SPHERE
 *     uW = 0.5   → slice through S¹ × S² horizon → BLACK RING (torus)
 *     uW = 1.0   → slice of a knotted/linked body → TWISTED FORM (Hopf-like)
 *
 *  The horizon is an SDF that is blended between those three shapes
 *  (see sdHorizon). The same `uW` also:
 *    • fans the accretion-disk layers out into different planes
 *      (layers are 3D "shadows" of sheets that live in different 4D planes),
 *    • changes the gravity fall-off (5D gravity is steeper: ~1/r³ vs 1/r²),
 *    • adds gravitomagnetic swirl (frame dragging) to the light rays,
 *    • drives a hidden 4th noise coordinate `w4` so plasma, tendrils and
 *      rifts "flow through" the extra dimension instead of just translating,
 *    • warps the background sky with a non-Euclidean wobble.
 *
 *  ── RENDERING OVERVIEW ───────────────────────────────────────────────────
 *  for every pixel:
 *    1. build the camera ray
 *    2. step the ray; at each step
 *         – bend it with a Schwarzschild-like acceleration (+ 5D extras)
 *         – test the morphing horizon SDF → absorbed = black
 *         – accumulate glow of the photon layer around the horizon
 *         – accumulate 3 fractured, counter-rotating disk layers (volumetric)
 *         – accumulate dark-energy tendrils (absorbing + violet edge glow)
 *    3. if the ray escaped, sample the lensed sky (nebula, stars, rifts)
 *  Output is linear HDR; bloom / tone-mapping happen in post.frag.js.
 * ========================================================================== */
window.SHADERS = window.SHADERS || {};

window.SHADERS.blackholeFrag = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
#define MAX_STEPS 260

// Explicit-LOD texture fetch: safe inside divergent loops (WebGL1 + WebGL2).
#if __VERSION__ >= 300
  #define TEXLOD(s, uv) textureLod(s, uv, 0.0)
#else
  #define TEXLOD(s, uv) texture2DLodEXT(s, uv, 0.0)
#endif

varying vec2 vUv;

uniform sampler2D uNoiseTex;   // 256x256 RGBA random texture (value-noise source)
uniform float uTime;
uniform vec2  uRes;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uW;              // THE 5th-dimension slider, 0..1
uniform float uSteps;          // max march steps (quality)
#if __VERSION__ >= 300
  // A uniform loop bound stops the shader compiler (ANGLE/fxc) from unrolling
  // the whole march loop, which otherwise can take minutes to compile.
  uniform int uIter;
  #define LOOP_END uIter
#else
  #define LOOP_END MAX_STEPS
#endif
uniform float uOutScale;       // 1.0 for HDR targets, <1 for the LDR fallback
uniform mat3  uLayer0;         // world -> disk-layer frames (rows = layer axes)
uniform mat3  uLayer1;
uniform mat3  uLayer2;
uniform vec3  uLayerOff;       // per-layer offset along its own normal

/* ───────────────────────────── hashing / noise ───────────────────────────── */

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// 3D value noise using only 1 texture fetch (2 slices are packed in R and G;
// G(x,y) = R(x+37, y+17) so the z-layer above is the G channel).
float noiseT(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = p.xy + vec2(37.0, 17.0) * p.z + f.xy;
  vec2 rg = TEXLOD(uNoiseTex, (uv + 0.5) / 256.0).xy;
  return mix(rg.x, rg.y, f.z);
}

// "4D" value noise: linearly blend two 3D noise slices along the hidden
// coordinate w. Moving w slides through the 4th dimension, so features
// morph / appear / vanish instead of merely translating in 3D.
float noise4(vec3 p, float w) {
  float fw = floor(w);
  float ff = fract(w);
  ff = ff * ff * (3.0 - 2.0 * ff);
  vec3 o0 = vec3(fw * 17.13, fw * 31.71, fw * 9.57);
  vec3 o1 = o0 + vec3(17.13, 31.71, 9.57);
  return mix(noiseT(p + o0), noiseT(p + o1), ff);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * noiseT(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

/* ─────────────────────── colour ramp (blackbody-ish) ─────────────────────── */

vec3 heatColor(float h) {
  h = clamp(h, 0.0, 1.0) * 4.0;
  vec3 c = mix(vec3(0.42, 0.04, 0.02), vec3(1.00, 0.36, 0.06), smoothstep(0.0, 1.0, h));
  c = mix(c, vec3(1.00, 0.72, 0.36), smoothstep(1.0, 2.0, h));
  c = mix(c, vec3(0.92, 0.94, 1.00), smoothstep(2.0, 3.0, h));
  c = mix(c, vec3(0.50, 0.72, 1.00), smoothstep(3.0, 4.0, h));
  return c;
}

/* ───────────────────── event horizon: the 5D morph SDF ───────────────────── */

float sdTorus(vec3 p, float R, float r) {
  return length(vec2(length(p.xz) - R, p.y)) - r;
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Third shape: two linked, helically-rippled rings (a Hopf link). It is the
// 3D shadow of a torus knot that "really" lives in 4D. The body is sheared
// (twisted) around the vertical axis and slowly tumbles, so it never looks
// like the same object twice.
float sdTwisted(vec3 p, float t) {
  p.xz = rot2(t * 0.25) * p.xz;                          // slow spin
  p.xz = rot2(0.9 * p.y + 0.35 * sin(t * 0.4)) * p.xz;   // height-dependent twist

  // ring A lies in the xz-plane
  vec3 pa = p - vec3(-0.42, 0.0, 0.0);
  float angA = atan(pa.z, pa.x);
  float dA = sdTorus(pa, 0.85, 0.27) + 0.06 * sin(angA * 5.0 - t * 1.5 + pa.y * 8.0);

  // ring B lies in the xy-plane and tumbles about the x-axis (stays linked)
  vec3 pb = p - vec3(0.42, 0.0, 0.0);
  pb.yz = rot2(t * 0.4) * pb.yz;
  pb = vec3(pb.x, pb.z, -pb.y);                          // 90° turn of the torus axis
  float angB = atan(pb.z, pb.x);
  float dB = sdTorus(pb, 0.85, 0.27) + 0.06 * sin(angB * 5.0 + t * 1.3 + pb.y * 8.0);

  return smin(dA, dB, 0.25) * 0.75;
}

// Horizon signed distance. Negative = inside = light is swallowed.
//   w: 0 → sphere,  0.5 → black ring,  1 → twisted higher-dimensional form
float sdHorizon(vec3 p, float w, float t) {
  float a = smoothstep(0.0, 0.5, w);   // phase 1: sphere -> ring
  float b = smoothstep(0.5, 1.0, w);   // phase 2: ring   -> twisted form

  float dSphere = length(p) - 1.0;
  float dRing   = sdTorus(p, 1.30, 0.52);
  float dTwist  = sdTwisted(p, t);

  // Blending SDFs value-by-value morphs the *shape* smoothly: the sphere
  // hollows out into a ring, then the ring tears into two linked twisted loops.
  float d = mix(dSphere, dRing, a);
  d = mix(d, dTwist, b);

  // restless horizon surface (quantum-foam ripple), stronger when not a sphere
  float rip = sin(p.x * 5.0 + t * 1.1) * sin(p.y * 5.0 - t * 1.3) * sin(p.z * 5.0 + t * 0.9);
  d += 0.035 * rip * (0.4 + a + b);
  return d;
}

/* ───────────────── dark-energy tendrils (volumetric veins) ───────────────── */
// Thin branching filaments = where TWO independent noise fields are both ≈ 0.5
// (the intersection of two iso-surfaces is a curve in 3D). Sampling along the
// radial direction makes them radiate away from the hole; W slides the field
// through the hidden dimension so filaments reconnect and slither.
void tendrils(vec3 pos, float r, float w, float t, out float sigma, out vec3 emit) {
  vec3 q = (pos / r) * 2.4 + vec3(0.11, 0.05, -0.08) * r + vec3(t * 0.012, 0.0, w * 2.5);
  float ww = noiseT(q * 1.6 + 7.7) - 0.5;
  q += ww * vec3(1.2, -0.8, 1.0);                       // domain warp -> branching
  float na = noiseT(q) - 0.5;
  float nb = noiseT(q + vec3(19.3, 7.1, 3.7)) - 0.5;
  float d = sqrt(na * na + nb * nb);                    // distance to filament core
  float core = 1.0 - smoothstep(0.0, 0.07, d);
  float halo = smoothstep(0.07, 0.10, d) * (1.0 - smoothstep(0.10, 0.17, d));
  float mask = smoothstep(1.8, 3.0, r) * (1.0 - smoothstep(9.0, 16.0, r));
  float k = 0.55 + 0.8 * w;
  sigma = core * mask * 3.0 * k;                        // absorbs light  -> dark veins
  emit  = vec3(0.42, 0.20, 1.00) * halo * mask * 0.55 * k;   // violet rim glow
}

/* ───────────────── fractured, multi-layered accretion disk ───────────────── */
// One volumetric layer. All three layers use this function with different
// orientation matrices, radii, spin direction and colour.
//
// Returns the distance to the layer's volume (used to shrink the step size),
// or 0.0 when the sample point is inside it (emission is added to col / T).
float layerStep(mat3 M, float off, float seed, float rotDir,
                float rin, float rout, float thick, float gain,
                vec3 tint, float heatOff,
                vec3 pos, vec3 vel, float dt, float w, float t,
                inout vec3 col, inout float T)
{
  vec3 q = M * pos;               // position in the layer's own frame
  q.y -= off;
  float rho = length(q.xz);

  // 5D "breathing": the sheet is displaced along the hidden axis, which shows
  // up in 3D as a travelling ripple whose amplitude grows with W.
  float amp = 0.04 + 0.30 * w;
  float rip = amp * sin(1.4 * rho - 0.7 * t + 2.5 * q.x / max(rho, 0.001) + seed * 6.0);
  float th = thick * (0.4 + 0.18 * rho);                 // flared disk
  float hy = q.y - rip;

  // conservative distance to (annulus x slab) → adaptive step size
  float dr = max(rin * 0.9 - rho, rho - rout);
  float ds = abs(hy) - 2.8 * th;
  float dist = length(vec2(max(dr, 0.0), max(ds, 0.0)));
  if (dist > 0.0) return dist;

  float hh = hy / th;
  float vert = exp(-hh * hh);
  float rad = smoothstep(rin, rin + 0.6, rho) * (1.0 - smoothstep(rout * 0.55, rout, rho));

  // a Cassini-like gap that differs per layer
  float gd = (rho - (3.3 + seed * 1.7)) / 0.10;
  rad *= 1.0 - 0.85 * exp(-gd * gd);
  if (vert * rad < 0.01) return 0.0;

  // Rotating noise frame. Bulk rotation + a bounded, oscillating shear
  // (an ever-growing Keplerian shear would wind the pattern into aliasing).
  vec2 dir2 = q.xz / rho;
  float ang = rotDir * (0.38 * t + 12.0 * sin(t * 0.09) / (rho * sqrt(rho)))
            + 0.75 * rho * rotDir + seed * TAU;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 u = mat2(ca, -sa, sa, ca) * dir2;

  // hidden 4th coordinate of the plasma noise (this is what makes the
  // turbulence look like it exists in higher dimensions)
  float w4 = 0.8 * sin(t * 0.17 + seed * 9.0) + w * 3.5 + 0.25 * rho;
  float n1 = noise4(vec3(u * 2.0, rho * 4.0 - t * 0.45 + hh * 0.8), w4);
  float nc = noiseT(vec3(u * 1.25, rho * 0.9) + seed * 3.1);

  // turbulence + fine concentric filaments
  float tur = 0.10 + 1.55 * smoothstep(0.28, 0.80, n1);
  tur *= 0.62 + 0.38 * sin(rho * 34.0 + n1 * 8.0 + seed * 20.0);

  // fractures: thin cracks along the 0.5 iso-line of a low-frequency noise.
  // More W → wider, more numerous fractures.
  float crackW = 0.020 + 0.035 * w;
  float crack = 1.0 - smoothstep(crackW * 0.35, crackW, abs(nc - 0.5));
  float dens = vert * rad * tur * (1.0 - 0.96 * crack * (0.35 + 0.65 * w));
  if (dens < 0.004) return 0.0;

  // relativistic Doppler beaming: the side moving toward us is brighter/bluer
  vec3 nL = vec3(M[0][1], M[1][1], M[2][1]);              // layer normal in world space
  vec3 vd = cross(pos, nL);
  vd = vd / (length(vd) + 1e-4) * rotDir;                 // orbital direction
  float beta = min(0.75, 0.85 / sqrt(0.3 + 0.6 * rho));
  float D = clamp(1.0 / (1.0 - beta * dot(vd, -vel)), 0.5, 2.2);
  float boost = pow(D, 2.6);

  float heat = (pow(rin / rho, 0.55) * (0.62 + 0.75 * n1) + heatOff) * (0.62 + 0.38 * D);
  vec3 emit = heatColor(heat) * tint * (dens * gain * boost);

  col += T * emit * dt;
  T *= exp(-dens * 4.0 * dt);
  return 0.0;
}

/* ─────────────────── background: lensed nebula, stars, rifts ─────────────── */

vec3 starLayer(vec3 d, float scale, float density, float size, float seed) {
  vec3 p = d * scale;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id + seed);
  if (h > density) return vec3(0.0);
  float u1 = h / density;
  float u2 = fract(u1 * 57.3);
  vec3 off = (hash33(id + seed + 7.7) - 0.5) * 0.6;
  float dd = length(f - off);
  float rad = size * (0.55 + 0.45 * u2);
  float s = smoothstep(rad, 0.0, dd);
  s = s * s * (0.5 + 3.0 * u1 * u1);
  vec3 tint = mix(vec3(1.0, 0.72, 0.52), vec3(0.62, 0.78, 1.0), fract(u1 * 13.1));
  return tint * s;
}

vec3 stars(vec3 d) {
  vec3 s = starLayer(d, 38.0, 0.07, 0.16, 0.0) * 1.6;
  s += starLayer(d, 85.0, 0.10, 0.20, 11.0) * 1.1;
  s += starLayer(d, 190.0, 0.14, 0.30, 23.0) * 0.8;
  return s;
}

vec3 nebula(vec3 d, float t) {
  vec3 p = d * 1.7;
  float n1 = fbm(p + vec3(0.0, t * 0.004, 0.0));
  float n2 = fbm(p * 2.2 + n1 * 2.4 + vec3(5.7, 1.3, 8.1));
  float cloud = pow(smoothstep(0.30, 0.80, n2), 1.7);
  vec3 c = mix(vec3(0.07, 0.02, 0.16), vec3(0.62, 0.20, 0.50), smoothstep(0.25, 0.75, n1));
  c = mix(c, vec3(1.00, 0.52, 0.24), pow(clamp(n2 * 1.1, 0.0, 1.0), 4.0) * 0.55);
  float bd = dot(d, normalize(vec3(0.35, 0.85, 0.40))) * 3.2;
  float band = exp(-bd * bd);                            // galactic-band glow
  return c * cloud * (0.22 + 1.5 * band) * 0.9;
}

vec3 background(vec3 d, float w, float t) {
  // Non-Euclidean wobble: the sky itself is slightly folded by 5D gravity.
  vec3 sd = normalize(d + 0.05 * w * vec3(sin(d.y * 9.0 + t * 0.30),
                                          sin(d.z * 7.0 - t * 0.22),
                                          sin(d.x * 8.0 + t * 0.27)));

  vec3 base = nebula(sd, t);
  base *= 1.0 - 0.7 * smoothstep(0.45, 0.72, fbm(sd * 3.1 + 11.0));   // dust lanes
  base += stars(sd);

  // dark-energy veins on the sky (single-noise iso-line = curve on the sphere)
  vec3 vp = sd * 1.7 + vec3(0.0, t * 0.01, 0.0);
  float wv = noiseT(vp * 1.4 + 3.0) - 0.5;
  float vn = noiseT(vp + wv * 1.6 + vec3(5.0, 1.0, 9.0));
  float vdist = abs(vn - 0.5);
  float vein = 1.0 - smoothstep(0.0, 0.035, vdist);
  float rim = smoothstep(0.035, 0.06, vdist) * (1.0 - smoothstep(0.06, 0.11, vdist));
  base *= 1.0 - 0.92 * vein;
  base += vec3(0.30, 0.12, 0.55) * rim * (0.10 + 0.25 * w);

  // dimensional rifts: hairline cracks with chromatic edges, born as W rises
  float rw = 0.010 + 0.018 * w;
  vec3 rp = sd * 2.6 + vec3(t * 0.02, 0.0, w * 2.0);
  float rA = noiseT(rp);
  float rB = noiseT(rp + vec3(0.035, 0.0, 0.0));
  float rC = noiseT(rp + vec3(0.070, 0.0, 0.0));
  vec3 rift = vec3(1.0 - smoothstep(0.0, rw, abs(rA - 0.5)),
                   1.0 - smoothstep(0.0, rw, abs(rB - 0.5)),
                   1.0 - smoothstep(0.0, rw, abs(rC - 0.5)));
  base += rift * vec3(1.6, 0.7, 2.0) * (0.05 + 1.0 * smoothstep(0.3, 1.0, w));
  return base;
}

/* ─────────────────────────────────── main ────────────────────────────────── */

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;
  vec3 rd = normalize(uCamFwd + uCamRight * (uv.x * uTanHalfFov) + uCamUp * (uv.y * uTanHalfFov));

  float w = uW;
  float t = uTime;
  float a = smoothstep(0.0, 0.5, w);      // sphere -> ring phase
  float b = smoothstep(0.5, 1.0, w);      // ring   -> twisted phase

  // ── how W bends space ────────────────────────────────────────────────────
  // point-mass lensing weakens a bit while the horizon is a ring (no central
  // mass → you can peek through the hole), then strengthens in the twisted form
  float lensK    = 1.5 * (1.0 + 0.35 * w) * mix(1.0, 0.55, a * (1.0 - b));
  float dimExp   = 0.30 * w;                                   // 5D: steeper gravity
  float ringPull = a * (1.0 - 0.6 * b);                        // pull toward the ring
  float spin     = 0.10 + 0.25 * a + 1.5 * b;                  // frame-dragging swirl
  vec3 spinAxis  = normalize(vec3(0.30 * b * sin(t * 0.23), 1.0, 0.30 * b * cos(t * 0.19)));

  float jit = hash12(gl_FragCoord.xy + fract(t) * 91.7);       // de-band the steps

  vec3 pos = uCamPos;
  vec3 vel = rd;
  vec3 col = vec3(0.0);
  float T = 1.0;                       // transmittance
  bool captured = false;
  float dmin = 1000.0;                 // distance to nearest disk volume (prev. step)
  float tSig = 0.0;                    // cached tendril sample (updated every 2nd step)
  vec3  tEmit = vec3(0.0);

  for (int i = 0; i < LOOP_END; i++) {
    if (float(i) >= uSteps) break;

    float r2 = dot(pos, pos);
    float r = sqrt(r2);
    if (r > 18.0 && dot(pos, vel) > 0.0) break;   // escaped to the sky
    if (T < 0.01) break;                          // fully occluded

    // ── event horizon test (only near the hole) ─────────────────────────
    float dH = 9.0;
    if (r < 3.4) {
      dH = sdHorizon(pos, w, t);
      if (dH < 0.0) { captured = true; break; }
    }

    // ── adaptive step: small near the hole and near disk layers ─────────
    float dt = 0.015 + 0.04 * r;
    dt = min(dt, max(0.02, dH * 0.6));
    dt = min(dt, max(0.045, dmin * 0.8));
    dt *= 0.85 + 0.3 * jit;

    // ── accretion disk: three fractured, counter-rotating layers ────────
    dmin = 1000.0;
    dmin = min(dmin, layerStep(uLayer0, uLayerOff.x, 0.13,  1.0, 2.0 + 0.3 * w, 7.0, 0.11, 5.0,
                               vec3(1.00, 0.90, 0.78), 0.05, pos, vel, dt, w, t, col, T));
    dmin = min(dmin, layerStep(uLayer1, uLayerOff.y, 0.47, -1.0, 2.2 + 0.3 * w, 5.8, 0.08, 4.2,
                               vec3(0.70, 0.85, 1.10), 0.25, pos, vel, dt, w, t, col, T));
    dmin = min(dmin, layerStep(uLayer2, uLayerOff.z, 0.81,  1.0, 2.4 + 0.3 * w, 4.8, 0.07, 3.6,
                               vec3(1.10, 0.65, 1.00), -0.05, pos, vel, dt, w, t, col, T));

    // ── photon layer glow hugging the horizon + faint volumetric halo ───
    if (r < 3.4) {
      float g = exp(-max(dH, 0.0) * 4.5);
      col += T * vec3(0.66, 0.80, 1.00) * (g * dt * 1.6);
    }
    col += T * vec3(0.30, 0.36, 0.75) * (dt * 0.05 / (0.6 + r2 * 0.12));

    // ── dark-energy tendrils ────────────────────────────────────────────
    if (r > 1.8 && r < 16.0) {
      if (mod(float(i), 2.0) < 0.5) tendrils(pos, r, w, t, tSig, tEmit);
      col += T * tEmit * dt;
      T *= exp(-tSig * dt);
    }

    // ── 5D-flavoured geodesic bending ───────────────────────────────────
    float rs = max(r, 0.25);
    vec3 hv = cross(pos, vel);
    float h2 = dot(hv, hv);
    float inv = 1.0 / (r2 * r2 * rs);                          // 1/r^5 Schwarzschild
    inv *= mix(1.0, 1.5 / rs, dimExp);                         // 5D: steeper near the hole
    vec3 acc = -lensK * h2 * pos * inv;
    acc += spin * cross(spinAxis, vel) / (r2 * rs + 0.5);      // gravitomagnetic swirl
    if (ringPull > 0.001) {
      vec3 c = vec3(pos.x, 0.0, pos.z);
      c = c / (length(c) + 1e-4) * 1.3;                        // nearest point on the ring
      vec3 tc = c - pos;
      float dd = dot(tc, tc) + 0.2;
      acc += ringPull * 0.6 * tc / (dd * sqrt(dd));
    }
    vel = normalize(vel + acc * dt);
    pos += vel * dt;
  }

  vec3 outCol = col;
  if (!captured) {
    outCol += T * background(normalize(vel), w, t);
  }
  outCol = min(outCol, vec3(60.0));
  gl_FragColor = vec4(outCol * uOutScale, 1.0);
}
`;
