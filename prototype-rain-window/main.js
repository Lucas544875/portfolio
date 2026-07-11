// ============================================================================
// 雨の中の窓 — 結露プロトタイプ #2
//
// - 夜景をプロシージャルに生成し、ブラー版とシャープ版を用意
// - 「拭いたマスク」だけ shaper(シャープ)な夜景が見え、それ以外はブラー(曇り)
// - マスクは時間とともにゆっくり減衰 = 水蒸気で再びガラスが曇っていく
// - 雨粒は個々に物理シミュレーション(重力で加速して落下・軌跡として小さな滴を
//   残す・近くの滴と衝突して合体)し、それぞれが背景を屈折させるレンズとして働く。
//   tympanus.net/Development/RainEffect と webgl.souhonzan.org の実装を参考に、
//   同じアプローチ(水滴ごとの法線マップ的な屈折 + 合成)を自前のプロシージャル
//   シェーダーで再構築している(アセット・コードのコピーはしていない)
// - ページを開くと、手で拭うようなジェスチャーを自動再生してから
//   ユーザーのドラッグ操作に引き継ぐ(プロトタイプ#1の「なぞり」と同じ手法)
//
// 外部アセット読み込み無し(完全プロシージャル)。レンダーターゲットは
// すべて UNSIGNED_BYTE / RGBA8 のみ使用し、float レンダーターゲットの
// 互換性問題(プロトタイプ#1で発生)を最初から回避している。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

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
  MASK_LINEAR_FADE_PER_SEC: 0.05, // 実時間ベースで蓄積し、8bit量子化ステップを跨いだ時だけ反映する
  // 半径は実際のUV空間半径(円の境界そのもの)。旧ガウシアン分布と見た目の
  // 太さを揃えた上でさらに半分にしている。
  AUTOPLAY_BRUSH_RADIUS: 0.036,
  USER_BRUSH_RADIUS: 0.0408, // ドラッグもクリックと同じ値を使う
  BLUR_ITERATIONS: 3,
  BLUR_PIXEL_RADIUS: 1.6,

  // 雨粒シミュレーション(物理ベース、tympanus/souhonzanのレンズ屈折方式を参考)
  WATER_RESOLUTION: 1000,
  DROP_MAX_COUNT: 420,
  DROP_AMBIENT_MIN: 150, // 常時維持する(主に静止した)水滴の最低数
  DROP_MIN_R: 0.0055, // UV空間(画面高さ基準)での最小半径
  DROP_MAX_R: 0.020,
  RAIN_SPAWN_PER_SEC: 20, // 新しい雨粒が上から降ってくる頻度
  TRAIL_RATE: 2.2, // 落下中に軌跡の滴を残す頻度
  MERGE_DISTANCE_FACTOR: 0.9, // 近くの滴同士が合体する距離のしきい値
  REFRACTION_STRENGTH: 0.045,
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
  uniform float uTime;
  uniform vec2 uResolution;
  out vec4 fragColor;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec2 hash22(vec2 p) {
    return vec2(hash21(p), hash21(p + 17.17));
  }

  void main () {
    vec2 uv = vUv;
    float aspect = uResolution.x / uResolution.y;

    vec3 skyTop = vec3(0.015, 0.02, 0.05);
    vec3 skyHorizon = vec3(0.09, 0.06, 0.10);
    vec3 sky = mix(skyHorizon, skyTop, smoothstep(0.0, 0.85, uv.y));

    float starField = hash21(floor(uv * vec2(400.0, 300.0)));
    float stars = step(0.996, starField) * smoothstep(0.35, 1.0, uv.y);
    sky += stars * vec3(0.8, 0.85, 0.95);

    vec3 bokeh = vec3(0.0);
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      vec2 seed = vec2(fi * 13.7, fi * 7.3);
      vec2 pos = hash22(seed);
      pos.y *= 0.55;
      vec2 d = uv - pos;
      d.x *= aspect;
      float r = mix(0.012, 0.05, hash21(seed + 3.1));
      float glow = smoothstep(r, 0.0, length(d));
      float flicker = 0.75 + 0.25 * sin(uTime * mix(0.6, 1.8, hash21(seed + 9.0)) + fi * 3.0);
      vec3 warmCool = mix(vec3(1.0, 0.75, 0.4), vec3(0.55, 0.75, 1.0), hash21(seed + 5.0));
      bokeh += warmCool * glow * flicker * 0.9;
    }

    float bx = uv.x * 22.0;
    float col = floor(bx);
    float bh = 0.10 + hash21(vec2(col, 1.0)) * 0.30;
    float building = step(uv.y, bh);

    vec2 wCell = vec2(floor(bx * 6.0), floor(uv.y / 0.028));
    float wx = fract(bx * 6.0);
    float wy = fract(uv.y / 0.028);
    float isWindowSlot = step(0.18, wx) * step(wx, 0.82) * step(0.15, wy) * step(wy, 0.85);
    float lit = step(0.55, hash21(wCell + col));
    float winFlicker = 0.85 + 0.15 * sin(uTime * 0.7 + hash21(wCell) * 40.0);
    vec3 windowColor = mix(vec3(1.0, 0.78, 0.42), vec3(0.6, 0.8, 1.0), hash21(wCell + col + 8.0) * 0.3);
    vec3 windows = windowColor * isWindowSlot * lit * winFlicker;

    vec3 buildingColor = vec3(0.008, 0.01, 0.018) + windows;
    vec3 color = mix(sky + bokeh, buildingColor, building);

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
// フラグメントシェーダー側で円形のSDFから疑似的な球面レンズの法線・厚みを
// 計算し、水滴マップ(R=屈折X, G=屈折Y, B=厚み, A=アルファ)に書き込む。
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

