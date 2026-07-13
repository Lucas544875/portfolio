// ============================================================================
// 無限に沈む回廊 — プロトタイプ #5
//
// portfolio-concept.md の「3. ナビゲーション:沈んでいく階層構造」を単体で
// 確かめるためのプロトタイプ。ドメインリピティション(domain repetition)で
// z軸方向に無限に繰り返す窓枠(ラウンドボックスのリング)をレイマーチし、
// 奥へ果てしなく後退していく回廊に見せる。深く潜るほど:
//   - 霧が濃くなり(距離フォグ + 深度フォグの2系統)
//   - 配色が暗く・冷たくなり
//   - わずかな歪み(水圧の不安定さ)が増す
// ことで「深度」を体感させる。
//
// 【手法の要点】
//  1. z軸ドメインリピティション: `zi = mod(p.z, SPACING) - SPACING*0.5` で
//     どんな p.z も [-SPACING/2, SPACING/2) に畳み込み、各リングを SPACING の
//     倍数の位置に「中心を合わせて」繰り返す。plain な mod(p.z, s) だと
//     リングがセル端に来て鋸歯状(sawtooth)になるので、必ず -s*0.5 する。
//     これがこのパターン最頻出のバグ。
//  2. 窓枠リングのSDF: 外側ラウンドボックス − 内側ラウンドボックス(貫通穴)で
//     長方形の額縁を作る。内側の z 半径を十分大きく取り、セルを z 方向に
//     貫通させることで「奥まで開いた穴」にする。
//  3. カメラは +z へ進む。ro.z を `uDepth` uniform から直接引く。
//     → 実サイト統合時は、この uDepth を scrollY 由来の値に差し替える想定。
//  4. フォグ/暗化は距離ベースと深度ベースの2系統を別係数で保持。
//  5. 深度連動の歪み(ドメインワープ)で水圧感を出す。ワープでSDFは厳密な
//     距離関数でなくなるため、スフィアトレースのステップを安全率で縮める。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false, // フルスクリーンのレイマーチなので MSAA は効かない。エッジは距離フォグで馴染む
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
// Config — チューニング用の名前付き定数。GLSL 側にはテンプレート展開で注入する
// (JS を単一の真実源にして、シェーダーとの二重管理を避ける)。
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.6 : 0.85, // 内部解像度倍率。レイマーチは重いので 1.0 未満で描く
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // --- 回廊ジオメトリ ---
  SPACING: 3.0,          // リング(窓枠)の z 間隔。小さいほど枠が密に、速く流れる
  OUTER_HALF_X: 2.2,     // 窓枠 外側の半幅(x)。断面(クロスセクション)の大きさ
  OUTER_HALF_Y: 1.45,    // 窓枠 外側の半高(y)。x/y 比が窓の縦横比
  OUTER_HALF_Z: 0.12,    // 窓枠の z 方向の厚み(半分)。薄いほどシャープな額縁
  FRAME_BORDER: 0.22,    // 枠の桟(さん)の太さ。内側ボックスは OUTER - この値
  FRAME_ROUND: 0.06,     // 角の丸め半径

  // --- カメラ ---
  FOCAL: 1.35,           // 大きいほど望遠(画角が狭く、奥行き圧縮が強い)
  MAX_STEPS: 96,
  MAX_DIST: 60.0,        // これ以上は霧の彼方として打ち切る
  SURF_EPS: 0.002,
  STEP_SAFETY: 0.75,     // ドメインワープでSDFが非厳密になる分、ステップを縮める安全率(<1)。
                         //   ワープの Lipschitz 増分 ≈ DISTORT_MAX*DISTORT_FREQ ≈ 0.07 なので
                         //   厳密には 0.93 程度でも足りるが、目視検証できないため保守的に 0.75。
  CAM_SWAY_AMP: 0.10,    // カメラ位置 xy の微揺れ(消失点は中央固定のままパララックスを出す)
  CAM_SWAY_SPEED: 0.35,

  // --- フォグ / 暗化(2系統) ---
  FOG_DENSITY: 0.055,    // (系統1)距離フォグ: 1-exp(-dist*density)。遠方の枠を霧で溶かす
  DEPTH_DARKEN_RAMP: 0.018, // (系統2)深度フォグ: 潜るほどシーン全体を暗く冷たく。飽和カーブの立ち上がり
  DEPTH_DARKEN_MAX: 0.9,    // 深度フォグの最大寄与(1.0 で完全な暗黒)

  // --- 深度連動の歪み(水圧感) ---
  DISTORT_MAX: 0.12,     // ワープ振幅の上限(深部で飽和)。大きすぎるとレイが枠を貫通(tunneling)する
  DISTORT_RAMP: 0.015,   // 深度に対する振幅の立ち上がり(1-exp(-depth*ramp))
  DISTORT_FREQ: 0.6,     // ワープの空間周波数(z方向)。STEP_SAFETY と対で効く
  DISTORT_SPEED: 0.5,    // ワープの時間変化速度

  // --- 自動再生 / 操作 ---
  AUTO_SPEED: 1.4,       // 自動で潜る速さ(z ワールド単位/秒)。ペース感は要目視調整
  WHEEL_SENSITIVITY: 0.006,  // ホイール1ノッチあたりの深度デルタ
  DRAG_SENSITIVITY: 0.02,    // 縦ドラッグ1pxあたりの深度デルタ
  DEPTH_MIN: 0.0,        // 最上層(これより浅くは戻れない)

  // --- ホラー演出フック(portfolio-concept.md「最下層だけ一瞬影がよぎる」)---
  HORROR_DEPTH_THRESHOLD: 220.0, // この深度を超えたら「何かの影」がよぎり得る最下層とみなす
};

