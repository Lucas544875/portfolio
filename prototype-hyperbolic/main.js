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
//  6. カメラが床から一定の高さへ昇降する経路は測地線ではなく「床から一定の
//     高さを保つ等距離曲線」にしてある。最初は素朴に測地線(cosh/sinh の
//     直進輸送)で実装したところ、床と平行に出発した測地線が床から指数的に
//     遠ざかっていき、数ステップでカメラが視野の外まで飛んで行ってしまった。
//     これはバグではなく「双曲空間では、ある直線に平行かつ等距離であり続け
//     る道は直線(測地線)にならない」という平行線公準が破れる核心そのもの
//     だったが、歩行カメラとしては使い物にならないため、2つのローレンツ
//     ブーストの合成(詳細は curvedCamera() 内のコメント)で床からの
//     高さが恒等的に一定になる経路に置き換えた。
//  7. カメラは「まっすぐ前進」ではなく、木を中心とする円軌道を周回する。
//     以前はまっすぐ前進する経路だったが、カメラの前進距離 t は定義上その
//     まま真の双曲距離である一方、格子は原点からの「チャート座標」で作ら
//     れており、チャート座標は真の距離に対して対数的にしか伸びない。その
//     ため t が線形に増えるとカメラは「1マス先の柱」をあっという間に追い
//     越し、しかも柱の横オフセットは前進と可換な変換ではないため、直前
//     まで正面にあった柱が急速に真横〜背後へ回り込んで見えなくなった
//     (実測: t=0 で正面から約33°だったのが t=1.3 で90°超)。「対象からの
//     距離を一定に保ったまま回り込む」周回に変えると、この問題はそもそも
//     起きない(距離が変わらないので非可換性の影響を受けない)。周回の
//     数学は木の生成コードと同じ「dir(θ)=S1·cosθ+S2·sinθ という接空間内で
//     回転する方向へ測地線移動する」パターンの再利用(curvedCamera()
//     内のコメント参照)。
//  8. 対比をさらに分かりやすくするため、周回の中心にフラクタルな木(細い
//     円柱の再帰的コピー)を1本立てている。枝分かれの規則(角度・本数・
//     減衰率・再帰段数)は buildTree() に1度だけ定義し、ユークリッド版・
//     双曲版それぞれの「フレーム(位置+3方向)を1歩分だけ前進させる」処理
//     (move())だけを差し替えて具体化する。同じ生成規則が曲率の違いだけで
//     どう変わるかを、床・柱に続く3つ目の比較材料にしている。
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
  // 双曲側の格子はローレンツブーストの合成(pillarSDF()参照)で作って
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
  FOCAL: 0.6,          // 広角寄り。木と周囲の柱を同時に画角へ収めるため
  MAX_STEPS: 84,
  SURF_EPS: 0.0015,
  STEP_SAFETY: 0.94,
  HYP_MAX_DIST: 6.0,   // レイ1本あたりの最大到達距離(双曲距離)。埋め込み座標が
                       //   cosh/sinh で指数的に増大し float32 精度を失う前に霧で隠しきる範囲に抑える
  EUC_MAX_DIST: 70.0,  // 同(ユークリッド距離)

  FOG_DENSITY_HYP: 0.75,
  FOG_DENSITY_EUC: 0.045,

  // --- 周回軌道 / 視点操作 ---
  // カメラは木を中心にした円軌道(ユークリッド版は普通の円、双曲版は木を
  // 中心とする双曲円)を周回する。以前は「まっすぐ前進」経路だったが、
  // それだと(README「前進すると格子が急速に真横・背後へ回り込む」参照)
  // 双曲側は前進するほど固定した目印(柱)が視野からすぐ外れてしまい、木を
  // 中心に置いても前進では素通りするだけだった。周回にすると木からの距離
  // (ORBIT_RADIUS)が終始一定に保たれるため、この問題がそもそも起きない
  // ——「対象からの距離を変えずに回り込む」動きは非可換性の影響を受けない。
  //
  // 半径の値は「周回円が柱と衝突しない」ことを Node.js で全周(θ を細かく
  // 走査)確認した上で決めている。最初 EUC=2.0, HYP=0.9 で試したところ、
  // どちらも円軌道の一部が柱の内部を通ってしまい(クリアランスが負)、
  // 該当角度でレイマーチが「カメラが柱の中」という縮退状態になって画面が
  // 単色で塗り潰されるバグを引いた。半径を縮めてクリアランスを確保している
  // (詳細は README「周回半径の衝突判定」参照)。
  ORBIT_RADIUS_EUC: 0.95,
  ORBIT_RADIUS_HYP: 0.38,
  // 曲率スライダー(K∈[-1,1])を導入した際、木の根元に近い柱は K によって
  // 周回軌道と衝突しうることが分かった。木からこの距離より近い柱は
  // pillarSDF() 側で丸ごと除外する(詳細はそちらのコメントと README
  // 「曲率のパラメータ化」参照)。0.9 は K∈[-1,1] 全域・全周(θ)を
  // Node.js で走査し、最小クリアランスが正になることを確認した値。
  TREE_EXCLUSION_RADIUS: 0.9,
  AUTO_SPEED: 0.12,     // 自動周回速度(rad / 秒)。2π/0.12 ≈ 52秒で一周
  WHEEL_SENSITIVITY: 0.0004,
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