const dropFragmentShader = `#version 300 es
  precision highp float;
  in vec2 vLocal;
  out vec4 fragColor;
  void main () {
    float d = length(vLocal);
    if (d > 1.0) discard;
    float nz = sqrt(max(0.0, 1.0 - d * d));
    vec2 refraction = vLocal * (1.0 - nz);
    float thickness = nz;
    float alpha = smoothstep(1.0, 0.8, d);
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

    // 曇り(拭いたマスク)による、シャープ⇔ブラーのブレンド
    vec3 composite = mix(blurred, sharp, smoothstep(0.05, 0.85, mask));

    // 個々の水滴は、曇っていても外側のガラスにあるので常に奥がシャープに見える
    // 小さなレンズとして、屈折させたシャープな景色を上から乗せる
    vec3 dropColor = texture(uScene, refractedUv).rgb * (0.82 + thickness * 0.4);
    composite = mix(composite, dropColor, dropAlpha * 0.92);

    float vig = smoothstep(1.15, 0.3, length(uv - 0.5) * 1.35);
    composite *= mix(0.55, 1.0, vig);

    fragColor = vec4(composite, 1.0);
  }
`;

const sceneProgram = createProgram(baseVertexShader, sceneShader);
const blurProgram = createProgram(baseVertexShader, blurShader);
const splatProgram = createProgram(baseVertexShader, splatShader);
const decayProgram = createProgram(baseVertexShader, decayShader);
const displayProgram = createProgram(baseVertexShader, displayShader);
const dropProgram = createProgram(dropVertexShader, dropFragmentShader);

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

let sceneFBO, blurTempFBO, blurredSceneFBO, mask, waterMapFBO;

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

window.addEventListener("resize", () => {
  if (resizeCanvas()) initFramebuffers();
});

// ----------------------------------------------------------------------------
// Passes
// ----------------------------------------------------------------------------
function renderScene(t) {
  gl.viewport(0, 0, sceneFBO.width, sceneFBO.height);
  const u = useProgram(sceneProgram);
  gl.uniform1f(u.uTime, t);
  gl.uniform2f(u.uResolution, sceneFBO.width, sceneFBO.height);
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
  blit(null);
}

// ----------------------------------------------------------------------------
// 雨粒シミュレーション
//
// tympanus.net/Development/RainEffect (Lucas Bebber / Codrops) と
// webgl.souhonzan.org の実装から、次のアプローチを参考にした自前の実装:
//   - 個々の水滴は重力に相当する momentum を持ち、大きいほど加速しやすい
//   - 落下中は軌跡として、小さく縮小した子滴を後ろに残す
//   - 近くの水滴同士がある距離まで近づくと合体する(メタボール的な見た目)
//   - 各水滴は円形SDFから疑似球面レンズの法線と厚みを計算し、
//     水滴マップ(RG=屈折方向, B=厚み, A=アルファ)にインスタンス描画で書き込む
// 画像アセットやコードそのものはコピーしておらず、アルゴリズムの設計のみ参考にしている。
// ----------------------------------------------------------------------------
function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function cubicBiasedRadius(min, max) {
  return min + Math.pow(Math.random(), 3) * (max - min);
}

const drops = [];
let nextDropId = 1;

function spawnDrop({ x, y, r, momentum = 0, momentumX = 0, parentId = null }) {
  if (drops.length >= CONFIG.DROP_MAX_COUNT) return null;
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
    killed: false,
  };
  drops.push(drop);
  return drop;
}

function seedInitialDrops() {
  for (let i = 0; i < CONFIG.DROP_AMBIENT_MIN; i++) {
    spawnDrop({
      x: Math.random(),
      y: Math.random(),
      r: randomRange(CONFIG.DROP_MIN_R, CONFIG.DROP_MIN_R * 2.2),
    });
  }
}
seedInitialDrops();

let rainSpawnAccumulator = 0;

