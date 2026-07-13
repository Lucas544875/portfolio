// ============================================================================
// 非ユークリッドの窓(ポータル) — プロトタイプ #5
//
// 目的:
//   1枚の平らなガラス板(ポータル矩形)越しに、その奥が「空間的に連続した部屋の
//   続き」に見えるのに、実は座標変換でつながった “別の部屋” を覗いている、という
//   Portal(Valve)/ 非ユークリッドの継ぎ目トリックを、単一パスのレイマーチだけで
//   作る(屈折用の render-to-texture は使わない。捲れの奥に別空間を出す点は
//   prototype-shards の screen-space capture と発想は近いが、ここでは 1 本の
//   レイマーチループの途中で座標系を乗り換えるという別アプローチを取る)。
//
// トリックの核(1 本のレイマーチループ内で完結):
//   - まず入口ポータル矩形との交差を解析的に求める(平面 ∩ 矩形の交差 t)。これは
//     「レイ位置のポータル平面への符号付き距離が + から - へ反転する点を検出する」
//     ことと数学的に等価で、毎ステップ符号を見るよりも正確で、しかもレイが
//     グレージング角で平面を何度も横切って詰まる心配が無い(交差は一意に決まる)。
//   - Room A(手前の部屋)を、その交差 t まで通常どおりレイマーチする。途中で
//     Room A のジオメトリ(床・壁・ポータルの額縁)に当たればそこで確定。
//   - 何にも当たらずにポータル矩形の内側の平面へ到達したら、そのレイの位置と方向を
//     剛体変換(回転 + 平行移動)で Room B のワールド座標系へ写し、残りのレイを
//     Room B の(形も色も違う)SDF でマーチし続ける。
//   - ポータルの乗り換えは 1 レイあたり最大 1 回に制限する(CROSSING CAP)。一度
//     Room B に入ったら二度と乗り換えないので、グレージング角でも無限ループしない。
//   - 矩形の外側を通るレイは乗り換えず、Room A の壁などをそのまま描く(Room B が
//     額縁の外に漏れない = クリッピング)。
//
// 意図的な設計判断(横・裏から見たとき):
//   これは物理的な「穴」ではなく 1 枚の板なので、真横やや裏から見たときに “薄い縁”
//   だけになってしまうと嘘がバレる。そこで:
//     - ポータルが「開く」(= Room B が見える)のはカメラが板の表側(法線側)に居て、
//       かつ視線が板に対して十分立っている(グレージングでない)ときだけ。
//     - 表からでもグレージング角、または裏側から見たときは、内側を “半透明の
//        tinted ガラス板”(Room A の環境を反射する曇りガラス)として不透明に描く。
//       これにより横・裏からは「ただのガラス板」に見え、正面からだけ奥の別空間が
//       開ける。この挙動は README の「視覚的に未検証な点」にも明記する。
//
// カメラ:
//   ロード時にポータル正面のやや斜めから、遠 → 近へ自動でドリーインして継ぎ目が
//   読みやすい構図に寄る。ユーザーがドラッグした瞬間に自由なオービットへ引き継ぐ
//   (prototype #1〜#4 と同じ「自動再生 → ハンドオフ」)。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: true,
  depth: false, // フルスクリーン矩形にレイマーチするだけなので深度バッファは不要
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 is not supported.");
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config(調整可能な定数はすべてここに集約)
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.6 : 0.9, // フルスクリーンをレイマーチするので #4 より控えめ
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  FOV: 1.4, // レンズの強さ(大きいほど広角に近づく係数。forward に掛ける)
  NEAR: 0.02,
  MAX_DIST: 60.0,
  MAX_STEPS: isCoarsePointer ? 80 : 120,
  SURF_EPS: 0.0012,

  // --- カメラ(ポータル中心をターゲットにオービット) ---
  CAM_DIST: 4.7, // 落ち着いたときの距離
  CAM_DIST_START: 9.5, // ロード直後の距離(ここから寄る)
  APPROACH_TIME: 2.8, // ドリーインにかける秒数
  CAM_YAW_START: 0.34, // 正面やや斜め(0 = 真正面 +z)。継ぎ目が読める角度
  CAM_PITCH_START: 0.12,
  AUTOPLAY_YAW_SPEED: 0.05, // ハンドオフ前のごく緩い周回
  DRAG_YAW_SENSITIVITY: 0.008,
  DRAG_PITCH_SENSITIVITY: 0.008,
  PITCH_LIMIT: 1.25,

  // --- ポータルが「開く」条件 ---
  GRAZE_MIN: 0.16, // |dot(rd, n_A)| がこれ未満なら開かない(横から見たとき閉じる)
};

