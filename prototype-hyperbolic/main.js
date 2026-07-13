// ============================================================================
// 双曲空間のレイマーチ — プロトタイプ #11
//
// 「無限に広い床 + 等間隔に並ぶ円柱」を、双曲空間 H³(双曲面モデル)の中で
// レイマーチして描画する。画面を左右分割し、まったく同じ格子(座標だけ見れば
// 等間隔グリッド)をユークリッド空間で描いた絵と並べることで、
// 「同じ格子・同じ操作入力なのに、曲率が違うだけでこれだけ見え方が変わる」
// という双曲幾何の直感しづらさを直接比較できるようにしている。
//
// 【数学的な要点(詳細は README.md)】
//  1. 双曲面モデル: H³ を R^{1,3}(ミンコフスキー空間, 符号 -+++)の中の
//     ⟨p,p⟩=-1, p.t>0 な双曲面として実装する。4成分は (t, x, y, z) の順で
//     GLSL の vec4 に (.x=t, .y=x, .z=y(上方向), .w=z) として詰める。
//  2. 床 = 全測地的な超平面(法線 (0,0,1,0))。符号付き距離は asinh(p.z)。
//  3. 円柱 = 鉛直な測地線からの距離が一定の管。測地線を
//     a=(t0,x0,0,z0)(時間的単位ベクトル), b=(0,0,1,0)(空間的単位ベクトル)
//     の張る2平面と双曲面の交わりとして定義すると、距離は
//       cosh(d) = sqrt(⟨p,a⟩² − ⟨p,b⟩²)
//     という閉じた式になる(README 参照、球面上の大円までの角距離
//     arcsin と同じ形の恒等式が双曲版として出てくる)。
//  4. スフィアトレースは通常の直線ではなく測地線に沿って進める:
//       p' = p·cosh(Δ) + d·sinh(Δ),  d' = p·sinh(Δ) + d·cosh(Δ)
//     (Δ は SDF が返した"双曲距離")。d' は毎ステップ p' への接空間へ
//     再射影して正規化し、数値誤差の蓄積を防ぐ。
//  5. 格子は「チャート座標 x0=i·S, z0=j·S を素朴に等間隔にする」だけでは
//     実は破綻する。原点から離れるほど、チャート座標上の等間隔は真の双曲
//     距離ではどんどん詰まっていき、遠方では柱同士が本当に重なってしまう
//     (実測: 半径 0.5・間隔 3.0 でも i=2 で早くも重なった)。代わりに
//     2つのローレンツブースト(x方向→z方向)の合成で格子点を作る:
//       x0 = sinh(n·S),  z0 = cosh(n·S)·sinh(m·S)
//     1径数部分群の軌道に沿う等パラメータ間隔は常に等距離になるという
//     群構造の帰結で、同じ行内(m固定, n→n+1)の間隔は原点からの遠さに
//     依らず常に S、列方向はむしろ軸から離れるほど広がる側に振れるため、
//     近づいて重なることはない(詳細は map() 内のコメントと README「格子の
//     定義について」を参照)。
//  6. カメラの前進経路は測地線ではなく「床から一定の高さを保つ等距離曲線」
//     にしてある。最初は素朴に測地線(cosh/sinh の直進輸送)で実装したところ、
//     床と平行に出発した測地線が床から指数的に遠ざかっていき、数ステップで
//     カメラが視野の外まで飛んで行ってしまった。これはバグではなく
//     「双曲空間では、ある直線に平行かつ等距離であり続ける道は直線(測地線)
//     にならない」という平行線公準が破れる核心そのものだったが、歩行カメラ
//     としては使い物にならないため、2つのローレンツブーストの合成
//     (詳細は hyperbolicCamera() 内のコメント)で床からの高さが恒等的に
//     一定になる経路に置き換えた。
//  7. 前進距離 T_MAX を大きく取れない。カメラの前進距離 t は定義上その
//     まま真の双曲距離だが、格子は原点からの「チャート座標」で作られており、
//     チャート座標は真の距離に対して対数的にしか伸びない。そのため t が
//     線形に増えるとカメラは「1マス先の柱」をあっという間に追い越し、
//     しかも柱の横オフセットは前進と可換な変換ではないため、直前まで正面に
//     あった柱が急速に真横〜背後へ回り込んで見えなくなる(実測: t=0 で正面
//     から約33°だったのが t=1.3 で90°超)。これも「同じ相対位置に固定した
//     つもりの物体が、移動するにつれ全く違う方向に見える」という非可換な
//     等長変換群由来の現象で、対策として T_MAX を小さく(0.6)、FOCAL を
//     広角(0.6)に抑えている。
//  8. 対比をさらに分かりやすくするため、通路の中心にフラクタルな木(細い
//     円柱の再帰的コピー)を1本立てている。枝分かれの規則(角度・本数・
//     減衰率・再帰段数)は buildTree() に1度だけ定義し、ユークリッド版・
//     双曲版それぞれの「フレーム(位置+3方向)を1歩分だけ前進させる」処理
//     (move())だけを差し替えて具体化する — カメラの前進と全く同じ
//     移動フレームの仕組みをそのまま再利用している。同じ生成規則が曲率の
//     違いだけでどう変わるかを、床・柱に続く3つ目の比較材料にしている。
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

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.55 : 0.85,
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // --- 格子ジオメトリ ---
  // SPACING/CYL_RADIUS はあえて左右で別値にしてある。ユークリッド側はチャート
  // 座標そのものが距離なので SPACING=3.0 のような値をそのまま使って構わないが、
  // 双曲側の格子はローレンツブーストの合成(hyperbolicPillar()参照)で作って
  // いるため、SPACING を「双曲距離」として cosh/sinh に直接渡す。3.0 のような
  // 値だと cosh(3)≈10 で1セル分の格子ですら埋め込み座標が10倍以上に暴れて格子が
  // 大きく歪む上、後述の「柱同士が重なる」問題も起きた。0.9 程度に抑えると
  // 歪みが穏やかになり、半径も追従して小さくしてある(README「格子の定義に
  // ついて」参照)。
  EUC_SPACING: 3.0,
  EUC_CYL_RADIUS: 0.5,
  HYP_SPACING: 0.9,
  HYP_CYL_RADIUS: 0.3,
  WINDOW_K: 1,         // 現在点周りに調べる格子セルの半径(±K, (2K+1)^2 本を評価)

  // カメラ高さは意図的に左右で別値。双曲側は「平行線角」(角距離 h だけ床から
  // 離れると、水平からある角度より浅い下向きのレイは床に二度と届かず彼方へ
  // 発散し続ける)の効きが height=1.0 だと強すぎ、画面のほぼ全域が空に抜けて
  // しまった。0.2 前後まで下げてようやく実用的な構図になる — これ自体
  // 「同じ見下ろし角でもユークリッドなら普通に地面が見えるのに、双曲だと
  // 屈まないと床が視界に入らない」という好対照な副産物なので、値をあえて
  // 揃えていない(README「カメラ高さについて」参照)。
  CAM_HEIGHT_EUC: 1.0,
  CAM_HEIGHT_HYP: 0.22,

  // --- カメラ / レイマーチ ---
  // FOCAL は意図的に小さく(=広角)している。理由は T_MAX のコメント参照。
  FOCAL: 0.6,
  MAX_STEPS: 84,
  SURF_EPS: 0.0015,
  STEP_SAFETY: 0.94,
  HYP_MAX_DIST: 6.0,   // レイ1本あたりの最大到達距離(双曲距離)。埋め込み座標が
                       //   cosh/sinh で指数的に増大し float32 精度を失う前に霧で隠しきる範囲に抑える
  EUC_MAX_DIST: 70.0,  // 同(ユークリッド距離)

  FOG_DENSITY_HYP: 0.75,
  FOG_DENSITY_EUC: 0.045,

  // --- 前進 / 視点操作 ---
  AUTO_SPEED: 0.09,     // 自動前進速度(t / 秒)。T_MAX が小さいのでゆっくりにして味わえるようにする
  // 前進距離の上限(双曲距離)。ここを大きくすると柱が画面から消える(README
  // 「前進距離を大きく取れない理由」参照): 格子は原点からのチャート座標に
  // 対して構築されているが、チャート座標は真の双曲距離に対して対数的にしか
  // 伸びない一方、カメラの前進距離 t は定義上そのまま真の双曲距離。そのため
  // t が線形に増えると、カメラは「1マス先の柱」の実座標をあっという間に
  // 追い越し、しかも柱側のマス目の"横オフセット"は前後移動と可換でないため、
  // 前進するほど直前まで正面にあった柱が急速に真横〜背後へ回り込んで見える
  // (実測: t=0 で正面から約33°、t=1.3 で90°超)。FOCAL を広角にして緩和は
  // したが、根本的な緩和には T_MAX を抑えるほうが効く。
  T_MAX: 0.6,
  WHEEL_SENSITIVITY: 0.0026,
  DRAG_YAW_SENSITIVITY: 0.0042,
  DRAG_PITCH_SENSITIVITY: 0.0042,
  PITCH_CLAMP: 1.3, // rad
};

