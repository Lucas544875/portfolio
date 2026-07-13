import { createProgram as compileLinkedProgram } from '../../gl/glUtils.js';
import bgImageUrl from './background1.jpg';
import bgImageSmallUrl from './background1_s.jpg';

// 「雨の中の窓」プロトタイプ(prototype-rain-window/main.js)の移植版。
// 元は自前canvas + 自前WebGL2コンテキスト + 自前rAFループを持つ独立アプリだったが、
// ここでは共有レンダラの1ブロックとして動くように以下を変更している:
//   - gl / rAFは共有レンダラから渡される。このファイルは自分のcanvas/contextを持たない
//   - canvas.width/height や gl.drawingBufferWidth/Height を参照していた箇所は、
//     すべて「このブロックのslot矩形のサイズ(ctx.width/height, デバイスpx)」に置き換えた
//     (共有canvas全体のサイズを見てしまうと、他ブロックの分まで含んだ縦長の比率で
//     アスペクト比を計算してしまうため)
//   - ポインタ操作は canvas 全体ではなく slotEl に対して行う(他ブロックの操作を奪わない)
//   - 「拭った跡」のカーソルUIはslotElの子要素として絶対配置し、fixedで画面全体に
//     残り続けないようにした
//   - reduced-motionでは、自動再生の拭うジェスチャー・降り続ける雨・結露の蒸発など
//     「自動で動き続ける」部分だけ止める(dt=0)。ユーザーが指で拭う操作自体は
//     常に有効(本作品の核となる操作なので殺さない)
//   - isLowPowerでは、内部解像度と水滴の密度を下げて負荷を抑える
//
// 内部で複数のFBOを使うため、render()の中では一度 gl.disable(SCISSOR_TEST) して
// オフスクリーンパスを済ませ、最後にcanvasへ描く直前だけ ctx.originX/Y/width/height
// でscissor/viewportを張り直す(GL_SCISSOR_TESTはFBOにも影響するため、canvas全体
// 基準のscissor矩形のままFBOへ描くと意図しないクリップが起きる)。

const CONFIG = {
  SCENE_RESOLUTION: 900,
  BLUR_RESOLUTION: 220,
  MASK_RESOLUTION: 640,
  MASK_DECAY: 0.9985,
  MASK_LINEAR_FADE_PER_SEC: 0.035,
  AUTOPLAY_BRUSH_RADIUS: 0.036,
  USER_BRUSH_RADIUS: 0.0308,
  BLUR_ITERATIONS: 3,
  BLUR_PIXEL_RADIUS: 1.6,

  WATER_RESOLUTION: 1000,
  DROP_MIN_R: 0.0045,
  DROP_MAX_R: 0.02,
  REFRACTION_STRENGTH: 0.045,
  METABALL_THRESHOLD: 0.5,
  METABALL_EDGE_SOFTNESS: 0.08,
  EVAPORATION_CHANCE_PER_SEC: 0.15,
  EVAPORATION_RATE_MIN: 0.00015,
  EVAPORATION_RATE_MAX: 0.0005,

  MIST_COUNT: 3000,

  DROP_MAX_COUNT: 1000,
  RAIN_SPAWN_PER_SEC: 30,
  RAIN_SPAWN_Y_MIN: 0.05,
  RAIN_SPAWN_Y_MAX: 1.05,
  TRAIL_RATE: 2.0,
  MERGE_DISTANCE_FACTOR: 0.33,
  MERGE_GROWTH_CAP: 0.8,

  DRIP_SPAWN_THRESHOLD: 0.025,
  DRIP_INITIAL_R: 0.015,
  DRIP_INITIAL_MOMENTUM: 0.4,
  DRIP_WIPE_AMOUNT: 1.0,
  DRIP_WIPE_RADIUS_FACTOR: 1 / 2,
};

// isLowPower時のスケール(内部解像度・粒の密度を落として負荷を抑える)
const LOW_POWER_RES_SCALE = 0.55;
const LOW_POWER_DENSITY_SCALE = 0.5;

const DENSITY_REFERENCE_ASPECT = 1280 / 800;

// ----------------------------------------------------------------------------
// Shaders(元プロトタイプと同一)
// ----------------------------------------------------------------------------
const baseVertexShader = `#version 300 es
  precision highp float;
  in vec2 aPosition;
  out vec2 vUv;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const sceneShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uBgImage;
  uniform vec2 uResolution;
  uniform float uImageAspect;
  uniform float uImageLoaded;
  out vec4 fragColor;

  void main () {
    vec2 uv = vUv;
    float screenAspect = uResolution.x / uResolution.y;

    vec2 ratio = vec2(
      min(screenAspect / uImageAspect, 1.0),
      min(uImageAspect / screenAspect, 1.0)
    );
    vec2 uvCover = vec2(
      uv.x * ratio.x + (1.0 - ratio.x) * 0.5,
      uv.y * ratio.y + (1.0 - ratio.y) * 0.5
    );

    vec3 color = texture(uBgImage, uvCover).rgb;
    color = mix(vec3(0.02, 0.025, 0.045), color, uImageLoaded);

    fragColor = vec4(color, 1.0);
  }
`;

const blurShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec2 uDirection;
  out vec4 fragColor;
  void main () {
    vec4 sum = texture(uTexture, vUv) * 0.227027;
    sum += texture(uTexture, vUv + uDirection * 1.0) * 0.1945946;
    sum += texture(uTexture, vUv - uDirection * 1.0) * 0.1945946;
    sum += texture(uTexture, vUv + uDirection * 2.0) * 0.1216216;
    sum += texture(uTexture, vUv - uDirection * 2.0) * 0.1216216;
    sum += texture(uTexture, vUv + uDirection * 3.0) * 0.0540541;
    sum += texture(uTexture, vUv - uDirection * 3.0) * 0.0540541;
    sum += texture(uTexture, vUv + uDirection * 4.0) * 0.0162162;
    sum += texture(uTexture, vUv - uDirection * 4.0) * 0.0162162;
    fragColor = sum;
  }
`;

const dropVertexShader = `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 aQuad;
  layout(location = 1) in vec4 aInstance; // x, y, rx, ry (UV空間)
  out vec2 vLocal;
  void main () {
    vLocal = aQuad;
    vec2 pos = aInstance.xy + aQuad * aInstance.zw;
    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const dropFieldFragmentShader = `#version 300 es
  precision highp float;
  in vec2 vLocal;
  out vec4 fragColor;
  void main () {
    float d2 = dot(vLocal, vLocal);
    if (d2 > 1.0) discard;
    float field = (1.0 - d2) * (1.0 - d2);
    fragColor = vec4(field, 0.0, 0.0, 0.0);
  }
`;

const metaballResolveShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uField;
  uniform vec2 uTexelSize;
  uniform float uThreshold;
  uniform float uEdgeSoftness;
  out vec4 fragColor;
  void main () {
    float f = texture(uField, vUv).r;
    float alpha = smoothstep(uThreshold - uEdgeSoftness, uThreshold + uEdgeSoftness, f);

    float fL = texture(uField, vUv - vec2(uTexelSize.x, 0.0)).r;
    float fR = texture(uField, vUv + vec2(uTexelSize.x, 0.0)).r;
    float fB = texture(uField, vUv - vec2(0.0, uTexelSize.y)).r;
    float fT = texture(uField, vUv + vec2(0.0, uTexelSize.y)).r;
    vec2 grad = vec2(fR - fL, fT - fB);
    vec2 refraction = clamp(grad * 3.5, -1.0, 1.0);

    float thickness = clamp(f, 0.0, 1.0);

    fragColor = vec4(refraction * 0.5 + 0.5, thickness, alpha);
  }
`;

const splatShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec2 point;
  uniform float radius;
  uniform float amount;
  out vec4 fragColor;
  void main () {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    float d = step(dot(p, p), radius * radius);
    float base = texture(uTarget, vUv).r;
    float v = clamp(base + d * amount, 0.0, 1.0);
    fragColor = vec4(v, v, v, 1.0);
  }
`;

const decayShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTexture;
  uniform float decay;
  uniform float linearFade;
  out vec4 fragColor;
  void main () {
    float v = texture(uTexture, vUv).r * decay - linearFade;
    fragColor = vec4(max(v, 0.0), max(v, 0.0), max(v, 0.0), 1.0);
  }
`;

const displayShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uBlurredScene;
  uniform sampler2D uMask;
  uniform sampler2D uWaterMap;
  uniform float uRefractionStrength;
  uniform float uFogEnabled;
  out vec4 fragColor;

  void main () {
    vec2 uv = vUv;

    float mask = texture(uMask, uv).r;

    vec4 water = texture(uWaterMap, uv);
    vec2 refraction = (water.rg - 0.5) * 2.0;
    float thickness = water.b;
    float dropAlpha = water.a;

    vec2 refractedUv = uv + refraction * thickness * uRefractionStrength;

    vec3 sharp = texture(uScene, uv).rgb;
    vec3 blurred = texture(uBlurredScene, uv).rgb;

    float fogMixAmt = mix(1.0, smoothstep(0.05, 0.85, mask), uFogEnabled);
    vec3 composite = mix(blurred, sharp, fogMixAmt);

    vec3 dropColor = texture(uScene, refractedUv).rgb * (0.82 + thickness * 0.4);
    composite = mix(composite, dropColor, dropAlpha * 0.92);

    fragColor = vec4(composite, 1.0);
  }
`;

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}
function cubicBiasedRadius(min, max) {
  return min + Math.pow(Math.random(), 3) * (max - min);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function createProgramReflected(gl, vs, fs) {
  const program = compileLinkedProgram(gl, vs, fs);
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    uniforms[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

export function createRainWindowBlock(slotEl) {
  // --- GL resources (createResources / destroyResources で生成・破棄) ---
  let programs = null; // { scene, blur, splat, decay, display, dropField, metaballResolve }
  let quadVAO, quadBuffer;
  let dropVAO, dropInstanceBuffer;

  // --- FBO群。ブロックのサイズが決まってから(初回render時)作る ---
  let fbo = null; // { sceneFBO, blurTempFBO, blurredSceneFBO, mask, waterMapFBO, dropFieldFBO }
  let sizeW = 0;
  let sizeH = 0;
  let lowPower = false;

  // --- 背景画像 ---
  let bgImageTexture = null;
  let bgImageAspect = 640 / 427;
  let bgImageLoaded = false;

  // --- 表示トグル ---
  const effects = { rain: true, fog: true };

  // --- 密度(サイズが決まってから計算) ---
  let DENSITY_SCALE = 1;
  let EFFECTIVE_MIST_COUNT = 0;
  let EFFECTIVE_DROP_MAX_COUNT = 0;
  let EFFECTIVE_DRIP_SPAWN_THRESHOLD = CONFIG.DRIP_SPAWN_THRESHOLD;
  let MAX_INSTANCES = 0;
  let dropInstanceData = null;

  const drops = [];
  const mistDrops = [];
  let nextDropId = 1;
  let rainSpawnAccumulator = 0;
  let maskLinearFadeAccumulator = 0;
  let dripWetnessAccumulator = 0;
  let lastWipeX = 0.5;
  let lastWipeY = 0.5;
  const MASK_QUANT_STEP = 1 / 255;

  const autoplay = {
    enabled: true,
    strokes: buildHandWipeStrokes(),
    strokeIndex: 0,
    pointIndex: 0,
    progress: 0,
    paused: true,
    pauseTimer: 0.5,
    speed: 130,
  };

  function buildHandWipeStrokes() {
    const strokeA = [];
    const nA = 90;
    for (let i = 0; i <= nA; i++) {
      const t = i / nA;
      const x = lerp(0.18, 0.82, t);
      const y = 0.62 - Math.sin(t * Math.PI) * 0.22 + Math.sin(t * Math.PI * 3.0) * 0.015;
      strokeA.push({ x, y });
    }
    const strokeB = [];
    const nB = 80;
    const cx = 0.62;
    const cy = 0.46;
    const r = 0.09;
    for (let i = 0; i <= nB; i++) {
      const t = i / nB;
      const ang = t * Math.PI * 2 * 1.7;
      strokeB.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.85 });
    }
    return [strokeA, strokeB];
  }

  // --- DOM UI(slotElの子として絶対配置。position:fixedにはしない) ---
  let ui = null; // { root, hint, fingerCursor, rainBtn, fogBtn }

  function buildUI() {
    const root = document.createElement('div');
    root.className = 'rain-window-ui';

    const controls = document.createElement('div');
    controls.className = 'rw-controls';
    const rainBtn = document.createElement('button');
    rainBtn.className = 'rw-toggle-btn';
    rainBtn.type = 'button';
    rainBtn.setAttribute('aria-pressed', 'true');
    rainBtn.setAttribute('aria-label', '雨の表示を切り替え');
    rainBtn.title = '雨';
    rainBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 10.5a3.5 3.5 0 0 1 0-7c.35 0 .69.04 1.02.13A4.5 4.5 0 0 1 16 5.5c.17 0 .34.01.5.03A3.5 3.5 0 0 1 17 12H6.5z"/><path d="M7 15.5 5.5 18M12 15.5 10.5 18M17 15.5 15.5 18"/></svg>';

    const fogBtn = document.createElement('button');
    fogBtn.className = 'rw-toggle-btn';
    fogBtn.type = 'button';
    fogBtn.setAttribute('aria-pressed', 'true');
    fogBtn.setAttribute('aria-label', '結露の表示を切り替え');
    fogBtn.title = '結露';
    fogBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h16"/><path d="M3 12.5h18"/><path d="M5 16.5h14"/></svg>';

    controls.append(rainBtn, fogBtn);

    const hint = document.createElement('div');
    hint.className = 'rw-hint';
    hint.textContent = 'なぞって、曇ったガラスを拭ってみてください';

    const fingerCursor = document.createElement('div');
    fingerCursor.className = 'rw-finger-cursor';

    root.append(controls, hint, fingerCursor);
    slotEl.appendChild(root);

    rainBtn.addEventListener('click', () => {
      effects.rain = !effects.rain;
      rainBtn.setAttribute('aria-pressed', String(effects.rain));
    });
    fogBtn.addEventListener('click', () => {
      effects.fog = !effects.fog;
      fogBtn.setAttribute('aria-pressed', String(effects.fog));
    });

    return { root, hint, fingerCursor, rainBtn, fogBtn };
  }

  function setFingerCursor(uLocalPx, vLocalPx, opacity) {
    ui.fingerCursor.style.opacity = String(opacity);
    ui.fingerCursor.style.left = `${uLocalPx}px`;
    ui.fingerCursor.style.top = `${vLocalPx}px`;
  }

  // ----------------------------------------------------------------------------
  function getResolution(resolution, w, h) {
    let aspectRatio = w / h;
    if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspectRatio);
    if (w > h) return { width: max, height: min };
    return { width: min, height: max };
  }

  function createFBO(gl, w, h, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fboObj = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboObj);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo: fboObj,
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(gl, w, h, filter) {
    let fbo1 = createFBO(gl, w, h, filter);
    let fbo2 = createFBO(gl, w, h, filter);
    return {
      width: w,
      height: h,
      get read() {
        return fbo1;
      },
      get write() {
        return fbo2;
      },
      swap() {
        const tmp = fbo1;
        fbo1 = fbo2;
        fbo2 = tmp;
      },
    };
  }

  function destroyFBOs(gl) {
    if (!fbo) return;
    for (const key of ['sceneFBO', 'blurTempFBO', 'blurredSceneFBO', 'waterMapFBO', 'dropFieldFBO']) {
      const f = fbo[key];
      gl.deleteTexture(f.texture);
      gl.deleteFramebuffer(f.fbo);
    }
    for (const f of [fbo.mask.read, fbo.mask.write]) {
      gl.deleteTexture(f.texture);
      gl.deleteFramebuffer(f.fbo);
    }
    fbo = null;
  }

  function initFramebuffers(gl, w, h) {
    destroyFBOs(gl);
    const resScale = lowPower ? LOW_POWER_RES_SCALE : 1;
    const sceneRes = getResolution(CONFIG.SCENE_RESOLUTION * resScale, w, h);
    const blurRes = getResolution(CONFIG.BLUR_RESOLUTION * resScale, w, h);
    const maskRes = getResolution(CONFIG.MASK_RESOLUTION * resScale, w, h);
    const waterRes = getResolution(CONFIG.WATER_RESOLUTION * resScale, w, h);

    fbo = {
      sceneFBO: createFBO(gl, sceneRes.width, sceneRes.height, gl.LINEAR),
      blurTempFBO: createFBO(gl, blurRes.width, blurRes.height, gl.LINEAR),
      blurredSceneFBO: createFBO(gl, blurRes.width, blurRes.height, gl.LINEAR),
      mask: createDoubleFBO(gl, maskRes.width, maskRes.height, gl.LINEAR),
      waterMapFBO: createFBO(gl, waterRes.width, waterRes.height, gl.LINEAR),
      dropFieldFBO: createFBO(gl, waterRes.width, waterRes.height, gl.LINEAR),
    };
  }

  function computeDensityScale(w, h) {
    const aspect = w / h;
    const base = Math.min(1.8, Math.max(0.35, aspect / DENSITY_REFERENCE_ASPECT));
    return lowPower ? base * LOW_POWER_DENSITY_SCALE : base;
  }

  function loadBackgroundImage(url) {
    const img = new Image();
    img.onload = () => {
      bgImageAspect = img.naturalWidth / img.naturalHeight;
      // gl/textureはcreateResources後にのみ存在するので、呼び出し側で生成する
      pendingBgImage = img;
    };
    img.onerror = () => {
      console.error(`Failed to load background image ${url}`);
    };
    img.src = url;
  }
  let pendingBgImage = null;

  function uploadBgImage(gl, img) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (bgImageTexture) gl.deleteTexture(bgImageTexture);
    bgImageTexture = tex;
    bgImageLoaded = true;
  }

  function blit(gl, targetFBO) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function useProgram(gl, p) {
    gl.useProgram(p.program);
    return p.uniforms;
  }

  function renderScene(gl) {
    gl.viewport(0, 0, fbo.sceneFBO.width, fbo.sceneFBO.height);
    const u = useProgram(gl, programs.scene);
    gl.uniform2f(u.uResolution, fbo.sceneFBO.width, fbo.sceneFBO.height);
    gl.uniform1f(u.uImageAspect, bgImageAspect);
    gl.uniform1f(u.uImageLoaded, bgImageLoaded ? 1.0 : 0.0);
    if (bgImageTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgImageTexture);
      gl.uniform1i(u.uBgImage, 0);
    }
    blit(gl, fbo.sceneFBO.fbo);
  }

  function renderBlur(gl) {
    const px = CONFIG.BLUR_PIXEL_RADIUS;
    let srcTex = fbo.sceneFBO.texture;

    for (let i = 0; i < CONFIG.BLUR_ITERATIONS; i++) {
      gl.viewport(0, 0, fbo.blurTempFBO.width, fbo.blurTempFBO.height);
      let u = useProgram(gl, programs.blur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(u.uTexture, 0);
      gl.uniform2f(u.uDirection, px / fbo.blurTempFBO.width, 0.0);
      blit(gl, fbo.blurTempFBO.fbo);

      gl.viewport(0, 0, fbo.blurredSceneFBO.width, fbo.blurredSceneFBO.height);
      u = useProgram(gl, programs.blur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo.blurTempFBO.texture);
      gl.uniform1i(u.uTexture, 0);
      gl.uniform2f(u.uDirection, 0.0, px / fbo.blurredSceneFBO.height);
      blit(gl, fbo.blurredSceneFBO.fbo);

      srcTex = fbo.blurredSceneFBO.texture;
    }
  }

  function splat(gl, x, y, radius, amount) {
    gl.viewport(0, 0, fbo.mask.width, fbo.mask.height);
    const u = useProgram(gl, programs.splat);
    gl.uniform1i(u.uTarget, fbo.mask.read.attach(0));
    gl.uniform1f(u.aspectRatio, sizeW / sizeH);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, radius);
    gl.uniform1f(u.amount, amount);
    blit(gl, fbo.mask.write.fbo);
    fbo.mask.swap();
  }

  function decayMask(gl, dt) {
    const decay = Math.pow(CONFIG.MASK_DECAY, dt * 60);
    maskLinearFadeAccumulator += CONFIG.MASK_LINEAR_FADE_PER_SEC * dt;
    let linearFade = 0;
    if (maskLinearFadeAccumulator >= MASK_QUANT_STEP) {
      linearFade = maskLinearFadeAccumulator;
      maskLinearFadeAccumulator = 0;
    }
    gl.viewport(0, 0, fbo.mask.width, fbo.mask.height);
    const u = useProgram(gl, programs.decay);
    gl.uniform1i(u.uTexture, fbo.mask.read.attach(0));
    gl.uniform1f(u.decay, decay);
    gl.uniform1f(u.linearFade, linearFade);
    blit(gl, fbo.mask.write.fbo);
    fbo.mask.swap();
  }

  function renderDisplay(gl, ctx) {
    gl.viewport(ctx.originX, ctx.originY, ctx.width, ctx.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(ctx.originX, ctx.originY, ctx.width, ctx.height);
    const u = useProgram(gl, programs.display);
    gl.uniform1i(u.uScene, fbo.sceneFBO.attach(0));
    gl.uniform1i(u.uBlurredScene, fbo.blurredSceneFBO.attach(1));
    gl.uniform1i(u.uMask, fbo.mask.read.attach(2));
    gl.uniform1i(u.uWaterMap, fbo.waterMapFBO.attach(3));
    gl.uniform1f(u.uRefractionStrength, CONFIG.REFRACTION_STRENGTH);
    gl.uniform1f(u.uFogEnabled, effects.fog ? 1.0 : 0.0);
    blit(gl, null);
  }

  // --- 雨粒シミュレーション ---
  function spawnDrop({ x, y, r, momentum = 0, momentumX = 0, parentId = null, isDrip = false }) {
    if (drops.length >= EFFECTIVE_DROP_MAX_COUNT) return null;
    const drop = {
      id: nextDropId++,
      x, y, r, momentum, momentumX,
      spreadY: 1.0, shrink: 0, lastSpawn: 0,
      nextSpawn: randomRange(0.02, 0.06),
      parentId, isDrip, killed: false,
    };
    drops.push(drop);
    return drop;
  }

  function respawnMistDrop(d) {
    d.x = Math.random();
    d.y = Math.random();
    d.r = randomRange(CONFIG.DROP_MIN_R, CONFIG.DROP_MIN_R * 2.2);
    d.shrink = 0;
    d.shrinking = false;
  }
  function makeMistDrop() {
    const d = { x: 0, y: 0, r: 0, shrink: 0, shrinking: false };
    respawnMistDrop(d);
    return d;
  }
  function seedMistDrops() {
    mistDrops.length = 0;
    for (let i = 0; i < EFFECTIVE_MIST_COUNT; i++) mistDrops.push(makeMistDrop());
  }

  function updateMistDrops(dt) {
    for (let i = 0; i < mistDrops.length; i++) {
      const d = mistDrops[i];
      if (!d.shrinking) {
        if (Math.random() < CONFIG.EVAPORATION_CHANCE_PER_SEC * dt) {
          d.shrinking = true;
          d.shrink = randomRange(CONFIG.EVAPORATION_RATE_MIN, CONFIG.EVAPORATION_RATE_MAX);
        }
        continue;
      }
      d.r -= d.shrink * dt;
      if (d.r <= CONFIG.DROP_MIN_R * 0.25) respawnMistDrop(d);
    }
  }

  function applyMergeSidewaysDrift(survivor, absorbed) {
    const wSurvivor = survivor.r * survivor.r;
    const wAbsorbed = absorbed.r * absorbed.r;
    survivor.x = (wSurvivor * survivor.x + wAbsorbed * absorbed.x) / (wSurvivor + wAbsorbed);
  }

  function updateDrops(gl, dt) {
    rainSpawnAccumulator += dt * CONFIG.RAIN_SPAWN_PER_SEC;
    while (rainSpawnAccumulator >= 1) {
      rainSpawnAccumulator -= 1;
      const r = cubicBiasedRadius(CONFIG.DROP_MIN_R, CONFIG.DROP_MAX_R);
      spawnDrop({
        x: Math.random(),
        y: randomRange(CONFIG.RAIN_SPAWN_Y_MIN, CONFIG.RAIN_SPAWN_Y_MAX),
        r,
        momentum: 0.09 + (r / CONFIG.DROP_MAX_R) * 0.22 + Math.random() * 0.06,
      });
    }

    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (d.killed) continue;

      if (d.momentum > 0.008) {
        d.lastSpawn += d.momentum * dt * CONFIG.TRAIL_RATE;
        if (d.lastSpawn > d.nextSpawn) {
          spawnDrop({
            x: d.x + (Math.random() - 0.5) * d.r * 0.4,
            y: d.y + d.r * 0.3,
            r: d.r * randomRange(0.25, 0.45),
            parentId: d.id,
            isDrip: d.isDrip,
          });
          d.r *= 0.985;
          d.lastSpawn = 0;
          d.nextSpawn = randomRange(0.02, 0.06);
        }
      } else if (Math.random() < CONFIG.EVAPORATION_CHANCE_PER_SEC * dt) {
        d.shrink = randomRange(CONFIG.EVAPORATION_RATE_MIN, CONFIG.EVAPORATION_RATE_MAX);
      }

      d.r -= d.shrink * dt;
      if (d.r <= CONFIG.DROP_MIN_R * 0.25) {
        d.killed = true;
        continue;
      }

      d.spreadY += (1.0 - d.spreadY) * Math.min(1, dt * 4.0);

      if (d.momentum > 0) {
        d.y -= d.momentum * dt;
        d.x += d.momentumX * dt;
        d.spreadY = 1.0 + d.momentum * 6.0;

        if (d.isDrip) {
          const wipeRadius = d.r * CONFIG.DRIP_WIPE_RADIUS_FACTOR;
          splat(gl, d.x, d.y, wipeRadius, CONFIG.DRIP_WIPE_AMOUNT);
        }

        if (d.y < -0.06) {
          d.killed = true;
          continue;
        }
      }

      d.momentum -= Math.max(0.5, d.momentum * 0.6) * dt;
      if (d.momentum < 0) d.momentum = 0;
      d.momentumX *= Math.pow(0.6, dt * 60);
    }

    // 合体判定
    {
      let maxR = CONFIG.DROP_MAX_R;
      for (const d of drops) if (!d.killed && d.r > maxR) maxR = d.r;
      const cellSize = CONFIG.MERGE_DISTANCE_FACTOR * maxR * 2.2;
      const grid = new Map();
      for (const d of drops) {
        if (d.killed) continue;
        const key = `${Math.floor(d.x / cellSize)},${Math.floor(d.y / cellSize)}`;
        let bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(d);
      }
      for (const a of drops) {
        if (a.killed) continue;
        const cx = Math.floor(a.x / cellSize);
        const cy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = grid.get(`${cx + ox},${cy + oy}`);
            if (!bucket) continue;
            for (const b of bucket) {
              if (b.killed || a.id >= b.id) continue;
              if (a.parentId === b.id || b.parentId === a.id) continue;
              if (a.isDrip !== b.isDrip) continue;
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const rSum = (a.r + b.r) * CONFIG.MERGE_DISTANCE_FACTOR;
              if (dx * dx + dy * dy < rSum * rSum) {
                const big = a.r >= b.r ? a : b;
                const small = a.r >= b.r ? b : a;
                big.r = Math.min(CONFIG.DROP_MAX_R * CONFIG.MERGE_GROWTH_CAP, Math.sqrt(big.r * big.r + small.r * small.r * 0.8));
                big.momentum = Math.max(big.momentum, small.momentum, big.momentum + 0.05);
                applyMergeSidewaysDrift(big, small);
                small.killed = true;
              }
            }
          }
        }
      }
    }

    // mist吸収判定
    {
      let maxDropR = CONFIG.DROP_MAX_R;
      for (const d of drops) if (!d.killed && !d.isDrip && d.r > maxDropR) maxDropR = d.r;
      const cellSize = CONFIG.MERGE_DISTANCE_FACTOR * maxDropR * 2.2;
      const mistGrid = new Map();
      for (const m of mistDrops) {
        const key = `${Math.floor(m.x / cellSize)},${Math.floor(m.y / cellSize)}`;
        let bucket = mistGrid.get(key);
        if (!bucket) { bucket = []; mistGrid.set(key, bucket); }
        bucket.push(m);
      }
      const consumedMist = new Set();
      for (const a of drops) {
        if (a.killed || a.isDrip) continue;
        const cx = Math.floor(a.x / cellSize);
        const cy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = mistGrid.get(`${cx + ox},${cy + oy}`);
            if (!bucket) continue;
            for (const m of bucket) {
              if (consumedMist.has(m)) continue;
              const dx = a.x - m.x;
              const dy = a.y - m.y;
              const rSum = (a.r + m.r) * CONFIG.MERGE_DISTANCE_FACTOR;
              if (dx * dx + dy * dy < rSum * rSum) {
                a.r = Math.min(CONFIG.DROP_MAX_R * CONFIG.MERGE_GROWTH_CAP, Math.sqrt(a.r * a.r + m.r * m.r * 0.8));
                a.momentum = Math.max(a.momentum, Math.min(0.6, a.momentum + 0.05));
                applyMergeSidewaysDrift(a, m);
                consumedMist.add(m);
                respawnMistDrop(m);
              }
            }
          }
        }
      }
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      if (drops[i].killed) drops.splice(i, 1);
    }
  }

  function spawnDrip(x, y) {
    spawnDrop({
      x: x + (Math.random() - 0.5) * 0.015,
      y: y - 0.004,
      r: CONFIG.DRIP_INITIAL_R * randomRange(0.8, 1.3),
      momentum: CONFIG.DRIP_INITIAL_MOMENTUM * randomRange(0.7, 1.2),
      isDrip: true,
    });
  }

  function userSplat(gl, x, y, radius, amount) {
    splat(gl, x, y, radius, amount);
    lastWipeX = x;
    lastWipeY = y;
    dripWetnessAccumulator += radius * radius;
    while (dripWetnessAccumulator >= EFFECTIVE_DRIP_SPAWN_THRESHOLD) {
      dripWetnessAccumulator -= EFFECTIVE_DRIP_SPAWN_THRESHOLD;
      spawnDrip(lastWipeX, lastWipeY);
    }
  }

  function renderDrops(gl) {
    const aspect = sizeW / sizeH;
    let n = 0;

    if (effects.rain) {
      for (let i = 0; i < mistDrops.length && n < MAX_INSTANCES; i++) {
        const d = mistDrops[i];
        dropInstanceData[n * 4 + 0] = d.x;
        dropInstanceData[n * 4 + 1] = d.y;
        dropInstanceData[n * 4 + 2] = d.r / aspect;
        dropInstanceData[n * 4 + 3] = d.r;
        n++;
      }
    }

    for (let i = 0; i < drops.length && n < MAX_INSTANCES; i++) {
      const d = drops[i];
      if (d.killed) continue;
      if (d.isDrip ? !effects.fog : !effects.rain) continue;
      dropInstanceData[n * 4 + 0] = d.x;
      dropInstanceData[n * 4 + 1] = d.y;
      dropInstanceData[n * 4 + 2] = d.r / aspect;
      dropInstanceData[n * 4 + 3] = d.r * d.spreadY;
      n++;
    }

    gl.viewport(0, 0, fbo.dropFieldFBO.width, fbo.dropFieldFBO.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.dropFieldFBO.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (n > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dropInstanceData.subarray(0, n * 4));

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);

      useProgram(gl, programs.dropField);
      gl.bindVertexArray(dropVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);

      gl.disable(gl.BLEND);
    }

    gl.viewport(0, 0, fbo.waterMapFBO.width, fbo.waterMapFBO.height);
    const u = useProgram(gl, programs.metaballResolve);
    gl.uniform1i(u.uField, fbo.dropFieldFBO.attach(0));
    gl.uniform2f(u.uTexelSize, fbo.dropFieldFBO.texelSizeX, fbo.dropFieldFBO.texelSizeY);
    gl.uniform1f(u.uThreshold, CONFIG.METABALL_THRESHOLD);
    gl.uniform1f(u.uEdgeSoftness, CONFIG.METABALL_EDGE_SOFTNESS);
    blit(gl, fbo.waterMapFBO.fbo);
  }

  function updateAutoplay(gl, dt) {
    if (!autoplay.enabled) return;
    const stroke = autoplay.strokes[autoplay.strokeIndex];
    if (!stroke) {
      autoplay.enabled = false;
      ui.fingerCursor.style.opacity = '0';
      ui.hint.classList.remove('faded');
      return;
    }
    if (autoplay.paused) {
      autoplay.pauseTimer -= dt;
      if (autoplay.pauseTimer <= 0) autoplay.paused = false;
      return;
    }
    autoplay.progress += dt * autoplay.speed;
    while (autoplay.progress >= 1 && autoplay.pointIndex < stroke.length - 1) {
      autoplay.progress -= 1;
      autoplay.pointIndex++;
    }
    const pt = stroke[autoplay.pointIndex];
    userSplat(gl, pt.x, pt.y, CONFIG.AUTOPLAY_BRUSH_RADIUS, 1.0);
    setFingerCursor(pt.x * sizeCssW, (1 - pt.y) * sizeCssH, 0.9);

    if (autoplay.pointIndex >= stroke.length - 1) {
      autoplay.strokeIndex++;
      autoplay.pointIndex = 0;
      autoplay.progress = 0;
      autoplay.paused = true;
      autoplay.pauseTimer = 0.3;
    }
  }

  // --- ポインタ操作(slotEl基準のCSS px) ---
  let sizeCssW = 0;
  let sizeCssH = 0;
  const pointerState = { down: false, lastX: 0, lastY: 0 };
  const BRUSH_SPACING = CONFIG.USER_BRUSH_RADIUS * 0.5;

  function toLocalUV(clientX, clientY) {
    const rect = slotEl.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = 1 - (clientY - rect.top) / rect.height;
    return { u, v, localX: clientX - rect.left, localY: clientY - rect.top };
  }

  function stopAutoplayForUser() {
    autoplay.enabled = false;
    ui.hint.classList.add('faded');
  }

  let pendingSplats = [];

  function splatAlongSegment(x0, y0, x1, y1, radius, amount) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.round(dist / BRUSH_SPACING));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pendingSplats.push({ x: x0 + dx * t, y: y0 + dy * t, radius, amount });
    }
  }

  function onPointerDown(e) {
    stopAutoplayForUser();
    const { u, v, localX, localY } = toLocalUV(e.clientX, e.clientY);
    pointerState.down = true;
    pointerState.lastX = u;
    pointerState.lastY = v;
    pendingSplats.push({ x: u, y: v, radius: CONFIG.USER_BRUSH_RADIUS, amount: 1.0 });
    setFingerCursor(localX, localY, 1.0);
  }
  function onPointerMove(e) {
    const { u, v, localX, localY } = toLocalUV(e.clientX, e.clientY);
    if (!autoplay.enabled) setFingerCursor(localX, localY, pointerState.down ? 1.0 : 0.55);
    if (!pointerState.down) return;
    splatAlongSegment(pointerState.lastX, pointerState.lastY, u, v, CONFIG.USER_BRUSH_RADIUS, 1.0);
    pointerState.lastX = u;
    pointerState.lastY = v;
  }
  function onPointerUp() {
    pointerState.down = false;
  }
  function onPointerLeave() {
    if (!pointerState.down) ui.fingerCursor.style.opacity = '0';
  }
  function onTouchMove(e) {
    e.preventDefault();
  }

  slotEl.addEventListener('pointerdown', onPointerDown);
  slotEl.addEventListener('pointermove', onPointerMove);
  slotEl.addEventListener('pointerleave', onPointerLeave);
  slotEl.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);

  return {
    id: 'rain-window',
    slotEl,
    active: false,

    createResources(gl) {
      programs = {
        scene: createProgramReflected(gl, baseVertexShader, sceneShader),
        blur: createProgramReflected(gl, baseVertexShader, blurShader),
        splat: createProgramReflected(gl, baseVertexShader, splatShader),
        decay: createProgramReflected(gl, baseVertexShader, decayShader),
        display: createProgramReflected(gl, baseVertexShader, displayShader),
        dropField: createProgramReflected(gl, dropVertexShader, dropFieldFragmentShader),
        metaballResolve: createProgramReflected(gl, baseVertexShader, metaballResolveShader),
      };

      quadVAO = gl.createVertexArray();
      gl.bindVertexArray(quadVAO);
      quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      dropVAO = gl.createVertexArray();
      gl.bindVertexArray(dropVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(0, 0);
      dropInstanceBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);

      // サイズ依存の状態(FBO・粒配列)は初回render時に測ってから作る
      fbo = null;
      sizeW = 0;
      sizeH = 0;
      bgImageTexture = null;
      bgImageLoaded = false;
      pendingBgImage = null;

      if (!ui) ui = buildUI();
    },

    destroyResources(gl) {
      destroyFBOs(gl);
      if (programs) {
        for (const p of Object.values(programs)) gl.deleteProgram(p.program);
      }
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (dropInstanceBuffer) gl.deleteBuffer(dropInstanceBuffer);
      if (quadVAO) gl.deleteVertexArray(quadVAO);
      if (dropVAO) gl.deleteVertexArray(dropVAO);
      if (bgImageTexture) gl.deleteTexture(bgImageTexture);
      slotEl.removeEventListener('pointerdown', onPointerDown);
      slotEl.removeEventListener('pointermove', onPointerMove);
      slotEl.removeEventListener('pointerleave', onPointerLeave);
      slotEl.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (ui) {
        ui.root.remove();
        ui = null;
      }
    },

    render(gl, ctx) {
      // オフスクリーンパスがcanvas全体基準のscissorに巻き込まれないよう一旦切る
      gl.disable(gl.SCISSOR_TEST);

      const w = ctx.width;
      const h = ctx.height;
      const sizeChanged = w !== sizeW || h !== sizeH || fbo === null;
      sizeW = w;
      sizeH = h;
      sizeCssW = w / ctx.dpr;
      sizeCssH = h / ctx.dpr;

      if (sizeChanged && w > 0 && h > 0) {
        lowPower = ctx.isLowPower;
        initFramebuffers(gl, w, h);
        DENSITY_SCALE = computeDensityScale(w, h);
        EFFECTIVE_MIST_COUNT = Math.round(CONFIG.MIST_COUNT * DENSITY_SCALE);
        EFFECTIVE_DROP_MAX_COUNT = Math.round(CONFIG.DROP_MAX_COUNT * DENSITY_SCALE);
        EFFECTIVE_DRIP_SPAWN_THRESHOLD = CONFIG.DRIP_SPAWN_THRESHOLD * DENSITY_SCALE;
        MAX_INSTANCES = EFFECTIVE_MIST_COUNT + EFFECTIVE_DROP_MAX_COUNT;
        dropInstanceData = new Float32Array(MAX_INSTANCES * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, dropInstanceData.byteLength, gl.DYNAMIC_DRAW);
        seedMistDrops();
        drops.length = 0;

        if (!bgImageLoaded && !pendingBgImage) {
          loadBackgroundImage(lowPower ? bgImageSmallUrl : bgImageUrl);
        }
      }

      if (pendingBgImage) {
        uploadBgImage(gl, pendingBgImage);
        pendingBgImage = null;
      }

      // reduced-motionでは自動で動き続ける部分(自動再生の拭う演出・降り続ける雨・
      // 結露の蒸発)だけ止める。指で拭う操作自体は常に有効。
      const simDt = ctx.reducedMotion ? 0 : ctx.dt;

      try {
        updateAutoplay(gl, simDt);
      } catch (err) {
        console.error('rain-window autoplay step failed — disabling:', err);
        autoplay.enabled = false;
      }

      for (const s of pendingSplats) userSplat(gl, s.x, s.y, s.radius, s.amount);
      pendingSplats = [];

      try {
        updateMistDrops(simDt);
        updateDrops(gl, simDt);
        renderDrops(gl);
      } catch (err) {
        console.error('rain-window drop simulation failed — window still renders without rain:', err);
      }

      decayMask(gl, simDt);
      renderScene(gl);
      renderBlur(gl);
      renderDisplay(gl, ctx);
      gl.bindVertexArray(null); // 他ブロックのVAOなし描画に影響しないよう明示的に戻す
    },
  };
}
