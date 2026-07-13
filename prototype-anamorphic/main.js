// ============================================================================
// アナモルフィック(単一視点)錯視 — プロトタイプ
//
// 「たくさんのガラス破片が3D空間にばらばらに散らばっているが、たった1つの
//   視点(スイートスポット)から見たときだけ、破片群が2Dの漢字シルエットに
//   整列して見える」という、エイムズの部屋 / 強制遠近法アート / “ありえない”
//   チョークアートと同じ系統の錯視をWebGL2で作る。
//
// 仕組み(構築手順):
//  1. 対象の漢字(ここでは「水」— サイトの中核モチーフである水・雨・結露に
//     直結する1文字。実名は未確定のためプレースホルダー。詳細はREADME参照)を、
//     フォントを解析せず、線分と2次ベジェ曲線という単純なパラメトリック
//     プリミティブで「簡略化した筆画スケルトン」としてハードコードする
//     (KANJI_STROKES)。各ストロークを弧長で等間隔サンプリングして、正規化
//     シルエット平面 [-1,1]×[-1,1] 上の2Dサンプル点列に変換する。
//  2. 固定の「スイートスポット」カメラを1つ定義する(SWEET_YAW/PITCH と
//     CAM_DIST/FOV)。各2Dサンプル点(px,py)について、そのスイートスポット
//     カメラから“その点を通る3Dレイ”を、prototype-shards と同一の射影
//     (uViewProj = proj * lookAt)の厳密な逆算で求める:
//       dir = forward*FOV + right*(px*S) + up*(py*S)     (lookAt基底)
//     この dir 方向のレイ上の任意の点は、スイートスポットから見ると必ず
//     NDC=(px*S/aspect, py*S) に射影される —— 深度に依存しない。ここが錯視の核。
//  3. 各サンプル点につき破片を1個、そのレイ上のランダムな深度に置く。深度が
//     ばらばらでもスイートスポットからは全て割り当てられたシルエット点に重なる。
//     深度のばらつきこそが、別角度から見たときに“ただの散らばり”に崩れる理由。
//  4. 破片の見た目(頂点ジッター/非等方スケール/自転、フラットシェーディング、
//     フレネルによる反射・屈折・色収差、screen-space refraction)は
//     prototype-shards の描画手法をそのまま流用している。
//  5. カメラは「最初スイートスポットで静止(第一印象=整列した漢字)→ 一定時間
//     ホールド → yaw/pitch を0を通過する振り子運動にして錯視の成立/崩壊を
//     繰り返し見せる → ユーザーがドラッグした瞬間に自由操作へハンドオフ」。
//     prototype-forced-perspective と同じ“振り子”パターン。
//
// 検証について: この環境にはブラウザ/スクリーンショットが無いため描画結果を
// 目視できない。逆射影の数式は prototype-shards の順射影の厳密な逆になるよう
// 手計算で突き合わせてある(下記コメント参照)。目視でしか確認できない点は
// README「視覚的に未検証な点」に列挙した。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: true,
  depth: true,
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 is not supported.");
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config — 錯視のチューニング可能な定数はすべてここに集約する
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.65 : 1.0,
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // --- 錯視の幾何(最重要) ---------------------------------------------------
  // スイートスポットカメラの向き。yaw=pitch=0 のとき eye=[0,0,CAM_DIST] で
  // 原点(=漢字の中心)を -Z 方向に見下ろす、いちばん素直な配置になる。
  SWEET_YAW: 0.0,
  SWEET_PITCH: 0.0,
  CAM_DIST: 5.6, // スイートスポットの eye から原点までの距離
  FOV: 1.7, // prototype-shards と同じ焦点距離パラメータ。fovy = 2*atan(1/FOV)
  NEAR: 0.05,
  FAR: 24.0,

  // シルエットの画面占有スケール。NDC縦方向で ±(SILHOUETTE_SCALE * |py|max) を占める。
  // py が最大 ~0.9 なので 0.62 なら縦およそ画面高さの ~56% を占める。
  SILHOUETTE_SCALE: 0.62,

  // 破片を置くレイ上の深度(スイートスポット eye からのユークリッド距離)レンジ。
  // eye が距離 5.6 にあるので、この範囲が原点をまたぐと破片が原点前後の“層”に
  // 散らばる。レンジが狭いほど別角度でも平面的に揃って見えて錯視が崩れにくく、
  // 広いほど散らばって崩れやすい(が広すぎると近い破片が巨大化する)。
  DEPTH_MIN: 3.4,
  DEPTH_MAX: 8.6,

  // シルエットの弧長サンプリング間隔([-1,1]シルエット単位)。小さいほど点(=破片)が
  // 増えて字が読みやすくなるが総破片数も増える。モバイルでは粗くして数を減らす。
  // 現在の筆画総長 ~4.2 に対し 0.035 で ~120点、0.055 で ~78点程度。
  SILHOUETTE_SPACING: isCoarsePointer ? 0.055 : 0.035,

  // 破片ごとの見かけの大きさを深度で補正し、スイートスポットからは全破片が
  // ほぼ同じ画面サイズに見えるようにする(遠近で近い破片だけ巨大化して字が
  // ガタつくのを防ぐ)。別角度からは逆に遠い破片が物理的に巨大=散らばりが強調される。
  UNIFORM_APPARENT_SIZE: true,
  APPARENT_REF_DIST: 5.6, // 見かけ==実寸 になる基準距離(CAM_DIST と同じに取る)

  // --- 破片の見た目(prototype-shards 準拠) ---------------------------------
  SIZE_MIN: 0.05, // 破片は“シルエット点”を表すので shards より一回り小さめ
  SIZE_MAX: 0.12,
  STRETCH_MIN: 1.3,
  STRETCH_MAX: 2.0,
  JITTER_STRENGTH: 0.5,
  REFRACT_PEEK_DEPTH: 1.1,
  CRYSTAL_IOR_MIN: 1.54,
  CRYSTAL_IOR_MAX: 1.56,
  CRYSTAL_ABBE_NUMBER: 38,
  SPIN_SPEED_MIN: 0.1,
  SPIN_SPEED_MAX: 0.4,

  // --- カメラ演出(prototype-forced-perspective と同じ振り子パターン) -------
  AUTOPLAY_HOLD: 2.6, // 最初この秒数だけスイートスポットで静止(第一印象=整列した漢字)
  AUTOPLAY_YAW_AMP: 0.6, // ≈34°。0 を通過し続けて錯視の成立/崩壊を繰り返し見せる
  AUTOPLAY_YAW_SPEED: 0.3,
  AUTOPLAY_PITCH_AMP: 0.14,
  AUTOPLAY_PITCH_SPEED: 0.2,
  DRAG_YAW_SENSITIVITY: 0.009,
  DRAG_PITCH_SENSITIVITY: 0.009,
  PITCH_LIMIT: 1.2,
};