// ----------------------------------------------------------------------------
// ポータル矩形の姿勢(入口 A / 出口 B)。位置・向き・サイズを名前付き定数で公開。
//
// 重要な点:出口ポータル B は入口 A の近くに置く必要は全く無い。B の位置 CENTER_B は
// 遠く離れていて、向きも A と揃っていない。この「見た目の入口位置」と「代数的な出口
// 位置」のミスマッチこそが非ユークリッド感を生む。ここでは B を A から見て垂直軸
// (ワールドの上方向)まわりに PORTAL_TURN だけ回した姿勢にしている。
//
// 垂直軸まわりの回転だけにしている理由:床の高さ(y)が変換で保存されるため、
// ポータル下端の床のラインが Room B へ「同じ高さで」連続して見え、まず「空間の続き」
// と錯覚させられる。よく見ると向きが回っていて奥のオブジェクトも別物(かつ巨大)…
// という順で気づかせるのが狙い。
// ----------------------------------------------------------------------------
const DEG = Math.PI / 180;

const PORTAL = {
  // 入口 A:原点に置き、法線は +z(=カメラの居る側)。u=+x, v=+y の軸並び。
  CENTER_A: [0, 0, 0],
  NORMAL_A: [0, 0, 1],
  UP_HINT_A: [0, 1, 0],
  HALF: [1.15, 1.6], // 半幅・半高(縦長の窓)。A/B 共通(局所オフセットを 1:1 対応させるため)

  // 出口 B:遠く離れた位置に、垂直軸まわりに PORTAL_TURN 回した姿勢で置く。
  TURN: 40 * DEG, // A→B の向きの回転量(垂直軸まわり)
  CENTER_B: [40, 0, 40], // A から遠く離れた任意の場所(見た目の連続性とは無関係)
  UP_HINT_B: [0, 1, 0],
};
// NORMAL_B は TURN から導出(NORMAL_A を垂直軸まわりに回したもの)
PORTAL.NORMAL_B = [
  Math.sin(PORTAL.TURN) * PORTAL.NORMAL_A[2] + Math.cos(PORTAL.TURN) * PORTAL.NORMAL_A[0],
  PORTAL.NORMAL_A[1],
  Math.cos(PORTAL.TURN) * PORTAL.NORMAL_A[2] - Math.sin(PORTAL.TURN) * PORTAL.NORMAL_A[0],
];

// ----------------------------------------------------------------------------
// Room A / Room B の SDF パラメータ(見た目を明確に描き分けるための定数)
//   Room A = サイトのトーン(結露ガラスの青灰色・冷たい光)
//   Room B = 暖色で、オブジェクトが約 3 倍大きい(= ありえない奥行き感)別空間
// ----------------------------------------------------------------------------
const ROOM_A = {
  FLOOR_Y: -1.6,
  ALBEDO_FLOOR: [0.30, 0.36, 0.44], // 青灰色
  ALBEDO_BOX: [0.42, 0.50, 0.60],
  ALBEDO_FRAME: [0.55, 0.72, 0.85], // ガラス額縁のうっすら青いティント
  KEY_DIR: [0.45, 0.82, 0.35], // 冷たい主光源(やや上・手前)
  KEY_COLOR: [0.62, 0.74, 0.95],
  AMBIENT: [0.10, 0.13, 0.18],
  FRAME_W: 0.14, // 額縁の枠幅
  FRAME_D: 0.09, // 額縁の厚み(z 方向)
};

const ROOM_B = {
  FLOOR_Y: -1.6, // A と同じ高さ(床を連続させる)
  ALBEDO_FLOOR: [0.40, 0.26, 0.16], // 暖色のテラコッタ
  ALBEDO_PILLAR: [0.62, 0.40, 0.22],
  ALBEDO_SPHERE: [0.80, 0.62, 0.34],
  ALBEDO_WALL: [0.34, 0.20, 0.14],
  KEY_DIR: [-0.35, 0.72, -0.30], // 暖色の主光源(逆側・上から)
  KEY_COLOR: [1.0, 0.72, 0.42],
  AMBIENT: [0.16, 0.10, 0.07],
  OBJ_SCALE: 3.0, // Room A のオブジェクトに対する相対サイズ(ありえない大きさ)
};