// ----------------------------------------------------------------------------
// 曲率 K の一般化三角関数(JS 側・倍精度版)。GLSL 側の cosK/sinK と完全に
// 対になっている(導出・恒等式は HYP_FRAG_SRC 内のコメントおよび README
// 「曲率のパラメータ化」を参照)。K<0: cosh/sinh(双曲空間)、K>0: cos/sin
// (球面)、|K|→0: 1/x(ユークリッド空間)にシームレスに一致する。
// ----------------------------------------------------------------------------
const K_EPS = 0.02;
function cosK(x, K) {
  const ak = Math.abs(K);
  if (ak < K_EPS) return 1.0;
  const sq = Math.sqrt(ak);
  return K > 0 ? Math.cos(sq * x) : Math.cosh(sq * x);
}
function sinK(x, K) {
  const ak = Math.abs(K);
  if (ak < K_EPS) return x;
  const sq = Math.sqrt(ak);
  return K > 0 ? Math.sin(sq * x) / sq : Math.sinh(sq * x) / sq;
}

// 曲率 K でパラメータ化した木の adapter。K=-1 のとき、以前の
// hyperbolicTreeAdapter と完全に一致する(恒等式は末尾のコメント参照)。
// 初期フレームは原点から距離 s だけ x軸(z=0, 床の上)方向へ一般化ブースト
// した点。F=(0,0,1,0) は床のどの点でも常に接空間内で単位・直交な
// 「上方向」になる(floorSDF の法線と同じベクトル。gdot(P,(0,0,1,0))=0 が
// 任意の床上の点 P で成り立つことから、曲率によらず成立する)。S1 はカメラの
// forward tangent と同じ式(原点から半径方向に伸びる接ベクトル)、S2 は
// 横方向。
function curvedTreeAdapter(K) {
  return {
    initFrame() {
      const s = TREE_CONFIG.HYP_DIST_FROM_ORIGIN;
      const c = cosK(s, K), sn = sinK(s, K);
      return {
        P: [c, sn, 0, 0],
        F: [0, 0, 1, 0],
        S1: [-K * sn, c, 0, 0],
        S2: [0, 0, 0, 1],
      };
    },
    move(frame, length) {
      const c = cosK(length, K), sn = sinK(length, K);
      return {
        P: vAddN(vScaleN(frame.P, c), vScaleN(frame.F, sn)),
        F: vAddN(vScaleN(frame.P, -K * sn), vScaleN(frame.F, c)),
        // S1, S2 は F 方向への移動と直交しているため不変(カメラの move と同じ理屈)
        S1: frame.S1,
        S2: frame.S2,
      };
    },
    makeSegment(startFrame, _endFrame, length, radius) {
      return { A: startFrame.P, D: startFrame.F, L: length, r: radius };
    },
  };
}

