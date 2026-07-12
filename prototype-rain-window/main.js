// ============================================================================
// 雨の中の窓 — 結露プロトタイプ #2
//
// - 夜景をプロシージャルに生成し、ブラー版とシャープ版を用意
// - 「拭いたマスク」だけ shaper(シャープ)な夜景が見え、それ以外はブラー(曇り)
// - マスクは時間とともにゆっくり減衰 = 水蒸気で再びガラスが曇っていく
// - 雨粒は個々に物理シミュレーション(重力で加速して落下・軌跡として小さな滴を
//   残す・近くの滴と衝突して合体)し、それぞれが背景を屈折させるレンズとして働く。
// - ページを開くと、手で拭うようなジェスチャーを自動再生してから
//   ユーザーのドラッグ操作に引き継ぐ
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

// 雨・結露それぞれの描写をON/OFFできるトグル状態
const effects = { rain: true, fog: true };

function setupToggleButton(id, key) {
  const btn = document.getElementById(id);
  btn.addEventListener("click", () => {
    effects[key] = !effects[key];
    btn.setAttribute("aria-pressed", String(effects[key]));
  });
}
setupToggleButton("toggleRain", "rain");
setupToggleButton("toggleFog", "fog");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 is not supported.");
}

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  SCENE_RESOLUTION: 900,
  BLUR_RESOLUTION: 220, // シーンよりずっと低い解像度でブラーすることで、強いフロスト感を安く出す
  MASK_RESOLUTION: 640,
  MASK_DECAY: 0.9985, // 拭った跡がゆっくり曇りへ戻る(水蒸気で再び曇る)速度
  MASK_LINEAR_FADE_PER_SEC: 0.035, // 実時間ベースで蓄積し、8bit量子化ステップを跨いだ時だけ反映する。
  // 半径は実際のUV空間半径(円の境界そのもの)。
  AUTOPLAY_BRUSH_RADIUS: 0.036,
  USER_BRUSH_RADIUS: 0.0308, // ドラッグもクリックと同じ値を使う
  BLUR_ITERATIONS: 3,
  BLUR_PIXEL_RADIUS: 1.6, // 少し強めのフロストで、外の世界との距離感を強調

  // 「静的な小粒の結露(mist)」と「物理演算で落ちる大粒の雨(drops)」を完全に別のシステムとして持つ。
  WATER_RESOLUTION: 1000,
  DROP_MIN_R: 0.0045, // UV空間(画面高さ基準)での最小半径
  DROP_MAX_R: 0.02, // まれに大粒の「涙」のような雫が生まれるよう少し大きめに
  REFRACTION_STRENGTH: 0.045, // 水滴一つ一つがより強くレンズのように景色を歪める
  METABALL_THRESHOLD: 0.5, // これを超えたfieldの場所が水滴の内側になる(低いほど繋がりやすい)
  METABALL_EDGE_SOFTNESS: 0.08, // しきい値付近の輪郭のなめらかさ
  EVAPORATION_CHANCE_PER_SEC: 0.15, // 水滴が「蒸発」を始める確率
  EVAPORATION_RATE_MIN: 0.00015, // 蒸発が始まった後の縮む速さの範囲
  EVAPORATION_RATE_MAX: 0.0005,

  // mist: 常時画面を覆う、動かない小粒の結露。固定数・配列の出し入れ無しで
  // 蒸発したその場に生まれ変わるだけなので、数が多くても軽い。
  MIST_COUNT: 3000,

  // drops: 重力で落ちる大粒の雨。物理演算(加速・軌跡・合体)はこちらだけが持つ。
  DROP_MAX_COUNT: 1000, // mistが土台の密度を担うので、こちらは動きのある粒だけで十分
  RAIN_SPAWN_PER_SEC: 30, // DROP_MAX_COUNTに達したらこれ以上増えても見た目は変わらない
  RAIN_SPAWN_Y_MIN: 0.05, // 雨粒は上端から流れてくるのではなく、画面全体にランダムに着弾する
  RAIN_SPAWN_Y_MAX: 1.05,
  TRAIL_RATE: 2.0, // 落下中に軌跡の滴を残す頻度
  MERGE_DISTANCE_FACTOR: 0.33, // 合体しにくくして小粒のままでいる水滴を主体にする
  MERGE_GROWTH_CAP: 0.8, // 合体しても大きくなりすぎない上限

  // 拭った場所に溜まる水滴(指でなぞった跡から垂れ落ちる)
  DRIP_SPAWN_THRESHOLD: 0.025, // これだけの「拭った面積」が溜まるたびに1滴生まれる
  DRIP_INITIAL_R: 0.015,
  DRIP_INITIAL_MOMENTUM: 0.4, // 初速
  DRIP_WIPE_AMOUNT: 1.0, // 結露を拭う強度
  DRIP_WIPE_RADIUS_FACTOR: 1 / 2, // 拭う範囲は見た目のインスタンスサイズのこの倍率まで絞る
};