// ----------------------------------------------------------------------------
// 剛体変換 R, t の構築(JS 側で計算し mat3 + vec3 として渡す)
//
//   フレーム行列 M = [u | v | n](列ベクトル、正規直交・右手系)。
//   ワールド点 p の局所座標  l = M^T (p - CENTER)。
//   A のワールド点 p を B のワールド点 p' へ写す剛体変換:
//       p' = CENTER_B + (M_B M_A^T) (p - CENTER_A)
//       d' = (M_B M_A^T) d                       … 方向は平行移動を受けない
//   回転 R = M_B M_A^T = u_B u_A^T + v_B v_A^T + n_B n_A^T(外積和)。
//
// これは「A の矩形上で局所オフセット (a,b) の点は、B の矩形上でも同じ局所オフセット
// (a,b) の点へ写る(向きだけ変わる)」ことを保証する。以下に θ=40°(cos≈0.766,
// sin≈0.643)で 2 点を手計算して検証しておく:
//
//   例1:A 矩形上の局所オフセット (a,b)=(0.5, 0.8) → ワールド A では (0.5,0.8,0)。
//        M_A=I なので l=(0.5,0.8,0)。M_B は垂直軸 y まわり θ 回転(Ry(θ))。
//        R*(0.5,0.8,0) = (0.5·cosθ, 0.8, -0.5·sinθ) = (0.383, 0.8, -0.321)。
//        これを B の軸へ射影して局所オフセットを確認:
//          u_B = (cosθ,0,-sinθ)=(0.766,0,-0.643):
//            0.383·0.766 + (-0.321)·(-0.643) = 0.293+0.206 = 0.499 ≈ 0.5 ✓
//          v_B = (0,1,0): 0.8 ✓
//        → 局所オフセット (0.5,0.8) が出口でもそのまま保存される。
//
//   例2:ポータルへ入る方向 d = (0,0,-1)(-n_A 側へ進む)。
//        R*(0,0,-1) = (-sinθ, 0, -cosθ) = (-0.643,0,-0.766) = -n_B
//        （n_B=(sinθ,0,cosθ)=(0.643,0,0.766)）。
//        → レイは出口ポータル B の -n_B 側(= Room B の中身を置いた側)へ進む ✓
// ----------------------------------------------------------------------------
function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
// 法線と up ヒントから正規直交フレーム [u, v, n] を作る(右手系)
function buildFrame(normal, upHint) {
  const n = normalize3(normal);
  const u = normalize3(cross3(upHint, n)); // 右方向
  const v = cross3(n, u); // 真の上方向(既に正規)
  return { u, v, n };
}

const frameA = buildFrame(PORTAL.NORMAL_A, PORTAL.UP_HINT_A);
const frameB = buildFrame(PORTAL.NORMAL_B, PORTAL.UP_HINT_B);

// R = u_B u_A^T + v_B v_A^T + n_B n_A^T。R[i][j] = uB[i]uA[j] + vB[i]vA[j] + nB[i]nA[j]
function buildRotation(fA, fB) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const colsA = [fA.u, fA.v, fA.n];
  const colsB = [fB.u, fB.v, fB.n];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += colsB[k][i] * colsA[k][j];
      R[i][j] = s;
    }
  }
  return R;
}
const R = buildRotation(frameA, frameB);
// GLSL mat3 は列優先。列優先配列 Rcm[j*3+i] = R[i][j]
const Rcm = new Float32Array([
  R[0][0], R[1][0], R[2][0],
  R[0][1], R[1][1], R[2][1],
  R[0][2], R[1][2], R[2][2],
]);