const eucTreeSegments = buildTree(euclideanTreeAdapter, TREE_CONFIG.EUC_TRUNK_LENGTH, TREE_CONFIG.EUC_TRUNK_RADIUS);
// シェーダーの uniform 配列サイズ(枝の本数)を決めるためだけに1回生成する。
// 実際に描画で使う座標値は、K が変わるたびに毎フレーム再生成する(frame() 参照)。
const hypTreeSegmentCount = buildTree(curvedTreeAdapter(-1), TREE_CONFIG.HYP_TRUNK_LENGTH, TREE_CONFIG.HYP_TRUNK_RADIUS).length;

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
// カメラ(定曲率空間上の点 + 接空間の正規直交フレーム)。各 vec4 は (t, x, y, z) の順。
uniform vec4 uP;
uniform vec4 uF;
uniform vec4 uR;
uniform vec4 uU;
uniform float uK; // 曲率。負=双曲空間、0=ユークリッド空間、正=球面(README「曲率のパラメータ化」参照)
// 木は uK が変わるたびに JS 側で再生成し、毎フレーム uniform として渡す
// (const 配列に焼き込むと曲率を変えるたびにシェーダー再コンパイルが必要になり、
// スライダーの応答が重くなる)。
uniform vec4 uTreeA[${hypTreeSegmentCount}];
uniform vec4 uTreeD[${hypTreeSegmentCount}];
uniform float uTreeL[${hypTreeSegmentCount}];
uniform float uTreeR[${hypTreeSegmentCount}];

const float SPACING    = ${f(CONFIG.HYP_SPACING)};
const float CYL_RADIUS = ${f(CONFIG.HYP_CYL_RADIUS)};
const float FOCAL      = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS  = ${Math.round(CONFIG.MAX_STEPS)};
const float SURF_EPS   = ${f(CONFIG.SURF_EPS)};
const float MAX_DIST   = ${f(CONFIG.HYP_MAX_DIST)};
const float STEP_SAFETY = ${f(CONFIG.STEP_SAFETY)};
const float FOG_DENSITY = ${f(CONFIG.FOG_DENSITY_HYP)};
const int   TREE_COUNT = ${hypTreeSegmentCount};
const float K_EPS = 0.02; // これより |uK| が小さければユークリッド(平坦)扱いにする

${SHARED_SHADING}

// 曲率 uK で一般化した内積。時間成分の重みに 1/uK を持たせることで、
// 位置ベクトル P は ⟨P,P⟩=1/uK、接ベクトル(方向)F は ⟨F,F⟩=1 という
// 規約を全ての曲率で保つ(README「曲率のパラメータ化」参照)。
// uK<0 ではミンコフスキー内積(元の mdot と一致)、uK>0 では符号が反転して
// 通常のユークリッド内積(球面の埋め込み)として働く。|uK|→0 では時間成分の
// 寄与がそのまま消え、空間成分だけの通常のユークリッド内積に自然に一致する
// ——実際 0 除算はせず、その場合だけ明示的に分岐する。
float gdot(vec4 a, vec4 b) {
  float spatial = a.y * b.y + a.z * b.z + a.w * b.w;
  if (abs(uK) < K_EPS) return spatial;
  return a.x * b.x / uK + spatial;
}

