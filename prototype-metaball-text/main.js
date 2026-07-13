// ============================================================================
// メタボール文字 — プロトタイプ(レイマーチするガラスの水滴で「川」を書く)
//
// コンセプト: サイト全体の「結露をなぞって、名前の漢字が一画ずつ現れる」演出を、
// 2Dの拭き取りシェーダーではなく、3D空間に浮かぶガラスの水滴(球)が smooth-min で
// 液体的に融合しながら、正しい筆順で一画ずつ文字の形に凝集していく——という
// フルレイマーチのガラス表現に置き換えたもの。
//
// - 文字は「筆順つきの簡略スケルトン」をコードにハードコードしたデータ(フォント精度
//   ではない)。各画は正規化平面 [-1,1] 上の2次ベジェ1本で表す(直線的な画は
//   制御点を中点に置いた退化ベジェ)。これは KanjiVG の "筆順に沿ってパスをなぞる"
//   考え方(../prototype/ 参照)を、SVGパス読み込みなしで最小構成に落としたもの
// - 各画を弧長等間隔でサンプルし、そのサンプル点に「水滴(球)」を1個ずつ置く。
//   隣り合う球は半径 > サンプル間隔となるよう配置してあり、smooth-min で繋ぐと
//   バラバラの玉ではなく1本の連続した画の形のブロブになる
// - 進行度 uniform `progress`(0→1)が「名前をどこまでなぞったか」を表す。
//   progress を (a) 現在アクティブな画のインデックス(正しい筆順)、(b) その画の
//   弧長上のどこまで水滴が"出現"したか、に写像する。まだ出現していない水滴は
//   半径0にして SDF から完全に除外する(smooth-min に一切寄与させない)
// - ガラスの質感は ../prototype-shards/(ガラスの破片)の見た目を踏襲:
//   フレネルで反射/屈折を配分し、R/G/Bごとにわずかに違う屈折率で屈折させて
//   色収差(分散)を出す。背景・光源・トーンマップ関数はそのまま流用して世界観を揃える
// - 読み込み時はゆっくり自動で progress が進んで「川」を書き切り、少し溜めてから
//   ループする(他プロトタイプの自動再生の作法に合わせる)。ユーザーが
//   ドラッグ/スクロールした瞬間に手動スクラブへハンドオフする
//   (../prototype-shards/ の「自動周回→ドラッグでハンドオフ」と同じ引き継ぎ方)
//
// 【文字の選定理由】「川」(かわ / river)を選んだ:
//   1. サイトの水・ガラス・結露のモチーフに合う("水"そのものより画の交差が無く、
//      メタボールにしたときの可読性が高い)
//   2. 3画すべてが空間的に分離した縦画で、玉が繋がって"読める文字"になりやすい
//   3. 筆順が明快で自信を持てる: 左の画 → 中央の画 → 右の画、各画は上から下へ。
//      "水"は2・3画目の形状の記憶が曖昧で、正しい筆順を断言しづらかったため見送った
//   (詳細と注意点は README.md 参照)
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: true,
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
// Config — 調整したい定数はすべてここに集約(意味はコメント参照)
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.6 : 0.9, // フルスクリーンをレイマーチするので解像度は控えめに
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // --- 水滴(メタボール)ジオメトリ ---
  DROPLET_RADIUS: 0.085, // 各水滴の球の半径(正規化 [-1,1] 空間)。画の太さ ≒ 2*これ
  SMIN_K: 0.12, // smooth-min のブレンド半径。大きいほど"とろけて液体的"、小さいほど"玉が分かれてボコボコ"
  STROKE_SAMPLE_SPACING: 0.11, // 画に沿って水滴を置く弧長間隔。radius より小さくして隣同士を必ず重ねる
  MAX_DROPLETS: 120, // 安全上限(レイマーチのstepごとに全水滴とsminするので抑える)。shardsの破片数と同オーダー
  DEPTH_JITTER: 0.03, // 水滴をガラス板の平面(z=0)付近にわずかに前後させる量。単調な平面配置を避ける

  // --- 出現アニメーション ---
  GROW_SPAN: 1.6, // 水滴が半径0→フルに育つ幅(水滴インデックス単位)。大きいほど"にじむように"複数同時に育つ
  AUTO_ADVANCE_SPEED: 0.085, // progress の自動進行速度(1/秒)。全画を書き切るのに約 1/これ 秒 + 溜め
  START_DELAY: 0.6, // 開始前の間(秒)
  END_HOLD: 1.8, // 書き切った後、ループ前に完成形を見せる時間(秒)

  // --- ガラスの光学(prototype-shards のクラウンガラス相当に合わせる) ---
  IOR: 1.51, // ガラスの屈折率 n_d(クラウンガラス代表値)
  ABBE_NUMBER: 55, // アッベ数(分散の指標。低いほど色収差が強い)。クラウンガラス ≒ 55〜59
  DENSITY_TINT: 0.6, // 屈折色にかけるうっすらした水色の吸収(厚みの気配)。0で無色

  // --- カメラ ---
  CAM_DIST: 3.2, // 原点(文字の中心)からのカメラ距離
  FOV: 2.2, // 大きいほど望遠(文字が画面に対して大きく・歪みなく写る)。FOV/CAM_DIST ≒ 画面占有率
  CAM_YAW_SWAY: 0.10, // アイドル時のごく僅かな水平首振り(ガラスに映る光を動かして生気を出す)
  CAM_PITCH_SWAY: 0.05,
  CAM_SWAY_SPEED: 0.16,

  // --- レイマーチ ---
  MAX_STEPS: 96,
  MAX_DIST: 12.0,
  SURF_EPS: 0.0012,

  // --- ユーザースクラブ感度 ---
  DRAG_SCRUB_SENSITIVITY: 0.0018, // 横ドラッグ1pxあたりの progress 変化量
  WHEEL_SCRUB_SENSITIVITY: 0.0009, // ホイール1notchあたりの progress 変化量
};