// --- 起動時セルフチェック(手計算の検証をコードでも確認しておく) ---
(function verifyTransform() {
  const CA = PORTAL.CENTER_A, CB = PORTAL.CENTER_B;
  function apply(p) {
    const d = [p[0] - CA[0], p[1] - CA[1], p[2] - CA[2]];
    return [
      CB[0] + R[0][0] * d[0] + R[0][1] * d[1] + R[0][2] * d[2],
      CB[1] + R[1][0] * d[0] + R[1][1] * d[1] + R[1][2] * d[2],
      CB[2] + R[2][0] * d[0] + R[2][1] * d[1] + R[2][2] * d[2],
    ];
  }
  // A 矩形上の (a,b)=(0.5,0.8) の点
  const a = 0.5, b = 0.8;
  const pA = [
    CA[0] + a * frameA.u[0] + b * frameA.v[0],
    CA[1] + a * frameA.u[1] + b * frameA.v[1],
    CA[2] + a * frameA.u[2] + b * frameA.v[2],
  ];
  const pB = apply(pA);
  const rel = [pB[0] - CB[0], pB[1] - CB[1], pB[2] - CB[2]];
  const lu = rel[0] * frameB.u[0] + rel[1] * frameB.u[1] + rel[2] * frameB.u[2];
  const lv = rel[0] * frameB.v[0] + rel[1] * frameB.v[1] + rel[2] * frameB.v[2];
  const okOffset = Math.abs(lu - a) < 1e-4 && Math.abs(lv - b) < 1e-4;
  console.assert(okOffset, "[portal] 局所オフセットが出口で保存されていません", { lu, lv });
})();

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

// ----------------------------------------------------------------------------
// Shaders
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

const fragmentShaderSource = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uCameraPos;
uniform vec3  uForward;
uniform vec3  uRight;
uniform vec3  uUp;
uniform float uFov;

// --- ポータル姿勢 ---
uniform vec3  uPortalCA;   // 入口中心
uniform vec3  uPortalNA;   // 入口法線
uniform vec3  uPortalUA;   // 入口 右
uniform vec3  uPortalVA;   // 入口 上
uniform vec2  uPortalHalf; // 半幅・半高
uniform mat3  uPortalR;    // 剛体回転 R = M_B M_A^T
uniform vec3  uPortalCB;   // 出口中心
uniform vec3  uRoomBN;     // 出口法線 n_B
uniform vec3  uRoomBU;     // 出口 右 u_B
uniform vec3  uRoomBV;     // 出口 上 v_B

// --- 定数(JS の CONFIG / ROOM_* から流し込む) ---
uniform float uGrazeMin;
uniform float uMaxDist;
uniform float uSurfEps;

// Room A
uniform float uAFloorY;
uniform vec3  uAAlbFloor, uAAlbBox, uAAlbFrame;
uniform vec3  uAKeyDir, uAKeyColor, uAAmbient;
uniform float uFrameW, uFrameD;
// Room B
uniform float uBFloorY;
uniform vec3  uBAlbFloor, uBAlbPillar, uBAlbSphere, uBAlbWall;
uniform vec3  uBKeyDir, uBKeyColor, uBAmbient;
uniform float uBObjScale;

const int MAX_STEPS = ${CONFIG.MAX_STEPS};

