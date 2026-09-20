/* ==========================================================================
 *  main.js — 5D black hole: scene, render pipeline, camera and UI glue
 *
 *  Pipeline (per frame)
 *    1. rtMain  ← full-screen ray-march pass (blackhole.frag.js)
 *                 + ~110k plasma point sprites (particles.*.js), additive
 *    2. rtBright ← bright pass at half resolution
 *    3. 4-level blur pyramid (H+V per level)
 *    4. composite to screen (bloom, god rays, ACES, grade, vignette, grain)
 *
 *  Draw calls: 1 (ray-march) + 1 (particles) + 10 tiny post passes.
 *
 *  THE 5TH DIMENSION
 *    st.w (0..1) is the only "physics" parameter. It is pushed to the shaders
 *    as uW. 0 = sphere, 0.5 = black ring, 1 = twisted linked form. When
 *    "auto morph" is on, st.w follows a smooth cosine loop; dragging the
 *    slider takes manual control.
 * ========================================================================== */
(function () {
  'use strict';
  window.__bh = window.__bh || {};
  window.__bh.boot = true;

  const SH = window.SHADERS;
  const $ = (id) => document.getElementById(id);
  const fail = (msg) => {
    const el = $('fatal');
    el.textContent = msg;
    el.style.display = 'flex';
    $('loading').style.display = 'none';
  };

  // Surface shader-compile and runtime errors on screen (easy to screenshot / paste).
  const diag = [];
  function showDiag(msg) {
    diag.push(String(msg));
    const el = $('fatal');
    el.textContent = 'Bir hata oluştu. Bu metni geliştiriciye iletin:\n\n' + diag.join('\n\n').slice(0, 3500);
    el.style.display = 'flex';
    $('loading').style.display = 'none';
  }
  const origConsoleError = console.error;
  console.error = function () {
    origConsoleError.apply(console, arguments);
    const txt = Array.prototype.map.call(arguments, String).join(' ');
    if (/WebGLProgram|shader|GLSL|ERROR:/i.test(txt)) showDiag(txt);
  };
  window.addEventListener('error', (e) => showDiag((e.message || 'error') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')));

  if (!window.THREE) { fail('Three.js yüklenemedi. İnternet bağlantınızı kontrol edin ya da three.min.js (r128) dosyasını lib/ klasörüne koyun.'); return; }
  if (!SH || !SH.blackholeFrag || !SH.compositeFrag) { fail('Shader dosyaları yüklenemedi. shaders/ klasörünün index.html ile aynı yerde olduğundan emin olun.'); return; }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const TAU = Math.PI * 2;

  /* ───────────────────────────── renderer ───────────────────────────── */
  const canvas = $('c');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    fail('Bu tarayıcıda WebGL başlatılamadı. Donanım hızlandırmanın açık olduğundan emin olun.');
    return;
  }
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 1);

  // HDR (half-float) render targets make the bloom look right. Fall back to 8-bit
  // with a scale trick if the GPU cannot render to float textures.
  let hdr = false;
  try {
    const ext = renderer.extensions;
    hdr = renderer.capabilities.isWebGL2
      ? (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))
      : (ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float'));
  } catch (e) { hdr = false; }
  const OUT_SCALE = hdr ? 1.0 : 0.2;

  /* ───────────────────────── noise texture (value noise) ────────────────── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeNoiseTexture() {
    const S = 256;
    const rnd = mulberry32(20260920);
    const base = new Uint8Array(S * S);
    for (let i = 0; i < base.length; i++) base[i] = (rnd() * 256) | 0;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        data[i]     = base[y * S + x];
        // G(x,y) = R(x+37, y+17): the shader reads the next z-slice from G
        data[i + 1] = base[((y + 17) % S) * S + ((x + 37) % S)];
        data[i + 2] = base[((y + 101) % S) * S + ((x + 59) % S)];
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
  const noiseTex = makeNoiseTexture();

  /* ─────────────────────────── shared uniforms ──────────────────────────── */
  const U = {
    uTime:        { value: 0 },
    uRes:         { value: new THREE.Vector2(1, 1) },
    uCamPos:      { value: new THREE.Vector3() },
    uCamRight:    { value: new THREE.Vector3(1, 0, 0) },
    uCamUp:       { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd:      { value: new THREE.Vector3(0, 0, -1) },
    uTanHalfFov:  { value: 1 },
    uW:           { value: 0 },
    uLayer0:      { value: new THREE.Matrix3() },
    uLayer1:      { value: new THREE.Matrix3() },
    uLayer2:      { value: new THREE.Matrix3() },
    uLayerOff:    { value: new THREE.Vector3() },
    uShadowR:     { value: 2.6 },
  };

  /* ───────────────────────────── main scene ─────────────────────────────── */
  const FOV = 55;
  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 200);
  U.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(FOV * 0.5));

  const sceneMain = new THREE.Scene();

  // one oversized triangle = the whole ray-marched black hole
  const triGeo = new THREE.BufferGeometry();
  triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));

  const matBH = new THREE.ShaderMaterial({
    vertexShader: SH.fullscreenVert,
    fragmentShader: SH.blackholeFrag,
    uniforms: Object.assign({ uNoiseTex: { value: noiseTex }, uSteps: { value: 200 }, uIter: { value: 200 }, uOutScale: { value: OUT_SCALE } }, U),
    depthTest: false,
    depthWrite: false,
  });
  matBH.extensions.shaderTextureLOD = true;   // only matters for WebGL1

  const bhMesh = new THREE.Mesh(triGeo, matBH);
  bhMesh.frustumCulled = false;
  bhMesh.renderOrder = 0;
  sceneMain.add(bhMesh);

  /* ────────────────── plasma particles (single draw call) ──────────────── */
  const NP = 14000;   // particles
  const NT = 4;       // trail samples per particle
  const NI = 2;       // lensed images per particle
  const NV = NP * NT * NI;
  const pGeo = new THREE.BufferGeometry();
  {
    const seed = new Float32Array(NV * 4);
    const meta = new Float32Array(NV * 2);
    const rnd = mulberry32(1337);
    let v = 0;
    for (let p = 0; p < NP; p++) {
      const s0 = rnd(), s1 = rnd(), s2 = rnd(), s3 = rnd();
      for (let im = 0; im < NI; im++) {
        for (let tr = 0; tr < NT; tr++) {
          seed[v * 4] = s0; seed[v * 4 + 1] = s1; seed[v * 4 + 2] = s2; seed[v * 4 + 3] = s3;
          meta[v * 2] = tr; meta[v * 2 + 1] = im;
          v++;
        }
      }
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NV * 3), 3)); // unused, needed for draw count
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    pGeo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 2));
    pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  }
  const matP = new THREE.ShaderMaterial({
    vertexShader: SH.particlesVert,
    fragmentShader: SH.particlesFrag,
    uniforms: Object.assign({ uPointScale: { value: 1 }, uLensK: { value: 1.0 } }, U),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(pGeo, matP);
  points.frustumCulled = false;
  points.renderOrder = 1;
  sceneMain.add(points);

  /* ─────────────────────────── post-processing ──────────────────────────── */
  const scenePost = new THREE.Scene();
  const camPost = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(triGeo, matBH);
  quad.frustumCulled = false;
  scenePost.add(quad);

  const postOpts = { vertexShader: SH.fullscreenVert, depthTest: false, depthWrite: false };
  const matBright = new THREE.ShaderMaterial(Object.assign({
    fragmentShader: SH.brightFrag,
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 * OUT_SCALE } },
  }, postOpts));
  const matBlur = new THREE.ShaderMaterial(Object.assign({
    fragmentShader: SH.blurFrag,
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
  }, postOpts));
  const matComposite = new THREE.ShaderMaterial(Object.assign({
    fragmentShader: SH.compositeFrag,
    uniforms: {
      tScene: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, tB3: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uTime: { value: 0 }, uBloom: { value: 1 }, uExposure: { value: 1 }, uRays: { value: 1 },
      uCA: { value: 0.012 }, uGrain: { value: 0.035 }, uVignette: { value: 0.55 }, uInScale: { value: 1 / OUT_SCALE },
    },
  }, postOpts));

  function makeRT(w, h) {
    return new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  /* ──────────────────────────── state ───────────────────────────────────── */
  const st = {
    w: 0, wTarget: 0, phase: 0,
    autoMorph: true, autoOrbit: true,
    bloom: 1, exposure: 1,
    quality: 'auto', scale: 1, scaleCeil: 1, steps: 200,
  };
  const MORPH_PERIOD = 44;       // seconds: sphere → ring → twisted → back

  let rtMain = null, rtBright = null;
  let rtH = [], rtV = [];
  let mainW = 2, mainH = 2;

  function allocTargets() {
    [rtMain, rtBright].concat(rtH, rtV).forEach((r) => r && r.dispose());
    const cw = renderer.domElement.width;
    const ch = renderer.domElement.height;
    mainW = Math.max(2, Math.round(cw * st.scale));
    mainH = Math.max(2, Math.round(ch * st.scale));
    rtMain = makeRT(mainW, mainH);
    const bw = Math.max(2, mainW >> 1);
    const bh = Math.max(2, mainH >> 1);
    rtBright = makeRT(bw, bh);
    rtH = []; rtV = [];
    for (let i = 0; i < 4; i++) {
      const lw = Math.max(2, bw >> i);
      const lh = Math.max(2, bh >> i);
      rtH.push(makeRT(lw, lh));
      rtV.push(makeRT(lw, lh));
    }
    U.uRes.value.set(mainW, mainH);
    matP.uniforms.uPointScale.value = mainH / 1080;
    matComposite.uniforms.uRes.value.set(cw, ch);
  }

  function autoCeil() {
    const px = renderer.domElement.width * renderer.domElement.height;
    return clamp(Math.sqrt(3.5e6 / px), 0.4, 1.0);
  }
  function initialScale() {
    const px = renderer.domElement.width * renderer.domElement.height;
    return clamp(Math.sqrt(1.6e6 / px), 0.4, 1.0);
  }

  function applyQuality(q) {
    st.quality = q;
    st.scaleCeil = autoCeil();
    if (q === 'auto')        { st.scale = Math.min(initialScale(), st.scaleCeil); st.steps = 200; }
    else if (q === 'high')   { st.scale = 1.0;  st.steps = 250; }
    else if (q === 'medium') { st.scale = 0.72; st.steps = 190; }
    else                     { st.scale = 0.5;  st.steps = 130; }
    allocTargets();
  }

  /* ────────────────────────── camera + input ────────────────────────────── */
  const R_MIN = 8.0, R_MAX = 40.0;
  const DEF = { theta: 0.6, phi: 1.36, radius: 12.5 };
  const cam = {
    theta: DEF.theta, phi: DEF.phi, radius: DEF.radius,
    tTheta: DEF.theta, tPhi: DEF.phi, tRadius: DEF.radius,
    lastInteract: -1e9,
  };

  const pointers = new Map();
  let pinchDist = 0;
  const pinchDistance = () => {
    const a = Array.from(pointers.values());
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cam.lastInteract = performance.now();
    if (pointers.size === 2) pinchDist = pinchDistance();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    cam.lastInteract = performance.now();
    if (pointers.size === 1) {
      cam.tTheta -= dx * 0.0055;
      cam.tPhi = clamp(cam.tPhi - dy * 0.0055, 0.08, Math.PI - 0.08);
    } else if (pointers.size === 2) {
      const d = pinchDistance();
      if (pinchDist > 0 && d > 0) cam.tRadius = clamp(cam.tRadius * (pinchDist / d), R_MIN, R_MAX);
      pinchDist = d;
    }
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); pinchDist = 0; cam.lastInteract = performance.now(); };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.tRadius = clamp(cam.tRadius * Math.exp(e.deltaY * 0.0012), R_MIN, R_MAX);
    cam.lastInteract = performance.now();
  }, { passive: false });
  canvas.addEventListener('dblclick', resetView);

  function resetView() {
    cam.tTheta = DEF.theta; cam.tPhi = DEF.phi; cam.tRadius = DEF.radius;
    cam.lastInteract = performance.now();
  }

  /* ─────────────────────────────── UI ───────────────────────────────────── */
  const slider = $('wSlider');
  const chkMorph = $('chkMorph');
  const chkOrbit = $('chkOrbit');
  const stations = $('stations').children;
  const formName = $('formName');
  const wVal = $('wVal');
  const hud = $('hud');

  slider.addEventListener('input', () => {
    st.wTarget = parseFloat(slider.value);
    if (st.autoMorph) { st.autoMorph = false; chkMorph.checked = false; }
  });
  chkMorph.addEventListener('change', () => {
    st.autoMorph = chkMorph.checked;
    if (st.autoMorph) st.phase = Math.acos(clamp(1 - 2 * st.wTarget, -1, 1));   // continue from here
  });
  chkOrbit.addEventListener('change', () => { st.autoOrbit = chkOrbit.checked; });
  $('rngBloom').addEventListener('input', (e) => { st.bloom = parseFloat(e.target.value); });
  $('rngExposure').addEventListener('input', (e) => { st.exposure = parseFloat(e.target.value); });
  $('selQuality').addEventListener('change', (e) => applyQuality(e.target.value));
  $('btnReset').addEventListener('click', resetView);
  $('settingsBtn').addEventListener('click', () => {
    const open = $('panel').classList.toggle('open');
    $('settingsBtn').setAttribute('aria-expanded', String(open));
  });

  const FORMS = ['Küre', 'Kara halka', 'Bükülmüş form'];
  let lastForm = -1;
  function updateReadout() {
    const w = st.w;
    const idx = w < 0.25 ? 0 : (w < 0.75 ? 1 : 2);
    if (idx !== lastForm) {
      lastForm = idx;
      formName.textContent = FORMS[idx];
      for (let i = 0; i < 3; i++) stations[i].classList.toggle('on', i === idx);
    }
    wVal.textContent = 'W = ' + w.toFixed(2);
  }

  /* ─────────────────── the disk layers = 3D shadows of 4D sheets ────────── */
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
  const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3();

  // Rows of the matrix are the layer's local axes expressed in world space, so
  // (M * p) gives p in the layer frame.  R = Ry(prec) * Rx(tx) * Rz(tz).
  function setLayer(m3, prec, tx, tz) {
    qA.setFromAxisAngle(AY, prec);
    qB.setFromAxisAngle(AX, tx);
    qC.setFromAxisAngle(AZ, tz);
    qA.multiply(qB).multiply(qC);
    ex.set(1, 0, 0).applyQuaternion(qA);
    ey.set(0, 1, 0).applyQuaternion(qA);
    ez.set(0, 0, 1).applyQuaternion(qA);
    m3.set(ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z);
  }

  // W = 0 : three almost-parallel sheets stacked like a thin pancake.
  // W → 1 : the sheets fan out into different planes ("dimensional split").
  function updateLayers(w, t) {
    const spread = smooth(0.04, 1.0, w);
    setLayer(U.uLayer0.value, t * 0.02, 0.05 * Math.sin(t * 0.13), 0.04 * Math.cos(t * 0.11));
    setLayer(U.uLayer1.value, -t * 0.035, 0.10 + spread * (0.85 + 0.15 * Math.sin(t * 0.17)), spread * 0.5 * Math.sin(t * 0.09));
    setLayer(U.uLayer2.value, t * 0.05, -0.09 - spread * (1.05 + 0.2 * Math.cos(t * 0.13)), spread * 0.6 * Math.cos(t * 0.07));
    const sep = 0.34 * (1 - 0.55 * spread);
    U.uLayerOff.value.set(0, sep, -sep);
  }

  /* ───────────────────────────── frame update ───────────────────────────── */
  let time = 0;
  const tmpV = new THREE.Vector3();

  function updateMorph(dt) {
    if (st.autoMorph) {
      st.phase += dt * TAU / MORPH_PERIOD;
      st.wTarget = 0.5 - 0.5 * Math.cos(st.phase);
      slider.value = st.wTarget.toFixed(4);
    }
    st.w += (st.wTarget - st.w) * (1 - Math.exp(-dt * 5.0));
  }

  function updateCamera(dt, now) {
    const idle = now - cam.lastInteract > 2500;
    if (st.autoOrbit && idle && pointers.size === 0) {
      cam.tTheta += dt * 0.06;
      const autoPhi = 1.30 + 0.28 * Math.sin(time * 0.11);
      cam.tPhi += (autoPhi - cam.tPhi) * (1 - Math.exp(-dt * 0.6));
    }
    const k = 1 - Math.exp(-dt * 8);
    cam.theta += (cam.tTheta - cam.theta) * k;
    cam.phi += (cam.tPhi - cam.phi) * k;
    cam.radius += (cam.tRadius - cam.radius) * k;

    const sp = Math.sin(cam.phi);
    camera.position.set(cam.radius * sp * Math.cos(cam.theta), cam.radius * Math.cos(cam.phi), cam.radius * sp * Math.sin(cam.theta));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const e = camera.matrixWorld.elements;
    U.uCamPos.value.copy(camera.position);
    U.uCamRight.value.set(e[0], e[1], e[2]);
    U.uCamUp.value.set(e[4], e[5], e[6]);
    U.uCamFwd.value.set(-e[8], -e[9], -e[10]);
  }

  function updateUniforms() {
    U.uTime.value = time;
    U.uW.value = st.w;
    updateLayers(st.w, time);
    U.uShadowR.value = 2.6 * (1 + 0.3 * smooth(0, 0.5, st.w));
    matBH.uniforms.uSteps.value = st.steps;
    matBH.uniforms.uIter.value = Math.min(st.steps | 0, 260);

    const c = matComposite.uniforms;
    c.uTime.value = time;
    c.uBloom.value = st.bloom * (0.95 + 0.05 * Math.sin(time * 0.7));    // the hole "breathes" slightly
    c.uExposure.value = st.exposure;

    // screen-space position of the singularity → origin of the god rays
    tmpV.set(0, 0, 0).project(camera);
    c.uCenter.value.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
    c.uRays.value = tmpV.z < 1 ? 1.0 : 0.0;
  }

  /* ─────────────────────────────── render ───────────────────────────────── */
  function runPass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(scenePost, camPost);
  }
  function blurPass(src, dst, dx, dy) {
    matBlur.uniforms.tSrc.value = src.texture;
    matBlur.uniforms.uDir.value.set(dx / src.width, dy / src.height);
    runPass(matBlur, dst);
  }

  function render() {
    // 1. ray-marched black hole + plasma sprites (HDR)
    renderer.setRenderTarget(rtMain);
    renderer.render(sceneMain, camera);

    // 2. bright pass (also downsamples 2x)
    matBright.uniforms.tSrc.value = rtMain.texture;
    matBright.uniforms.uTexel.value.set(1 / rtMain.width, 1 / rtMain.height);
    runPass(matBright, rtBright);

    // 3. blur pyramid
    let src = rtBright;
    for (let i = 0; i < 4; i++) {
      blurPass(src, rtH[i], 1, 0);
      blurPass(rtH[i], rtV[i], 0, 1);
      src = rtV[i];
    }

    // 4. composite to the screen
    const c = matComposite.uniforms;
    c.tScene.value = rtMain.texture;
    c.tB0.value = rtV[0].texture;
    c.tB1.value = rtV[1].texture;
    c.tB2.value = rtV[2].texture;
    c.tB3.value = rtV[3].texture;
    runPass(matComposite, null);
  }

  /* ─────────────────── adaptive resolution (performance) ────────────────── */
  let ema = 16.7, frames = 0, lastChange = 0, lastDecrease = 0;
  function adapt(dtms, now) {
    ema = ema * 0.94 + dtms * 0.06;
    if (st.quality !== 'auto') return;
    if (++frames < 40 || now - lastChange < 1200) return;
    frames = 0;
    let ns = st.scale;
    if (ema > 22) { ns = Math.max(0.4, st.scale * 0.9); lastDecrease = now; }
    else if (ema < 17.8 && now - lastDecrease > 7000) { ns = Math.min(st.scaleCeil, st.scale * 1.05); }
    st.steps = ns < 0.55 ? 150 : 200;
    if (Math.abs(ns - st.scale) > 0.02) {
      st.scale = ns;
      lastChange = now;
      allocTargets();
    }
  }

  /* ───────────────────────────── resize ─────────────────────────────────── */
  let resizeTimer = 0;
  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    st.scaleCeil = autoCeil();
    st.scale = Math.min(st.scale, st.scaleCeil);
    allocTargets();
  }
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 120);
  });

  /* ─────────────────────────────── loop ─────────────────────────────────── */
  let last = performance.now();
  let frameCount = 0;
  let hudTimer = 0, hudFrames = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    try { step(now); } catch (err) { showDiag((err && err.stack) || err); }
  }

  function step(now) {
    const dtms = Math.min(now - last, 100);
    last = now;
    const dt = dtms / 1000;
    time += dt;

    updateMorph(dt);
    updateCamera(dt, now);
    updateUniforms();
    updateReadout();
    render();
    adapt(dtms, now);

    if (++frameCount === 1) window.__bh.frame = true;
    if (frameCount === 3) $('loading').classList.add('done');

    hudTimer += dtms; hudFrames++;
    if (hudTimer >= 500) {
      hud.textContent = Math.round(hudFrames * 1000 / hudTimer) + ' fps, çözünürlük %' + Math.round(st.scale * 100);
      hudTimer = 0; hudFrames = 0;
    }
  }

  applyQuality('auto');
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  requestAnimationFrame(frame);
})();
