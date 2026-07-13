// ============================================================================
// 強制遠近法 — プロトタイプ #5
//
// エイムズの部屋(Ames room)系の「強制遠近法(forced perspective)」の錯視。
// ある1点の "スイートスポット" カメラから見ると、本当は大きさも距離もまったく
// 違う複数の球が「同じ大きさで横一列に並んでいる」ように見える。カメラが
// その1点から離れる(自動再生 or ドラッグ/スクロール)と、普通の遠近法が
// 効きはじめて、本当の大きさと奥行きの差が露わになり、錯視が崩れる。
//
// ── 錯視の数学(このプロトタイプの全て。ここだけは厳密に正しくないと成立しない) ──
//
//   スイートスポットのカメラを原点に置き、前方 forward = (0,0,-1) を見る。
//   物体 i の中心をカメラからの「真の(ユークリッド)距離」d_i の位置、
//   前方から水平角 α_i の方向に置く:
//       center_i = d_i * (sin α_i, 0, -cos α_i)      … |center_i| = d_i(単位方向×距離)
//   半径 r_i の球がカメラに張る "見かけの角半径" は
//       apparentRadius_i = asin(r_i / d_i)
//   したがって r_i / d_i を全物体で同じ定数 k にすれば、d_i がどれだけ違っても
//   見かけの大きさ(角半径)は完全に一致する。これが錯視の定義そのもの。
//   水平方向の見かけの位置は α_i だけで決まる(d_i に依存しない)ので、
//   α_i を等間隔にすれば「同じ大きさの球が等間隔で横に並ぶ」画になる。
//
//   本プロトタイプでは k = RATIO = 0.1 に固定:
//       物体A: d=3,  r=0.3   → r/d = 0.1
//       物体B: d=9,  r=0.9   → r/d = 0.1
//       物体C: d=27, r=2.7   → r/d = 0.1
//       物体D: d=81, r=8.1   → r/d = 0.1
//   → 見かけの角半径はどれも asin(0.1) ≈ 5.739°(直径 ≈ 11.48°)で完全に等しい。
//     一方で実寸は 0.3 対 8.1(27倍)、距離は 3 対 81(27倍)と極端に違う。
//
//   水平角は α = [-24°, -8°, +8°, +24°](16°等間隔)。見かけの直径が 11.48° なので
//   隣り合う球の隙間は 16 - 11.48 = 4.52°。スクリーン上で重ならない=手前の球が
//   奥の球を隠さない(奥行きが違っても遮蔽が起きない)。
//
//   ※ カメラが動いても物体の位置・スケールは一切変えない。種明かしは
//     「スイートスポットでだけ見かけが一致する」という正直な透視投影の帰結として
//     のみ起こる(物体側は何も細工しない)。
//
// ── 描画方式 ──
//   4つの球のSDF(符号付き距離関数)をフラグメントシェーダでレイマーチする。
//   球は解析的な完全球なので法線 = normalize(hit - center) が正確に求まり、
//   「見かけの大きさ」の錯視の検証に余計な近似が入らない。背景は暗い
//   グラデーションのみ(床グリッド等の奥行き手がかりを置かないことで、
//   スイートスポットでの錯視を最大限に保つ。手がかりは動かした時の視差だけ)。
//   各球は識別しやすいよう別々の色にしている(「青い球が実は巨大で遠い」と
//   崩れる瞬間に追跡できるようにするため。材質のリアルさより可読性を優先)。
//
//   カメラは注視点 target=(0,0,-9) の周りをオービットする。yaw=pitch=0 のとき
//   カメラ位置はちょうど原点(スイートスポット)に来る。プロトタイプ#1〜#4と
//   同じ「自動再生 → ユーザー操作へハンドオフ」の設計。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: true,
  depth: false, // フルスクリーンのレイマーチのみ。深度バッファは使わない
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 is not supported.");
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// 錯視のパラメータ表(構成の全て)。r_i と center_i は d_i と α_i から導出する
// ので、比率 r/d が全物体で一致していることがコード上でも自明になる。
// ----------------------------------------------------------------------------
const RATIO = 0.1; // k = r_i / d_i。見かけの角半径 = asin(k) ≈ 5.739° を全物体で共有