// ---------------- SDF プリミティブ ----------------
float sdBox (vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sdSphere (vec3 p, float r) { return length(p) - r; }

// matId を運ぶ union
vec2 opU (vec2 a, vec2 b) { return (a.x < b.x) ? a : b; }

// ---------------- Room A の SDF(青灰色の部屋) ----------------
// 戻り値 = vec2(距離, matId)。matId: 1=床, 2=箱, 3=ガラス額縁
vec2 sdfRoomA (vec3 p) {
  vec2 res = vec2(p.y - uAFloorY, 1.0); // 床(無限平面)

  // 手前の空間に置く数個の箱(冷たいトーン)。ポータルの脇に文脈を与える程度に疎に置く
  res = opU(res, vec2(sdBox(p - vec3(-2.9, -1.0, -1.2), vec3(0.6, 0.6, 0.6)), 2.0));
  res = opU(res, vec2(sdBox(p - vec3( 3.1, -0.8, -2.0), vec3(0.5, 0.8, 0.5)), 2.0));
  res = opU(res, vec2(sdBox(p - vec3( 2.4, -1.2, 2.6),  vec3(0.4, 0.4, 0.4)), 2.0));

  // ガラスの額縁:ポータル矩形の縁を囲む薄い枠(= outer box から inner opening を引く)。
  // Room A は軸並び(u=+x, v=+y, n=+z)なので、フレーム座標は p - CENTER_A でよい。
  vec3 fp = p - uPortalCA;
  float outer = sdBox(fp, vec3(uPortalHalf.x + uFrameW, uPortalHalf.y + uFrameW, uFrameD));
  float inner = sdBox(fp, vec3(uPortalHalf.x, uPortalHalf.y, uFrameD * 3.0));
  float frame = max(outer, -inner); // 矩形リング状の枠
  res = opU(res, vec2(frame, 3.0));

  return res;
}

// ---------------- Room B の SDF(暖色・巨大な別空間) ----------------
// Room B は出口中心 uPortalCB のまわり、-n_B 側(= 変換後のレイが進む側)へ
// オブジェクトを並べる。matId: 1=床, 2=柱, 3=球, 4=奥の壁
vec2 sdfRoomB (vec3 p) {
  vec2 res = vec2(p.y - uBFloorY, 1.0); // 床(A と同じ高さ)

  vec3 fwd = -uRoomBN;      // Room B の「奥へ」向かう方向
  vec3 rgt = uRoomBU;       // 右
  float s = uBObjScale;

  // 巨大な角柱 2 本(3 倍スケール)
  vec3 c1 = uPortalCB + fwd * 6.0 + rgt * 2.6;
  res = opU(res, vec2(sdBox(p - c1, vec3(0.5, 2.4, 0.5) * s * 0.5), 2.0));
  vec3 c2 = uPortalCB + fwd * 8.5 - rgt * 3.2;
  res = opU(res, vec2(sdBox(p - c2, vec3(0.5, 2.8, 0.5) * s * 0.5), 2.0));

  // 宙に浮く大きな球
  vec3 sp = uPortalCB + fwd * 7.0 + vec3(0.0, 1.4, 0.0) + rgt * (-0.4);
  res = opU(res, vec2(sdSphere(p - sp, 1.1 * s * 0.5), 3.0));

  // 奥の壁(暖色)。fwd 方向のずっと先に薄い板を立てる
  vec3 wc = uPortalCB + fwd * 13.0 + vec3(0.0, 2.0, 0.0);
  vec3 wp = p - wc;
  // 壁は fwd 法線の薄板。ローカル軸へ回さず、十分大きな box を薄くして近似
  res = opU(res, vec2(sdBox(wp, vec3(9.0, 5.0, 0.25)), 4.0));

  return res;
}

// 法線(SDF 勾配、中心差分)
vec3 normalA (vec3 p) {
  vec2 e = vec2(0.0009, 0.0);
  return normalize(vec3(
    sdfRoomA(p + e.xyy).x - sdfRoomA(p - e.xyy).x,
    sdfRoomA(p + e.yxy).x - sdfRoomA(p - e.yxy).x,
    sdfRoomA(p + e.yyx).x - sdfRoomA(p - e.yyx).x));
}
vec3 normalB (vec3 p) {
  vec2 e = vec2(0.0009, 0.0);
  return normalize(vec3(
    sdfRoomB(p + e.xyy).x - sdfRoomB(p - e.xyy).x,
    sdfRoomB(p + e.yxy).x - sdfRoomB(p - e.yxy).x,
    sdfRoomB(p + e.yyx).x - sdfRoomB(p - e.yyx).x));
}

// ---------------- 背景(レイがどこにも当たらず抜けたとき) ----------------
vec3 backgroundA (vec3 rd) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3(0.05, 0.07, 0.11), vec3(0.11, 0.15, 0.22), h); // 冷たい霧
}
vec3 backgroundB (vec3 rd) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3(0.18, 0.10, 0.06), vec3(0.42, 0.24, 0.12), h); // 暖色の靄
}

// ---------------- ライティング(部屋ごとに色温度を変える) ----------------
vec3 albedoA (float matId) {
  if (matId < 1.5) return uAAlbFloor;
  if (matId < 2.5) return uAAlbBox;
  return uAAlbFrame;
}
vec3 albedoB (float matId) {
  if (matId < 1.5) return uBAlbFloor;
  if (matId < 2.5) return uBAlbPillar;
  if (matId < 3.5) return uBAlbSphere;
  return uBAlbWall;
}

