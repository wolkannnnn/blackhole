/* ==========================================================================
 *  fullscreen.vert.js
 *  One oversized triangle covers the whole screen (1 draw call, no quad seam).
 *  Used by the ray-marched black hole pass AND by every post-processing pass.
 *
 *  Shaders are stored as JS strings (instead of .glsl files) so the project
 *  runs by double-clicking index.html — no local web server needed.
 * ========================================================================== */
window.SHADERS = window.SHADERS || {};

window.SHADERS.fullscreenVert = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
