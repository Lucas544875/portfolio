// ============================================================================
// マンデルボックスのレイマーチ — プロトタイプ #12
//
// 参考: https://hausdorff-dimension.netlify.app/mandelbox.html
// 参考サイトは6自由度で自由に飛び回れる一方、常にほぼ同じ縮尺で見て回る
// ため「マンデルボックスが実は無限に細かい構造を持つ」という一番大事な
// 性質が体感しづらい。このプロトタイプは自由なフライトを捨て、代わりに
// 「同じ1点へ、対数スケールで一定速度でひたすら潜り続けるカメラ」に絞る
// ことで、その性質を正面から見せることに賭けている。
//
// 【設計の骨子(詳細は README.md)】
//  1. マンデルボックスの距離推定(DE)は、固定回数(ITER)の
//     box-fold → ball-fold → scale+translate という反復で書ける。この
//     反復回数はズーム段数を上げても増やす必要が無い——ズームで見えている
//     微細構造は「反復を増やしてやっと見える」ものではなく、たった同じ
//     ITER 回の反復から返る距離推定値そのものの中に、対象点をどれだけ
//     ピンポイントに指定できるか(=浮動小数点の精度)次第で既に折り畳まれて
//     入っている。つまり計算コストはズーム段数に対して定数(README「計算
//     コストがズーム段数に依存しない理由」参照)。
//  2. 「常に一定」なのは計算コストの方で、実際に無限に見えるわけではない。
//     float32 は目標点 p0(O(1) の座標)から見て相対 1e-6〜1e-7 程度離れた
//     オフセットまでしか安定に解決できない(Node.js で ULP を実測——
//     precision.js 参照)。このプロトタイプは「ズーム開始距離(数単位)から
//     この限界(数万分の一)まで対数的に一定速度で潜り、限界に達したら
//     フェードで次の1点へ移る」を延々と繰り返すことで、有限の精度で
//     「無限に潜り続けている」体感を作る(2重精度や摂動法などの追加コスト
//     は一切使わない——README「なぜ二重精度が要らないか」参照)。
//  3. カメラは常に固定した1本の直線(p0 を通る視線)の上だけを、指数的に
//     縮む距離 dist(t) で前後するだけ(横に振れたりオービットしたりは
//     しない)。これにより ro = p0 - viewDir*dist(t) の唯一の入力
//     dist(t) だけが浮動小数点精度の危険因子になり、扱いが単純になる。
//     ドラッグによる見回しは、この基準方向に対する小さな yaw/pitch の
//     上乗せとして加える(移動そのものには影響しない)。
//  4. サイクルは「広い視点で全体を見せる(overview)→同じ1点へ対数的に
//     潜る(dive)→精度限界でフェードし次の点を JS 側で探して差し替える
//     (fade)」の3段。overview があることで「今どこにいるか」の全体像を
//     必ず提示してから潜るため、参考サイトと違って「今どれだけ拡大した
//     状態を見ているか」を見失わない。
//  5. 潜る先の1点(p0, viewDir)は、JS側に持つ倍精度(number型)の同じ
//     DE をそのままスフィアトレースして毎サイクル選び直す
//     (pickTarget())。GPU側でズームするのと全く同じ数式を CPU 側で
//     1回走らせるだけなので追加コストは無視できる。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");
const fadeOverlay = document.getElementById("fadeOverlay");
const zoomReadout = document.getElementById("zoomReadout");
const zoomBarFill = document.getElementById("zoomBarFill");
const zoomPhaseEl = document.getElementById("zoomPhase");

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

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.55 : 0.85,
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // --- マンデルボックスのパラメータ(README「パラメータの選定」参照) ---
  SCALE: 2.5,
  MINR2: 0.09,
  FIXEDR2: 1.0,
  FOLD: 1.0,
  ITER: 14,
  BOUND_RADIUS: 5.0, // Node.js での実測値(概ね4.6〜5.0、de.js「bounding radius probe」参照)

  // --- レイマーチ ---
  FOCAL: 0.62,
  MAX_STEPS: 180,
  STEP_SAFETY: 0.93,
  SURF_EPS_FACTOR: 0.0012, // 実効イプシロン = uMaxDist * この係数(ズーム段数に依らずスケール不変)
  SURF_EPS_MIN: 1e-8,
  FAR_MULT: 6.0, // uMaxDist = 現在のカメラ距離 * FAR_MULT
  FOG_K: 1.5,

  // --- ズームサイクル ---
  OVERVIEW_DIST: 13.0, // 全体を見渡す距離(BOUND_RADIUSの実測値から逆算、README参照)
  DIST_MIN: 2.5e-5, // float32で安定に解決できる下限(precision.js の実測に基づく。README参照)
  ORBIT_DURATION: 4.0, // 秒。overview フェーズの長さ
  DIVE_DURATION: 24.0, // 秒。dive フェーズの長さ(この間 dist は指数的にDIST_MINまで縮む)
  FADE_DURATION: 1.1, // 秒。次の1点へ切り替える際のフェード

  AUTO_YAW_SPEED: 0.045, // rad/秒。サイクル全体を通した緩やかな自動首振り
  WHEEL_SPEED_MULT_RANGE: [0.35, 3.2],
  WHEEL_SENSITIVITY: 0.0011,
  DRAG_YAW_SENSITIVITY: 0.0042,
  DRAG_PITCH_SENSITIVITY: 0.0042,
  DRAG_YAW_CLAMP: 0.4,
  DRAG_PITCH_CLAMP: 0.4,
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ----------------------------------------------------------------------------
// GLSL float リテラル生成
// ----------------------------------------------------------------------------
function f(x) {
  let s = Number(x).toString();
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

// ----------------------------------------------------------------------------
// JS側 倍精度版マンデルボックス DE(GPU側と全く同じ式)。
// ズーム先の1点(p0, viewDir)をサイクルごとに選ぶためだけに使う
// (README「潜る先の選び方」参照)。GPU側の高速なfloat32反復を
// CPU側でもう一度倍精度でなぞるだけなので、毎サイクル1回・数百ステップ
// 程度のコストは無視できる。
// ----------------------------------------------------------------------------
function jsDE(x0, y0, z0) {
  let x = x0, y = y0, z = z0;
  let dr = 1.0;
  const { SCALE, MINR2, FIXEDR2, FOLD, ITER } = CONFIG;
  for (let n = 0; n < ITER; n++) {
    x = clamp(x, -FOLD, FOLD) * 2 - x;
    y = clamp(y, -FOLD, FOLD) * 2 - y;
    z = clamp(z, -FOLD, FOLD) * 2 - z;
    const r2 = x * x + y * y + z * z;
    if (r2 < MINR2) {
      const t = FIXEDR2 / MINR2;
      x *= t; y *= t; z *= t; dr *= t;
    } else if (r2 < FIXEDR2) {
      const t = FIXEDR2 / r2;
      x *= t; y *= t; z *= t; dr *= t;
    }
    x = x * SCALE + x0;
    y = y * SCALE + y0;
    z = z * SCALE + z0;
    dr = dr * Math.abs(SCALE) + 1.0;
  }
  const r = Math.sqrt(x * x + y * y + z * z);
  return r / Math.abs(dr);
}

function vnormalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function vcross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

function jsRaymarch(ro, rd, maxDist) {
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const d = jsDE(p[0], p[1], p[2]);
    if (d < 1e-5 * Math.max(1, t)) return { hit: true, t, p };
    t += d;
    if (t > maxDist) return { hit: false, t };
  }
  return { hit: false, t };
}