// ----------------------------------------------------------------------------
// GL helpers(他プロトタイプと同じ最小構成)
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
  return program;
}

// ----------------------------------------------------------------------------
// 文字データ「川」— 各画を正規化平面 [-1,1](x:右+, y:上+)上の2次ベジェで定義。
// 配列の順序 = 筆順(左 → 中央 → 右)。各ベジェの p0 は必ず画の"書き始め"(=上端)。
// 直線的な画は制御点 c を p0-p1 の中点付近に置いた退化ベジェにしている。
// ----------------------------------------------------------------------------
const STROKES = [
  // 1画目: 左の画。上から下へ、やや左へ張り出しながら流れる曲線
  { p0: [-0.52, 0.72], c: [-0.66, -0.05], p1: [-0.74, -0.86] },
  // 2画目: 中央の画。ほぼ直線で短め・やや上寄り(川の中棒の特徴)
  { p0: [0.02, 0.5], c: [0.0, 0.0], p1: [-0.02, -0.5] },
  // 3画目: 右の画。最も長い、ほぼ直線の縦画
  { p0: [0.6, 0.82], c: [0.66, -0.02], p1: [0.68, -0.9] },
];

function quadBezier(s, t) {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * mt * t;
  const d = t * t;
  return [
    a * s.p0[0] + b * s.c[0] + d * s.p1[0],
    a * s.p0[1] + b * s.c[1] + d * s.p1[1],
  ];
}

// 1本の画を弧長で等間隔サンプルして、書き始め順に並んだ点列を返す。
// 高解像度(200分割)で累積弧長テーブルを作り、spacing ごとに線形補間で拾う。
function sampleStroke(stroke, spacing) {
  const DENSE = 200;
  const dense = [];
  let acc = 0;
  let prev = quadBezier(stroke, 0);
  dense.push({ p: prev, s: 0 });
  for (let i = 1; i <= DENSE; i++) {
    const p = quadBezier(stroke, i / DENSE);
    acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    dense.push({ p, s: acc });
    prev = p;
  }
  const total = acc;
  const nSeg = Math.max(1, Math.round(total / spacing));
  const pts = [];
  let di = 0;
  for (let k = 0; k <= nSeg; k++) {
    const target = (k / nSeg) * total;
    while (di < dense.length - 1 && dense[di + 1].s < target) di++;
    const a = dense[di];
    const b = dense[Math.min(di + 1, dense.length - 1)];
    const seg = b.s - a.s;
    const f = seg > 1e-9 ? (target - a.s) / seg : 0;
    pts.push([a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f]);
  }
  return pts;
}