// ----------------------------------------------------------------------------
// 対象の漢字「水」— 簡略化した筆画スケルトン(フォント精度ではない)
//
// 正規化シルエット平面 [-1,1]×[-1,1]、+y が上。文字の中心が原点。
// KanjiVG のような実グリフではなく、線分(line)と2次ベジェ(quad)で手打ちした
// “読めればよい”骨格。4画で 水 のゲシュタルト(中央の縦はね + 左右の払い/はらい
// + 左上の短い払い)を出している。README に簡略化の旨を明記。
// ----------------------------------------------------------------------------
const KANJI_STROKES = [
  // 第1画: 中央の縦画 + 左下へのはね(竪鉤)
  [
    { type: "line", a: [0.0, 0.9], b: [0.0, -0.65] },
    { type: "line", a: [0.0, -0.65], b: [-0.17, -0.5] },
  ],
  // 第2画: 左の長い払い(撇)。縦画のすぐ左上から左下へ大きく払う
  [{ type: "quad", a: [-0.02, 0.28], c: [-0.28, -0.05], b: [-0.6, -0.6] }],
  // 第3画: 左上の短い払い(水 の左側を賑やかにする特徴的な小画)
  [{ type: "line", a: [-0.34, 0.3], b: [-0.14, 0.1] }],
  // 第4画: 右の払い/はらい(捺)。縦画のすぐ右上から右下へ大きく払う
  [{ type: "quad", a: [0.02, 0.24], c: [0.3, -0.05], b: [0.6, -0.6] }],
];

