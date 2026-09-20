/* ==========================================================================
 *  particles.frag.js  —  soft glowing spark, blended additively
 * ========================================================================== */
window.SHADERS = window.SHADERS || {};

window.SHADERS.particlesFrag = /* glsl */ `
varying vec3  vCol;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;                       // 0 at centre, 1 at the sprite edge
  float a = exp(-d * 4.5) * (1.0 - smoothstep(0.7, 1.0, d));
  // Additive blending uses SRC_ALPHA * rgb, so alpha stays 1.0 and the
  // intensity is baked into rgb.
  gl_FragColor = vec4(vCol * (a * vAlpha), 1.0);
}
`;