// name, d(カメラからの真の距離), alphaDeg(水平方向の見かけ角), color(識別用のリニア色)
const OBJECT_TABLE = [
  { name: "A", d: 3, alphaDeg: -24, color: [1.0, 0.55, 0.28] }, // 小さくて近い(実半径 0.3)/ 琥珀
  { name: "B", d: 9, alphaDeg: -8, color: [0.35, 0.85, 0.95] }, // 中(実半径 0.9)/ シアン
  { name: "C", d: 27, alphaDeg: 8, color: [0.55, 0.95, 0.55] }, // 大(実半径 2.7)/ 若草
  { name: "D", d: 81, alphaDeg: 24, color: [0.85, 0.5, 0.95] }, // 巨大で遠い(実半径 8.1)/ 藤
];

// d_i と α_i から r_i(= RATIO*d_i)と中心座標(= d_i * 単位方向ベクトル)を導出。
// 単位方向 × 距離 d_i なので |center_i| は厳密に d_i に一致し、
// 見かけの角半径 asin(r_i / |center_i|) = asin(RATIO) が全物体で完全に等しくなる。
const OBJECTS = OBJECT_TABLE.map((o) => {
  const a = (o.alphaDeg * Math.PI) / 180;
  const r = RATIO * o.d;
  const center = [Math.sin(a) * o.d, 0, -Math.cos(a) * o.d];
  return { ...o, r, center };
});

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.7 : 1.0,
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,
  MAX_STEPS: isCoarsePointer ? 96 : 160,
  MAX_DIST: 260.0, // 物体Dはカメラから最大 ~90 程度先。余裕を持たせる
  SURF_EPS: 0.0008,

  // レイ構成: rd = normalize(forward*FOV + right*uv.x + up*uv.y)、uv.y∈[-1,1]。
  // 垂直半画角 = atan(1/FOV)。FOV を上げるほどズームイン。
  // 見かけの水平位置 ux = FOV * tan(α) なので、モバイル(縦長・aspect小)では
  // FOV を下げて全物体を画面内に収める(錯視の比率自体は FOV に依存しない)。
  FOV: isCoarsePointer ? 0.95 : 1.7,

  // カメラのオービット(注視点 target の周り)。yaw=pitch=0・dist=CAM_DIST で
  // カメラ位置 = 原点 = スイートスポットに来るよう target と CAM_DIST を選ぶ。
  TARGET: [0, 0, -9],
  CAM_DIST: 9.0, // |target - 原点| = 9

  // 自動再生: 最初 HOLD 秒はスイートスポットで静止(第一印象=同じ大きさの列)。
  // その後 yaw を振り子のように振って錯視を崩す→戻すを繰り返す。
  AUTOPLAY_HOLD: 2.6,
  AUTOPLAY_YAW_AMP: 0.62, // ≈ 35.5°。これだけ振れば錯視は完全に崩れる
  AUTOPLAY_YAW_SPEED: 0.32,
  AUTOPLAY_PITCH_AMP: 0.14,
  AUTOPLAY_PITCH_SPEED: 0.21,

  DRAG_YAW_SENSITIVITY: 0.007,
  DRAG_PITCH_SENSITIVITY: 0.007,
  PITCH_LIMIT: 1.2,

  WHEEL_SENSITIVITY: 0.02, // スクロールで dolly(注視点からの距離を変える)
  DIST_MIN: 9.0, // スイートスポットより近づけない(ここが錯視の一致点)
  DIST_MAX: 60.0,
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
    // 配列ユニフォームは "uName[0]" という名前で1個返る。角括弧を落として保持
    const base = info.name.replace(/\[0\]$/, "");
    uniforms[base] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

function useProgram(p) {
  gl.useProgram(p.program);
  return p.uniforms;
}