// 決定論的な小さいハッシュ(水滴の z ジッター用。乱数のばらつきを固定して再現性を保つ)
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// 全画を通した水滴リストを筆順どおりに構築する。
// droplets[i] = { x, y, z, strokeIndex }。radius はフレームごとに progress から決まる。
function buildDroplets() {
  const droplets = [];
  for (let si = 0; si < STROKES.length; si++) {
    const pts = sampleStroke(STROKES[si], CONFIG.STROKE_SAMPLE_SPACING);
    for (let k = 0; k < pts.length; k++) {
      const z = (hash1(droplets.length + 1) - 0.5) * 2.0 * CONFIG.DEPTH_JITTER;
      droplets.push({ x: pts[k][0], y: pts[k][1], z, strokeIndex: si });
      if (droplets.length >= CONFIG.MAX_DROPLETS) {
        console.warn("MAX_DROPLETS に達したため以降の水滴を打ち切りました。STROKE_SAMPLE_SPACING を広げてください。");
        return droplets;
      }
    }
  }
  return droplets;
}

const DROPLETS = buildDroplets();
const DROPLET_COUNT = DROPLETS.length;

// 進行の総ステップ。GROW_SPAN 分だけ余裕を足し、progress=1 で最後の水滴も完全に育ち切るようにする
const TOTAL_STEPS = DROPLET_COUNT + CONFIG.GROW_SPAN;

// GPUへ渡す vec4 バッファ: xyz = 中心, w = 実効半径(0 なら未出現でSDFから除外)
const dropletData = new Float32Array(DROPLET_COUNT * 4);
for (let i = 0; i < DROPLET_COUNT; i++) {
  dropletData[i * 4 + 0] = DROPLETS[i].x;
  dropletData[i * 4 + 1] = DROPLETS[i].y;
  dropletData[i * 4 + 2] = DROPLETS[i].z;
  dropletData[i * 4 + 3] = 0.0; // 初期は全部未出現
}

// progress(0..1)から各水滴の実効半径を更新する。
// "書きヘッド" head = progress * TOTAL_STEPS。水滴 i の出現度 = clamp((head - i)/GROW_SPAN, 0, 1)。
// 出現度を smoothstep で滑らかにして半径に掛ける。出現度が 0 のときは半径ちょうど 0 になり、
// シェーダー側で SDF から完全に除外される(未出現の水滴が blend に混ざる余地が無い)。
function updateDropletRadii(progress) {
  const head = progress * TOTAL_STEPS;
  for (let i = 0; i < DROPLET_COUNT; i++) {
    let a = (head - i) / CONFIG.GROW_SPAN;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    const eased = a * a * (3 - 2 * a); // smoothstep。a=0 → 0 なので半径ちょうど0
    dropletData[i * 4 + 3] = CONFIG.DROPLET_RADIUS * eased;
  }
}