// ----------------------------------------------------------------------------
// GLSL float リテラル生成
// ----------------------------------------------------------------------------
function f(x) {
  let s = Number(x).toString();
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

// ----------------------------------------------------------------------------
// フラクタルな木(細い円柱の再帰的コピー)を生成する。
//
// 「枝分かれの規則(角度・本数・長さ/太さの減衰・再帰段数)」は完全に共通の
// JS コードで1回だけ定義し、それを「ユークリッド版のフレーム(位置+3方向)」
// と「双曲版のフレーム」という2通りの adapter で具体化する。回転
// (rotateFrame)はどちらの幾何でも同じ式で書ける — フレームの3方向はすでに
// 正規直交(ユークリッドなら通常の意味で、双曲ならミンコフスキー内積の意味
// で)なので、2方向を角度θで混ぜる標準的な回転式がそのまま両方で成立する。
// 違うのは「前進」(move)だけ: ユークリッドは単純加算、双曲は測地線に沿った
// cosh/sinh の輸送(カメラの前進と全く同じ式。README「カメラの前進経路」
// 参照)。この対称性のおかげで、枝分かれの規則そのものを二重管理せずに
// 済んでいる。
// ----------------------------------------------------------------------------
const TREE_CONFIG = {
  MAX_DEPTH: 3,                       // 再帰段数(段数nで枝の本数は 2^(n+1)-1)
  BRANCH_ANGLE: 27 * Math.PI / 180,   // 親の伸長方向からの分岐角
  LENGTH_DECAY: 0.72,                 // 1段ごとの長さの減衰率
  RADIUS_DECAY: 0.68,                 // 1段ごとの太さの減衰率

  EUC_TRUNK_LENGTH: 0.85,
  EUC_TRUNK_RADIUS: 0.13,
  EUC_POS: [2.4, 0],                  // 幹の根元(x,z)。y=0 の床の上

  HYP_TRUNK_LENGTH: 0.5,
  HYP_TRUNK_RADIUS: 0.075,
  HYP_DIST_FROM_ORIGIN: 1.3,          // 幹の根元の、原点からの真の双曲距離(z=0軸上)
};

function vAddN(a, b) { return a.map((x, i) => x + b[i]); }
function vScaleN(a, s) { return a.map((x) => x * s); }

// フレーム {P, F, S1, S2} のうち2方向(axisA, axisB の張る面)を角度で回転する。
// P・第3の方向には触れない。ユークリッド(vec3)・双曲(vec4)どちらの
// フレームに対しても、同じ式のまま成立する(コメント冒頭参照)。
function rotateFrame(frame, axisA, axisB, angle) {
  const a = frame[axisA], b = frame[axisB];
  const c = Math.cos(angle), s = Math.sin(angle);
  return {
    ...frame,
    [axisA]: vAddN(vScaleN(a, c), vScaleN(b, s)),
    [axisB]: vAddN(vScaleN(a, -s), vScaleN(b, c)),
  };
}

// 共通の再帰。adapter が move()/makeSegment() で幾何ごとの具体的な計算を担う。
function buildTree(adapter, trunkLength, trunkRadius) {
  const segments = [];
  function recurse(frame, length, radius, depth, planeAxis) {
    const endFrame = adapter.move(frame, length);
    segments.push(adapter.makeSegment(frame, endFrame, length, radius));
    if (depth >= TREE_CONFIG.MAX_DEPTH) return;
    const otherAxis = planeAxis === "S1" ? "S2" : "S1";
    for (const sign of [-1, 1]) {
      const childFrame = rotateFrame(endFrame, "F", planeAxis, sign * TREE_CONFIG.BRANCH_ANGLE);
      recurse(childFrame, length * TREE_CONFIG.LENGTH_DECAY, radius * TREE_CONFIG.RADIUS_DECAY, depth + 1, otherAxis);
    }
  }
  recurse(adapter.initFrame(), trunkLength, trunkRadius, 0, "S1");
  return segments;
}

const euclideanTreeAdapter = {
  initFrame() {
    return {
      P: [TREE_CONFIG.EUC_POS[0], 0, TREE_CONFIG.EUC_POS[1]],
      F: [0, 1, 0],  // 伸長方向の初期値 = 上(床から生える)
      S1: [1, 0, 0],
      S2: [0, 0, 1],
    };
  },
  move(frame, length) {
    return { ...frame, P: vAddN(frame.P, vScaleN(frame.F, length)) };
  },
  makeSegment(startFrame, endFrame, length, radius) {
    return { A: startFrame.P, B: endFrame.P, r: radius };
  },
};

// 双曲版。初期フレームは原点から双曲距離 s だけ x軸(z=0, 床の上)を進んだ点。
// F=(0,0,1,0) は床のどの点でも常に接空間内で単位・直交な「上方向」になる
// (floorSDF の法線 (0,0,1,0) と同じベクトル。mdot(P,(0,0,1,0))=0 が任意の
// P=(t0,x0,0,z0) で成り立つことから)。S1 はカメラの forward tangent と
// 同じ式(原点から半径方向に伸びる接ベクトル)、S2 は横方向。
const hyperbolicTreeAdapter = {
  initFrame() {
    const s = TREE_CONFIG.HYP_DIST_FROM_ORIGIN;
    const ch = Math.cosh(s), sh = Math.sinh(s);
    return {
      P: [ch, sh, 0, 0],
      F: [0, 0, 1, 0],
      S1: [sh, ch, 0, 0],
      S2: [0, 0, 0, 1],
    };
  },
  move(frame, length) {
    const ch = Math.cosh(length), sh = Math.sinh(length);
    return {
      P: vAddN(vScaleN(frame.P, ch), vScaleN(frame.F, sh)),
      F: vAddN(vScaleN(frame.P, sh), vScaleN(frame.F, ch)),
      // S1, S2 は F 方向への移動と直交しているため不変(カメラの move と同じ理屈)
      S1: frame.S1,
      S2: frame.S2,
    };
  },
  makeSegment(startFrame, _endFrame, length, radius) {
    return { A: startFrame.P, D: startFrame.F, L: length, r: radius };
  },
};

const eucTreeSegments = buildTree(euclideanTreeAdapter, TREE_CONFIG.EUC_TRUNK_LENGTH, TREE_CONFIG.EUC_TRUNK_RADIUS);
const hypTreeSegments = buildTree(hyperbolicTreeAdapter, TREE_CONFIG.HYP_TRUNK_LENGTH, TREE_CONFIG.HYP_TRUNK_RADIUS);

// ----------------------------------------------------------------------------
// GLSL 配列リテラル生成
// ----------------------------------------------------------------------------
function glslVec3Array(name, vecs) {
  const items = vecs.map((v) => `vec3(${f(v[0])}, ${f(v[1])}, ${f(v[2])})`).join(", ");
  return `const vec3 ${name}[${vecs.length}] = vec3[${vecs.length}](${items});`;
}
function glslVec4Array(name, vecs) {
  const items = vecs.map((v) => `vec4(${f(v[0])}, ${f(v[1])}, ${f(v[2])}, ${f(v[3])})`).join(", ");
  return `const vec4 ${name}[${vecs.length}] = vec4[${vecs.length}](${items});`;
}
function glslFloatArray(name, nums) {
  const items = nums.map((x) => f(x)).join(", ");
  return `const float ${name}[${nums.length}] = float[${nums.length}](${items});`;
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

const SHARED_SHADING = `
vec3 skyColor(vec2 uv) {
  vec3 skyTop = vec3(0.021, 0.03, 0.058);
  vec3 skyBot = vec3(0.05, 0.068, 0.108);
  return mix(skyBot, skyTop, clamp(uv.y * 0.5 + 0.5, 0.0, 1.0));
}

// matId: 0=床, 1=柱, 2=木(フラクタルツリー)
vec3 shade(vec3 n, vec3 viewDir, float matId, vec2 p2, float spacing) {
  float diff = max(dot(n, viewDir), 0.0);
  float amb = 0.16;
  vec3 floorCol = vec3(0.09, 0.12, 0.17);
  vec3 pillarCol = vec3(0.86, 0.72, 0.48);
  vec3 treeCol = vec3(0.58, 0.33, 0.20);
  vec3 base = matId < 0.5 ? floorCol : (matId < 1.5 ? pillarCol : treeCol);
  vec3 col = base * (amb + 0.95 * diff);
  float isFloorF = matId < 0.5 ? 1.0 : 0.0;
  float gx = abs(fract(p2.x / spacing + 0.5) - 0.5);
  float gz = abs(fract(p2.y / spacing + 0.5) - 0.5);
  float gridLine = 1.0 - smoothstep(0.0, 0.05, min(gx, gz));
  col = mix(col, col * 1.35, gridLine * isFloorF * 0.5);
  return col;
}
`;

const EUC_FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uResolution;
uniform float uViewportX; // このペインのビューポートXオフセット(gl_FragCoordはウィンドウ座標なので補正が要る)
uniform vec3 uP;
uniform vec3 uF;
uniform vec3 uR;
uniform vec3 uU;

const float SPACING    = ${f(CONFIG.EUC_SPACING)};
const float CYL_RADIUS = ${f(CONFIG.EUC_CYL_RADIUS)};
const float FOCAL      = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS  = ${Math.round(CONFIG.MAX_STEPS)};
const float SURF_EPS   = ${f(CONFIG.SURF_EPS)};
const float MAX_DIST   = ${f(CONFIG.EUC_MAX_DIST)};
const float FOG_DENSITY = ${f(CONFIG.FOG_DENSITY_EUC)};

${SHARED_SHADING}

float floorSDF(vec3 p) { return p.y; }

float cylSDF(vec3 p, float x0, float z0) {
  vec2 q = p.xz - vec2(x0, z0);
  return length(q) - CYL_RADIUS;
}

float pillarSDF(vec3 p) {
  float d = 1e9;
  float ix0 = floor(p.x / SPACING + 0.5);
  // z(横)方向は半セル分オフセットした格子にする。カメラは z=0 に沿って
  // 直進するので、オフセット無しだと柱の列がちょうど進行経路の真上に並んで
  // しまい正面衝突コースになる。半セルずらして通路の両脇に柱を並べる。
  float iz0 = floor(p.z / SPACING);
  for (int di = -${CONFIG.WINDOW_K}; di <= ${CONFIG.WINDOW_K}; di++) {
    for (int dj = -${CONFIG.WINDOW_K}; dj <= ${CONFIG.WINDOW_K}; dj++) {
      float x0 = (ix0 + float(di)) * SPACING;
      float z0 = (iz0 + float(dj) + 0.5) * SPACING;
      d = min(d, cylSDF(p, x0, z0));
    }
  }
  return d;
}

// フラクタルな木(細い円柱=カプセルの再帰的コピー)。本数は固定・小規模
// なので窓探索はせず、全本を毎回チェックする。
${glslVec3Array("TREE_A", eucTreeSegments.map((s) => s.A))}
${glslVec3Array("TREE_B", eucTreeSegments.map((s) => s.B))}
${glslFloatArray("TREE_R", eucTreeSegments.map((s) => s.r))}
const int TREE_COUNT = ${eucTreeSegments.length};

float capsuleSDF(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float treeSDF(vec3 p) {
  float d = 1e9;
  for (int i = 0; i < TREE_COUNT; i++) {
    d = min(d, capsuleSDF(p, TREE_A[i], TREE_B[i], TREE_R[i]));
  }
  return d;
}

float map(vec3 p) {
  return min(floorSDF(p), min(pillarSDF(p), treeSDF(p)));
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}

void main() {
  vec2 fragXY = vec2(gl_FragCoord.x - uViewportX, gl_FragCoord.y);
  vec2 uv = (fragXY - 0.5 * uResolution) / uResolution.y;
  vec3 ro = uP;
  vec3 rd = normalize(uv.x * uR + uv.y * uU + FOCAL * uF);

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < SURF_EPS) { hit = true; break; }
    t += d;
    if (t > MAX_DIST) break;
  }

  vec3 fogColor = skyColor(uv);
  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    float fd = floorSDF(p), pd = pillarSDF(p), td = treeSDF(p);
    float matId = 0.0, best = fd;
    if (pd < best) { best = pd; matId = 1.0; }
    if (td < best) { best = td; matId = 2.0; }
    col = shade(n, -rd, matId, p.xz, SPACING);
  } else {
    col = fogColor;
  }
  float fogAmt = 1.0 - exp(-t * FOG_DENSITY);
  col = mix(col, fogColor, fogAmt);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  outColor = vec4(col, 1.0);
}`;

const HYP_FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uResolution;
uniform float uViewportX; // このペインのビューポートXオフセット(gl_FragCoordはウィンドウ座標なので補正が要る)
// カメラ(双曲面上の点 + 接空間の正規直交フレーム)。各 vec4 は (t, x, y, z) の順。
uniform vec4 uP;
uniform vec4 uF;
uniform vec4 uR;
uniform vec4 uU;

const float SPACING    = ${f(CONFIG.HYP_SPACING)};
const float CYL_RADIUS = ${f(CONFIG.HYP_CYL_RADIUS)};
const float FOCAL      = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS  = ${Math.round(CONFIG.MAX_STEPS)};
const float SURF_EPS   = ${f(CONFIG.SURF_EPS)};
const float MAX_DIST   = ${f(CONFIG.HYP_MAX_DIST)};
const float STEP_SAFETY = ${f(CONFIG.STEP_SAFETY)};
const float FOG_DENSITY = ${f(CONFIG.FOG_DENSITY_HYP)};

${SHARED_SHADING}

// ミンコフスキー内積 (符号 -+++)。成分順は (t,x,y,z) = (.x,.y,.z,.w)。
float mdot(vec4 a, vec4 b) {
  return -a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

// 床 = 法線 (0,0,1,0) を持つ全測地的超平面までの符号付き距離
float floorSDF(vec4 p) { return asinh(p.z); }

// 点 (x0,0,z0) を通る鉛直測地線までの距離 - 半径。
// 測地線は a=(t0,x0,0,z0)(時間的), b=(0,0,1,0)(空間的) の張る2平面との交線。
// cosh(d) = sqrt(⟨p,a⟩² − ⟨p,b⟩²) (README 参照)。
float cylSDF(vec4 p, float x0, float z0) {
  float t0 = sqrt(1.0 + x0 * x0 + z0 * z0);
  float pa = -p.x * t0 + p.y * x0 + p.w * z0;
  float pb = p.z;
  float c = sqrt(max(pa * pa - pb * pb, 1.0));
  return acosh(c) - CYL_RADIUS;
}

// 柱の格子はチャート座標 x0=n*SPACING, z0=m*SPACING の素朴な等間隔では
// 置かない。原点から離れるほど「チャート座標での等間隔」は真の双曲距離では
// どんどん詰まっていき(x0=i*S と (i+1)*S の実際の双曲距離は i が増えるほど
// 単調に縮み、遠方では柱同士が重なってしまう)、これは意図した「等間隔に
// 並ぶ円柱」になっていなかった(README「格子の定義について」参照)。
// 代わりに2つのローレンツブースト(x方向→z方向)の合成で格子点を生成する:
//   x0 = sinh(n·SPACING)
//   z0 = cosh(n·SPACING)·sinh(m·SPACING)
// 1径数部分群の軌道に沿う等パラメータ間隔は常に等距離(isometryの群構造の
// 帰結)になるため、同じ行内(m固定, n→n+1)の隣接柱は原点からの遠さに依らず
// 常にちょうど SPACING だけ離れる。列方向(n固定, m→m+1)の間隔は軸から
// 離れるほどむしろ広がる側に振れるため、近づいて重なることはない。
float pillarSDF(vec4 p) {
  float d = 1e9;
  // p.y ≈ x0 とみなして n を逆算(asinh の逆関数)。
  float nCenter = floor(asinh(p.y) / SPACING + 0.5);
  for (int di = -${CONFIG.WINDOW_K}; di <= ${CONFIG.WINDOW_K}; di++) {
    float n = nCenter + float(di);
    float chN = cosh(n * SPACING);
    // z0 = chN·sinh(m·SPACING) を p.w から逆算(半セルオフセットは m 側に持たせる)
    float mCenter = floor(asinh(p.w / chN) / SPACING);
    for (int dj = -${CONFIG.WINDOW_K}; dj <= ${CONFIG.WINDOW_K}; dj++) {
      float m = mCenter + float(dj) + 0.5;
      float x0 = sinh(n * SPACING);
      float z0 = chN * sinh(m * SPACING);
      d = min(d, cylSDF(p, x0, z0));
    }
  }
  return d;
}

// フラクタルな木。各枝は測地線分に沿った「有限の管」(カプセルの双曲版)。
// 枝を定義する A(始点), D(始点での接ベクトル=測地線の向き), L(弧長) から、
// 無限測地線上の最近点のパラメータ s* を求めて [0,L] にクランプすることで
// 「線分までの距離」にする。導出は cylSDF の無限直線版と同じ分解
// (P = c_A·A + c_D·D + 直交成分)を使う: c_A=-⟨P,A⟩, c_D=⟨P,D⟩ とすると
// 無限測地線上の最近点は A·cosh(s*) + D·sinh(s*) の形に書け、
// cosh(s*)=c_A/k, sinh(s*)=c_D/k (k=sqrt(c_A²-c_D²)) を満たすので
// s* = asinh(c_D/k) で復元できる。
${glslVec4Array("TREE_A", hypTreeSegments.map((s) => s.A))}
${glslVec4Array("TREE_D", hypTreeSegments.map((s) => s.D))}
${glslFloatArray("TREE_L", hypTreeSegments.map((s) => s.L))}
${glslFloatArray("TREE_R", hypTreeSegments.map((s) => s.r))}
const int TREE_COUNT = ${hypTreeSegments.length};

float hCapsuleSDF(vec4 p, vec4 A, vec4 D, float L, float r) {
  float cA = -mdot(p, A);
  float cD = mdot(p, D);
  float k = sqrt(max(cA * cA - cD * cD, 1.0));
  float s = clamp(asinh(cD / k), 0.0, L);
  vec4 Q = A * cosh(s) + D * sinh(s);
  return acosh(max(-mdot(p, Q), 1.0)) - r;
}

float treeSDF(vec4 p) {
  float d = 1e9;
  for (int i = 0; i < TREE_COUNT; i++) {
    d = min(d, hCapsuleSDF(p, TREE_A[i], TREE_D[i], TREE_L[i], TREE_R[i]));
  }
  return d;
}

float map(vec4 p) {
  return min(floorSDF(p), min(pillarSDF(p), treeSDF(p)));
}

// シェーディング用法線: p を双曲面に載ったベクトルとみなさず、周辺の空間成分
// (y,z,w) 方向への通常の中心差分で近似する(見た目のためのプラグマティックな
// 近似。SDF 自体の距離値は厳密だが、法線はここだけ簡略化している)。
vec3 calcNormal(vec4 p) {
  float e = 0.001;
  float dy = map(p + vec4(0.0, e, 0.0, 0.0)) - map(p - vec4(0.0, e, 0.0, 0.0));
  float dz = map(p + vec4(0.0, 0.0, e, 0.0)) - map(p - vec4(0.0, 0.0, e, 0.0));
  float dw = map(p + vec4(0.0, 0.0, 0.0, e)) - map(p - vec4(0.0, 0.0, 0.0, e));
  return normalize(vec3(dy, dz, dw));
}

void main() {
  vec2 fragXY = vec2(gl_FragCoord.x - uViewportX, gl_FragCoord.y);
  vec2 uv = (fragXY - 0.5 * uResolution) / uResolution.y;

  vec4 p = uP;
  float lenSq = uv.x * uv.x + uv.y * uv.y + FOCAL * FOCAL;
  // uR, uU, uF は互いにミンコフスキー正規直交かつ uP に直交するので、
  // 通常のユークリッド正規化がそのままこの1次結合の単位接ベクトル化になる。
  vec4 rd = (uv.x * uR + uv.y * uU + FOCAL * uF) / sqrt(lenSq);

  float travelled = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    float dist = map(p);
    if (dist < SURF_EPS) { hit = true; break; }
    float step = dist * STEP_SAFETY;
    vec4 newP = p * cosh(step) + rd * sinh(step);
    vec4 newD = p * sinh(step) + rd * cosh(step);
    // 接空間への再射影(v_tan = v + ⟨v,P⟩P, ⟨P,P⟩=-1 を利用)+ 正規化でドリフトを抑える
    newD = newD + mdot(newD, newP) * newP;
    newD = newD / sqrt(max(mdot(newD, newD), 1e-6));
    p = newP;
    rd = newD;
    travelled += step;
    if (travelled > MAX_DIST) break;
  }

  vec3 fogColor = skyColor(uv);
  vec3 col;
  if (hit) {
    vec3 n = calcNormal(p);
    vec3 viewDirApprox = normalize(vec3(-rd.y, -rd.z, -rd.w));
    float fd = floorSDF(p), pd = pillarSDF(p), td = treeSDF(p);
    float matId = 0.0, best = fd;
    if (pd < best) { best = pd; matId = 1.0; }
    if (td < best) { best = td; matId = 2.0; }
    col = shade(n, viewDirApprox, matId, vec2(p.y, p.w), SPACING);
  } else {
    col = fogColor;
  }
  float fogAmt = 1.0 - exp(-travelled * FOG_DENSITY);
  col = mix(col, fogColor, fogAmt);
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

const eucProgram = createProgram(VERT_SRC, EUC_FRAG_SRC);
const eucU = {
  resolution: gl.getUniformLocation(eucProgram, "uResolution"),
  viewportX: gl.getUniformLocation(eucProgram, "uViewportX"),
  P: gl.getUniformLocation(eucProgram, "uP"),
  F: gl.getUniformLocation(eucProgram, "uF"),
  R: gl.getUniformLocation(eucProgram, "uR"),
  U: gl.getUniformLocation(eucProgram, "uU"),
};

const hypProgram = createProgram(VERT_SRC, HYP_FRAG_SRC);
const hypU = {
  resolution: gl.getUniformLocation(hypProgram, "uResolution"),
  viewportX: gl.getUniformLocation(hypProgram, "uViewportX"),
  P: gl.getUniformLocation(hypProgram, "uP"),
  F: gl.getUniformLocation(hypProgram, "uF"),
  R: gl.getUniformLocation(hypProgram, "uR"),
  U: gl.getUniformLocation(hypProgram, "uU"),
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
}
window.addEventListener("resize", resize);
resize();

// ----------------------------------------------------------------------------
// カメラの数学(JS 側は倍精度で計算し、毎フレーム 2組の vec4/vec3 フレームを
// uniform として GPU に渡す。双曲側・ユークリッド側は「同じ入力(t, yaw,
// pitch)を、それぞれの幾何の直進・回転の公式に通す」という完全に並行な構造
// にしてあるので、見え方の違いは純粋に幾何(曲率)の差から来る。
// ----------------------------------------------------------------------------
function v4(a, b, c, d) { return [a, b, c, d]; }
function v4add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]; }
function v4scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s, a[3] * s]; }
function v3add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function v3scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

// 双曲面モデルのカメラ。t=前進距離、yaw/pitch=見回し角、height=床からの高さ。
//
// 注意: 前進を「測地線」に沿わせてはいけない。双曲空間では、ある超平面(床)
// に接する方向へ出発した測地線は、その超平面から指数的に遠ざかっていく
// (「一直線に等距離であり続ける道」は測地線にならない、というのが双曲幾何
// で平行線公準が破れる所以そのもの)。歩行カメラとして自然な「常に床から
// 高さ h を保ったまま前進する」経路は、測地線ではなく等距離曲線であり、
// 2つのローレンツブースト(高さ方向→前進方向の順)を原点の正規直交フレーム
// に合成適用することで得られる。ブーストは等長写像なので、フレーム全体に
// 同じ行列を掛けるだけで正規直交性が自動的に保たれる。
//   1. 高さ方向ブースト(t,y成分を混ぜる) を原点フレームへ:
//        P0=(ch,0,sh,0), F0=(0,1,0,0)(不変), R0=(0,0,0,1)(不変), U0=(sh,0,ch,0)
//   2. 前進方向ブースト(t,x成分を混ぜる) を上記へさらに適用:
//        P(t) = (ch·ct, ch·st, sh, 0)   ← .z(床からの高さ成分)が sh のまま一定!
//        F(t) = (st, ct, 0, 0)
//        R(t) = (0, 0, 0, 1)             ← 不変
//        U(t) = (sh·ct, sh·st, ch, 0)
// floorSDF(P(t)) = asinh(sh) = height が t に依らず一定になることが直接確認できる
// (格子の柱と同じ「チャート座標を素朴に動かす」設計思想に合わせてある)。
// その後 yaw→pitch の順に、接空間内の通常の回転として視線フレームへ回す。
function hyperbolicCamera(t, yaw, pitch, height) {
  const ch = Math.cosh(height), sh = Math.sinh(height);
  const ct = Math.cosh(t), st = Math.sinh(t);

  const P = v4(ch * ct, ch * st, sh, 0);
  const Ft = v4(st, ct, 0, 0);
  const R0 = v4(0, 0, 0, 1);
  const Ut = v4(sh * ct, sh * st, ch, 0);

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Fy = v4add(v4scale(Ft, cy), v4scale(R0, sy));
  const Ry = v4add(v4scale(Ft, -sy), v4scale(R0, cy));

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Fp = v4add(v4scale(Fy, cp), v4scale(Ut, sp));
  const Up = v4add(v4scale(Fy, -sp), v4scale(Ut, cp));

  return { P, F: Fp, R: Ry, U: Up };
}

// ユークリッド版。x=前進距離(=t をそのまま平行移動量として使う), y=高さ, z=横。
// 上と全く同じ回転式(yaw→pitch)を使い、直進だけが「t を足すだけ」に変わる。
function euclideanCamera(t, yaw, pitch, height) {
  const P0 = [t, height, 0];
  const F0 = [1, 0, 0];
  const R0 = [0, 0, 1];
  const U0 = [0, 1, 0];

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Fy = v3add(v3scale(F0, cy), v3scale(R0, sy));
  const Ry = v3add(v3scale(F0, -sy), v3scale(R0, cy));

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Fp = v3add(v3scale(Fy, cp), v3scale(U0, sp));
  const Up = v3add(v3scale(Fy, -sp), v3scale(U0, cp));

  return { P: P0, F: Fp, R: Ry, U: Up };
}

// ----------------------------------------------------------------------------
// Input — 自動前進(t)を基本に、ドラッグで見回し(yaw/pitch)、
//   ホイールで前進速度を上乗せ(慣性減衰)。prototype-infinite-corridor の
//   auto-advance + drag パターンを踏襲。
// ----------------------------------------------------------------------------
let t = 0.0;
let tVelocity = 0;
let yaw = 0;
let pitch = 0;

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
  tVelocity += -e.deltaY * CONFIG.WHEEL_SENSITIVITY;
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
  yaw += dx * CONFIG.DRAG_YAW_SENSITIVITY;
  pitch = Math.max(-CONFIG.PITCH_CLAMP, Math.min(CONFIG.PITCH_CLAMP, pitch - dy * CONFIG.DRAG_PITCH_SENSITIVITY));
});
function endDrag() { dragging = false; }
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

setTimeout(() => { if (!userEngaged) hint.classList.add("faded"); }, 6000);

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let startTime = performance.now();
let lastTime = startTime;

function drawPane(program, uLoc, viewportX, viewportW, cam) {
  gl.viewport(viewportX, 0, viewportW, fullH);
  gl.useProgram(program);
  gl.bindVertexArray(emptyVAO);
  gl.uniform2f(uLoc.resolution, viewportW, fullH);
  gl.uniform1f(uLoc.viewportX, viewportX);
  if (cam.P.length === 4) {
    gl.uniform4fv(uLoc.P, cam.P);
    gl.uniform4fv(uLoc.F, cam.F);
    gl.uniform4fv(uLoc.R, cam.R);
    gl.uniform4fv(uLoc.U, cam.U);
  } else {
    gl.uniform3fv(uLoc.P, cam.P);
    gl.uniform3fv(uLoc.F, cam.F);
    gl.uniform3fv(uLoc.R, cam.R);
    gl.uniform3fv(uLoc.U, cam.U);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  try {
    t += CONFIG.AUTO_SPEED * dt;
    t += tVelocity;
    tVelocity *= 0.85;
    t = Math.max(0, Math.min(CONFIG.T_MAX, t));

    const eucCam = euclideanCamera(t, yaw, pitch, CONFIG.CAM_HEIGHT_EUC);
    const hypCam = hyperbolicCamera(t, yaw, pitch, CONFIG.CAM_HEIGHT_HYP);

    const halfW = Math.floor(fullW / 2);
    drawPane(eucProgram, eucU, 0, halfW, eucCam);
    drawPane(hypProgram, hypU, halfW, fullW - halfW, hypCam);
  } catch (err) {
    console.error(err);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