// 一般化三角関数。測地線に沿った移動 P(s)=P0*cosK(s)+F0*sinK(s) が
// 全ての符号の uK で成立する(uK<0: cosh/sinh、uK>0: cos/sin、
// uK→0: cosK→1, sinK→x に一致)。
float cosK(float x) {
  float ak = abs(uK);
  if (ak < K_EPS) return 1.0;
  float sq = sqrt(ak);
  return uK > 0.0 ? cos(sq * x) : cosh(sq * x);
}
float sinK(float x) {
  float ak = abs(uK);
  if (ak < K_EPS) return x;
  float sq = sqrt(ak);
  return uK > 0.0 ? sin(sq * x) / sq : sinh(sq * x) / sq;
}
// sinK の逆関数。uK→0 でも(1階微分が有限なので)桁落ちせず安定。
float asinK(float v) {
  float ak = abs(uK);
  if (ak < K_EPS) return v;
  float sq = sqrt(ak);
  return uK > 0.0 ? asin(clamp(v * sq, -1.0, 1.0)) / sq : asinh(v * sq) / sq;
}
// cosK(d)=c から距離 d を復元する。uK→0 では 1-cosK(d)≈uK d²/2 と
// 桁落ちしてしまい安定に逆算できない(sinK/asinK と違って1階微分が0)ため、
// 呼び出し側(cylSDF/hCapsuleSDF)で K_EPS 未満はそもそも別式に切り替える。
float distFromCosK(float c) {
  float sq = sqrt(abs(uK));
  return uK > 0.0 ? acos(clamp(c, -1.0, 1.0)) / sq : acosh(max(c, 1.0)) / sq;
}

// 2点間の距離(点対点の一般化版)。周回半径の衝突判定(木の近くの柱を
// 除外する)にだけ使う。distFromCosK と同じ理由で uK≈0 近傍は別式。
float pointDistK(vec4 P, vec4 Q) {
  if (abs(uK) < K_EPS) return length(P.yzw - Q.yzw);
  float c = uK * gdot(P, Q);
  return distFromCosK(c);
}

// 床 = 法線 (0,0,1,0) を持つ全測地的超平面までの符号付き距離。
// asinK は uK=0 近傍でも桁落ちしないので、床だけは分岐無しの一本の式で
// 双曲・ユークリッド・球面をシームレスに繋げる。
float floorSDF(vec4 p) { return asinK(gdot(p, vec4(0.0, 0.0, 1.0, 0.0))); }

// 点 (x0,0,z0) を通る鉛直測地線までの距離 - 半径。
// 測地線は a(時間的), b=(0,0,1,0)(空間的) の張る2平面との交線
// (⟨a,a⟩=1/uK, ⟨b,b⟩=1, ⟨a,b⟩=0)。cosK(d) = sqrt(ca² + uK·cb²),
// ca=uK·⟨p,a⟩, cb=⟨p,b⟩ (README「曲率のパラメータ化」参照。uK=-1 のとき
// 従来の cosh(d)=sqrt(⟨p,a⟩²−⟨p,b⟩²) に一致する)。
float cylSDF(vec4 p, float x0, float z0) {
  if (abs(uK) < K_EPS) {
    vec2 q = vec2(p.y, p.w) - vec2(x0, z0);
    return length(q) - CYL_RADIUS;
  }
  float t0 = sqrt(max(1.0 - uK * (x0 * x0 + z0 * z0), 0.001));
  vec4 a = vec4(t0, x0, 0.0, z0);
  vec4 b = vec4(0.0, 0.0, 1.0, 0.0);
  float ca = uK * gdot(p, a);
  float cb = gdot(p, b);
  float radicand = ca * ca + uK * cb * cb;
  float lambda = uK > 0.0 ? sqrt(clamp(radicand, 0.0, 1.0)) : sqrt(max(radicand, 1.0));
  return distFromCosK(lambda) - CYL_RADIUS;
}

