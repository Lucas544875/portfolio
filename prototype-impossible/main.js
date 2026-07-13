// ============================================================================
// 不可能な結晶 — プロトタイプ #5(depth-swap トリックによる錯視)
//
// 参考: https://hausdorff-dimension.netlify.app/trick.frag
//
// ■ 何をやっているか
// フルスクリーンのレイマーチ(1つのSDFシーンをピクセルごとに描く。破片=#4の
// ラスタライズとは別系統で、#3(結晶レイマーチ)の直系)。ただし普通のレイマーチに
// 「depth-swap トリック」を1段足している:
//
//   1. まず distanceFunction(p)(結晶2ピース + 床)で通常のレイマーチをして
//      「一番手前の面」に当てる = nearHit
//   2. その当たった点から、視線方向へ固定量だけ踏み越し(overstep)、今度は
//      depthFunction(p)(床を含まない、結晶2ピースだけ)に対してもう一度マーチする
//      = trickMarch。このとき距離が負(=ピースの内部にいる)の間は sphere-trace
//      せずに固定量ずつ前進して内部を突き抜け、次の面(=奥のピースの面)を掴む
//   3. その「奥の面」で nearHit を置き換えて陰影計算する
//
// ■ 錯視の作り方(このプロトタイプ独自の形状設計)
// 2本のガラス角柱(rounded box)を、視線(スイートスポット方向 = -Z)に沿って
// 前後に大きく離し、かつ横(X)にずらして配置している:
//   - ピースA(手前, +Z 側): X の左半分をカバー
//   - ピースB(奥,   -Z 側): X の右半分をカバー
// スイートスポット(= Z 軸上からまっすぐ見る)からは A と B の投影(スクリーン上の
// X 範囲)が中央でオーバーラップし、"1本のつながった結晶棒" に見える。
// オーバーラップ領域では手前のAに当たった光線を、トリックが overstep で貫通させて
// 奥のBの面へ差し替える。これで A→B の継ぎ目が「奥へ段差なくつながった1本」として
// 読める(=本当は前後 2.0 も離れた2つの別ピースなのに、そこだけ連続に見える)。
//
// ■ 崩し方(インタラクション)
// トリックの効き(uTrickAmount, 0..1)を、現在のカメラ前方ベクトルとスイートスポット
// 方向の内積の smoothstep で連続的にブレンドする。スイートスポットに近いほど 1.0
// (トリック全開=つながって見える)、離れるほど 0.0(素の nearHit=手前のAの面を
// そのまま描く=A と B が前後・左右にズレた別々の2ピースだと露呈する)。
// ブレンドは「ヒット位置・法線を mix してから1回だけ陰影計算」する真のクロスフェード
// なので、視点を動かすと錯視が"割れて"いく過程がなめらかに見える(ここが主眼)。
//
// ■ カメラ
// #1〜#4と同じ「自動再生 → ドラッグでハンドオフ」。ただし本作は錯視が主役なので、
// ロード直後はまずスイートスポットで静止(LINGER_SECONDS)して"完成した錯視"を
// 見せてから、ゆっくり視点をドリフトさせて崩れ始めるようにしている。ユーザーが
// ドラッグした瞬間に自由オービットへ引き継ぐ。
//
// ■ 検証について
// この環境ではブラウザ描画を目視できないため、レイマーチ/法線/トリックの overstep は
// すべて数式で詰めている(無限ループ・NaN を出さないよう反復・距離を必ずキャップし、
// 奥の面が見つからなければ nearHit にフォールバックする)。錯視が"実際につながって
// 見えるか"は人間の目視チューニングが必要。README の「視覚的に未検証な点」を参照。
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: true,
  depth: false, // フルスクリーン1パスのレイマーチなので深度バッファは使わない
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 is not supported.");
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config — 人間が目視後にチューニングする定数はすべてここに集約する
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.6 : 1.0, // フルスクリーンをレイマーチするので重い。モバイルは内部解像度を落とす
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,

  // ---- カメラ ----
  // この手の錯視は近オルソ(遠くから狭い画角)が正しい領域。カメラを引いて FOV を
  // 上げると、前後に離れた2ピースの「遠近による見かけの太さの差」が小さくなり、
  // 継ぎ目が太さの揃った1本に見えやすくなる(近すぎると奥のピースが細く見えて割れる)。
  FOV: 2.9, // rd = normalize(forward*FOV + right*x + up*y)。大きいほど画角が狭い(#3/#4と同じ流儀)
  CAM_DIST: 9.0,

  // ---- スイートスポット(錯視が成立する唯一の視点)----
  // yaw=pitch=0 で eye=(0,0,CAM_DIST), 前方=(0,0,-1)。2本の角柱は
  // この -Z 視線に沿って前後に並べてあるので、ここからだけ投影が一致する。
  // ※もっと"3/4アングル"の見栄えのするスイートスポットにしたい場合は、
  //   この yaw/pitch と下の PIECE_* 配置を一緒に作り直す必要がある(README参照)。
  SWEET_YAW: 0.0,
  SWEET_PITCH: 0.0,

  // ---- トリックのブレンド範囲(前方ベクトル・スイートスポット方向の内積のしきい値)----
  // 内積が TRICK_COS_INNER(=cos(内側角度))以上 → トリック全開(1.0)
  // 内積が TRICK_COS_OUTER(=cos(外側角度))以下 → トリック無効(0.0)
  // ここは完全に見た目次第の推定値。錯視が割れ始める角度が早すぎ/遅すぎたら広げる/狭める。
  TRICK_COS_INNER: Math.cos((6.0 * Math.PI) / 180.0), // スイートスポットから約6°までは完全につながって見せる
  TRICK_COS_OUTER: Math.cos((22.0 * Math.PI) / 180.0), // 約22°離れると完全に素の姿(2ピース)

  // ---- 2本の結晶角柱(ワールド座標。回転なしの軸並行 box で法線・推論を単純化)----
  // A は手前(+Z)・左寄り、B は奥(-Z)・右寄り。Y 範囲は共通にして棒の太さを継ぎ目で揃える。
  // A: x∈[-2.3,0.7] z≈[0.66,1.34], B: x∈[-0.7,2.3] z≈[-1.34,-0.66]。
  // 投影の重なりは x∈[-0.7,0.7]、合わせると x∈[-2.3,2.3] の1本の長い棒に見える。
  PIECE_A_CENTER: [-0.8, 0.0, 1.0],
  PIECE_A_HALF: [1.5, 0.34, 0.34],
  PIECE_B_CENTER: [0.8, 0.0, -1.0],
  PIECE_B_HALF: [1.5, 0.34, 0.34],
  PIECE_ROUND: 0.07, // rounded box の丸め半径(結晶らしい面取り)

  // ---- トリックマーチ ----
  // TRICK_OVERSTEP: nearHit から最初に踏み越す距離。手前ピースを飛び越え、かつ
  //   「一気に奥ピースBの内部へ着地して貫通してしまう」ほど大きくしない値にする。
  //   本配置では A 前面(z≈1.41)から B 前面(z≈-0.59)まで 2.0 なので、
  //   OVERSTEP < 2.0 なら最初の踏み越しで B の内部には入らない(手前のギャップに落ちる)。
  TRICK_OVERSTEP: 0.6,
  TRICK_INTERIOR_STEP: 0.3, // ピース内部(d<0)を突き抜けるときの固定前進量(ピース厚 0.68 未満に)
  TRICK_MAX_DIST: 10.0, // これ以上進んだら奥に面が無いと見なして打ち切り(→フォールバック)

  // ---- ガラス(クリスタル)の物理量。#4 と同じ考え方の簡略版 ----
  IOR: 1.52, // d線(緑)の屈折率
  ABBE: 40.0, // アッベ数(分散の指標)。R/G/B の屈折率差 = 色収差の元
  GLASS_TINT: [0.82, 0.92, 0.98], // 屈折光に薄く乗せる硝子の吸収色

  // ---- 床(参考デモに合わせて distanceFunction にだけ入れる。トリック=depthFunctionには入れない)----
  FLOOR_Y: -1.7,

  // ---- レイマーチのループ上限(GLSL のループ境界はコンパイル時定数なので JS から注入)----
  MARCH_STEPS: isCoarsePointer ? 96 : 160,
  TRICK_STEPS: isCoarsePointer ? 40 : 72,
  SHADOW_STEPS: isCoarsePointer ? 12 : 24,
  MAX_DIST: 40.0,
  SURF_EPS: 0.0009,
  NORMAL_EPS: 0.0015,

  // ---- 自動再生 → ハンドオフ ----
  LINGER_SECONDS: 3.2, // ロード後、スイートスポットで静止して"完成した錯視"を見せておく時間
  DRIFT_YAW_SPEED: 0.12, // その後ゆっくり yaw をずらして錯視を崩し始める速さ
  DRIFT_PITCH_AMP: 0.12,
  DRIFT_PITCH_SPEED: 0.5,
  DRAG_YAW_SENSITIVITY: 0.008,
  DRAG_PITCH_SENSITIVITY: 0.008,
  PITCH_LIMIT: 1.2,
};