// 2次ベジェ上の点
function quadAt(a, c, b, t) {
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
    u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
  ];
}

function dist2d(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

// プリミティブの弧長を推定(quad は細かく分割して折れ線長で近似)
function primitiveLength(prim) {
  if (prim.type === "line") return dist2d(prim.a, prim.b);
  let len = 0;
  let prev = prim.a;
  const SUB = 32;
  for (let i = 1; i <= SUB; i++) {
    const p = quadAt(prim.a, prim.c, prim.b, i / SUB);
    len += dist2d(prev, p);
    prev = p;
  }
  return len;
}

function primitivePoint(prim, t) {
  if (prim.type === "line") {
    return [prim.a[0] + (prim.b[0] - prim.a[0]) * t, prim.a[1] + (prim.b[1] - prim.a[1]) * t];
  }
  return quadAt(prim.a, prim.c, prim.b, t);
}

// 全ストロークを弧長で等間隔サンプリングして 2D 点列を返す。
// ストローク内で隣接プリミティブが端点を共有する場合、その重複点は落とす。
function sampleSilhouette(spacing) {
  const pts = [];
  for (const stroke of KANJI_STROKES) {
    let strokeStarted = false;
    for (const prim of stroke) {
      const len = primitiveLength(prim);
      const n = Math.max(1, Math.round(len / spacing));
      for (let i = 0; i <= n; i++) {
        // プリミティブ境界の重複(前プリミティブの終点 == 次の始点)を回避
        if (i === 0 && strokeStarted) continue;
        pts.push(primitivePoint(prim, i / n));
      }
      strokeStarted = true;
    }
  }
  return pts;
}

const silhouettePoints = sampleSilhouette(CONFIG.SILHOUETTE_SPACING);
const SHARD_COUNT = silhouettePoints.length;

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

function useProgram(p) {
  gl.useProgram(p.program);
  return p.uniforms;
}

// ----------------------------------------------------------------------------
// Shared GLSL(prototype-shards と同じ環境・トーンマップ関数群)
// ----------------------------------------------------------------------------
const commonGLSL = `
float hash21 (vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 keyLightDir (int i) {
  if (i == 0) return normalize(vec3(0.55, 0.65, -0.4));
  if (i == 1) return normalize(vec3(-0.7, 0.22, 0.6));
  return normalize(vec3(0.15, -0.6, -0.75));
}

vec3 keyLightColor (int i) {
  if (i == 0) return vec3(1.0, 0.97, 0.9) * 3.4;
  if (i == 1) return vec3(0.55, 0.78, 1.0) * 2.6;
  return vec3(1.0, 0.6, 0.38) * 2.0;
}

vec3 background (vec3 rd) {
  float depth = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.014, 0.02, 0.036), vec3(0.05, 0.065, 0.11), depth);

  for (int i = 0; i < 3; i++) {
    vec3 ld = keyLightDir(i);
    vec3 lc = keyLightColor(i);
    float d = max(dot(rd, ld), 0.0);
    col += lc * pow(d, 420.0) * 2.2;
    col += lc * 0.05 * pow(d, 40.0);
  }

  vec2 uv = rd.xy / (abs(rd.z) + 0.35) + vec2(uTime * 0.004, uTime * 0.0025);
  vec2 id = floor(uv * 30.0);
  vec2 f = fract(uv * 30.0) - 0.5;
  float h = hash21(id);
  float speck = smoothstep(0.05, 0.0, length(f) - 0.05) * step(0.95, h);
  col += speck * vec3(0.6, 0.7, 0.85) * (0.4 + 0.6 * hash21(id + 3.0));

  return col;
}

float sparkle (vec3 reflDir) {
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += pow(clamp(dot(reflDir, keyLightDir(i)), 0.0, 1.0), 900.0);
  }
  return s;
}

vec3 reinhard (vec3 col) {
  return col / (col + vec3(1.0));
}

vec3 gammaCorrect (vec3 col) {
  return pow(col, vec3(1.0 / 2.2));
}

vec3 decodeCapture (vec3 encoded) {
  return encoded / max(vec3(1.0) - encoded, vec3(0.0001));
}

float vignette (vec2 ndc, float aspect) {
  return smoothstep(0.35, 1.15, length(vec2(ndc.x * aspect, ndc.y)));
}
`;

// ----------------------------------------------------------------------------
// 背景パス(prototype-shards と同一)
// ----------------------------------------------------------------------------
const quadVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main () {
  vUv = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const bgFragmentShaderSource = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uFov;
uniform bool uCaptureMode;
out vec4 fragColor;

${commonGLSL}

void main () {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;
  vec3 rd = normalize(uForward * uFov + uRight * uv.x + uUp * uv.y);

  vec3 col = background(rd);

  if (uCaptureMode) {
    fragColor = vec4(reinhard(col), 1.0);
    return;
  }

  col = gammaCorrect(reinhard(col));
  col *= mix(1.0, 0.72, vignette(vUv, aspect));

  fragColor = vec4(col, 1.0);
}
`;

const bgProgram = createProgram(quadVertexShaderSource, bgFragmentShaderSource);

const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// ----------------------------------------------------------------------------
// 破片パス(prototype-shards と同一の頂点/フラグメントシェーダー)
// ----------------------------------------------------------------------------
const shardVertexShaderSource = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aBasePos;
layout(location = 1) in vec3 aOffset;
layout(location = 2) in vec3 aScale;
layout(location = 3) in vec3 aAxis;
layout(location = 4) in vec2 aSpin;
layout(location = 5) in float aSeed;

uniform mat4 uViewProj;
uniform float uTime;
uniform float uJitterStrength;

out vec3 vWorldPos;
flat out float vSeed;

float hash13 (vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 rotateAxisAngle (vec3 v, vec3 axis, float angle) {
  float s = sin(angle), c = cos(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main () {
  // 破片の“中心”は常に aOffset(=シルエットレイ上の点)に固定される。
  // ジッター/スケール/自転はすべて local(中心まわりの相対座標)にのみ効くので、
  // 破片がどれだけ変形・自転してもスイートスポットからの見かけの位置は動かない。
  float jHash = hash13(vec3(aSeed, float(gl_VertexID) * 7.13, aSeed * 3.71));
  vec3 local = aBasePos * (1.0 + (jHash - 0.5) * uJitterStrength);
  local *= aScale;

  float angle = aSpin.x + uTime * aSpin.y;
  local = rotateAxisAngle(local, normalize(aAxis), angle);

  vec3 worldPos = local + aOffset;
  vWorldPos = worldPos;
  vSeed = aSeed;
  gl_Position = uViewProj * vec4(worldPos, 1.0);
}
`;

const shardFragmentShaderSource = `#version 300 es
precision highp float;

in vec3 vWorldPos;
flat in float vSeed;

uniform vec3 uCameraPos;
uniform vec2 uResolution;
uniform float uTime;
uniform mat4 uViewProj;
uniform bool uCaptureMode;
uniform sampler2D uSceneTex;
uniform float uRefractPeekDepth;
uniform float uCrystalIorMin;
uniform float uCrystalIorMax;
uniform float uCrystalAbbeNumber;
out vec4 fragColor;

${commonGLSL}

vec3 sampleBehind (vec3 dir) {
  if (uCaptureMode) return background(dir);

  vec3 samplePos = vWorldPos + dir * uRefractPeekDepth;
  vec4 clip = uViewProj * vec4(samplePos, 1.0);
  if (clip.w <= 0.0) return background(dir);

  vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return background(dir);

  return decodeCapture(texture(uSceneTex, uv).rgb);
}

void main () {
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  if (dot(n, viewDir) < 0.0) n = -n;
  vec3 rd = -viewDir;

  float ndv = clamp(dot(n, viewDir), 0.0, 1.0);

  float iorD = mix(uCrystalIorMin, uCrystalIorMax, fract(vSeed * 12.9898));

  float dispersion = (iorD - 1.0) / uCrystalAbbeNumber;
  float iorR = iorD - 0.4 * dispersion;
  float iorG = iorD;
  float iorB = iorD + 0.6 * dispersion;

  float f0 = pow((iorD - 1.0) / (iorD + 1.0), 2.0);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

  vec3 reflDir = reflect(rd, n);
  vec3 reflColor = background(reflDir);

  vec3 rR = refract(rd, n, 1.0 / iorR);
  vec3 rG = refract(rd, n, 1.0 / iorG);
  vec3 rB = refract(rd, n, 1.0 / iorB);
  if (dot(rR, rR) < 0.0001) rR = reflDir;
  if (dot(rG, rG) < 0.0001) rG = reflDir;
  if (dot(rB, rB) < 0.0001) rB = reflDir;
  vec3 refrColor = vec3(sampleBehind(rR).r, sampleBehind(rG).g, sampleBehind(rB).b);

  vec3 col = mix(refrColor, reflColor, clamp(fresnel, 0.0, 1.0));

  vec3 mainLightDir = normalize(vec3(0.5, 0.8, -0.3));
  float diff = clamp(dot(n, mainLightDir), 0.0, 1.0);
  col += diff * vec3(0.05, 0.065, 0.08);

  vec3 rimLightDir = normalize(vec3(-0.6, -0.35, 0.7));
  float rim = pow(1.0 - ndv, 2.2) * clamp(dot(n, rimLightDir), 0.0, 1.0);
  col += rim * vec3(0.95, 0.55, 0.25) * 0.6;

  col += sparkle(reflDir) * vec3(1.0, 0.97, 0.92) * 7.0;
  col += vec3(0.014, 0.02, 0.032);

  float dist = length(uCameraPos - vWorldPos);
  float fog = 1.0 - exp(-dist * 0.028);
  col = mix(col, background(rd), fog * 0.5);

  if (uCaptureMode) {
    fragColor = vec4(reinhard(col), 1.0);
    return;
  }

  col = gammaCorrect(reinhard(col));

  float aspect = uResolution.x / uResolution.y;
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  col *= mix(1.0, 0.72, vignette(ndc, aspect));

  fragColor = vec4(col, 1.0);
}
`;

const shardProgram = createProgram(shardVertexShaderSource, shardFragmentShaderSource);

// 正八面体(6頂点・8面)。全インスタンス共通のベースジオメトリ
const octahedronPositions = new Float32Array([
  1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1,
]);
// prettier-ignore
const octahedronIndices = new Uint16Array([
  0, 2, 4,  0, 5, 2,  0, 4, 3,  0, 3, 5,
  1, 4, 2,  1, 2, 5,  1, 3, 4,  1, 5, 3,
]);

function randomUnitVector() {
  let x, y, z, d;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    d = x * x + y * y + z * z;
  } while (d > 1 || d === 0);
  const inv = 1 / Math.sqrt(d);
  return [x * inv, y * inv, z * inv];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ----------------------------------------------------------------------------
// スイートスポットカメラの基底(lookAt と同じ規約で構築)
//
// これが逆射影の“順”側。破片のスクリーン位置を決めるのは uViewProj = proj*lookAt
// なので、逆算にも lookAt の基底(背景シェーダーの right とは符号が逆な点に注意)を
// 使わなければならない。
//   z = normalize(eye - target)      (視線の逆向き = 後方)
//   x(right) = normalize(up × z)
//   y(up)    = z × x
//   forward(前方) = -z
// ----------------------------------------------------------------------------
function sweetSpotCamera() {
  const cy = Math.cos(CONFIG.SWEET_YAW), sy = Math.sin(CONFIG.SWEET_YAW);
  const cp = Math.cos(CONFIG.SWEET_PITCH), sp = Math.sin(CONFIG.SWEET_PITCH);
  const eye = [CONFIG.CAM_DIST * cp * sy, CONFIG.CAM_DIST * sp, CONFIG.CAM_DIST * cp * cy];
  const worldUp = [0, 1, 0];

  // z = normalize(eye - target), target = 原点
  let zx = eye[0], zy = eye[1], zz = eye[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;

  // x = normalize(up × z)
  let xx = worldUp[1] * zz - worldUp[2] * zy;
  let xy = worldUp[2] * zx - worldUp[0] * zz;
  let xz = worldUp[0] * zy - worldUp[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;

  // y = z × x
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return {
    eye,
    forward: [-zx, -zy, -zz],
    right: [xx, xy, xz],
    up: [yx, yy, yz],
  };
}

// ----------------------------------------------------------------------------
// インスタンスデータ生成 —— ここが錯視の本体。
// 各シルエット点 (px,py) について、スイートスポットからその点を通るレイ方向
//   dir = forward*FOV + right*(px*S) + up*(py*S)
// を作り、eye からランダム深度だけ進んだ位置に破片を1個置く。
//
// なぜこれで揃うか(prototype-shards の順射影の逆になっている証明):
//   pos = eye + D*normalize(dir) をビュー空間へ移すと、right/up/forward が正規直交
//   基底なので view座標は x_v ∝ (px*S), y_v ∝ (py*S), z_v = -(FOV成分) となり、
//   proj([0][0]=FOV/aspect, [1][1]=FOV)を通すと
//     NDC_x = (FOV/aspect)*(px*S)/(FOV) = px*S/aspect
//     NDC_y = FOV*(py*S)/(FOV)          = py*S
//   となって D(深度)にも aspect にも依存しない。深度をどうランダムにしても、
//   スイートスポットからは必ず同じ NDC=(px*S/aspect, py*S) に落ちる。
//   さらに aspect は NDC_x 側にしか現れず、これは画面の横伸びをちょうど打ち消すので、
//   ワールド座標は aspect 非依存(=ウィンドウをリサイズしても破片を作り直さなくて
//   よい)かつ文字は常に正方形比で表示される。
// ----------------------------------------------------------------------------
function buildInstanceData(points) {
  const cam = sweetSpotCamera();
  const S = CONFIG.SILHOUETTE_SCALE;
  const stride = 12; // offset(3) + scale(3) + axis(3) + spin(2) + seed(1)
  const data = new Float32Array(points.length * stride);

  for (let i = 0; i < points.length; i++) {
    const o = i * stride;
    const [px, py] = points[i];

    // レイ方向(未正規化)= forward*FOV + right*(px*S) + up*(py*S)
    let dx = cam.forward[0] * CONFIG.FOV + cam.right[0] * (px * S) + cam.up[0] * (py * S);
    let dy = cam.forward[1] * CONFIG.FOV + cam.right[1] * (px * S) + cam.up[1] * (py * S);
    let dz = cam.forward[2] * CONFIG.FOV + cam.right[2] * (px * S) + cam.up[2] * (py * S);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // レイ上のランダム深度(eye からのユークリッド距離)
    const depth = lerp(CONFIG.DEPTH_MIN, CONFIG.DEPTH_MAX, Math.random());
    data[o + 0] = cam.eye[0] + dx * depth;
    data[o + 1] = cam.eye[1] + dy * depth;
    data[o + 2] = cam.eye[2] + dz * depth;

    // 見かけの大きさを深度で補正(スイートスポットから全破片をほぼ同じ画面サイズに)
    let apparent = 1.0;
    if (CONFIG.UNIFORM_APPARENT_SIZE) apparent = depth / CONFIG.APPARENT_REF_DIST;

    const baseSize = lerp(CONFIG.SIZE_MIN, CONFIG.SIZE_MAX, Math.random()) * apparent;
    const scale = [
      baseSize * lerp(0.55, 1.0, Math.random()),
      baseSize * lerp(0.55, 1.0, Math.random()),
      baseSize * lerp(0.55, 1.0, Math.random()),
    ];
    const stretchAxis = Math.floor(Math.random() * 3);
    scale[stretchAxis] *= lerp(CONFIG.STRETCH_MIN, CONFIG.STRETCH_MAX, Math.random());
    data[o + 3] = scale[0];
    data[o + 4] = scale[1];
    data[o + 5] = scale[2];

    const [ax, ay, az] = randomUnitVector();
    data[o + 6] = ax;
    data[o + 7] = ay;
    data[o + 8] = az;

    data[o + 9] = Math.random() * Math.PI * 2; // spin phase
    const speed = lerp(CONFIG.SPIN_SPEED_MIN, CONFIG.SPIN_SPEED_MAX, Math.random());
    data[o + 10] = Math.random() < 0.5 ? -speed : speed; // spin speed

    data[o + 11] = Math.random() * 1000; // seed
  }
  return data;
}

const shardVAO = gl.createVertexArray();
gl.bindVertexArray(shardVAO);

const basePosBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, basePosBuffer);
gl.bufferData(gl.ARRAY_BUFFER, octahedronPositions, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

const indexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, octahedronIndices, gl.STATIC_DRAW);

const instanceBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
gl.bufferData(gl.ARRAY_BUFFER, buildInstanceData(silhouettePoints), gl.STATIC_DRAW);

const STRIDE = 12 * 4; // bytes
function instanceAttrib(location, size, offsetFloats) {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE, offsetFloats * 4);
  gl.vertexAttribDivisor(location, 1);
}
instanceAttrib(1, 3, 0); // aOffset
instanceAttrib(2, 3, 3); // aScale
instanceAttrib(3, 3, 6); // aAxis
instanceAttrib(4, 2, 9); // aSpin
instanceAttrib(5, 1, 11); // aSeed

gl.bindVertexArray(null);

// ----------------------------------------------------------------------------
// 最小限の行列ヘルパー(列優先。prototype-shards と同一)
// ----------------------------------------------------------------------------
function mat4Perspective(fovy, aspect, near, far) {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;

  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;

  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;

  // prettier-ignore
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

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
// シーンcapture用フレームバッファ(screen-space refraction 用。shards と同一)
// ----------------------------------------------------------------------------
const sceneFBO = gl.createFramebuffer();
const sceneColorTex = gl.createTexture();
const sceneDepthRB = gl.createRenderbuffer();
let sceneFBOWidth = 0;
let sceneFBOHeight = 0;

function ensureSceneFBO(w, h) {
  if (w === sceneFBOWidth && h === sceneFBOHeight) return;
  sceneFBOWidth = w;
  sceneFBOHeight = h;

  gl.bindTexture(gl.TEXTURE_2D, sceneColorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepthRB);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);

  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneColorTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepthRB);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ----------------------------------------------------------------------------
// Camera: スイートスポットで静止 → 振り子 → ドラッグでハンドオフ
// yaw=pitch=0 のとき eye はスイートスポットそのものになる(破片生成と同じ規約)。
// ----------------------------------------------------------------------------
const camera = { yaw: CONFIG.SWEET_YAW, pitch: CONFIG.SWEET_PITCH };
const autoplay = { enabled: true };

function updateAutoplay(t) {
  if (!autoplay.enabled) return;
  const e = t - CONFIG.AUTOPLAY_HOLD;
  if (e <= 0) {
    // 第一印象: スイートスポットで静止 = 破片が「水」に整列して見える
    camera.yaw = CONFIG.SWEET_YAW;
    camera.pitch = CONFIG.SWEET_PITCH;
    return;
  }
  // 振り子。スイートスポット(yaw=pitch=0)を通過し続け、錯視の成立と崩壊を繰り返す
  camera.yaw = CONFIG.SWEET_YAW + CONFIG.AUTOPLAY_YAW_AMP * Math.sin(e * CONFIG.AUTOPLAY_YAW_SPEED);
  camera.pitch = CONFIG.SWEET_PITCH + CONFIG.AUTOPLAY_PITCH_AMP * Math.sin(e * CONFIG.AUTOPLAY_PITCH_SPEED);
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
  "touchmove",
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

// ----------------------------------------------------------------------------
// Main loop(2パス構成は prototype-shards と同一)
// ----------------------------------------------------------------------------
const startTime = performance.now();

function frame() {
  const t = (performance.now() - startTime) / 1000;
  updateAutoplay(t);

  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const eye = [CONFIG.CAM_DIST * cp * sy, CONFIG.CAM_DIST * sp, CONFIG.CAM_DIST * cp * cy];
  const target = [0, 0, 0];
  const up = [0, 1, 0];

  const forward = [-eye[0] / CONFIG.CAM_DIST, -eye[1] / CONFIG.CAM_DIST, -eye[2] / CONFIG.CAM_DIST];
  const rightLen = Math.hypot(up[1] * forward[2] - up[2] * forward[1], up[2] * forward[0] - up[0] * forward[2], up[0] * forward[1] - up[1] * forward[0]) || 1;
  const right = [
    (up[1] * forward[2] - up[2] * forward[1]) / rightLen,
    (up[2] * forward[0] - up[0] * forward[2]) / rightLen,
    (up[0] * forward[1] - up[1] * forward[0]) / rightLen,
  ];
  const trueUp = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];

  const aspect = canvas.width / canvas.height;
  const fovy = 2 * Math.atan(1 / CONFIG.FOV);
  const proj = mat4Perspective(fovy, aspect, CONFIG.NEAR, CONFIG.FAR);
  const view = mat4LookAt(eye, target, up);
  const viewProj = mat4Multiply(proj, view);

  ensureSceneFBO(canvas.width, canvas.height);

  function drawScene(captureMode) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    const ub = useProgram(bgProgram);
    gl.uniform2f(ub.uResolution, canvas.width, canvas.height);
    gl.uniform1f(ub.uTime, t);
    gl.uniform3f(ub.uForward, forward[0], forward[1], forward[2]);
    gl.uniform3f(ub.uRight, right[0], right[1], right[2]);
    gl.uniform3f(ub.uUp, trueUp[0], trueUp[1], trueUp[2]);
    gl.uniform1f(ub.uFov, CONFIG.FOV);
    gl.uniform1i(ub.uCaptureMode, captureMode ? 1 : 0);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    const us = useProgram(shardProgram);
    gl.uniformMatrix4fv(us.uViewProj, false, viewProj);
    gl.uniform3f(us.uCameraPos, eye[0], eye[1], eye[2]);
    gl.uniform2f(us.uResolution, canvas.width, canvas.height);
    gl.uniform1f(us.uTime, t);
    gl.uniform1f(us.uJitterStrength, CONFIG.JITTER_STRENGTH);
    gl.uniform1f(us.uRefractPeekDepth, CONFIG.REFRACT_PEEK_DEPTH);
    gl.uniform1f(us.uCrystalIorMin, CONFIG.CRYSTAL_IOR_MIN);
    gl.uniform1f(us.uCrystalIorMax, CONFIG.CRYSTAL_IOR_MAX);
    gl.uniform1f(us.uCrystalAbbeNumber, CONFIG.CRYSTAL_ABBE_NUMBER);
    gl.uniform1i(us.uCaptureMode, captureMode ? 1 : 0);
    if (!captureMode) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneColorTex);
      gl.uniform1i(us.uSceneTex, 0);
    }
    gl.bindVertexArray(shardVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, octahedronIndices.length, gl.UNSIGNED_SHORT, 0, SHARD_COUNT);
  }

  // パス1: capture(フィードバックループ回避のため事前にユニットを空にする)
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  drawScene(true);

  // パス2: 本番
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  drawScene(false);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