function randomUnitVector() {
  // 棄却法。完全な一様分布である必要は無い(ズーム先の見た目のバリエーションが
  // 出れば十分)ため簡易な実装で済ませている。
  for (let i = 0; i < 20; i++) {
    const v = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const l2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (l2 > 0.05 && l2 <= 1) return vnormalize(v);
  }
  return [0, 1, 0];
}

// フォールバック(乱数探索が万一全滅した場合の既知の有効点。de.js の
// 探索で確認済み)。
const FALLBACK_TARGET = {
  p0: [2.2786, 1.67098, 2.73432],
  viewDir: vnormalize([2.2786 - 3.0, 1.67098 - 2.2, 2.73432 - 3.6]),
};

// 潜る先の1点を選ぶ。probe原点をバウンディング球の外側にランダムに置き、
// ほぼ原点方向(+わずかなジッター)へレイを飛ばして命中点を採用する。
// 命中点ごとに局所的な形状が変わるため、サイクルごとに違う場所へ潜れる。
function pickTarget() {
  const probeR = CONFIG.BOUND_RADIUS * 2.4;
  for (let attempt = 0; attempt < 24; attempt++) {
    const dir0 = randomUnitVector();
    const probeOrigin = vscale(dir0, probeR);
    const jitter = randomUnitVector();
    const aim = vnormalize(vadd(vscale(dir0, -1), vscale(jitter, 0.18)));
    const res = jsRaymarch(probeOrigin, aim, probeR * 2.5);
    if (!res.hit) continue;
    const distFromOrigin = Math.hypot(res.p[0], res.p[1], res.p[2]);
    if (distFromOrigin < CONFIG.BOUND_RADIUS * 0.25 || distFromOrigin > CONFIG.BOUND_RADIUS * 1.4) continue;
    return { p0: res.p, viewDir: aim };
  }
  return FALLBACK_TARGET;
}