// 柱の格子はチャート座標を素朴に等間隔にするだけでは破綻する(README「格子の
// 定義について」参照)。代わりに2つの一般化ブースト(x方向→z方向)の合成で
// 格子点を生成する: x0=sinK(n·SPACING), z0=cosK(n·SPACING)·sinK(m·SPACING)。
// uK=-1 のとき従来の sinh/cosh 版に一致する。
// 木の根元に近すぎる柱は周回軌道と衝突しうるので、格子から除外する。
// 曲率スライダーを K<0(双曲空間)から K>0(球面)まで動かせるようにした際、
// 固定の周回半径・格子間隔のままだと、円軌道が柱の内部を通ってしまう
// θ・K の組み合わせが広い範囲に存在することが Node.js での全周探索で
// 判明した(README「曲率のパラメータ化」参照)。三角不等式より、木の中心
// からの距離が TREE_EXCLUSION_RADIUS 以上の柱だけを候補にすれば、
// 周回半径がいくつであっても「軌道上のどの点からもその柱までの距離は
// TREE_EXCLUSION_RADIUS − ORBIT_RADIUS 以上」が保証できるため、個々の
// θ・K の組み合わせを逐一チューニングするより頑健。
float pillarSDF(vec4 p) {
  float d = 1e9;
  float treeS = ${f(TREE_CONFIG.HYP_DIST_FROM_ORIGIN)};
  vec4 treeC = vec4(cosK(treeS), sinK(treeS), 0.0, 0.0);
  float nCenter = floor(asinK(p.y) / SPACING + 0.5);
  for (int di = -${CONFIG.WINDOW_K}; di <= ${CONFIG.WINDOW_K}; di++) {
    float n = nCenter + float(di);
    float chN = cosK(n * SPACING);
    float mCenter = floor(asinK(p.w / chN) / SPACING);
    for (int dj = -${CONFIG.WINDOW_K}; dj <= ${CONFIG.WINDOW_K}; dj++) {
      float m = mCenter + float(dj) + 0.5;
      float x0 = sinK(n * SPACING);
      float z0 = chN * sinK(m * SPACING);
      float t0 = sqrt(max(1.0 - uK * (x0 * x0 + z0 * z0), 0.001));
      if (pointDistK(treeC, vec4(t0, x0, 0.0, z0)) < ${f(CONFIG.TREE_EXCLUSION_RADIUS)}) continue;
      d = min(d, cylSDF(p, x0, z0));
    }
  }
  return d;
}

// フラクタルな木。各枝は測地線分に沿った「有限の管」(カプセルの一般化版)。
// cylSDF と同じ分解を使うが、始点 A・向き D・弧長 L で定義された"線分"
// なので、無限測地線上の最近点のパラメータ s* を求めて [0,L] にクランプ
// する必要がある。s* は sinK(s*)=cD/λ (λ=cosK(距離)) の関係から
// asinK で復元できる(README 参照)。
float hCapsuleSDF(vec4 p, vec4 A, vec4 D, float L, float r) {
  if (abs(uK) < K_EPS) {
    vec3 pa = p.yzw - A.yzw;
    vec3 ba = D.yzw * L;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }
  float cA = uK * gdot(p, A);
  float cD = gdot(p, D);
  float radicand = cA * cA + uK * cD * cD;
  float lambda = uK > 0.0 ? sqrt(clamp(radicand, 0.0, 1.0)) : sqrt(max(radicand, 1.0));
  float s = clamp(asinK(cD / lambda), 0.0, L);
  vec4 Q = A * cosK(s) + D * sinK(s);
  float cosDist = uK * gdot(p, Q);
  return distFromCosK(cosDist) - r;
}

float treeSDF(vec4 p) {
  float d = 1e9;
  for (int i = 0; i < TREE_COUNT; i++) {
    d = min(d, hCapsuleSDF(p, uTreeA[i], uTreeD[i], uTreeL[i], uTreeR[i]));
  }
  return d;
}

float map(vec4 p) {
  return min(floorSDF(p), min(pillarSDF(p), treeSDF(p)));
}