vec3 shadeA (vec3 p, vec3 rd, float matId) {
  vec3 n = normalA(p);
  vec3 alb = albedoA(matId);
  float diff = clamp(dot(n, normalize(uAKeyDir)), 0.0, 1.0);
  vec3 col = alb * (uAAmbient + uAKeyColor * diff);
  // 額縁だけフレネルの縁光でガラスらしさを足す
  if (matId > 2.5) {
    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    col += fres * vec3(0.5, 0.72, 0.9) * 0.9;
  }
  float fog = 1.0 - exp(-length(p - uCameraPos) * 0.012);
  col = mix(col, backgroundA(rd), fog * 0.6);
  return col;
}
vec3 shadeB (vec3 p, vec3 rd, float matId) {
  vec3 n = normalB(p);
  vec3 alb = albedoB(matId);
  float diff = clamp(dot(n, normalize(uBKeyDir)), 0.0, 1.0);
  vec3 col = alb * (uBAmbient + uBKeyColor * diff);
  float dist = length(p - uPortalCB);
  float fog = 1.0 - exp(-dist * 0.02);
  col = mix(col, backgroundB(rd), fog * 0.55);
  return col;
}

// ---------------- Room B のマーチ(乗り換え後の残りのレイ) ----------------
vec3 marchRoomB (vec3 ro, vec3 rd) {
  float t = uSurfEps * 4.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    vec2 s = sdfRoomB(p);
    if (s.x < uSurfEps) return shadeB(p, rd, s.y);
    t += s.x;
    if (t > uMaxDist) break;
  }
  return backgroundB(rd);
}

// ---------------- ポータル矩形との解析的交差 ----------------
// 出力: hit=矩形内で交差したか, tHit=交差距離, front=カメラが表側に居るか, denom=dot(rd,n)
struct PortalHit { bool hit; float tHit; bool front; float denom; };
PortalHit portalIntersect (vec3 ro, vec3 rd) {
  PortalHit ph;
  ph.hit = false; ph.tHit = 1e9; ph.front = false;
  ph.denom = dot(rd, uPortalNA);
  if (abs(ph.denom) > 1e-6) {
    float tPlane = dot(uPortalCA - ro, uPortalNA) / ph.denom;
    if (tPlane > 0.0) {
      vec3 hp = ro + rd * tPlane;
      vec3 rel = hp - uPortalCA;
      float lu = dot(rel, uPortalUA);
      float lv = dot(rel, uPortalVA);
      if (abs(lu) <= uPortalHalf.x && abs(lv) <= uPortalHalf.y) {
        ph.hit = true;
        ph.tHit = tPlane;
        ph.front = dot(ro - uPortalCA, uPortalNA) > 0.0; // カメラが法線側に居るか
      }
    }
  }
  return ph;
}

// 閉じているとき(横・裏)の不透明な tinted ガラス板。Room A の環境を反射する曇りガラス
vec3 shadeClosedPane (vec3 hp, vec3 rd, float denom) {
  vec3 nf = (denom < 0.0) ? uPortalNA : -uPortalNA; // 視線側を向いた面法線
  vec3 env = backgroundA(reflect(rd, nf));
  float fres = pow(1.0 - abs(denom), 3.0);
  vec3 base = vec3(0.07, 0.11, 0.15);         // 暗い青のガラス地色
  return mix(base, env, 0.30) + fres * vec3(0.4, 0.56, 0.72);
}