// ----------------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------------
const VERT_SRC = `#version 300 es
precision highp float;
const vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uResolution;
uniform vec3 uP;
uniform vec3 uF;
uniform vec3 uR;
uniform vec3 uU;
uniform float uMaxDist; // 現在のカメラ〜目標点距離に比例。イプシロン・フォグをこれ基準にしてスケール不変にする

const float SCALE   = ${f(CONFIG.SCALE)};
const float MINR2   = ${f(CONFIG.MINR2)};
const float FIXEDR2 = ${f(CONFIG.FIXEDR2)};
const float FOLD    = ${f(CONFIG.FOLD)};
const int   ITER    = ${Math.round(CONFIG.ITER)};
const float FOCAL   = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS = ${Math.round(CONFIG.MAX_STEPS)};
const float STEP_SAFETY = ${f(CONFIG.STEP_SAFETY)};
const float SURF_EPS_FACTOR = ${f(CONFIG.SURF_EPS_FACTOR)};
const float SURF_EPS_MIN = ${f(CONFIG.SURF_EPS_MIN)};
const float FOG_K = ${f(CONFIG.FOG_K)};

vec3 skyColor(vec2 uv) {
  vec3 top = vec3(0.02, 0.018, 0.045);
  vec3 bot = vec3(0.045, 0.03, 0.06);
  return mix(bot, top, clamp(uv.y * 0.5 + 0.5, 0.0, 1.0));
}

// マンデルボックスの距離推定(DE)。Rrrola型の box-fold + ball-fold +
// scale+translate を ITER 回繰り返す(README「マンデルボックスのDE」参照)。
// trap には反復中に到達した最小の |z|^2 を記録し、着色にだけ使う——
// この trap はどのズーム段数でも「同じ ITER 回の反復のうちどこで
// 折り畳みが強く効いたか」を表す量なので、対数スケールで潜っても同じ
// ような色の帯が繰り返し現れ、自己相似性を色でも裏付ける(README参照)。
float mapDE(vec3 p, out float trap) {
  vec3 z = p;
  float dr = 1.0;
  trap = 1e9;
  for (int n = 0; n < ITER; n++) {
    z = clamp(z, -FOLD, FOLD) * 2.0 - z;
    float r2 = dot(z, z);
    if (r2 < MINR2) {
      float t = FIXEDR2 / MINR2;
      z *= t; dr *= t;
    } else if (r2 < FIXEDR2) {
      float t = FIXEDR2 / r2;
      z *= t; dr *= t;
    }
    z = z * SCALE + p;
    dr = dr * abs(SCALE) + 1.0;
    trap = min(trap, dot(z, z));
  }
  return length(z) / abs(dr);
}

vec3 calcNormal(vec3 p, float eps) {
  const vec2 k = vec2(1.0, -1.0);
  float t;
  return normalize(
    k.xyy * mapDE(p + k.xyy * eps, t) +
    k.yyx * mapDE(p + k.yyx * eps, t) +
    k.yxy * mapDE(p + k.yxy * eps, t) +
    k.xxx * mapDE(p + k.xxx * eps, t)
  );
}

vec3 shade(vec3 n, vec3 viewDir, float trap) {
  vec3 lightDir = normalize(vec3(0.5, 0.8, 0.35));
  float diff = max(dot(n, lightDir), 0.0);
  float amb = 0.13;
  // trap(最小|z|^2到達値)を可視域へ写像し、深藍〜暖色の色帯として使う。
  float trapT = clamp(sqrt(max(trap, 0.0)) / 1.15, 0.0, 1.0);
  vec3 colA = vec3(0.09, 0.11, 0.20);
  vec3 colB = vec3(0.95, 0.76, 0.46);
  vec3 base = mix(colA, colB, trapT);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  vec3 col = base * (amb + 0.95 * diff) + fres * 0.16 * vec3(0.55, 0.78, 1.0);
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec3 ro = uP;
  vec3 rd = normalize(uv.x * uR + uv.y * uU + FOCAL * uF);

  float surfEps = max(SURF_EPS_MIN, uMaxDist * SURF_EPS_FACTOR);

  float t = 0.0;
  bool hit = false;
  float trapAtHit = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float trapDummy;
    float d = mapDE(p, trapDummy);
    if (d < surfEps) { hit = true; trapAtHit = trapDummy; break; }
    t += d * STEP_SAFETY;
    if (t > uMaxDist) break;
  }

  vec3 fogColor = skyColor(uv);
  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, surfEps * 0.5);
    col = shade(n, -rd, trapAtHit);
  } else {
    col = fogColor;
  }
  float relT = t / uMaxDist;
  float fogAmt = 1.0 - exp(-relT * FOG_K);
  col = mix(col, fogColor, clamp(fogAmt, 0.0, 1.0));
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  outColor = vec4(col, 1.0);
}`;

