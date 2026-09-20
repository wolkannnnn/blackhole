/* ==========================================================================
 *  post.frag.js  —  cinematic post-processing chain
 *
 *   main HDR render ─► bright pass (½ res) ─► 4-level gaussian pyramid
 *                                     └───────────────┐
 *   composite:  scene + bloom + god-rays + chromatic aberration
 *               → exposure → ACES filmic tone-map → grade → vignette → grain
 *
 *  All passes share fullscreen.vert.js.
 * ========================================================================== */
window.SHADERS = window.SHADERS || {};

/* ── 1. bright pass + 2x downsample (4 taps to avoid fireflies) ───────────── */
window.SHADERS.brightFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;        // 1 / source resolution
uniform float uThreshold;

void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-0.5,  0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25;
  c = min(c, vec3(30.0));
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

/* ── 2. separable 9-tap gaussian (5 fetches thanks to linear filtering) ───── */
window.SHADERS.blurFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;           // (1/width, 0) or (0, 1/height) of the SOURCE

void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb +
        texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb +
        texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

/* ── 3. final composite → screen ──────────────────────────────────────────── */
window.SHADERS.compositeFrag = /* glsl */ `
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tB0;
uniform sampler2D tB1;
uniform sampler2D tB2;
uniform sampler2D tB3;
uniform vec2  uRes;
uniform vec2  uCenter;       // black hole position in uv space (for god rays)
uniform float uTime;
uniform float uBloom;
uniform float uExposure;
uniform float uRays;
uniform float uCA;           // chromatic aberration strength
uniform float uGrain;
uniform float uVignette;
uniform float uInScale;      // undo the LDR-fallback scaling

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Narkowicz ACES approximation
vec3 aces(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float rr = dot(cc, cc);

  // radial chromatic aberration (lens fringing towards the edges)
  vec2 ca = cc * rr * uCA;
  vec3 col;
  col.r = texture2D(tScene, uv - ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv + ca).b;
  col *= uInScale;

  // multi-scale bloom
  vec3 bloom = texture2D(tB0, uv).rgb * 0.55
             + texture2D(tB1, uv).rgb * 0.75
             + texture2D(tB2, uv).rgb * 0.95
             + texture2D(tB3, uv).rgb * 1.15;
  col += bloom * (uBloom * 0.5 * uInScale);

  // volumetric light shafts: radial smear of the bloom buffer away from the hole
  vec2 toC = uCenter - uv;
  vec2 p = uv;
  vec3 rays = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < 16; i++) {
    p += toC * 0.05;
    rays += texture2D(tB1, p).rgb * decay;
    decay *= 0.92;
  }
  col += rays * (uRays * 0.06 * uInScale);

  // exposure + filmic curve
  col *= uExposure;
  col = aces(col);

  // cosmic-horror grade: cold shadows, slightly sickly warm highlights
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, 1.08);
  col *= mix(vec3(0.90, 0.95, 1.10), vec3(1.05, 1.00, 0.94), smoothstep(0.0, 0.7, lum));

  // vignette + grain
  col *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(cc) * 1.5);
  col += (hash12(uv * uRes + fract(uTime) * 173.0) - 0.5) * uGrain;

  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;
