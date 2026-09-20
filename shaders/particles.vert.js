/* ==========================================================================
 *  particles.vert.js  —  glowing plasma with 5D motion (one draw call)
 *
 *  ~110k additive point sprites drawn from ONE BufferGeometry. All motion is
 *  computed on the GPU from per-vertex random seeds — the CPU never touches
 *  the particles after upload.
 *
 *  Each "particle" is really 8 vertices: 4 trail samples (older times) x
 *  2 lensed images (primary + secondary, like a real gravitational lens).
 *
 *  ── 5D MOTION ────────────────────────────────────────────────────────────
 *  Every particle owns a hidden 4th spatial coordinate w4 that oscillates.
 *  We rotate its 4D position in two mixed planes (x–w and z–w). The
 *  rotation angles grow with the slider uW, so at uW = 0 the flow is a
 *  calm 3D orbit, and as uW → 1 particles "dive" out of our 3D slice:
 *  they slide sideways, drift between layers and FADE OUT (exp(-w²)) when
 *  their leftover w-coordinate is large — exactly what a 4D object crossing
 *  a 3D hyperplane would look like.
 *
 *  ── LENSING OF SPRITES ───────────────────────────────────────────────────
 *  Points are rasterised, not ray-marched, so they can't follow the curved
 *  rays. Instead each sprite is moved to where a THIN GRAVITATIONAL LENS
 *  would place its image (lens equation  θ² − βθ − θE² = 0), and hidden if
 *  that image would land inside the black hole's shadow.
 * ========================================================================== */
window.SHADERS = window.SHADERS || {};