// ----------------------------------------------------------------------------
// GL setup
// ----------------------------------------------------------------------------
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    console.error(source);
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
  return program;
}

const program = createProgram(VERT_SRC, FRAG_SRC);
const uLoc = {
  resolution: gl.getUniformLocation(program, "uResolution"),
  P: gl.getUniformLocation(program, "uP"),
  F: gl.getUniformLocation(program, "uF"),
  R: gl.getUniformLocation(program, "uR"),
  U: gl.getUniformLocation(program, "uU"),
  maxDist: gl.getUniformLocation(program, "uMaxDist"),
};
const emptyVAO = gl.createVertexArray();

// ----------------------------------------------------------------------------
// Resize
// ----------------------------------------------------------------------------
let fullW = 1, fullH = 1;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  const w = Math.max(2, Math.floor(window.innerWidth * dpr * CONFIG.RENDER_SCALE));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr * CONFIG.RENDER_SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  fullW = w;
  fullH = h;
  gl.viewport(0, 0, fullW, fullH);
}
window.addEventListener("resize", resize);
resize();

// ----------------------------------------------------------------------------
// カメラ: p0 を通る1本の視線の上を、指数的に縮む距離 dist(t) だけ前後する。
// yaw/pitch(自動ドリフト+ドラッグ)は、この基準方向に対する小さな首振り
// として最後に上乗せする(README「カメラ」参照)。
// ----------------------------------------------------------------------------
function buildCameraFrame(p0, viewDir, dist, yaw, pitch) {
  const F0 = viewDir;
  const worldUp = Math.abs(F0[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const R0 = vnormalize(vcross(F0, worldUp));
  const U0 = vcross(R0, F0);

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Fy = vadd(vscale(F0, cy), vscale(R0, sy));
  const Ry = vadd(vscale(F0, -sy), vscale(R0, cy));

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Fp = vadd(vscale(Fy, cp), vscale(U0, sp));
  const Up = vadd(vscale(Fy, -sp), vscale(U0, cp));

  const P = vadd(p0, vscale(F0, -dist));
  return { P, F: Fp, R: Ry, U: Up };
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------
let autoYaw = 0;
let dragYaw = 0, dragPitch = 0;
let speedMult = 1.0;

let userEngaged = false;
function engage() {
  if (!userEngaged) {
    userEngaged = true;
    hint.classList.add("faded");
  }
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  engage();
  speedMult = clamp(
    speedMult * Math.exp(-e.deltaY * CONFIG.WHEEL_SENSITIVITY),
    CONFIG.WHEEL_SPEED_MULT_RANGE[0],
    CONFIG.WHEEL_SPEED_MULT_RANGE[1]
  );
}, { passive: false });

let dragging = false;
let lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  engage();
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  dragYaw = clamp(dragYaw + dx * CONFIG.DRAG_YAW_SENSITIVITY, -CONFIG.DRAG_YAW_CLAMP, CONFIG.DRAG_YAW_CLAMP);
  dragPitch = clamp(dragPitch - dy * CONFIG.DRAG_PITCH_SENSITIVITY, -CONFIG.DRAG_PITCH_CLAMP, CONFIG.DRAG_PITCH_CLAMP);
});
function endDrag() { dragging = false; }
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