// ----------------------------------------------------------------------------
// 共通GLSL(../prototype-shards/ の質感関数をそのまま流用して世界観を揃える)
// ----------------------------------------------------------------------------
const commonGLSL = `
float hash21 (vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 keyLightDir (int i) {
  if (i == 0) return normalize(vec3(0.55, 0.65, 0.5));
  if (i == 1) return normalize(vec3(-0.7, 0.22, 0.6));
  return normalize(vec3(0.15, -0.6, 0.75));
}

vec3 keyLightColor (int i) {
  if (i == 0) return vec3(1.0, 0.97, 0.9) * 3.4;
  if (i == 1) return vec3(0.55, 0.78, 1.0) * 2.6;
  return vec3(1.0, 0.6, 0.38) * 2.0;
}

// 暗いグラデーション + 3つの"スタジオ光源"風の光点 + まばらな塵。レイマーチしない安価な方向関数
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

vec3 reinhard (vec3 col) { return col / (col + vec3(1.0)); }
vec3 gammaCorrect (vec3 col) { return pow(col, vec3(1.0 / 2.2)); }

float vignette (vec2 ndc, float aspect) {
  return smoothstep(0.35, 1.15, length(vec2(ndc.x * aspect, ndc.y)));
}
`;

// ----------------------------------------------------------------------------
// フルスクリーンquad頂点シェーダー
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

// ----------------------------------------------------------------------------
// メタボールをレイマーチするフラグメントシェーダー
// COUNT はJS側で確定した水滴数を文字列として焼き込む(ループ境界は定数式である必要があるため)
// ----------------------------------------------------------------------------
const marchFragmentShaderSource = `#version 300 es
precision highp float;

#define COUNT ${DROPLET_COUNT}

in vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uFov;
uniform float uK;             // smooth-min のブレンド半径
uniform vec4 uDroplets[COUNT]; // xyz = 中心, w = 実効半径(<=0 は未出現 → SDFから除外)
uniform float uIor;
uniform float uAbbe;
uniform float uDensityTint;
out vec4 fragColor;

${commonGLSL}

// --- smooth-min ---
// IQ の "polynomial smooth min"(多項式版)。exp版(-log(exp(-k a)+exp(-k b))/k)より
// 安価で、k がそのまま距離の単位(ブレンド幅)になり直感的なのでこちらを採用。
// h=0 または h=1(=一方が他方より k 以上離れている)のとき補正項 k*h*(1-h) が
// ちょうど 0 になり、離れた面へ余計な膨らみを生まない。
float smin (float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// シーンのSDF: 全水滴の球を smooth-min で融合。
// 実効半径 <= 0 の水滴(未出現)は continue で完全にスキップし、blend に一切寄与させない。
// 初期値 1e5 は場のどの実距離(シーン半径〜2, カメラ距離〜3)より桁違いに大きいので、
// 最初の1個目の smin で h がちょうど 0 にクランプされ、番兵由来の膨らみは出ない。
float mapScene (vec3 p) {
  float d = 1e5;
  for (int i = 0; i < COUNT; i++) {
    vec4 dp = uDroplets[i];
    if (dp.w <= 0.0) continue;
    float ds = length(p - dp.xyz) - dp.w;
    d = smin(d, ds, uK);
  }
  return d;
}

// 四面体法によるSDF勾配 = 法線
vec3 calcNormal (vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0009;
  return normalize(
    e.xyy * mapScene(p + e.xyy) +
    e.yyx * mapScene(p + e.yyx) +
    e.yxy * mapScene(p + e.yxy) +
    e.xxx * mapScene(p + e.xxx)
  );
}

void main () {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  vec3 ro = uCamPos;
  vec3 rd = normalize(uForward * uFov + uRight * uv.x + uUp * uv.y);

  // レイマーチ
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < ${CONFIG.MAX_STEPS}; i++) {
    vec3 p = ro + rd * t;
    float d = mapScene(p);
    if (d < ${CONFIG.SURF_EPS.toFixed(6)}) { hit = true; break; }
    t += d;
    if (t > ${CONFIG.MAX_DIST.toFixed(1)}) break;
  }

  vec3 col;
  if (!hit) {
    col = background(rd);
  } else {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 viewDir = normalize(ro - p);
    if (dot(n, viewDir) < 0.0) n = -n; // カメラ側を向く法線に揃える
    float ndv = clamp(dot(n, viewDir), 0.0, 1.0);

    // アッベ数の定義 V_d = (n_d - 1)/(n_F - n_C) から R/G/B の屈折率差を逆算(shardsと同じ流儀)
    float dispersion = (uIor - 1.0) / uAbbe;
    float iorR = uIor - 0.4 * dispersion;
    float iorG = uIor;
    float iorB = uIor + 0.6 * dispersion;

    // Schlick近似のフレネル(空気 n=1 → ガラス n=uIor)
    float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
    float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

    vec3 reflDir = reflect(rd, n);
    vec3 reflColor = background(reflDir);

    // R/G/B それぞれ実際に別方向へ屈折させ、その方向の背景をサンプル。この3方向の
    // ズレそのものが色収差になる(単一界面近似。空気→ガラスなので全反射は起きない)
    vec3 rR = refract(rd, n, 1.0 / iorR);
    vec3 rG = refract(rd, n, 1.0 / iorG);
    vec3 rB = refract(rd, n, 1.0 / iorB);
    vec3 refrColor = vec3(background(rR).r, background(rG).g, background(rB).b);
    // うっすらした水色の吸収で"水/ガラスの厚み"の気配を出す(屈折色だけに掛ける)
    refrColor *= mix(vec3(1.0), vec3(0.82, 0.92, 1.0), uDensityTint);

    col = mix(refrColor, reflColor, clamp(fresnel, 0.0, 1.0));

    // shardsと同じ、冷たい主光源のlift + 暖色リム光でのっぺりを防ぐ
    vec3 mainLightDir = normalize(vec3(0.5, 0.8, 0.3));
    col += clamp(dot(n, mainLightDir), 0.0, 1.0) * vec3(0.05, 0.065, 0.08);
    vec3 rimLightDir = normalize(vec3(-0.6, -0.35, 0.7));
    float rim = pow(1.0 - ndv, 2.2) * clamp(dot(n, rimLightDir), 0.0, 1.0);
    col += rim * vec3(0.95, 0.55, 0.25) * 0.5;

    col += sparkle(reflDir) * vec3(1.0, 0.97, 0.92) * 7.0;
    col += vec3(0.014, 0.02, 0.032);
  }

  col = gammaCorrect(reinhard(col));
  col *= mix(1.0, 0.72, vignette(vUv, aspect));
  fragColor = vec4(col, 1.0);
}
`;