// ----------------------------------------------------------------------------
// GL helpers
// ----------------------------------------------------------------------------
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    throw new Error("Shader compile error");
  }
  return shader;
}

function createProgram(vsSource, fsSource) {
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    throw new Error("Program link error");
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    uniforms[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

function blit(targetFBO) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function useProgram(p) {
  gl.useProgram(p.program);
  return p.uniforms;
}

// ----------------------------------------------------------------------------
// Shaders
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

    // CSSのbackground-size:coverと同じ考え方で、画像のアスペクト比を保ったまま
    // 画面いっぱいにクロップする(引き伸ばして歪ませない)。
    vec2 ratio = vec2(
      min(screenAspect / uImageAspect, 1.0),
      min(uImageAspect / screenAspect, 1.0)
    );
    vec2 uvCover = vec2(
      uv.x * ratio.x + (1.0 - ratio.x) * 0.5,
      uv.y * ratio.y + (1.0 - ratio.y) * 0.5
    );

    vec3 color = texture(uBgImage, uvCover).rgb;
    // 画像読み込み前は暗いプレースホルダーにフォールバックし、
    // 読み込み完了まで空白/エラーにならないようにする。
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

// 雨粒1つを、インスタンス化された矩形(=水滴の外接ボックス)として描画する。
// 直接レンズ形状を書き込むのではなく、まず「なめらかな距離場(field)」を
// 加算ブレンドで蓄積し(このパス)、別パスでしきい値化して初めて最終的な
// 輪郭・屈折を決める。これにより、まだ物理的には合体していない近くの水滴
// 同士も、距離場が重なる場所でなめらかに繋がる(本来のメタボール表現)。
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

// fieldを読み、しきい値を境に「水滴の中/外」を決める(メタボールの本体)。
// 屈折方向は、隣接テクセルとのfieldの差(勾配)から求める。これにより、
// 合体していない水滴同士が繋がった「首」の部分でも、勾配がなめらかに
// つながった自然な屈折になる。
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
    // 指でなぞった時の挙動を再現するため、なだらかなガウシアンではなく
    // 境界のはっきりした円(0 or 1 の二値)を使う。radius は実際のUV空間半径。
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
    // マスクは8bit(RGBA8, 256段階)。乗算だけの減衰だと、値が小さくなるほど
    // 1フレームあたりの変化量が量子化ステップ(1/255)を下回り、保存される
    // バイト値が変化しなくなって止まってしまう(=曇りが永久に戻らない)。
    // 小さな線形の減算項を足すことで、量子化に関係なく必ず0まで落ちるようにする。
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
  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uFogEnabled;
  out vec4 fragColor;

  void main () {
    vec2 uv = vUv;

    float mask = texture(uMask, uv).r;

    // 水滴マップ: R,G = 屈折方向(0.5中心), B = 厚み(レンズ中心が最大), A = アルファ
    vec4 water = texture(uWaterMap, uv);
    vec2 refraction = (water.rg - 0.5) * 2.0;
    float thickness = water.b;
    float dropAlpha = water.a;

    vec2 refractedUv = uv + refraction * thickness * uRefractionStrength;

    vec3 sharp = texture(uScene, uv).rgb;
    vec3 blurred = texture(uBlurredScene, uv).rgb;

    // 曇り(拭いたマスク)による、シャープ⇔ブラーのブレンド。
    // uFogEnabled が 0 のときは曇り自体を無効にして常にシャープに見せる。
    float fogMixAmt = mix(1.0, smoothstep(0.05, 0.85, mask), uFogEnabled);
    vec3 composite = mix(blurred, sharp, fogMixAmt);

    // 個々の水滴は、曇っていても外側のガラスにあるので常に奥がシャープに見える
    // 小さなレンズとして、屈折させたシャープな景色を上から乗せる
    vec3 dropColor = texture(uScene, refractedUv).rgb * (0.82 + thickness * 0.4);
    composite = mix(composite, dropColor, dropAlpha * 0.92);

    fragColor = vec4(composite, 1.0);
  }
`;

const sceneProgram = createProgram(baseVertexShader, sceneShader);
const blurProgram = createProgram(baseVertexShader, blurShader);
const splatProgram = createProgram(baseVertexShader, splatShader);
const decayProgram = createProgram(baseVertexShader, decayShader);
const displayProgram = createProgram(baseVertexShader, displayShader);
const dropFieldProgram = createProgram(dropVertexShader, dropFieldFragmentShader);
const metaballResolveProgram = createProgram(baseVertexShader, metaballResolveShader);

// ----------------------------------------------------------------------------
// Framebuffers (all RGBA8 / UNSIGNED_BYTE — universally supported render targets)
// ----------------------------------------------------------------------------
function createFBO(w, h, filter) {
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return {
    texture,
    fbo,
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

function createDoubleFBO(w, h, filter) {
  let fbo1 = createFBO(w, h, filter);
  let fbo2 = createFBO(w, h, filter);
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

function getResolution(resolution) {
  let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
  const min = Math.round(resolution);
  const max = Math.round(resolution * aspectRatio);
  if (gl.drawingBufferWidth > gl.drawingBufferHeight) {
    return { width: max, height: min };
  }
  return { width: min, height: max };
}

let sceneFBO, blurTempFBO, blurredSceneFBO, mask, waterMapFBO, dropFieldFBO;

function initFramebuffers() {
  const sceneRes = getResolution(CONFIG.SCENE_RESOLUTION);
  const blurRes = getResolution(CONFIG.BLUR_RESOLUTION);
  const maskRes = getResolution(CONFIG.MASK_RESOLUTION);
  const waterRes = getResolution(CONFIG.WATER_RESOLUTION);

  sceneFBO = createFBO(sceneRes.width, sceneRes.height, gl.LINEAR);
  blurTempFBO = createFBO(blurRes.width, blurRes.height, gl.LINEAR);
  blurredSceneFBO = createFBO(blurRes.width, blurRes.height, gl.LINEAR);
  mask = createDoubleFBO(maskRes.width, maskRes.height, gl.LINEAR);
  waterMapFBO = createFBO(waterRes.width, waterRes.height, gl.LINEAR);
  dropFieldFBO = createFBO(waterRes.width, waterRes.height, gl.LINEAR);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

resizeCanvas();
initFramebuffers();

// 調整に使ったビューポート比(1280x800)を基準に、アスペクト比に比例して
// 水滴数をスケールする(横長ほど多く、縦長ほど少なく)。
const DENSITY_REFERENCE_ASPECT = 1280 / 800;
function computeDensityScale() {
  const aspect = canvas.width / canvas.height;
  return Math.min(1.8, Math.max(0.35, aspect / DENSITY_REFERENCE_ASPECT));
}

window.addEventListener("resize", () => {
  if (resizeCanvas()) initFramebuffers();
});

// ----------------------------------------------------------------------------
// Passes
// ----------------------------------------------------------------------------
let bgImageTexture = null;
let bgImageAspect = 640 / 427;
let bgImageLoaded = false;

function loadBackgroundImage(url) {
  const img = new Image();
  img.onload = () => {
    bgImageAspect = img.naturalWidth / img.naturalHeight;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    bgImageTexture = tex;
    bgImageLoaded = true;
  };
  img.onerror = () => {
    console.error(`Failed to load background image ${url} — showing dark placeholder instead.`);
  };
  img.src = url;
}
loadBackgroundImage("./assets/background1.jpg");

function renderScene() {
  gl.viewport(0, 0, sceneFBO.width, sceneFBO.height);
  const u = useProgram(sceneProgram);
  gl.uniform2f(u.uResolution, sceneFBO.width, sceneFBO.height);
  gl.uniform1f(u.uImageAspect, bgImageAspect);
  gl.uniform1f(u.uImageLoaded, bgImageLoaded ? 1.0 : 0.0);
  if (bgImageTexture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgImageTexture);
    gl.uniform1i(u.uBgImage, 0);
  }
  blit(sceneFBO.fbo);
}

function renderBlur() {
  const px = CONFIG.BLUR_PIXEL_RADIUS;
  let srcTex = sceneFBO.texture;
  let srcAttachId = sceneFBO.attach(0);

  for (let i = 0; i < CONFIG.BLUR_ITERATIONS; i++) {
    gl.viewport(0, 0, blurTempFBO.width, blurTempFBO.height);
    let u = useProgram(blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(u.uTexture, 0);
    gl.uniform2f(u.uDirection, px / blurTempFBO.width, 0.0);
    blit(blurTempFBO.fbo);

    gl.viewport(0, 0, blurredSceneFBO.width, blurredSceneFBO.height);
    u = useProgram(blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, blurTempFBO.texture);
    gl.uniform1i(u.uTexture, 0);
    gl.uniform2f(u.uDirection, 0.0, px / blurredSceneFBO.height);
    blit(blurredSceneFBO.fbo);

    srcTex = blurredSceneFBO.texture;
  }
}

function splat(x, y, radius, amount) {
  gl.viewport(0, 0, mask.width, mask.height);
  const u = useProgram(splatProgram);
  gl.uniform1i(u.uTarget, mask.read.attach(0));
  gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(u.point, x, y);
  gl.uniform1f(u.radius, radius);
  gl.uniform1f(u.amount, amount);
  blit(mask.write.fbo);
  mask.swap();
}

const MASK_QUANT_STEP = 1 / 255;
let maskLinearFadeAccumulator = 0;

function decayMask(dt) {
  // MASK_DECAY は「60fps基準・1フレームあたり」の値として定義しているため、
  // 実際のフレームレートに関わらず実時間で同じ速さで曇りが戻るよう、
  // 経過時間(dt)でべき乗補正する。
  const decay = Math.pow(CONFIG.MASK_DECAY, dt * 60);
  // linearFade は8bit量子化の不動点を避けるための項。単純に「1フレームあたり
  // 最低でもこれだけ引く」という下限にすると、フレームレートが高いほど
  // 秒間の合計減少量が際限なく増えてしまう(フレームレート依存の再発)。
  // 代わりに実時間ベースで蓄積しておき、量子化ステップ(1/255)を跨ぐタイミングに
  // なったフレームでだけまとめて反映することで、実時間での合計量を保ったまま
  // 不動点も避ける。
  maskLinearFadeAccumulator += CONFIG.MASK_LINEAR_FADE_PER_SEC * dt;
  let linearFade = 0;
  if (maskLinearFadeAccumulator >= MASK_QUANT_STEP) {
    linearFade = maskLinearFadeAccumulator;
    maskLinearFadeAccumulator = 0;
  }
  gl.viewport(0, 0, mask.width, mask.height);
  const u = useProgram(decayProgram);
  gl.uniform1i(u.uTexture, mask.read.attach(0));
  gl.uniform1f(u.decay, decay);
  gl.uniform1f(u.linearFade, linearFade);
  blit(mask.write.fbo);
  mask.swap();
}

function render(t) {
  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = useProgram(displayProgram);
  gl.uniform1i(u.uScene, sceneFBO.attach(0));
  gl.uniform1i(u.uBlurredScene, blurredSceneFBO.attach(1));
  gl.uniform1i(u.uMask, mask.read.attach(2));
  gl.uniform1i(u.uWaterMap, waterMapFBO.attach(3));
  gl.uniform1f(u.uRefractionStrength, CONFIG.REFRACTION_STRENGTH);
  gl.uniform1f(u.uTime, t);
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  gl.uniform1f(u.uFogEnabled, effects.fog ? 1.0 : 0.0);
  blit(null);
}

// ----------------------------------------------------------------------------
// 雨粒シミュレーション
//   - 個々の水滴は重力に相当する momentum を持ち、大きいほど加速しやすい
//   - 落下中は軌跡として、小さく縮小した子滴を後ろに残す
//   - 近くの水滴同士がある距離まで近づくと合体する(メタボール的な見た目)
//   - 各水滴は円形SDFから疑似球面レンズの法線と厚みを計算し、
//     水滴マップ(RG=屈折方向, B=厚み, A=アルファ)にインスタンス描画で書き込む
// ----------------------------------------------------------------------------
function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function cubicBiasedRadius(min, max) {
  return min + Math.pow(Math.random(), 3) * (max - min);
}

// 現在の画面アスペクト比に合わせて、密度が一定に見えるよう水滴数を補正する
const DENSITY_SCALE = computeDensityScale();
const EFFECTIVE_MIST_COUNT = Math.round(CONFIG.MIST_COUNT * DENSITY_SCALE);
const EFFECTIVE_DROP_MAX_COUNT = Math.round(CONFIG.DROP_MAX_COUNT * DENSITY_SCALE);

const drops = [];
let nextDropId = 1;

function spawnDrop({ x, y, r, momentum = 0, momentumX = 0, parentId = null, isDrip = false }) {
  if (drops.length >= EFFECTIVE_DROP_MAX_COUNT) return null;
  const drop = {
    id: nextDropId++,
    x,
    y,
    r,
    momentum,
    momentumX,
    spreadY: 1.0,
    shrink: 0,
    lastSpawn: 0,
    nextSpawn: randomRange(0.02, 0.06),
    parentId,
    isDrip,
    killed: false,
  };
  drops.push(drop);
  return drop;
}

// ----------------------------------------------------------------------------
// mist: 常時画面を覆う、動かない小粒の結露。
// dropsとは完全に別の配列・別の更新ロジックで、物理演算(合体・軌跡・重力)を
// 一切持たない。固定長の配列を使い回し、蒸発したら同じスロットで別の場所に
// 生まれ変わるだけなので、数が多くても(数千個でも)非常に軽い。
// ----------------------------------------------------------------------------
const mistDrops = [];

// 蒸発しきった時・dropsに吸収された時のどちらでも、配列の出し入れはせず
// 同じスロットで別の場所に生まれ変わらせるための共通処理。
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
  for (let i = 0; i < EFFECTIVE_MIST_COUNT; i++) {
    mistDrops.push(makeMistDrop());
  }
}
seedMistDrops();

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
    if (d.r <= CONFIG.DROP_MIN_R * 0.25) {
      respawnMistDrop(d);
    }
  }
}

let rainSpawnAccumulator = 0;

// 合体時、生き残る側(survivor)の位置を、吸収する側(absorbed)との
// 重さ(半径^2 = 面積で近似)の加重平均の位置までそのまま寄せる。
// 速度(momentumX)ではなくその場の変位として与えるので、dtやフレームレートの
// ブレに影響されず、常に同じ分だけ位置がずれる。
function applyMergeSidewaysDrift(survivor, absorbed) {
  const wSurvivor = survivor.r * survivor.r;
  const wAbsorbed = absorbed.r * absorbed.r;
  survivor.x = (wSurvivor * survivor.x + wAbsorbed * absorbed.x) / (wSurvivor + wAbsorbed);
}

function updateDrops(dt) {
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
      d.spreadY = 1.0 +  d.momentum * 6.0;

      // 指で拭った場所に溜まった水滴は、垂れ落ちながら結露も拭っていく。
      // 見た目のインスタンスサイズ(d.r)はそのまま大きく保ちつつ、
      // 拭う範囲だけはそのCONFIG.DRIP_WIPE_RADIUS_FACTOR倍に絞る。
      if (d.isDrip) {
        const wipeRadius = d.r * CONFIG.DRIP_WIPE_RADIUS_FACTOR;
        splat(d.x, d.y, wipeRadius, CONFIG.DRIP_WIPE_AMOUNT);
      }

      if (d.y < -0.06) {
        d.killed = true;
        continue;
      }
    }

    // 摩擦を弱め、一度動き出したら画面を最後まで滑り落ちていく余韻を持たせる
    d.momentum -= Math.max(0.5, d.momentum * 0.6) * dt;
    if (d.momentum < 0) d.momentum = 0;
    d.momentumX *= Math.pow(0.6, dt * 60);
  }

  // 近くの水滴との合体判定
  {
    // セルサイズは合体判定距離(rSum)以上でなければ、3x3近傍探索が
    // 実際には範囲内にいる水滴を取りこぼしてしまう。水滴は合体を重ねる
    // ことでDROP_MAX_Rを大きく超えて成長しうる(最大 DROP_MAX_R * MERGE_GROWTH_CAP)ため、
    // 固定値のDROP_MAX_Rではなく、現時点で存在する水滴の最大半径から動的に求める。
    let maxR = CONFIG.DROP_MAX_R;
    for (const d of drops) {
      if (!d.killed && d.r > maxR) maxR = d.r;
    }
    const cellSize = CONFIG.MERGE_DISTANCE_FACTOR * maxR * 2.2;
    const grid = new Map();
    for (const d of drops) {
      if (d.killed) continue;
      const key = `${Math.floor(d.x / cellSize)},${Math.floor(d.y / cellSize)}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
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
            // 拭った跡の水滴は外の雨粒と混ざらず、独立して動くようにする
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

  // dropsが近づいた時のmist(結露)の受動的な吸収判定。
  // 対象は外の雨によるdrops(isDrip=false)のみ — 拭った跡から垂れる水滴
  // (isDrip=true)は結露(mist)とは無関係な独立したシステムとして扱うため、
  // ここでは一切mistを探しに行かない。
  // mist側からは一切近寄っていかず、対象のdropsだけが探しに行く。大小に関わらず
  // 生き残るのは常にdrops側で、mist側は蒸発しきった時と同じ要領で
  // 別の場所に生まれ変わる(配列の出し入れはしない)。
  {
    let maxDropR = CONFIG.DROP_MAX_R;
    for (const d of drops) {
      if (!d.killed && !d.isDrip && d.r > maxDropR) maxDropR = d.r;
    }
    const cellSize = CONFIG.MERGE_DISTANCE_FACTOR * maxDropR * 2.2;
    const mistGrid = new Map();
    for (const m of mistDrops) {
      const key = `${Math.floor(m.x / cellSize)},${Math.floor(m.y / cellSize)}`;
      let bucket = mistGrid.get(key);
      if (!bucket) {
        bucket = [];
        mistGrid.set(key, bucket);
      }
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

  // 常時一定数を維持する処理は無い。密度の土台はmistが担い、dropsは
  // 雨として降ってくる分・その軌跡・拭った跡の水滴だけで構成される。
  for (let i = drops.length - 1; i >= 0; i--) {
    if (drops[i].killed) drops.splice(i, 1);
  }
}

// 拭った面積に応じて水が溜まっていき、しきい値を超えると水滴として生まれ落ちる。
// 生まれた水滴は他の雨粒と同じ物理(重力・軌跡・合体)に従うが、指の跡を追加で
// 拭うことはしない — instead 落下しながら "isDrip" フラグを見て自らマスクを拭う
// (updateDrops内)。手で拭う操作(splat)だけがこの蓄積に寄与し、水滴自身が
// 落下中に拭うぶんはカウントしない(そうしないと無限に増殖してしまう)。
let dripWetnessAccumulator = 0;
let lastWipeX = 0.5;
let lastWipeY = 0.5;

const EFFECTIVE_DRIP_SPAWN_THRESHOLD = CONFIG.DRIP_SPAWN_THRESHOLD * DENSITY_SCALE;

function spawnDrip(x, y) {
  spawnDrop({
    x: x + (Math.random() - 0.5) * 0.015,
    y: y - 0.004,
    r: CONFIG.DRIP_INITIAL_R * randomRange(0.8, 1.3),
    momentum: CONFIG.DRIP_INITIAL_MOMENTUM * randomRange(0.7, 1.2),
    isDrip: true,
  });
}

function userSplat(x, y, radius, amount) {
  splat(x, y, radius, amount);
  lastWipeX = x;
  lastWipeY = y;
  dripWetnessAccumulator += radius * radius;
  while (dripWetnessAccumulator >= EFFECTIVE_DRIP_SPAWN_THRESHOLD) {
    dripWetnessAccumulator -= EFFECTIVE_DRIP_SPAWN_THRESHOLD;
    spawnDrip(lastWipeX, lastWipeY);
  }
}

const MAX_INSTANCES = EFFECTIVE_MIST_COUNT + EFFECTIVE_DROP_MAX_COUNT;
const dropInstanceData = new Float32Array(MAX_INSTANCES * 4);
const dropInstanceBuffer = gl.createBuffer();

const dropVAO = gl.createVertexArray();
gl.bindVertexArray(dropVAO);
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
gl.bufferData(gl.ARRAY_BUFFER, dropInstanceData.byteLength, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(1, 1);
gl.bindVertexArray(null);

function renderDrops() {
  const aspect = canvas.width / canvas.height;
  let n = 0;

  // mist: 常時画面を覆う静的な小粒。雨の描写トグルに従う
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

  // drops: 重力で落ちる大粒の雨・拭った跡から垂れる水滴
  for (let i = 0; i < drops.length && n < MAX_INSTANCES; i++) {
    const d = drops[i];
    if (d.killed) continue;
    // 「拭った跡から垂れる水滴」は結露の描写、それ以外(外の雨)は雨の描写のトグルに従う
    if (d.isDrip ? !effects.fog : !effects.rain) continue;
    dropInstanceData[n * 4 + 0] = d.x;
    dropInstanceData[n * 4 + 1] = d.y;
    dropInstanceData[n * 4 + 2] = d.r / aspect;
    dropInstanceData[n * 4 + 3] = d.r * d.spreadY;
    n++;
  }

  // パス1: 各水滴のなめらかな距離場(field)を加算ブレンドで蓄積する。
  gl.viewport(0, 0, dropFieldFBO.width, dropFieldFBO.height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, dropFieldFBO.fbo);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (n > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, dropInstanceData.subarray(0, n * 4));

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    useProgram(dropFieldProgram);
    gl.bindVertexArray(dropVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
  }

  // パス2: 蓄積したfieldをしきい値化して、初めて水滴の輪郭・屈折方向が決まる。
  // 合体していない近くの水滴同士も、fieldが重なる場所ではなめらかに繋がる。
  gl.viewport(0, 0, waterMapFBO.width, waterMapFBO.height);
  const u = useProgram(metaballResolveProgram);
  gl.uniform1i(u.uField, dropFieldFBO.attach(0));
  gl.uniform2f(u.uTexelSize, dropFieldFBO.texelSizeX, dropFieldFBO.texelSizeY);
  gl.uniform1f(u.uThreshold, CONFIG.METABALL_THRESHOLD);
  gl.uniform1f(u.uEdgeSoftness, CONFIG.METABALL_EDGE_SOFTNESS);
  blit(waterMapFBO.fbo);
}

// ----------------------------------------------------------------------------
// Autoplay: 手で拭うようなジェスチャーを自動再生してからユーザーに引き継ぐ
// ----------------------------------------------------------------------------
function lerp(a, b, t) {
  return a + (b - a) * t;
}

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

const autoplay = {
  enabled: true,
  strokes: buildHandWipeStrokes(),
  strokeIndex: 0,
  pointIndex: 0,
  progress: 0,
  paused: true,
  pauseTimer: 0.5,
  speed: 130, // points per second
};

function makeFingerCursor() {
  const el = document.createElement("div");
  el.style.cssText = `
    position: fixed; width: 26px; height: 26px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.8), rgba(255,255,255,0) 70%);
    pointer-events: none; transform: translate(-50%, -50%); z-index: 5;
    transition: opacity 0.2s ease; opacity: 0;
  `;
  document.body.appendChild(el);
  return el;
}
const fingerCursor = makeFingerCursor();

function setFingerCursor(clientX, clientY, opacity) {
  fingerCursor.style.opacity = String(opacity);
  fingerCursor.style.left = `${clientX}px`;
  fingerCursor.style.top = `${clientY}px`;
}

function updateAutoplay(dt) {
  if (!autoplay.enabled) return;

  const stroke = autoplay.strokes[autoplay.strokeIndex];
  if (!stroke) {
    autoplay.enabled = false;
    fingerCursor.style.opacity = "0";
    hint.classList.remove("faded");
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
  userSplat(pt.x, pt.y, CONFIG.AUTOPLAY_BRUSH_RADIUS, 1.0);
  setFingerCursor(pt.x * window.innerWidth, (1 - pt.y) * window.innerHeight, 0.9);

  if (autoplay.pointIndex >= stroke.length - 1) {
    autoplay.strokeIndex++;
    autoplay.pointIndex = 0;
    autoplay.progress = 0;
    autoplay.paused = true;
    autoplay.pauseTimer = 0.3;
  }
}

// ----------------------------------------------------------------------------
// Pointer / touch: 自由にガラスを拭う
// ----------------------------------------------------------------------------
const pointerState = { down: false, lastX: 0, lastY: 0 };

function toUV(clientX, clientY) {
  const dpr = canvas.width / window.innerWidth;
  const u = (clientX * dpr) / canvas.width;
  const v = 1 - (clientY * dpr) / canvas.height;
  return { u, v };
}

function stopAutoplayForUser() {
  autoplay.enabled = false;
  hint.classList.add("faded");
}

// 移動距離に応じて一定間隔おきに補間しながらsplatすることで、ドラッグの速さによらず太さを揃える。
const BRUSH_SPACING = CONFIG.USER_BRUSH_RADIUS * 0.5;

function splatAlongSegment(x0, y0, x1, y1, radius, amount) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.round(dist / BRUSH_SPACING));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    userSplat(x0 + dx * t, y0 + dy * t, radius, amount);
  }
}

function handlePointerDown(clientX, clientY) {
  stopAutoplayForUser();
  const { u, v } = toUV(clientX, clientY);
  pointerState.down = true;
  pointerState.lastX = u;
  pointerState.lastY = v;
  userSplat(u, v, CONFIG.USER_BRUSH_RADIUS, 1.0);
  setFingerCursor(clientX, clientY, 1.0);
}

function handlePointerMove(clientX, clientY) {
  if (!autoplay.enabled) {
    setFingerCursor(clientX, clientY, pointerState.down ? 1.0 : 0.55);
  }
  if (!pointerState.down) return;
  const { u, v } = toUV(clientX, clientY);
  splatAlongSegment(pointerState.lastX, pointerState.lastY, u, v, CONFIG.USER_BRUSH_RADIUS, 1.0);
  pointerState.lastX = u;
  pointerState.lastY = v;
}

function handlePointerUp() {
  pointerState.down = false;
}

canvas.addEventListener("pointerdown", (e) => handlePointerDown(e.clientX, e.clientY));
canvas.addEventListener("pointermove", (e) => handlePointerMove(e.clientX, e.clientY));
canvas.addEventListener("pointerleave", () => {
  if (!pointerState.down) fingerCursor.style.opacity = "0";
});
window.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
const startTime = performance.now();
let lastTime = startTime;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  const t = (now - startTime) / 1000;
  lastTime = now;

  try {
    updateAutoplay(dt);
  } catch (err) {
    console.error("Hand-wipe autoplay step failed — disabling, window still renders:", err);
    autoplay.enabled = false;
  }

  try {
    updateMistDrops(dt);
    updateDrops(dt);
    renderDrops();
  } catch (err) {
    console.error("Raindrop simulation step failed — window still renders without rain:", err);
    updateMistDrops = () => {};
    updateDrops = () => {};
    renderDrops = () => {};
  }

  decayMask(dt);
  renderScene();
  renderBlur();
  render(t);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