// シェーディング用法線: p を曲面に載ったベクトルとみなさず、周辺の空間成分
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
  // uR, uU, uF は互いに gdot で正規直交かつ uP に直交するので、
  // 通常のユークリッド正規化がそのままこの1次結合の単位接ベクトル化になる。
  vec4 rd = (uv.x * uR + uv.y * uU + FOCAL * uF) / sqrt(lenSq);

  float travelled = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    float dist = map(p);
    if (dist < SURF_EPS) { hit = true; break; }
    float step = dist * STEP_SAFETY;
    vec4 newP = p * cosK(step) + rd * sinK(step);
    vec4 newD = p * (-uK) * sinK(step) + rd * cosK(step);
    // 接空間への再射影(v_tan = v − uK⟨v,P⟩P, ⟨P,P⟩=1/uK を利用)+ 正規化でドリフトを抑える
    newD = newD - uK * gdot(newD, newP) * newP;
    newD = newD / sqrt(max(gdot(newD, newD), 1e-6));
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
  K: gl.getUniformLocation(hypProgram, "uK"),
  treeA: gl.getUniformLocation(hypProgram, "uTreeA"),
  treeD: gl.getUniformLocation(hypProgram, "uTreeD"),
  treeL: gl.getUniformLocation(hypProgram, "uTreeL"),
  treeR: gl.getUniformLocation(hypProgram, "uTreeR"),
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
// uniform として GPU に渡す。双曲側・ユークリッド側は「同じ入力(theta, yaw,
// pitch)を、それぞれの幾何の周回・回転の公式に通す」という完全に並行な構造
// にしてあるので、見え方の違いは純粋に幾何(曲率)の差から来る。
//
// カメラは木を中心とする円軌道を周回する(theta=周回角)。木の根元 C を
// 中心に、木の initFrame() と同じ接空間の基底(S1=原点から半径方向、
// S2=横方向)を使って「方向 dir(θ)=S1·cosθ+S2·sinθ へ ORBIT_RADIUS だけ
// 移動した点」を軌道上の位置とする。木を見る(内向き)方向は、その移動の
// 外向き接ベクトルの符号を反転するだけで得られ、円に接する横方向
// tangentDir(θ)=-S1·sinθ+S2·cosθ は移動方向と直交しているため、フラクタル
// ツリーの move() と同じ理屈で不変のまま運ばれる(導出の詳細は
// curvedCamera() 内のコメント)。
// ----------------------------------------------------------------------------
function v4(a, b, c, d) { return [a, b, c, d]; }
function v4add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]; }
function v4scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s, a[3] * s]; }
function v3add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function v3scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