// スクロール統合フック:
//   実サイトに組み込む際は、下の `depth` を Lenis 等の scrollY(慣性スクロール量)
//   から算出した値へ差し替える。イメージとしては
//     depth = scrollY * PIXELS_TO_DEPTH;
//   の1行で置き換わるように、depth は「潜った総量(ワールドz)」の1変数に集約してある。
//   auto-advance とユーザー操作は、その scrollY が無い単体プロトタイプ用の代替入力。
let depth = 4.0;        // 開始深度(いきなり枠の真上だと単調なので少し進めた位置から)
let depthVelocity = 0;  // ユーザー入力による瞬間的な追加速度(慣性で減衰)

// ----------------------------------------------------------------------------
// GLSL float リテラル生成(整数でも必ず小数点付きにする)
// ----------------------------------------------------------------------------
function f(x) {
  let s = Number(x).toString();
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

// ----------------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------------
const VERT_SRC = `#version 300 es
precision highp float;
// フルスクリーン三角形(頂点バッファ不要)
const vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uDepth;   // ★ スクロール統合時はここを scrollY 由来の値に差し替える

// --- CONFIG から注入される定数 ---
const float SPACING      = ${f(CONFIG.SPACING)};
const vec3  OUTER_HALF   = vec3(${f(CONFIG.OUTER_HALF_X)}, ${f(CONFIG.OUTER_HALF_Y)}, ${f(CONFIG.OUTER_HALF_Z)});
const float FRAME_BORDER = ${f(CONFIG.FRAME_BORDER)};
const float FRAME_ROUND  = ${f(CONFIG.FRAME_ROUND)};
const float FOCAL        = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS    = ${Math.round(CONFIG.MAX_STEPS)};
const float MAX_DIST     = ${f(CONFIG.MAX_DIST)};
const float SURF_EPS     = ${f(CONFIG.SURF_EPS)};
const float STEP_SAFETY  = ${f(CONFIG.STEP_SAFETY)};
const float CAM_SWAY_AMP   = ${f(CONFIG.CAM_SWAY_AMP)};
const float CAM_SWAY_SPEED = ${f(CONFIG.CAM_SWAY_SPEED)};
const float FOG_DENSITY       = ${f(CONFIG.FOG_DENSITY)};
const float DEPTH_DARKEN_RAMP = ${f(CONFIG.DEPTH_DARKEN_RAMP)};
const float DEPTH_DARKEN_MAX  = ${f(CONFIG.DEPTH_DARKEN_MAX)};
const float DISTORT_MAX   = ${f(CONFIG.DISTORT_MAX)};
const float DISTORT_RAMP  = ${f(CONFIG.DISTORT_RAMP)};
const float DISTORT_FREQ  = ${f(CONFIG.DISTORT_FREQ)};
const float DISTORT_SPEED = ${f(CONFIG.DISTORT_SPEED)};
const float HORROR_DEPTH_THRESHOLD = ${f(CONFIG.HORROR_DEPTH_THRESHOLD)};

// 3D ラウンドボックスの符号付き距離
//   b: 各軸の半径, r: 角の丸め
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// 深度に応じたワープ振幅(飽和カーブ)。無限に潜っても発散しないよう頭打ちにする。
float distortAmp(float depth) {
  return DISTORT_MAX * (1.0 - exp(-depth * DISTORT_RAMP));
}

// 回廊の SDF。p はワールド座標。
float mapCorridor(vec3 p) {
  // (4) 深度連動のドメインワープ = 水圧による不安定さ。p.xy をずらしてから評価。
  //     これで SDF は厳密な距離関数でなくなる → レイマーチ側で STEP_SAFETY により補償する。
  float amp = distortAmp(uDepth);
  p.x += amp * sin(p.z * DISTORT_FREQ + uTime * DISTORT_SPEED);
  p.y += amp * cos(p.z * DISTORT_FREQ * 1.3 - uTime * DISTORT_SPEED * 0.8);

  // (1) z ドメインリピティション(中心を合わせて畳み込む)
  float zi = mod(p.z, SPACING) - SPACING * 0.5;
  vec3 q = vec3(p.x, p.y, zi);

  // (2) 窓枠リング = 外側ボックス − 内側ボックス(貫通穴)
  float outer = sdRoundBox(q, OUTER_HALF, FRAME_ROUND);
  // 内側は桟の太さぶん小さく、z は貫通させるため十分大きく取る(セルを z 方向に開通)
  vec3 innerHalf = vec3(OUTER_HALF.x - FRAME_BORDER, OUTER_HALF.y - FRAME_BORDER, SPACING);
  float inner = sdRoundBox(q, innerHalf, FRAME_ROUND);
  return max(outer, -inner);
}

// 法線(中心差分)
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    mapCorridor(p + e.xyy) - mapCorridor(p - e.xyy),
    mapCorridor(p + e.yxy) - mapCorridor(p - e.yxy),
    mapCorridor(p + e.yyx) - mapCorridor(p - e.yyx)
  ));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y; // アスペクト補正済み

  // カメラ: +z へ進む。消失点は中央固定のまま、位置だけ微揺れさせてパララックスを出す。
  vec3 ro = vec3(
    sin(uTime * CAM_SWAY_SPEED) * CAM_SWAY_AMP,
    cos(uTime * CAM_SWAY_SPEED * 0.8) * CAM_SWAY_AMP,
    uDepth  // ★ 深度 = カメラの z 位置。スクロール統合時はこの uDepth を差し替えるだけ
  );
  vec3 rd = normalize(vec3(uv, FOCAL)); // forward = +z

  // スフィアトレース
  float t = 0.0;
  float dist = MAX_DIST;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = mapCorridor(p);
    if (d < SURF_EPS) { hit = true; dist = t; break; }
    t += d * STEP_SAFETY; // (4) ワープで非厳密になった距離を安全率で縮めてオーバーシュート/貫通を防ぐ
    if (t > MAX_DIST) break;
  }

  // 配色(深度で冷たく寄せる)
  vec3 frameColBase = vec3(0.42, 0.47, 0.55); // 窓枠のベース色(青みがかった石/金属)
  vec3 fogNear = vec3(0.05, 0.08, 0.13);      // 浅い層の霧色
  vec3 fogDeep = vec3(0.006, 0.012, 0.03);    // 深い層の霧色(ほぼ暗黒の冷たい青)

  // (3) 深度フォグ係数 — 距離とは独立。潜った総量だけで全体を暗く冷たくする。
  float depthDark = DEPTH_DARKEN_MAX * (1.0 - exp(-uDepth * DEPTH_DARKEN_RAMP));
  vec3 fogColor = mix(fogNear, fogDeep, depthDark);

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * dist;
    vec3 n = calcNormal(p);
    // ヘッドライト(カメラ方向)+ 弱い環境光。冷たい主光源。
    float diff = max(dot(n, -rd), 0.0);
    float amb = 0.18;
    col = frameColBase * (amb + 0.9 * diff);
    // 深部ほど枠自体も色温度を下げて沈ませる
    col = mix(col, col * vec3(0.55, 0.68, 0.9), depthDark * 0.7);
  } else {
    col = fogColor; // 枠に当たらず霧の彼方へ抜けたレイ(=消失点付近)
  }

  // (3) 距離フォグ係数 — hit までの距離で遠方の枠を霧へ溶かす(系統1、深度フォグとは別係数)
  float fogDist = 1.0 - exp(-dist * FOG_DENSITY);
  col = mix(col, fogColor, fogDist);

  // 深度フォグを全体へ(近くの枠も含めて)重ねる。fogDist とは別に効かせるのが肝。
  col = mix(col, fogDeep, depthDark * 0.55);

  // ------------------------------------------------------------------------
  // (5) ホラー演出フック — portfolio-concept.md「最下層(Contact等)だけ、
  //     ガラスの向こうを一瞬何かの影がよぎる」。
  //     ここは意図的にスタブのまま。将来の実装案:
  //       - 別SDF(人影/手)を消失点付近だけに極薄アルファで一瞬合成する
  //       - もしくは下記のように、しきい値を跨いだ瞬間だけ画面端に影を差す
  //     amp を上げすぎるとホラーが常時見えて「静かな不穏さ」を壊すので、
  //     出現は極短時間・低頻度・低コントラストに留めること。
  if (uDepth > HORROR_DEPTH_THRESHOLD) {
    // float lurk = smoothstep(0.0, 1.0, sin(uTime * 0.3) * 0.5 + 0.5); // 稀な明滅
    // float edge = smoothstep(0.35, 0.5, length(uv));                  // 画面端だけ
    // col = mix(col, vec3(0.0), lurk * edge * 0.25);                    // 影がよぎる
  }

  // 出力(ガンマ)
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
const uResolution = gl.getUniformLocation(program, "uResolution");
const uTime = gl.getUniformLocation(program, "uTime");
const uDepth = gl.getUniformLocation(program, "uDepth");

// 頂点データ無しでフルスクリーン三角形を描くための空 VAO
const emptyVAO = gl.createVertexArray();

// ----------------------------------------------------------------------------
// Resize
// ----------------------------------------------------------------------------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  const w = Math.max(1, Math.floor(window.innerWidth * dpr * CONFIG.RENDER_SCALE));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr * CONFIG.RENDER_SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", resize);
resize();

// ----------------------------------------------------------------------------
// Input — auto-advance を基本に、ホイール/縦ドラッグで深度を上書き/加算。
//   これは実サイトの scrollY 駆動の代替。統合時は depth を scrollY 由来へ差し替える。
// ----------------------------------------------------------------------------
let userEngaged = false; // 一度でも操作したら自動再生から手動へハンドオフ

function engage() {
  if (!userEngaged) {
    userEngaged = true;
    hint.classList.add("faded");
  }
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  engage();
  depthVelocity += e.deltaY * CONFIG.WHEEL_SENSITIVITY;
}, { passive: false });

let dragging = false;
let lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastY = e.clientY;
  engage();
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dy = e.clientY - lastY;
  lastY = e.clientY;
  // 上へドラッグ(dy<0)で潜る、が直感的なので符号を反転して加算
  depthVelocity += -dy * CONFIG.DRAG_SENSITIVITY;
});
function endDrag() { dragging = false; }
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// 数秒操作が無ければヒントを自然に薄れさせる(自動再生中の案内)
setTimeout(() => { if (!userEngaged) hint.classList.add("faded"); }, 6000);

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let startTime = performance.now();
let lastTime = startTime;

function frame(now) {
  const time = (now - startTime) / 1000;
  const dt = Math.min(0.05, (now - lastTime) / 1000); // スパイク対策で dt をクランプ
  lastTime = now;

  try {
    // 自動で潜る(サイト未統合時の代替入力)。ユーザーが触っても自動前進は止めず、
    // その上に瞬間的な入力速度を上乗せする設計(sibling の autoplay→handoff に準拠)。
    depth += CONFIG.AUTO_SPEED * dt;
    depth += depthVelocity;
    depthVelocity *= 0.85; // 慣性の減衰
    if (depth < CONFIG.DEPTH_MIN) { depth = CONFIG.DEPTH_MIN; depthVelocity = 0; }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(emptyVAO);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, time);
    gl.uniform1f(uDepth, depth);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } catch (err) {
    console.error(err);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