function updateDrops(dt) {
  rainSpawnAccumulator += dt * CONFIG.RAIN_SPAWN_PER_SEC;
  while (rainSpawnAccumulator >= 1) {
    rainSpawnAccumulator -= 1;
    const r = cubicBiasedRadius(CONFIG.DROP_MIN_R, CONFIG.DROP_MAX_R);
    spawnDrop({
      x: Math.random(),
      y: 1.02 + Math.random() * 0.04,
      r,
      momentum: 0.09 + (r / CONFIG.DROP_MAX_R) * 0.22 + Math.random() * 0.06,
    });
  }

  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    if (d.killed) continue;

    const gainChance = Math.max(0, d.r - CONFIG.DROP_MIN_R * 0.6) * 3.0 * dt;
    if (Math.random() < gainChance) {
      d.momentum += Math.random() * (d.r / CONFIG.DROP_MAX_R) * 1.6;
    }

    if (d.momentum > 0.008) {
      d.lastSpawn += d.momentum * dt * CONFIG.TRAIL_RATE;
      if (d.lastSpawn > d.nextSpawn) {
        spawnDrop({
          x: d.x + (Math.random() - 0.5) * d.r * 0.4,
          y: d.y + d.r * 0.3,
          r: d.r * randomRange(0.25, 0.45),
          parentId: d.id,
        });
        d.r *= 0.985;
        d.lastSpawn = 0;
        d.nextSpawn = randomRange(0.02, 0.06);
      }
    } else if (Math.random() < 0.02 * dt * 60) {
      d.shrink = randomRange(0.0006, 0.002);
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
      d.spreadY = 1.0 + Math.min(2.2, d.momentum * 6.0);
      if (d.y < -0.06) {
        d.killed = true;
        continue;
      }
    }

    d.momentum -= Math.max(0.02, d.momentum * 0.6) * dt;
    if (d.momentum < 0) d.momentum = 0;
    d.momentumX *= Math.pow(0.6, dt * 60);
  }

  // 近くの水滴との簡易な合体判定(配列内で近い順に並んでいる前提はしないため
  // 数個先までの総当たりで十分な見た目のメタボール的マージを再現する)
  for (let i = 0; i < drops.length; i++) {
    const a = drops[i];
    if (a.killed) continue;
    for (let k = 1; k <= 6 && i + k < drops.length; k++) {
      const b = drops[i + k];
      if (b.killed) continue;
      if (a.parentId === b.id || b.parentId === a.id) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const rSum = (a.r + b.r) * CONFIG.MERGE_DISTANCE_FACTOR;
      if (dx * dx + dy * dy < rSum * rSum) {
        const big = a.r >= b.r ? a : b;
        const small = a.r >= b.r ? b : a;
        big.r = Math.min(CONFIG.DROP_MAX_R * 1.4, Math.sqrt(big.r * big.r + small.r * small.r * 0.8));
        big.momentum = Math.max(big.momentum, small.momentum, Math.min(0.6, big.momentum + 0.05));
        small.killed = true;
      }
    }
  }

  for (let i = drops.length - 1; i >= 0; i--) {
    if (drops[i].killed) drops.splice(i, 1);
  }
  while (drops.length < CONFIG.DROP_AMBIENT_MIN) {
    spawnDrop({
      x: Math.random(),
      y: Math.random(),
      r: randomRange(CONFIG.DROP_MIN_R, CONFIG.DROP_MIN_R * 2),
    });
  }
}

const dropInstanceData = new Float32Array(CONFIG.DROP_MAX_COUNT * 4);
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
  for (let i = 0; i < drops.length && n < CONFIG.DROP_MAX_COUNT; i++) {
    const d = drops[i];
    if (d.killed) continue;
    dropInstanceData[n * 4 + 0] = d.x;
    dropInstanceData[n * 4 + 1] = d.y;
    dropInstanceData[n * 4 + 2] = d.r / aspect;
    dropInstanceData[n * 4 + 3] = d.r * d.spreadY;
    n++;
  }

  gl.viewport(0, 0, waterMapFBO.width, waterMapFBO.height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, waterMapFBO.fbo);
  gl.clearColor(0.5, 0.5, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (n > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, dropInstanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, dropInstanceData.subarray(0, n * 4));

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);

    useProgram(dropProgram);
    gl.bindVertexArray(dropVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }
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
  splat(pt.x, pt.y, CONFIG.AUTOPLAY_BRUSH_RADIUS, 1.0);
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

// ドラッグ中に pointermove のたびに無条件でsplatすると、ゆっくり動かした時に
// 同じような場所へ何度も重ね塗りしてしまい、単発クリックより実質的に太い
// ストロークになってしまう(滲みが加算されるため)。移動距離に応じて一定間隔
// おきに補間しながらsplatすることで、ドラッグの速さによらず太さを揃える。
const BRUSH_SPACING = CONFIG.USER_BRUSH_RADIUS * 0.5;

function splatAlongSegment(x0, y0, x1, y1, radius, amount) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.round(dist / BRUSH_SPACING));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    splat(x0 + dx * t, y0 + dy * t, radius, amount);
  }
}

function handlePointerDown(clientX, clientY) {
  stopAutoplayForUser();
  const { u, v } = toUV(clientX, clientY);
  pointerState.down = true;
  pointerState.lastX = u;
  pointerState.lastY = v;
  splat(u, v, CONFIG.USER_BRUSH_RADIUS, 1.0);
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
    updateDrops(dt);
    renderDrops();
  } catch (err) {
    console.error("Raindrop simulation step failed — window still renders without rain:", err);
    updateDrops = () => {};
    renderDrops = () => {};
  }

  decayMask(dt);
  renderScene(t);
  renderBlur();
  render(t);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