// 定曲率空間のカメラ。theta=周回角、yaw/pitch=見回し角、height=床からの
// 高さ、orbitRadius=木の根元からの距離、K=曲率。K=-1 のとき、以前の
// hyperbolicCamera(常に双曲空間)と完全に一致する。
//
// 1. 木の根元 C = (cosK(s), sinK(s), 0, 0)(s=HYP_DIST_FROM_ORIGIN)を中心に、
//    接空間の基底 S1=(-K・sinK(s), cosK(s), 0, 0)(半径方向), S2=(0,0,0,1)
//    (横方向)を θ で回転して dir(θ), tangentDir(θ) を作る(木の生成コードの
//    curvedTreeAdapter(K).initFrame() と全く同じ基底)。
// 2. dir(θ) 方向へ測地線を orbitRadius だけ進めた点が「床の上の」軌道位置
//    Pfloor(θ)。外向きの接ベクトル radOut(θ) はその輸送式でそのまま求まり、
//    木を見る内向き方向 Fin はその符号を反転するだけ。tangentDir(θ) は
//    移動方向と直交するため不変のまま運ばれる。
// 3. Pfloor から「上方向」U0=(0,0,1,0)(床のどの点でも常に接空間内で単位・
//    直交、README「フラクタルな木」参照)へ height だけ測地線移動して
//    実際のカメラ高さにする。Fin・tangentDir は U0 とも直交しているため、
//    この昇降でも変化しない。
// 4. 最後に yaw→pitch の順に、接空間内の通常の回転として視線フレームへ回す。
function curvedCamera(theta, yaw, pitch, height, orbitRadius, K) {
  const s = TREE_CONFIG.HYP_DIST_FROM_ORIGIN;
  const cs = cosK(s, K), ss = sinK(s, K);
  const C = v4(cs, ss, 0, 0);
  const S1 = v4(-K * ss, cs, 0, 0);
  const S2 = v4(0, 0, 0, 1);
  const Up0 = v4(0, 0, 1, 0);

  const ct = Math.cos(theta), st = Math.sin(theta);
  const dir = v4add(v4scale(S1, ct), v4scale(S2, st));
  const tangentDir = v4add(v4scale(S1, -st), v4scale(S2, ct));

  const cR = cosK(orbitRadius, K), sR = sinK(orbitRadius, K);
  const Pfloor = v4add(v4scale(C, cR), v4scale(dir, sR));
  const radOut = v4add(v4scale(C, -K * sR), v4scale(dir, cR));
  const FinFloor = v4scale(radOut, -1);

  const cH = cosK(height, K), sH = sinK(height, K);
  const P = v4add(v4scale(Pfloor, cH), v4scale(Up0, sH));
  const UpElev = v4add(v4scale(Pfloor, -K * sH), v4scale(Up0, cH));

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Fy = v4add(v4scale(FinFloor, cy), v4scale(tangentDir, sy));
  const Ry = v4add(v4scale(FinFloor, -sy), v4scale(tangentDir, cy));

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Fp = v4add(v4scale(Fy, cp), v4scale(UpElev, sp));
  const Up = v4add(v4scale(Fy, -sp), v4scale(UpElev, cp));

  return { P, F: Fp, R: Ry, U: Up };
}

// ユークリッド版。木の根元 C=(EUC_POS.x, 0, EUC_POS.z) を中心とする普通の円。
// 上と全く同じ構造(dir/tangentDir の回転→半径方向への移動→内向きに反転→
// 高さ方向へ加算→yaw→pitch)で、「移動」だけが cosh/sinh の測地線輸送から
// 単純なベクトル加算に変わる。
function euclideanCamera(theta, yaw, pitch, height, orbitRadius) {
  const C = [TREE_CONFIG.EUC_POS[0], 0, TREE_CONFIG.EUC_POS[1]];
  const dir = [Math.cos(theta), 0, Math.sin(theta)];
  const tangentDir = [-Math.sin(theta), 0, Math.cos(theta)];
  const Up0 = [0, 1, 0];

  const Pfloor = v3add(C, v3scale(dir, orbitRadius));
  const FinFloor = v3scale(dir, -1);
  const P = v3add(Pfloor, v3scale(Up0, height));

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const Fy = v3add(v3scale(FinFloor, cy), v3scale(tangentDir, sy));
  const Ry = v3add(v3scale(FinFloor, -sy), v3scale(tangentDir, cy));

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Fp = v3add(v3scale(Fy, cp), v3scale(Up0, sp));
  const Up = v3add(v3scale(Fy, -sp), v3scale(Up0, cp));

  return { P, F: Fp, R: Ry, U: Up };
}

// ----------------------------------------------------------------------------
// Input — 自動周回(theta)を基本に、ドラッグで見回し(yaw/pitch)、
//   ホイールで周回速度を上乗せ(慣性減衰)。prototype-infinite-corridor の
//   auto-advance + drag パターンを踏襲(前進距離だったものを周回角に変えただけ)。
// ----------------------------------------------------------------------------
let theta = 0.0;
let thetaVelocity = 0;
let yaw = 0;
let pitch = 0.32; // 少し見上げる角度から開始(木に近い周回半径のため、既定の水平視線だと幹しか映らない)
let curvatureK = -1.0; // 右ペインの曲率。スライダーで操作する(README「曲率のパラメータ化」参照)

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
  thetaVelocity += -e.deltaY * CONFIG.WHEEL_SENSITIVITY;
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
// 曲率スライダー。K<0=双曲空間・K=0=ユークリッド空間・K>0=球面が
// シームレスに繋がる(README「曲率のパラメータ化」参照)。ラベル・読み値は
// K の符号だけで切り替え、値自体は毎回そのまま表示する。
// ----------------------------------------------------------------------------
const curvatureSlider = document.getElementById("curvatureSlider");
const curvatureReadout = document.getElementById("curvatureReadout");
const labelRight = document.getElementById("labelRight");