// ----------------------------------------------------------------------------
// シェーダ
// ----------------------------------------------------------------------------
const vertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main () {
  vUv = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const N = OBJECTS.length;

const fragmentShaderSource = `#version 300 es
precision highp float;

#define N ${N}

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uFov;
uniform float uMaxDist;
uniform int uMaxSteps;
uniform float uSurfEps;

uniform vec3 uCenters[N];
uniform float uRadii[N];
uniform vec3 uColors[N];

// 背景: 暗い縦方向グラデーション + わずかな星。奥行きの手がかりになる
// 床やグリッドはあえて置かない(スイートスポットでの錯視を保つため)。
vec3 background (vec3 rd) {
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.02, 0.03, 0.05), vec3(0.06, 0.08, 0.13), t);
  // 上方向にほんのり明るいグロー
  col += vec3(0.05, 0.06, 0.09) * pow(clamp(rd.y, 0.0, 1.0), 2.0);
  // まばらな星
  vec2 uv = rd.xy / (abs(rd.z) + 0.6);
  vec2 id = floor(uv * 42.0);
  vec2 f = fract(uv * 42.0) - 0.5;
  float h = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
  float star = smoothstep(0.06, 0.0, length(f)) * step(0.985, h);
  col += star * vec3(0.7, 0.75, 0.85);
  return col;
}

// シーンSDF: 4つの球のunion。id にどの球かを返す。
float mapScene (vec3 p, out int id) {
  float best = 1e9;
  id = -1;
  for (int i = 0; i < N; i++) {
    float d = length(p - uCenters[i]) - uRadii[i];
    if (d < best) { best = d; id = i; }
  }
  return best;
}

void main () {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  // カメラ基底からピクセルごとのレイ方向を作る(スイートスポットの透視投影)。
  // FOV は「同じ角度=同じ見かけの大きさ」の比率には影響せず、画面上の
  // 拡大率(ズーム)だけを決める。
  vec3 ro = uEye;
  vec3 rd = normalize(uForward * uFov + uRight * uv.x + uUp * uv.y);

  // sphere tracing
  float t = 0.0;
  int hitId = -1;
  for (int s = 0; s < 256; s++) {
    if (s >= uMaxSteps) break;
    vec3 p = ro + rd * t;
    int id;
    float d = mapScene(p, id);
    if (d < uSurfEps) { hitId = id; break; }
    t += d;
    if (t > uMaxDist) break;
  }

  vec3 col;
  if (hitId >= 0) {
    vec3 p = ro + rd * t;
    // 完全球なので法線は解析的に厳密
    vec3 n = normalize(p - uCenters[hitId]);
    vec3 base = uColors[hitId];

    vec3 viewDir = normalize(uEye - p);
    vec3 keyDir = normalize(vec3(0.4, 0.75, 0.35));

    float diff = clamp(dot(n, keyDir), 0.0, 1.0);
    float amb = 0.28;
    // フレネル的なリム(球のシルエット際を明るく=球体感)
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    // スペキュラのハイライト
    vec3 h = normalize(keyDir + viewDir);
    float spec = pow(clamp(dot(n, h), 0.0, 1.0), 48.0);

    col = base * (amb + diff * 0.85);
    col += vec3(1.0) * spec * 0.5;
    col += base * fres * 0.6 + vec3(0.15, 0.18, 0.22) * fres;
  } else {
    col = background(rd);
  }

  // 軽いビネット
  vec2 ndc = vUv;
  float vig = smoothstep(1.25, 0.35, length(vec2(ndc.x * aspect, ndc.y)));
  col *= mix(0.78, 1.0, vig);

  // トーンマップ + ガンマ
  col = col / (col + vec3(1.0));
  col = pow(col, vec3(1.0 / 2.2));

  fragColor = vec4(col, 1.0);
}
`;

const program = createProgram(vertexShaderSource, fragmentShaderSource);

// フルスクリーンquad
const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// 球データをフラットな Float32Array にしてまとめて送る
const centersFlat = new Float32Array(N * 3);
const radiiFlat = new Float32Array(N);
const colorsFlat = new Float32Array(N * 3);
OBJECTS.forEach((o, i) => {
  centersFlat[i * 3 + 0] = o.center[0];
  centersFlat[i * 3 + 1] = o.center[1];
  centersFlat[i * 3 + 2] = o.center[2];
  radiiFlat[i] = o.r;
  colorsFlat[i * 3 + 0] = o.color[0];
  colorsFlat[i * 3 + 1] = o.color[1];
  colorsFlat[i * 3 + 2] = o.color[2];
});

// ----------------------------------------------------------------------------
// Resize
// ----------------------------------------------------------------------------
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  const w = Math.max(1, Math.round(window.innerWidth * dpr * CONFIG.RENDER_SCALE));
  const h = Math.max(1, Math.round(window.innerHeight * dpr * CONFIG.RENDER_SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ----------------------------------------------------------------------------
// Camera: 自動再生 → ドラッグ/スクロールでのハンドオフ
// yaw=pitch=0, dist=CAM_DIST でカメラ位置がスイートスポット(原点)になる。
// ----------------------------------------------------------------------------
const camera = { yaw: 0, pitch: 0, dist: CONFIG.CAM_DIST };
const autoplay = { enabled: true };

function updateAutoplay(t) {
  if (!autoplay.enabled) return;
  const e = t - CONFIG.AUTOPLAY_HOLD;
  if (e <= 0) {
    // 第一印象: スイートスポットで静止(同じ大きさの列に見える)
    camera.yaw = 0;
    camera.pitch = 0;
    return;
  }
  // 振り子。yaw は 0 を通過し続ける=錯視の成立と崩壊を繰り返し見せる
  camera.yaw = CONFIG.AUTOPLAY_YAW_AMP * Math.sin(e * CONFIG.AUTOPLAY_YAW_SPEED);
  camera.pitch = CONFIG.AUTOPLAY_PITCH_AMP * Math.sin(e * CONFIG.AUTOPLAY_PITCH_SPEED);
}

function stopAutoplayForUser() {
  if (!autoplay.enabled) return;
  autoplay.enabled = false;
  hint.classList.add("faded");
}

const pointerState = { down: false, lastX: 0, lastY: 0 };

function handlePointerDown(clientX, clientY) {
  stopAutoplayForUser();
  pointerState.down = true;
  pointerState.lastX = clientX;
  pointerState.lastY = clientY;
}

function handlePointerMove(clientX, clientY) {
  if (!pointerState.down) return;
  const dx = clientX - pointerState.lastX;
  const dy = clientY - pointerState.lastY;
  pointerState.lastX = clientX;
  pointerState.lastY = clientY;
  camera.yaw -= dx * CONFIG.DRAG_YAW_SENSITIVITY;
  camera.pitch = Math.min(
    CONFIG.PITCH_LIMIT,
    Math.max(-CONFIG.PITCH_LIMIT, camera.pitch + dy * CONFIG.DRAG_PITCH_SENSITIVITY)
  );
}

function handlePointerUp() {
  pointerState.down = false;
}

canvas.addEventListener("pointerdown", (e) => handlePointerDown(e.clientX, e.clientY));
canvas.addEventListener("pointermove", (e) => handlePointerMove(e.clientX, e.clientY));
canvas.addEventListener("pointerleave", handlePointerUp);
window.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    stopAutoplayForUser();
    camera.dist = Math.min(
      CONFIG.DIST_MAX,
      Math.max(CONFIG.DIST_MIN, camera.dist + e.deltaY * CONFIG.WHEEL_SENSITIVITY)
    );
  },
  { passive: false }
);
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
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const startTime = performance.now();

function frame() {
  const t = (performance.now() - startTime) / 1000;
  updateAutoplay(t);

  const T = CONFIG.TARGET;
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  // eye = target + dist * (cp*sy, sp, cp*cy)
  // yaw=pitch=0 のとき (0,0,1) 方向 → eye = target + (0,0,dist) = (0,0,-9+9) = 原点
  const eye = [
    T[0] + camera.dist * cp * sy,
    T[1] + camera.dist * sp,
    T[2] + camera.dist * cp * cy,
  ];
  const forward = normalize([T[0] - eye[0], T[1] - eye[1], T[2] - eye[2]]);
  const worldUp = [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = cross(right, forward);

  resizeCanvas();
  gl.viewport(0, 0, canvas.width, canvas.height);

  const u = useProgram(program);
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  gl.uniform1f(u.uTime, t);
  gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
  gl.uniform3f(u.uForward, forward[0], forward[1], forward[2]);
  gl.uniform3f(u.uRight, right[0], right[1], right[2]);
  gl.uniform3f(u.uUp, up[0], up[1], up[2]);
  gl.uniform1f(u.uFov, CONFIG.FOV);
  gl.uniform1f(u.uMaxDist, CONFIG.MAX_DIST);
  gl.uniform1i(u.uMaxSteps, CONFIG.MAX_STEPS);
  gl.uniform1f(u.uSurfEps, CONFIG.SURF_EPS);
  gl.uniform3fv(u.uCenters, centersFlat);
  gl.uniform1fv(u.uRadii, radiiFlat);
  gl.uniform3fv(u.uColors, colorsFlat);

  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