const marchProgram = createProgram(quadVertexShaderSource, marchFragmentShaderSource);

// uniform ロケーション
const uni = {
  uResolution: gl.getUniformLocation(marchProgram, "uResolution"),
  uTime: gl.getUniformLocation(marchProgram, "uTime"),
  uCamPos: gl.getUniformLocation(marchProgram, "uCamPos"),
  uForward: gl.getUniformLocation(marchProgram, "uForward"),
  uRight: gl.getUniformLocation(marchProgram, "uRight"),
  uUp: gl.getUniformLocation(marchProgram, "uUp"),
  uFov: gl.getUniformLocation(marchProgram, "uFov"),
  uK: gl.getUniformLocation(marchProgram, "uK"),
  uDroplets: gl.getUniformLocation(marchProgram, "uDroplets"),
  uIor: gl.getUniformLocation(marchProgram, "uIor"),
  uAbbe: gl.getUniformLocation(marchProgram, "uAbbe"),
  uDensityTint: gl.getUniformLocation(marchProgram, "uDensityTint"),
};

// フルスクリーンquad
const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

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
// 進行(progress)の状態管理: 自動再生 → ユーザー操作でハンドオフ
// ----------------------------------------------------------------------------
const play = {
  auto: true,
  progress: 0,
  phase: "start", // "start"(開始待ち) → "writing"(自動進行) → "hold"(完成保持) → ループで start へ
  timer: CONFIG.START_DELAY,
};

function updateAutoplay(dt) {
  if (!play.auto) return;
  if (play.phase === "start") {
    play.timer -= dt;
    if (play.timer <= 0) play.phase = "writing";
    return;
  }
  if (play.phase === "writing") {
    play.progress += dt * CONFIG.AUTO_ADVANCE_SPEED;
    if (play.progress >= 1) {
      play.progress = 1;
      play.phase = "hold";
      play.timer = CONFIG.END_HOLD;
    }
    return;
  }
  if (play.phase === "hold") {
    play.timer -= dt;
    if (play.timer <= 0) {
      play.progress = 0;
      play.phase = "start";
      play.timer = CONFIG.START_DELAY;
    }
  }
}