window.SHADERS.particlesVert = /* glsl */ `
#define TAU 6.28318530718

uniform float uTime;
uniform float uW;
uniform vec3  uCamPos;
uniform float uPointScale;
uniform float uShadowR;
uniform float uLensK;
uniform mat3  uLayer0;
uniform mat3  uLayer1;
uniform mat3  uLayer2;
uniform vec3  uLayerOff;

attribute vec4 aSeed;   // 4 random numbers per particle (same for all its vertices)
attribute vec2 aMeta;   // x = trail index (0..3), y = lensed image id (0 or 1)

varying vec3  vCol;
varying float vAlpha;

vec3 heatColor(float h) {
  h = clamp(h, 0.0, 1.0) * 4.0;
  vec3 c = mix(vec3(0.42, 0.04, 0.02), vec3(1.00, 0.36, 0.06), smoothstep(0.0, 1.0, h));
  c = mix(c, vec3(1.00, 0.72, 0.36), smoothstep(1.0, 2.0, h));
  c = mix(c, vec3(0.92, 0.94, 1.00), smoothstep(2.0, 3.0, h));
  c = mix(c, vec3(0.50, 0.72, 1.00), smoothstep(3.0, 4.0, h));
  return c;
}

void main() {
  float trail = aMeta.x;
  float imgId = aMeta.y;
  float t = uTime - trail * 0.05;               // older trail samples = earlier time

  // ── which disk layer does this particle live in? ────────────────────────
  float kf  = aSeed.x * 3.0;
  float k   = floor(kf);
  float cls = fract(kf);

  mat3 M;
  float off;
  float rotDir;
  float rin;
  float rout;
  float seedL;
  vec3 tint;
  float heatOff;
  if (k < 0.5) {
    M = uLayer0; off = uLayerOff.x; rotDir = 1.0;  rin = 2.0 + 0.3 * uW; rout = 7.0;
    seedL = 0.13; tint = vec3(1.00, 0.90, 0.78); heatOff = 0.05;
  } else if (k < 1.5) {
    M = uLayer1; off = uLayerOff.y; rotDir = -1.0; rin = 2.2 + 0.3 * uW; rout = 5.8;
    seedL = 0.47; tint = vec3(0.70, 0.85, 1.10); heatOff = 0.25;
  } else {
    M = uLayer2; off = uLayerOff.z; rotDir = 1.0;  rin = 2.4 + 0.3 * uW; rout = 4.8;
    seedL = 0.81; tint = vec3(1.10, 0.65, 1.00); heatOff = -0.05;
  }

  // ── orbit (Keplerian) or infall spiral ──────────────────────────────────
  float rho;
  float ang;
  float life = 1.0;
  float infall = 0.0;
  if (cls > 0.72) {
    float lf = fract(aSeed.z * 13.7 + t * 0.05);          // 0 = outer edge, 1 = plunged
    rho = mix(rout * 0.95, 1.1, pow(lf, 1.3));
    ang = aSeed.w * TAU + rotDir * (2.0 + 9.0 * pow(lf, 0.7));
    life = sin(3.14159265 * lf);                          // fade in/out at the ends
    infall = 1.0 - lf;
  } else {
    rho = mix(rin, rout, pow(aSeed.y, 0.7));
    ang = aSeed.z * TAU + rotDir * 2.2 / (rho * sqrt(rho)) * t;
  }

  // height inside the flared sheet + the same ripple the ray-marched disk has
  float th  = 0.09 * (0.4 + 0.18 * rho);
  float h   = (fract(aSeed.w * 7.13) - 0.5) * th * 4.0;
  float rip = (0.04 + 0.30 * uW) * sin(1.4 * rho - 0.7 * t + 2.5 * cos(ang) + seedL * 6.0);
  vec3 lp = vec3(cos(ang) * rho, h + off + rip, sin(ang) * rho);   // layer-local 3D position

  // ── 5D: give the particle a hidden coordinate and rotate through it ─────
  float w4 = (0.25 + 1.4 * uW) * sin(t * 0.5 + aSeed.x * 40.0) + 0.8 * uW * (aSeed.y - 0.5);
  float ph = uW * (0.6 + 0.15 * rho) * (1.0 + 0.3 * sin(t * 0.3));   // x–w rotation angle
  float c1 = cos(ph);
  float s1 = sin(ph);
  float x2 = lp.x * c1 - w4 * s1;
  float wa = lp.x * s1 + w4 * c1;
  float ps = 0.45 * uW * sin(t * 0.27 + aSeed.z * 6.0);             // z–w rotation angle
  float c2 = cos(ps);
  float s2 = sin(ps);
  float z2 = lp.z * c2 - wa * s2;
  float wb = lp.z * s2 + wa * c2;                                   // leftover 5th-dim depth
  vec3 lp3 = vec3(x2, lp.y, z2);
  vec3 wp = lp3 * M;                        // layer frame -> world  (row-vector * M = M^T * v)
  float slice = exp(-wb * wb * 0.35);       // visibility inside our 3D hyperplane

  // ── thin-lens image position ────────────────────────────────────────────
  vec3 C = uCamPos;
  float Dl = length(C);
  vec3 L = -C / Dl;                         // observer -> lens direction
  vec3 rel = wp - C;
  float len = length(rel);
  vec3 d = rel / len;
  float Ds = dot(rel, L);                   // source distance along the optical axis
  float cb = clamp(dot(d, L), -1.0, 1.0);
  float beta = acos(cb);                    // angular offset of the true source
  vec3 dn = d;
  float mag = 1.0;
  float vis = 1.0;
  if (Ds > Dl) {
    float Dls = Ds - Dl;
    float thE2 = 2.0 * uLensK * Dls / (Dl * Ds);       // Einstein angle squared
    float sq = sqrt(beta * beta + 4.0 * thE2);
    float sgn = imgId < 0.5 ? 1.0 : -1.0;
    float theta = 0.5 * (beta + sgn * sq);             // image angle from the lens axis
    vec3 perp = d - L * cb;
    perp = perp / (length(perp) + 1e-5);
    dn = L * cos(theta) + perp * sin(theta);
    float mu = 0.5 + (beta * beta + 2.0 * thE2) / (2.0 * beta * sq + 1e-4);
    mag = clamp(imgId < 0.5 ? mu : abs(mu - 1.0), 0.15, 4.0);
    float shadowA = asin(clamp(uShadowR / Dl, 0.0, 0.95));
    vis = smoothstep(shadowA * 0.92, shadowA * 1.12, abs(theta));   // hide inside the shadow
  } else if (imgId > 0.5) {
    vis = 0.0;                              // secondary images exist only for lensed sources
  }
  if (length(wp) < 1.0) vis = 0.0;          // swallowed by the horizon

  vec3 P2 = C + dn * len;
  vec4 mv = viewMatrix * vec4(P2, 1.0);
  gl_Position = projectionMatrix * mv;

  // ── colour: same blackbody ramp + Doppler beaming as the volumetric disk ─
  vec3 nL = vec3(M[0][1], M[1][1], M[2][1]);
  vec3 vd = cross(wp, nL);
  vd = vd / (length(vd) + 1e-4) * rotDir;
  float beta2 = min(0.75, 0.85 / sqrt(0.3 + 0.6 * rho));
  float D = clamp(1.0 / (1.0 - beta2 * dot(vd, normalize(C - wp))), 0.5, 2.2);
  float heat = (pow(rin / rho, 0.55) * (0.65 + 0.6 * aSeed.y) + heatOff + 0.35 * infall) * (0.62 + 0.38 * D);
  vCol = heatColor(heat) * tint * pow(D, 2.0) * 1.5;
  vAlpha = slice * life * (1.0 - 0.22 * trail) * (imgId < 0.5 ? 1.0 : 0.55) * vis;

  float dist = max(-mv.z, 0.1);
  float sz = (1.6 + 2.6 * fract(aSeed.w * 3.71)) * (1.0 - 0.12 * trail);
  gl_PointSize = clamp(sz * uPointScale * 11.0 / dist * sqrt(mag), 1.0, 16.0);

  if (vAlpha < 0.01) {                      // cull invisible sprites cheaply
    gl_Position = vec4(3.0, 3.0, 3.0, 1.0);
    gl_PointSize = 1.0;
  }
}
`;