// ---------------- メイン:1 本のレイマーチ(A → (乗り換え) → B) ----------------
vec3 renderPortal (vec3 ro, vec3 rd) {
  PortalHit ph = portalIntersect(ro, rd);
  // 「開く」条件:カメラが表側 & 矩形内で交差 & 視線が十分立っている(非グレージング)
  bool open = ph.hit && ph.front && (abs(ph.denom) > uGrazeMin);

  // Room A を、ポータル平面(交差があればそこ)まで通常マーチ
  float tLimit = ph.hit ? ph.tHit : uMaxDist;
  float t = ${CONFIG.NEAR.toFixed(4)};
  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tLimit) break;         // ポータル矩形の平面へ到達(乗り換え判定へ)
    vec3 p = ro + rd * t;
    vec2 s = sdfRoomA(p);
    if (s.x < uSurfEps) return shadeA(p, rd, s.y); // 額縁・箱・床に先に当たった
    t += s.x;
    if (t > uMaxDist) break;
  }

  // ポータル矩形の平面へ到達したか
  if (ph.hit && t >= ph.tHit - 0.02) {
    vec3 hp = ro + rd * ph.tHit;   // 平面上の正確な交差点
    if (open) {
      // ---- ここで 1 回だけ座標系を乗り換える(CROSSING CAP = 1) ----
      vec3 ro2 = uPortalCB + uPortalR * (hp - uPortalCA);
      vec3 rd2 = uPortalR * rd;
      vec3 col = marchRoomB(ro2, rd2);
      // ガラス板越しであることを示すため、わずかなティントとフレネル縁光を重ねる
      float fres = pow(1.0 - abs(ph.denom), 4.0);
      col *= mix(vec3(1.0), vec3(0.80, 0.88, 0.97), 0.16); // うっすら冷たいティント
      col += fres * vec3(0.30, 0.45, 0.58) * 0.5;
      return col;
    }
    // 表からでもグレージング、または裏側:不透明な曇りガラス板として描く
    return shadeClosedPane(hp, rd, ph.denom);
  }

  // 矩形の外を通り抜けた:Room A の背景
  return backgroundA(rd);
}