setTimeout(() => { if (!userEngaged) hint.classList.add("faded"); }, 7000);

// ----------------------------------------------------------------------------
// ズームサイクルの状態機械(README「3段のサイクル」参照)
// ----------------------------------------------------------------------------
let target = pickTarget();
let cycleT = 0;
let phase = "overview"; // "overview" | "dive" | "fade"
let fadeT = 0;
let fadeAlpha = 0;
let pickedNewThisFade = false;

function currentDist(t) {
  if (t <= CONFIG.ORBIT_DURATION) return CONFIG.OVERVIEW_DIST;
  const u = clamp((t - CONFIG.ORBIT_DURATION) / CONFIG.DIVE_DURATION, 0, 1);
  return CONFIG.OVERVIEW_DIST * Math.pow(CONFIG.DIST_MIN / CONFIG.OVERVIEW_DIST, u);
}

function updateCycle(dt) {
  if (phase === "fade") {
    fadeT += dt;
    const half = CONFIG.FADE_DURATION * 0.5;
    if (fadeT < half) {
      fadeAlpha = fadeT / half;
    } else if (fadeT < CONFIG.FADE_DURATION) {
      if (!pickedNewThisFade) {
        target = pickTarget();
        cycleT = 0;
        pickedNewThisFade = true;
      }
      fadeAlpha = 1 - (fadeT - half) / half;
    } else {
      phase = "overview";
      fadeAlpha = 0;
      fadeT = 0;
      pickedNewThisFade = false;
    }
  } else {
    cycleT += dt * speedMult;
    if (cycleT > CONFIG.ORBIT_DURATION + CONFIG.DIVE_DURATION) {
      phase = "fade";
      fadeT = 0;
      fadeAlpha = 0;
      pickedNewThisFade = false;
    } else {
      phase = cycleT <= CONFIG.ORBIT_DURATION ? "overview" : "dive";
    }
  }
  autoYaw += CONFIG.AUTO_YAW_SPEED * dt;
}

function updateHUD(dist) {
  const zoomFactor = CONFIG.OVERVIEW_DIST / dist;
  const zoomExp = Math.log10(Math.max(zoomFactor, 1));
  zoomReadout.textContent = `10^${zoomExp.toFixed(2)}×`;
  const maxExp = Math.log10(CONFIG.OVERVIEW_DIST / CONFIG.DIST_MIN);
  zoomBarFill.style.width = `${clamp((zoomExp / maxExp) * 100, 0, 100)}%`;
  zoomPhaseEl.textContent =
    phase === "overview" ? "全体像を確認中…" :
    phase === "fade" ? "次のポイントへ移動中…" :
    "同じ地点へズームイン中…";
  fadeOverlay.style.opacity = fadeAlpha.toFixed(3);
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let lastTime = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  try {
    updateCycle(dt);
    const dist = currentDist(cycleT);
    const yaw = autoYaw + dragYaw;
    const pitch = dragPitch;
    const cam = buildCameraFrame(target.p0, target.viewDir, dist, yaw, pitch);
    const maxDist = dist * CONFIG.FAR_MULT;

    gl.useProgram(program);
    gl.bindVertexArray(emptyVAO);
    gl.uniform2f(uLoc.resolution, fullW, fullH);
    gl.uniform3fv(uLoc.P, cam.P);
    gl.uniform3fv(uLoc.F, cam.F);
    gl.uniform3fv(uLoc.R, cam.R);
    gl.uniform3fv(uLoc.U, cam.U);
    gl.uniform1f(uLoc.maxDist, maxDist);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    updateHUD(dist);
  } catch (err) {
    console.error(err);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