function curvatureGeometryName(K) {
  if (Math.abs(K) < K_EPS) return "ユークリッド空間";
  return K < 0 ? "双曲空間" : "球面";
}

function updateCurvatureUI(K) {
  const text = `K = ${K >= 0 ? "+" : ""}${K.toFixed(2)} (${curvatureGeometryName(K)})`;
  curvatureReadout.textContent = text;
  labelRight.textContent = `K = ${K >= 0 ? "+" : ""}${K.toFixed(2)} — ${curvatureGeometryName(K).toUpperCase()}`;
}

curvatureSlider.addEventListener("input", () => {
  curvatureK = parseFloat(curvatureSlider.value);
  updateCurvatureUI(curvatureK);
});
updateCurvatureUI(curvatureK);

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let startTime = performance.now();
let lastTime = startTime;

function drawPane(program, uLoc, viewportX, viewportW, cam, extra) {
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
  if (extra) extra();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// 曲率が変わるたびに木を再生成し、シェーダーへ渡すフラット配列を作り直す。
// 毎フレーム呼んでも安いが(枝は最大 15 本)、K が変わっていなければ
// 再計算そのものをスキップする。
let lastTreeK = null;
let hypTreeFlat = null;
function updateHypTreeUniforms(K) {
  if (K === lastTreeK) return;
  lastTreeK = K;
  const segments = buildTree(curvedTreeAdapter(K), TREE_CONFIG.HYP_TRUNK_LENGTH, TREE_CONFIG.HYP_TRUNK_RADIUS);
  const A = new Float32Array(segments.length * 4);
  const D = new Float32Array(segments.length * 4);
  const L = new Float32Array(segments.length);
  const R = new Float32Array(segments.length);
  segments.forEach((seg, i) => {
    A.set(seg.A, i * 4);
    D.set(seg.D, i * 4);
    L[i] = seg.L;
    R[i] = seg.r;
  });
  hypTreeFlat = { A, D, L, R };
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  try {
    theta += CONFIG.AUTO_SPEED * dt;
    theta += thetaVelocity;
    thetaVelocity *= 0.85;
    // 周回角なので上限を設けず、2πごとに巻き戻して精度を保つだけでよい
    // (前進距離だった頃と違い「対象からの距離」が常に一定なので、無限に
    // 進んでも視野から外れる心配が無い)。
    theta = theta % (2 * Math.PI);

    const eucCam = euclideanCamera(theta, yaw, pitch, CONFIG.CAM_HEIGHT_EUC, CONFIG.ORBIT_RADIUS_EUC);
    const hypCam = curvedCamera(theta, yaw, pitch, CONFIG.CAM_HEIGHT_HYP, CONFIG.ORBIT_RADIUS_HYP, curvatureK);
    updateHypTreeUniforms(curvatureK);

    const halfW = Math.floor(fullW / 2);
    drawPane(eucProgram, eucU, 0, halfW, eucCam);
    drawPane(hypProgram, hypU, halfW, fullW - halfW, hypCam, () => {
      gl.uniform1f(hypU.K, curvatureK);
      gl.uniform4fv(hypU.treeA, hypTreeFlat.A);
      gl.uniform4fv(hypU.treeD, hypTreeFlat.D);
      gl.uniform1fv(hypU.treeL, hypTreeFlat.L);
      gl.uniform1fv(hypU.treeR, hypTreeFlat.R);
    });
  } catch (err) {
    console.error(err);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