vec3 gammaCorrect (vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 reinhard (vec3 c) { return c / (c + vec3(1.0)); }

void main () {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  vec3 ro = uCameraPos;
  vec3 rd = normalize(uForward * uFov + uRight * uv.x + uUp * uv.y);

  vec3 col = renderPortal(ro, rd);
  col = gammaCorrect(reinhard(col));

  // 軽いビネット(GLSL の smoothstep は edge0 < edge1 が必須。中心=0, 縁=1 にして反転)
  float vig = smoothstep(0.35, 1.25, length(vec2(vUv.x * aspect, vUv.y)));
  col *= mix(1.0, 0.72, vig);

  fragColor = vec4(col, 1.0);
}
`;

const program = createProgram(vertexShaderSource, fragmentShaderSource);
const U = program.uniforms;

// フルスクリーン矩形
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
// Camera: 自動ドリーイン → ドラッグでハンドオフ
// ----------------------------------------------------------------------------
const camera = { yaw: CONFIG.CAM_YAW_START, pitch: CONFIG.CAM_PITCH_START, dist: CONFIG.CAM_DIST_START };
const autoplay = { enabled: true };
const target = PORTAL.CENTER_A;

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function updateAutoplay(t) {
  if (!autoplay.enabled) return;
  const k = smoothstep(0, CONFIG.APPROACH_TIME, t);
  camera.dist = CONFIG.CAM_DIST_START + (CONFIG.CAM_DIST - CONFIG.CAM_DIST_START) * k;
  camera.yaw = CONFIG.CAM_YAW_START + t * CONFIG.AUTOPLAY_YAW_SPEED;
}

function stopAutoplayForUser() {
  if (!autoplay.enabled) return;
  autoplay.enabled = false;
  camera.dist = CONFIG.CAM_DIST; // ハンドオフ時に落ち着いた距離へ固定
  hint.classList.add("faded");
}

const pointerState = { down: false, lastX: 0, lastY: 0 };
function handlePointerDown(x, y) {
  stopAutoplayForUser();
  pointerState.down = true;
  pointerState.lastX = x;
  pointerState.lastY = y;
}
function handlePointerMove(x, y) {
  if (!pointerState.down) return;
  const dx = x - pointerState.lastX;
  const dy = y - pointerState.lastY;
  pointerState.lastX = x;
  pointerState.lastY = y;
  camera.yaw -= dx * CONFIG.DRAG_YAW_SENSITIVITY;
  camera.pitch = Math.min(CONFIG.PITCH_LIMIT, Math.max(-CONFIG.PITCH_LIMIT, camera.pitch + dy * CONFIG.DRAG_PITCH_SENSITIVITY));
}
function handlePointerUp() {
  pointerState.down = false;
}
canvas.addEventListener("pointerdown", (e) => handlePointerDown(e.clientX, e.clientY));
canvas.addEventListener("pointermove", (e) => handlePointerMove(e.clientX, e.clientY));
canvas.addEventListener("pointerleave", handlePointerUp);
window.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

// ----------------------------------------------------------------------------
// カメラ基底の構築(prototype #4 と同じ規約:forward/right/up を JS で作って渡す)
// ----------------------------------------------------------------------------
function computeCameraBasis() {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  // ターゲット(ポータル中心)を中心にオービット
  const eye = [
    target[0] + camera.dist * cp * sy,
    target[1] + camera.dist * sp,
    target[2] + camera.dist * cp * cy,
  ];
  const forward = normalize3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const worldUp = [0, 1, 0];
  // gluLookAt と同じ右手系:right = forward × up_world, up = right × forward。
  // これで画面 +x = ワールド右方向になり、上の変換の手計算(「左は左のまま」)と
  // 画面の見た目が一致する(cross の順を逆にすると全体が左右反転する)。
  const right = normalize3(cross3(forward, worldUp));
  const up = cross3(right, forward);
  return { eye, forward, right, up };
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
const startTime = performance.now();

function frame() {
  const t = (performance.now() - startTime) / 1000;
  updateAutoplay(t);

  const cam = computeCameraBasis();

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(program.program);

  gl.uniform2f(U.uResolution, canvas.width, canvas.height);
  gl.uniform1f(U.uTime, t);
  gl.uniform3f(U.uCameraPos, cam.eye[0], cam.eye[1], cam.eye[2]);
  gl.uniform3f(U.uForward, cam.forward[0], cam.forward[1], cam.forward[2]);
  gl.uniform3f(U.uRight, cam.right[0], cam.right[1], cam.right[2]);
  gl.uniform3f(U.uUp, cam.up[0], cam.up[1], cam.up[2]);
  gl.uniform1f(U.uFov, CONFIG.FOV);

  // ポータル姿勢
  gl.uniform3fv(U.uPortalCA, PORTAL.CENTER_A);
  gl.uniform3fv(U.uPortalNA, frameA.n);
  gl.uniform3fv(U.uPortalUA, frameA.u);
  gl.uniform3fv(U.uPortalVA, frameA.v);
  gl.uniform2fv(U.uPortalHalf, PORTAL.HALF);
  gl.uniformMatrix3fv(U.uPortalR, false, Rcm);
  gl.uniform3fv(U.uPortalCB, PORTAL.CENTER_B);
  gl.uniform3fv(U.uRoomBN, frameB.n);
  gl.uniform3fv(U.uRoomBU, frameB.u);
  gl.uniform3fv(U.uRoomBV, frameB.v);

  gl.uniform1f(U.uGrazeMin, CONFIG.GRAZE_MIN);
  gl.uniform1f(U.uMaxDist, CONFIG.MAX_DIST);
  gl.uniform1f(U.uSurfEps, CONFIG.SURF_EPS);

  // Room A
  gl.uniform1f(U.uAFloorY, ROOM_A.FLOOR_Y);
  gl.uniform3fv(U.uAAlbFloor, ROOM_A.ALBEDO_FLOOR);
  gl.uniform3fv(U.uAAlbBox, ROOM_A.ALBEDO_BOX);
  gl.uniform3fv(U.uAAlbFrame, ROOM_A.ALBEDO_FRAME);
  gl.uniform3fv(U.uAKeyDir, ROOM_A.KEY_DIR);
  gl.uniform3fv(U.uAKeyColor, ROOM_A.KEY_COLOR);
  gl.uniform3fv(U.uAAmbient, ROOM_A.AMBIENT);
  gl.uniform1f(U.uFrameW, ROOM_A.FRAME_W);
  gl.uniform1f(U.uFrameD, ROOM_A.FRAME_D);

  // Room B
  gl.uniform1f(U.uBFloorY, ROOM_B.FLOOR_Y);
  gl.uniform3fv(U.uBAlbFloor, ROOM_B.ALBEDO_FLOOR);
  gl.uniform3fv(U.uBAlbPillar, ROOM_B.ALBEDO_PILLAR);
  gl.uniform3fv(U.uBAlbSphere, ROOM_B.ALBEDO_SPHERE);
  gl.uniform3fv(U.uBAlbWall, ROOM_B.ALBEDO_WALL);
  gl.uniform3fv(U.uBKeyDir, ROOM_B.KEY_DIR);
  gl.uniform3fv(U.uBKeyColor, ROOM_B.KEY_COLOR);
  gl.uniform3fv(U.uBAmbient, ROOM_B.AMBIENT);
  gl.uniform1f(U.uBObjScale, ROOM_B.OBJ_SCALE);

  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