function handoffToUser() {
  if (play.auto) {
    play.auto = false;
    hint.classList.add("faded");
  }
}

function scrubBy(delta) {
  handoffToUser();
  play.progress = Math.min(1, Math.max(0, play.progress + delta));
}

// ドラッグ(横方向)/スクロールで手動スクラブ
const pointerState = { down: false, lastX: 0 };
canvas.addEventListener("pointerdown", (e) => {
  pointerState.down = true;
  pointerState.lastX = e.clientX;
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointerState.down) return;
  const dx = e.clientX - pointerState.lastX;
  pointerState.lastX = e.clientX;
  scrubBy(dx * CONFIG.DRAG_SCRUB_SENSITIVITY);
});
window.addEventListener("pointerup", () => {
  pointerState.down = false;
});
canvas.addEventListener("pointerleave", () => {
  pointerState.down = false;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    scrubBy(-e.deltaY * CONFIG.WHEEL_SCRUB_SENSITIVITY);
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
const startTime = performance.now();
let lastTime = startTime;

function frame() {
  const now = performance.now();
  const t = (now - startTime) / 1000;
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;

  updateAutoplay(dt);
  updateDropletRadii(play.progress);

  // カメラ: 原点(文字中心)を見つめ、ごく僅かに首を振るだけ(操作は progress スクラブに使う)
  const yaw = Math.sin(t * CONFIG.CAM_SWAY_SPEED) * CONFIG.CAM_YAW_SWAY;
  const pitch = Math.sin(t * CONFIG.CAM_SWAY_SPEED * 0.73) * CONFIG.CAM_PITCH_SWAY;
  const eye = [
    CONFIG.CAM_DIST * Math.cos(pitch) * Math.sin(yaw),
    CONFIG.CAM_DIST * Math.sin(pitch),
    CONFIG.CAM_DIST * Math.cos(pitch) * Math.cos(yaw),
  ];
  // forward = 原点方向、right = up×forward、trueUp = forward×right(shardsと同じ基底の作り方)
  const invDist = 1 / CONFIG.CAM_DIST;
  const forward = [-eye[0] * invDist, -eye[1] * invDist, -eye[2] * invDist];
  const wUp = [0, 1, 0];
  let rx = wUp[1] * forward[2] - wUp[2] * forward[1];
  let ry = wUp[2] * forward[0] - wUp[0] * forward[2];
  let rz = wUp[0] * forward[1] - wUp[1] * forward[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = forward[1] * rz - forward[2] * ry;
  const uy = forward[2] * rx - forward[0] * rz;
  const uz = forward[0] * ry - forward[1] * rx;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(marchProgram);
  gl.uniform2f(uni.uResolution, canvas.width, canvas.height);
  gl.uniform1f(uni.uTime, t);
  gl.uniform3f(uni.uCamPos, eye[0], eye[1], eye[2]);
  gl.uniform3f(uni.uForward, forward[0], forward[1], forward[2]);
  gl.uniform3f(uni.uRight, rx, ry, rz);
  gl.uniform3f(uni.uUp, ux, uy, uz);
  gl.uniform1f(uni.uFov, CONFIG.FOV);
  gl.uniform1f(uni.uK, CONFIG.SMIN_K);
  gl.uniform4fv(uni.uDroplets, dropletData);
  gl.uniform1f(uni.uIor, CONFIG.IOR);
  gl.uniform1f(uni.uAbbe, CONFIG.ABBE_NUMBER);
  gl.uniform1f(uni.uDensityTint, CONFIG.DENSITY_TINT);

  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(frame);
}

console.log(`メタボール文字「川」: 水滴 ${DROPLET_COUNT} 個(上限 ${CONFIG.MAX_DROPLETS})`);
requestAnimationFrame(frame);