// スイートスポットの前方ベクトル(= eye から原点を見る向き)。yaw/pitch から導出。
function forwardFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // eye = CAM_DIST * (cp*sy, sp, cp*cy) を正規化して符号反転(原点向き)
  return [-cp * sy, -sp, -cp * cy];
}
const SWEET_RD = forwardFromYawPitch(CONFIG.SWEET_YAW, CONFIG.SWEET_PITCH);

// ----------------------------------------------------------------------------
// GL helpers
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

// GLSL の float リテラルには必ず小数点を付ける(40 → "40.0")。int(ループ境界)は別扱い。
function f(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}
function v3(a) {
  return `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;
}

// ----------------------------------------------------------------------------
// Shaders
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

const fragmentShaderSource = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform vec3 uCameraPos;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uFov;
uniform float uTrickAmount; // 0..1: トリックの効き(スイートスポットで1、離れると0)

// ---- 形状・マーチの定数(JS の CONFIG から注入)----
const vec3  A_CENTER   = ${v3(CONFIG.PIECE_A_CENTER)};
const vec3  A_HALF     = ${v3(CONFIG.PIECE_A_HALF)};
const vec3  B_CENTER   = ${v3(CONFIG.PIECE_B_CENTER)};
const vec3  B_HALF     = ${v3(CONFIG.PIECE_B_HALF)};
const float PIECE_ROUND    = ${f(CONFIG.PIECE_ROUND)};
const float FLOOR_Y        = ${f(CONFIG.FLOOR_Y)};
const float SURF_EPS       = ${f(CONFIG.SURF_EPS)};
const float NORMAL_EPS     = ${f(CONFIG.NORMAL_EPS)};
const float MAX_DIST       = ${f(CONFIG.MAX_DIST)};
const float TRICK_OVERSTEP      = ${f(CONFIG.TRICK_OVERSTEP)};
const float TRICK_INTERIOR_STEP = ${f(CONFIG.TRICK_INTERIOR_STEP)};
const float TRICK_MAX_DIST      = ${f(CONFIG.TRICK_MAX_DIST)};
const float IOR  = ${f(CONFIG.IOR)};
const float ABBE = ${f(CONFIG.ABBE)};
const vec3  GLASS_TINT = ${v3(CONFIG.GLASS_TINT)};

// ---- SDF ----
// 丸め角の直方体(結晶角柱)。中心 c・半径方向の半サイズ b・面取り r
float sdRoundBox (vec3 p, vec3 c, vec3 b, float r) {
  vec3 q = abs(p - c) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdPieceA (vec3 p) { return sdRoundBox(p, A_CENTER, A_HALF, PIECE_ROUND); }
float sdPieceB (vec3 p) { return sdRoundBox(p, B_CENTER, B_HALF, PIECE_ROUND); }

// depthFunction: 結晶2ピースだけ(床を含まない)。トリック(貫通マーチ)と影が使う。
float depthFunction (vec3 p) { return min(sdPieceA(p), sdPieceB(p)); }

// 水平な床の平面(法線 (0,1,0))。平面なので符号付き距離は厳密。
float sdFloor (vec3 p) { return p.y - FLOOR_Y; }

// distanceFunction: 通常のレイマーチが当てる「本当の一番手前の面」= 結晶 + 床
float distanceFunction (vec3 p) { return min(depthFunction(p), sdFloor(p)); }

// depthFunction の勾配から法線(トリック後の奥の面・近接の結晶面で使う)
vec3 calcNormalDepth (vec3 p) {
  vec2 e = vec2(NORMAL_EPS, 0.0);
  return normalize(vec3(
    depthFunction(p + e.xyy) - depthFunction(p - e.xyy),
    depthFunction(p + e.yxy) - depthFunction(p - e.yxy),
    depthFunction(p + e.yyx) - depthFunction(p - e.yyx)
  ));
}

// ---- 環境(背景 = 結晶に映り込む空間)----
vec3 background (vec3 rd) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.025, 0.03, 0.05), vec3(0.09, 0.12, 0.19), h);
  // 3つのスタジオ光源風の光点(const にすると normalize が定数式にならないので局所変数)
  vec3 L0 = normalize(vec3(0.4, 0.7, 0.5));
  vec3 L1 = normalize(vec3(-0.6, 0.3, 0.4));
  vec3 L2 = normalize(vec3(0.1, -0.5, -0.7));
  col += vec3(1.0, 0.96, 0.9) * pow(max(dot(rd, L0), 0.0), 350.0) * 3.0;
  col += vec3(0.6, 0.8, 1.0) * pow(max(dot(rd, L1), 0.0), 60.0) * 0.08;
  col += vec3(1.0, 0.6, 0.4) * pow(max(dot(rd, L2), 0.0), 220.0) * 1.4;
  return col;
}

// ---- 通常のレイマーチ(distanceFunction)----
// 戻り値: ヒット距離 t(ミスなら -1)。matId: 0=結晶, 1=床
float march (vec3 ro, vec3 rd, out int matId) {
  float t = 0.0;
  matId = -1;
  for (int i = 0; i < ${CONFIG.MARCH_STEPS}; i++) {
    vec3 p = ro + rd * t;
    float d = distanceFunction(p);
    if (d < SURF_EPS) {
      matId = (sdFloor(p) < depthFunction(p)) ? 1 : 0;
      return t;
    }
    t += d;
    if (t > MAX_DIST) break;
  }
  return -1.0;
}

// ---- depth-swap トリック ----
// nearHit(startPos)から視線方向へ overstep で踏み越し、depthFunction に対して
// 再マーチする。内部(d<0)の間は固定量ずつ前進して突き抜け、次に出会う面(奥の
// ピースの面)を掴む。反復・距離を必ずキャップし、奥に面が無ければ found=false で
// startPos を返す(=呼び出し側が nearHit にフォールバックできる)。
vec3 trickMarch (vec3 startPos, vec3 rd, out bool found) {
  found = false;
  float t = TRICK_OVERSTEP; // まず手前の面を確実に踏み越す
  for (int i = 0; i < ${CONFIG.TRICK_STEPS}; i++) {
    vec3 p = startPos + rd * t;
    float d = depthFunction(p);
    if (d < 0.0) {
      t += TRICK_INTERIOR_STEP; // ピース内部: sphere-trace せず固定量で突き抜ける
    } else if (d < SURF_EPS) {
      found = true; // 奥の面に到達
      return p;
    } else {
      t += d; // 隙間: 通常の sphere-trace で次の面へ寄る
    }
    if (t > TRICK_MAX_DIST) break; // 奥に何も無かった → 打ち切り
  }
  return startPos; // フォールバック(nearHit をそのまま使う)
}

// ---- 影(結晶が床に落とす。2ピースが別物であることを露呈させる手掛かり)----
float softShadow (vec3 ro, vec3 ld) {
  float res = 1.0;
  float t = 0.05;
  for (int i = 0; i < ${CONFIG.SHADOW_STEPS}; i++) {
    vec3 p = ro + ld * t;
    float d = depthFunction(p);
    if (d < 0.001) return 0.0;
    res = min(res, 8.0 * d / t);
    t += clamp(d, 0.02, 0.5);
    if (t > 6.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

// ---- ガラス(クリスタル)陰影。#4 と同じ考え方の簡略版(屈折先は背景のみを覗く)----
vec3 shadeCrystal (vec3 pos, vec3 nIn, vec3 rd) {
  vec3 n = nIn;
  vec3 v = -rd;
  if (dot(n, v) < 0.0) n = -n; // 視点側を向くように
  float ndv = clamp(dot(n, v), 0.0, 1.0);

  float f0 = pow((IOR - 1.0) / (IOR + 1.0), 2.0);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

  vec3 refl = reflect(rd, n);
  vec3 reflCol = background(refl);

  // R/G/B を分散から求めた別々の屈折率で refract。この差が色収差。
  float disp = (IOR - 1.0) / ABBE;
  vec3 rR = refract(rd, n, 1.0 / (IOR - 0.4 * disp));
  vec3 rG = refract(rd, n, 1.0 / IOR);
  vec3 rB = refract(rd, n, 1.0 / (IOR + 0.6 * disp));
  if (dot(rR, rR) < 1e-4) rR = refl; // 全反射時のフォールバック(空気→ガラスなので理論上は起きない)
  if (dot(rG, rG) < 1e-4) rG = refl;
  if (dot(rB, rB) < 1e-4) rB = refl;
  vec3 refrCol = vec3(background(rR).r, background(rG).g, background(rB).b);
  refrCol *= GLASS_TINT; // 硝子の薄い吸収色

  vec3 col = mix(refrCol, reflCol, clamp(fresnel, 0.0, 1.0));

  // 鋭いスペキュラ + フレネルリム(#3/#4 と同じく単調なグレーに沈むのを防ぐ)
  vec3 keyDir = normalize(vec3(0.4, 0.7, 0.5));
  col += pow(clamp(dot(refl, keyDir), 0.0, 1.0), 400.0) * vec3(1.0, 0.97, 0.92) * 5.0;
  col += pow(1.0 - ndv, 3.0) * vec3(0.5, 0.7, 1.0) * 0.25;
  col += vec3(0.02, 0.03, 0.045); // わずかな地色
  return col;
}

// ---- 床の陰影(暗くて控えめ。錯視の主役ではなく"接地"のためだけ)----
vec3 shadeFloor (vec3 pos, vec3 rd) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.5));
  float sh = softShadow(pos + n * 0.03, lightDir);
  float diff = clamp(dot(n, lightDir), 0.0, 1.0);
  vec3 base = vec3(0.035, 0.04, 0.05);
  vec3 col = base * (0.35 + 0.65 * sh) + diff * vec3(0.06, 0.065, 0.07) * sh;
  vec3 refl = reflect(rd, n);
  col = mix(col, background(refl) * 0.4, 0.12);
  return col;
}

// ---- ポストプロセス ----
vec3 reinhard (vec3 c) { return c / (c + vec3(1.0)); }
vec3 gammaCorrect (vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
float vignette (vec2 ndc, float aspect) {
  return smoothstep(0.35, 1.2, length(vec2(ndc.x * aspect, ndc.y)));
}

void main () {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;
  vec3 rd = normalize(uForward * uFov + uRight * uv.x + uUp * uv.y);
  vec3 ro = uCameraPos;

  int matId;
  float t = march(ro, rd, matId);

  vec3 col;
  if (t < 0.0) {
    col = background(rd);
  } else {
    vec3 hitPos = ro + rd * t;
    if (matId == 1) {
      // 床はトリックの対象外(depthFunction に床は無い)。参考デモと同じ扱い。
      col = shadeFloor(hitPos, rd);
    } else {
      // 結晶: 手前のヒットと、トリックで掴んだ奥のヒットをクロスフェードする
      vec3 nearN = calcNormalDepth(hitPos);
      vec3 pos = hitPos;
      vec3 nrm = nearN;

      if (uTrickAmount > 0.001) {
        bool found;
        vec3 farPos = trickMarch(hitPos, rd, found);
        if (found) {
          vec3 farN = calcNormalDepth(farPos);
          float a = uTrickAmount;
          // 位置と法線を先に mix してから1回だけ陰影計算する = 真のクロスフェード。
          // これで視点移動に伴い錯視が"割れる"過程がなめらかに見える。
          pos = mix(hitPos, farPos, a);
          vec3 mixedN = mix(nearN, farN, a);
          nrm = (length(mixedN) > 1e-4) ? normalize(mixedN) : nearN; // 逆向き同士でゼロにならない保険
        }
      }

      col = shadeCrystal(pos, nrm, rd);
    }

    // 距離フォグで背景へなじませる
    float fog = 1.0 - exp(-t * 0.02);
    col = mix(col, background(rd), fog * 0.35);
  }

  col = gammaCorrect(reinhard(col));
  col *= mix(1.0, 0.75, vignette(vUv, aspect));
  fragColor = vec4(col, 1.0);
}
`;

const program = createProgram(quadVertexShaderSource, fragmentShaderSource);

// フルスクリーン三角形ストリップ
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
// Camera: スイートスポットで静止 → ドリフト → ドラッグでハンドオフ
// ----------------------------------------------------------------------------
const camera = { yaw: CONFIG.SWEET_YAW, pitch: CONFIG.SWEET_PITCH };
const autoplay = { enabled: true };

function updateAutoplay(t) {
  if (!autoplay.enabled) return;
  if (t < CONFIG.LINGER_SECONDS) {
    // ロード直後はスイートスポットで静止して"完成した錯視"を見せる
    camera.yaw = CONFIG.SWEET_YAW;
    camera.pitch = CONFIG.SWEET_PITCH;
    return;
  }
  // その後ゆっくり視点をずらして錯視を崩し始める
  const dt = t - CONFIG.LINGER_SECONDS;
  camera.yaw = CONFIG.SWEET_YAW + dt * CONFIG.DRIFT_YAW_SPEED;
  camera.pitch = CONFIG.SWEET_PITCH + Math.sin(dt * CONFIG.DRIFT_PITCH_SPEED) * CONFIG.DRIFT_PITCH_AMP;
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
canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

// ----------------------------------------------------------------------------
// トリックの効きを、前方ベクトルとスイートスポット方向の内積の smoothstep で求める
// ----------------------------------------------------------------------------
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function computeTrickAmount(forward) {
  const d = forward[0] * SWEET_RD[0] + forward[1] * SWEET_RD[1] + forward[2] * SWEET_RD[2];
  // 内積が INNER(≈1)なら 1.0、OUTER まで下がると 0.0
  return smoothstep(CONFIG.TRICK_COS_OUTER, CONFIG.TRICK_COS_INNER, d);
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
const startTime = performance.now();

function frame() {
  const t = (performance.now() - startTime) / 1000;
  updateAutoplay(t);

  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const eye = [CONFIG.CAM_DIST * cp * sy, CONFIG.CAM_DIST * sp, CONFIG.CAM_DIST * cp * cy];

  const forward = [-eye[0] / CONFIG.CAM_DIST, -eye[1] / CONFIG.CAM_DIST, -eye[2] / CONFIG.CAM_DIST];
  const up = [0, 1, 0];
  // right = up × forward
  const rx = up[1] * forward[2] - up[2] * forward[1];
  const ry = up[2] * forward[0] - up[0] * forward[2];
  const rz = up[0] * forward[1] - up[1] * forward[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  const right = [rx / rl, ry / rl, rz / rl];
  // trueUp = forward × right
  const trueUp = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];

  const trickAmount = computeTrickAmount(forward);

  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = useProgram(program);
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  gl.uniform3f(u.uCameraPos, eye[0], eye[1], eye[2]);
  gl.uniform3f(u.uForward, forward[0], forward[1], forward[2]);
  gl.uniform3f(u.uRight, right[0], right[1], right[2]);
  gl.uniform3f(u.uUp, trueUp[0], trueUp[1], trueUp[2]);
  gl.uniform1f(u.uFov, CONFIG.FOV);
  gl.uniform1f(u.uTrickAmount, trickAmount);

  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
