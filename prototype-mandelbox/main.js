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
//     WebGL2のGLSLにはハードウェアの倍精度が無いため、float32のペア(hi/lo)
//     で倍精度相当を再現する df64(double-float)演算を GPU 側に実装した
//     (README「df64(double-float)による倍精度」参照)。素の float32 は
//     目標点 p0(O(1) の座標)から見て相対 1e-6〜1e-7 程度離れたオフセット
//     までしか安定に解決できないのに対し、df64 では Node.js での実測で
//     ~1e-12〜1e-14 付近まで構造を保って解決できる。それでも有限の精度
//     である以上いつか限界には達するため、「ズーム開始距離(数単位)から
//     この限界まで対数的に一定速度で潜り、限界に達したらフェードで次の
//     1点へ移る」を延々と繰り返すことで、有限の精度で「無限に潜り続けて
//     いる」体感を作る。
//  3. カメラは常に固定した1本の直線(p0 を通る視線)の上だけを、指数的に
//     縮む距離 dist(t) で前後するだけ(横に振れたりオービットしたりは
//     しない)。ro = p0 + camOffset(t) の合成(dist(t) を含む)は、
//     p0 を df64 の (hi,lo) のまま GPU に渡し、tiny な camOffset をそこへ
//     df64 の補正加算で足し込むことで行う——CPU側で先に倍精度の p0 と
//     dist を1つの float64 に潰してしまうと、そちらの精度(53bit)が
//     ボトルネックになってしまうため。ドラッグによる見回しは、この基準
//     方向に対するクォータニオン回転(制限なし、ジンバルロック無し)の
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
  MAX_STEPS: 220,
  STEP_SAFETY: 0.93,
  // 表面判定のイプシロンは「カメラ距離全体に比例した定数」ではなく、
  // レイの進行距離 t × 1ピクセルが投影される角度サイズ、で決める
  // (README「遠景でのっぺりする問題」参照)。SURF_EPS_PIXEL_MULT は
  // 1ピクセル分のイプシロンに掛ける安全率。
  SURF_EPS_PIXEL_MULT: 1.5,
  SURF_EPS_MIN: 1e-13, // DIST_MIN(下記)より十分小さい絶対下限
  FAR_MULT: 6.0, // uMaxDist = 現在のカメラ距離 * FAR_MULT
  FOG_K: 1.5,

  // --- 配色・ライティング(参考: https://hausdorff-dimension.netlify.app/mandelbox.html の mandelbox.frag) ---
  // 参考サイトの incCenter(軸±2)・incRadius(2.0)は、参考サイトの
  // カメラ距離(11)に対する比率(≒0.18)をこちらの OVERVIEW_DIST に
  // 当てはめてスケールしたもの。
  GLOW_RADIUS: 2.4,
  BRIGHTNESS: 1.0, // ガンマ補正前の線形色に掛ける明るさ倍率(色相・彩度は不変)
  // grow(ステップ消費率ベースの発光)のsmoothstep閾値。参考サイトの
  // smoothstep(0, 0.95, iterate) は「ステップ予算の95%を使うほど複雑な
  // 箇所」でしか発火しない厳しい閾値で、自己相似構造が常に画面を占める
  // このプロトタイプでは100倍ズーム以降ほとんど視認できなくなっていた。
  // 閾値を大きく緩め、もっと早い段階から強くかかるようにしている。
  GROW_ITER_LO: 0.0,
  GROW_ITER_HI: 0.3,

  // --- ズームサイクル ---
  OVERVIEW_DIST: 13.0, // 全体を見渡す距離(BOUND_RADIUSの実測値から逆算、README参照)
  // df64の中心レイ単体(オフセットを直接p0へ補正加算するケース)は理論上
  // ~1e-12〜1e-14あたりまで安定に解決できるが、画面全域(中心からズレた
  // レイ)まで含めると実際にはずっと手前で崩れ始める。実機・複数の
  // pickTarget()先で実測したところ、dist~1e-4(zoom~10^5倍)あたりまでは
  // 密でクリアな構造を保ち、~1e-5(10^6倍)前後からまばらな点状に薄れ、
  // ~1e-7(10^7〜8倍)で実質何も見えなくなる、という経過をたどる
  // (README「df64(double-float)による倍精度」参照)。「まばらになり
  // 始める手前」で止まる旧設定(5e-5)はやや保守的すぎたため、
  // 「薄れてはいくが真っ黒にはならない」範囲まで一段深くした。
  DIST_MIN: 1e-5,
  ORBIT_DURATION: 4.0, // 秒。overview フェーズの長さ
  DIVE_DURATION: 26.0, // 秒。dive フェーズの長さ(この間 dist は指数的にDIST_MINまで縮む)。
                        // DIST_MIN引き下げ分、1桁あたりの速さが変わらないよう比例して延長。
  FADE_DURATION: 1.1, // 秒。次の1点へ切り替える際のフェード

  // rad/秒。サイクル全体を通した緩やかな自動首振り。
  // pixel-projected epsilon(README「遠景でのっぺりする問題」参照)導入前は
  // イプシロンが粗く、多少カメラの向きがp0からズレても周辺の粗い構造に
  // 「引っかかって」何かしら映っていたが、精密なイプシロンでは首振りが
  // 累積してp0の方向から大きくズレると、dive後半でレイが本当に何にも
  // 当たらなくなり画面が真っ黒になる(headless Chromiumでの実描画と
  // Node.js上の同一ロジック再現の両方でyaw=90°付近で完全に0hitになる
  // ことを確認)。DIVE_DURATION全体を通した首振りが約15°を超えないよう
  // 旧値(0.045)から引き下げた。
  AUTO_YAW_SPEED: 0.006,
  WHEEL_SPEED_MULT_RANGE: [0.35, 3.2],
  WHEEL_SENSITIVITY: 0.0011,
  DRAG_YAW_SENSITIVITY: 0.0042,
  DRAG_PITCH_SENSITIVITY: 0.0042,

  // 手持ちカメラのような微小なランダム揺れ。実時間(performance.now())
  // 基準の複数のサイン波を合成した疑似ノイズで、周期性が目立たないように
  // している(README「カメラ」参照)。AUTO_YAW_SPEEDと違って蓄積しない
  // 揺らぎなので、大きくしすぎない限りdive中にレイが的を外す心配はない。
  SHAKE_AMPLITUDE: 0.01, // rad。yaw/pitchの最大振れ幅の目安
  SHAKE_ROLL_MULT: 0.5, // rollはyaw/pitchよりやや控えめに
  SHAKE_SPEED: 1.0, // 大きいほど手ブレが速く/小刻みになる
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
function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

// ----------------------------------------------------------------------------
// クォータニオン(w,x,y,z)。ドラッグによる自由な見回しをオイラー角
// (yaw→pitch)ではなくクォータニオンの合成で表すことで、特定の角度で
// 感度が落ちたり回転が破綻したりするジンバルロックを避け、上下逆さまも
// 含めて任意方向へ制限なく回転できるようにする(README「カメラ」参照)。
// ----------------------------------------------------------------------------
function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qFromAxisAngle(axis, angle) {
  const s = Math.sin(angle * 0.5);
  return [Math.cos(angle * 0.5), axis[0] * s, axis[1] * s, axis[2] * s];
}
function qNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qRotateVec(q, v) {
  const p = [0, v[0], v[1], v[2]];
  const r = qMul(qMul(q, p), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
}
const Q_IDENTITY = [1, 0, 0, 0];

// 手持ちカメラの揺れを模した疑似ノイズ。周波数の異なる3つのサイン波を
// 重ねるだけの簡易な実装だが、位相(seed)をずらして呼べば軸ごとに
// 無相関な、いかにも人の手のブレっぽい非周期の揺れが得られる。戻り値は
// おおよそ[-1, 1]に収まる(振幅の合計が1になるよう重み付けしてある)。
function shakeNoise(t, seed) {
  return (
    Math.sin(t * 1.3 + seed) * 0.5 +
    Math.sin(t * 2.7 + seed * 1.7) * 0.3 +
    Math.sin(t * 5.1 + seed * 2.3) * 0.2
  );
}

// JSの倍精度(number)を、GPUへdf64として渡すためのfloat32ペア(hi,lo)に
// 分割する(README「df64(double-float)による倍精度」参照)。
function splitFloat(x) {
  const hi = Math.fround(x);
  const lo = Math.fround(x - hi);
  return [hi, lo];
}
function splitVec3(v) {
  const sx = splitFloat(v[0]), sy = splitFloat(v[1]), sz = splitFloat(v[2]);
  return { hi: [sx[0], sy[0], sz[0]], lo: [sx[1], sy[1], sz[1]] };
}

// ヒットしきい値は DIST_MIN(GPU側でdf64により潜れる下限)より十分小さく
// 締めておく必要がある。ここが緩いと、p0 自身が isosurface からズレた
// 「だいたい表面上」の点になり、そのズレが DIST_MIN のスケールでは無視
// できない誤差になって、深く潜るほど全く違う構造に着地したり完全に
// 外れたりする(README「df64(double-float)による倍精度」参照)。
//
// ただし締めすぎても壊れる: このレイマーチは STEP_SAFETY 等の減衰を
// 掛けない素朴な sphere tracing で、fold構造が複雑な箇所ではDEの収束が
// 1e-8〜1e-9あたりで頭打ちになりやすい。しきい値を 1e-13 まで締めていた
// ところ、800ステップの予算内でまず到達できず、ほぼ毎回 pickTarget() の
// 全24試行が失敗してフォールバック地点(常に同じ座標)に落ちる
// バグになっていた(「ズーム先が毎回同じ場所になる」として発覚。Node.js
// で150回の試行を複数のしきい値で実測し、1e-6 は約99%が800ステップ
// 以内に到達する一方、1e-8 以下では成功率が急落することを確認した)。
const PICK_TARGET_HIT_EPS = 1e-6;
function jsRaymarch(ro, rd, maxDist) {
  let t = 0;
  for (let i = 0; i < 800; i++) {
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const d = jsDE(p[0], p[1], p[2]);
    if (d < PICK_TARGET_HIT_EPS) return { hit: true, t, p };
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
uniform vec3 uP0_hi; // 潜る先の1点 p0 の上位(float32丸め)成分
uniform vec3 uP0_lo; // p0 の残差(下位)成分。uP0_hiと合わせてdf64のp0を成す
uniform vec3 uCamOffset; // カメラ位置 - p0(README「df64(double-float)による倍精度」参照)
uniform vec3 uF;
uniform vec3 uR;
uniform vec3 uU;
uniform float uMaxDist; // 現在のカメラ〜目標点距離に比例。フォグをこれ基準にしてスケール不変にする

const float SCALE   = ${f(CONFIG.SCALE)};
const float MINR2   = ${f(CONFIG.MINR2)};
const float FIXEDR2 = ${f(CONFIG.FIXEDR2)};
const float FOLD    = ${f(CONFIG.FOLD)};
const int   ITER    = ${Math.round(CONFIG.ITER)};
const float FOCAL   = ${f(CONFIG.FOCAL)};
const int   MAX_STEPS = ${Math.round(CONFIG.MAX_STEPS)};
const float STEP_SAFETY = ${f(CONFIG.STEP_SAFETY)};
const float SURF_EPS_PIXEL_MULT = ${f(CONFIG.SURF_EPS_PIXEL_MULT)};
const float SURF_EPS_MIN = ${f(CONFIG.SURF_EPS_MIN)};
const float FOG_K = ${f(CONFIG.FOG_K)};

// 参考サイト(mandelbox.frag)のマテリアル定数をそのまま移植。
const vec3  BASE_COLOR = vec3(0.454, 0.301, 0.211); // マテリアル BROWN
const vec3  GLOW_COLOR = vec3(1.000, 0.501, 0.200); // 白熱光/グローの色
const vec3  LIGHT_DIR  = normalize(vec3(2.0, 1.0, 1.0));
const float AMBIENT_INTENSITY = 0.7;
const float DIFFUSE_INTENSITY = 1.1;
const float INC_INTENSITY = 1.5;
const float GLOW_RADIUS = ${f(CONFIG.GLOW_RADIUS)}; // incCenter・incRadius 兼用(参考サイトでは両方 2.0)
const float GROW_INTENSITY = 1.0;
const float GROW_ITER_LO = ${f(CONFIG.GROW_ITER_LO)};
const float GROW_ITER_HI = ${f(CONFIG.GROW_ITER_HI)};
// ガンマ補正(pow 2.2)にかける前の線形色を一律に底上げする係数。
// 全チャンネルへ同じ倍率をかけるだけなので色相・彩度の比率は変わらず、
// 明るさだけが持ち上がる(色味は変えずに明るくする)。
const float BRIGHTNESS = ${f(CONFIG.BRIGHTNESS)};

vec3 skyColor() {
  return vec3(0.0); // 参考サイトの背景(マテリアル SAIHATE)は完全な黒
}

// ----------------------------------------------------------------------------
// df64: float32 の (hi, lo) ペアで倍精度相当を再現する「double-float」演算
// (Dekker/Knuth の2Sum・2Prodアルゴリズムをfloat32の24bit仮数部向けに
// 実装したもの)。WebGL2のGLSLにハードウェアのdouble型が無いため、座標
// だけをこの表現で持ち回ることで、float32単体では相対オフセット~1e-6で
// 崩れる精度を~1e-12〜1e-14付近まで伸ばす(README「df64(double-float)に
// よる倍精度」参照、Node.js上で真の倍精度と比較して実測)。
// ----------------------------------------------------------------------------
vec2 twoSum(float a, float b) {
  float s = a + b;
  float v = s - a;
  float e = (a - (s - v)) + (b - v);
  return vec2(s, e);
}
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  float e = b - (s - a);
  return vec2(s, e);
}
void split32(float a, out float hi, out float lo) {
  float c = 4097.0 * a; // 2^12+1: float32(24bit仮数部)向けのVeltkamp分割定数
  hi = c - (c - a);
  lo = a - hi;
}
vec2 twoProd(float a, float b) {
  float p = a * b;
  float aHi, aLo, bHi, bLo;
  split32(a, aHi, aLo);
  split32(b, bHi, bLo);
  float e = ((aHi * bHi - p) + aHi * bLo + aLo * bHi) + aLo * bLo;
  return vec2(p, e);
}
vec2 dfAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  s.y += a.y + b.y;
  return quickTwoSum(s.x, s.y);
}
vec2 dfAddF(vec2 a, float b) {
  vec2 s = twoSum(a.x, b);
  s.y += a.y;
  return quickTwoSum(s.x, s.y);
}
vec2 dfSub(vec2 a, vec2 b) { return dfAdd(a, vec2(-b.x, -b.y)); }
vec2 dfMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  p.y += a.x * b.y + a.y * b.x;
  return quickTwoSum(p.x, p.y);
}
vec2 dfMulF(vec2 a, float b) {
  vec2 p = twoProd(a.x, b);
  p.y += a.y * b;
  return quickTwoSum(p.x, p.y);
}
vec2 dfDiv(vec2 a, vec2 b) {
  float q1 = a.x / b.x;
  vec2 r = dfSub(a, dfMulF(b, q1));
  float q2 = r.x / b.x;
  r = dfSub(r, dfMulF(b, q2));
  float q3 = r.x / b.x;
  vec2 q = quickTwoSum(q1, q2);
  return dfAddF(q, q3);
}
vec2 dfFromFloat(float a) { return vec2(a, 0.0); }
float dfToFloat(vec2 a) { return a.x + a.y; }

// vec3を成分ごとにdf64で保持する「倍精度座標」。
struct DF3 { vec3 hi; vec3 lo; };

vec3 df3ToVec3(DF3 a) { return a.hi + a.lo; }

DF3 df3AddVec3(DF3 a, vec3 b) {
  vec2 rx = dfAddF(vec2(a.hi.x, a.lo.x), b.x);
  vec2 ry = dfAddF(vec2(a.hi.y, a.lo.y), b.y);
  vec2 rz = dfAddF(vec2(a.hi.z, a.lo.z), b.z);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3Add(DF3 a, DF3 b) {
  vec2 rx = dfAdd(vec2(a.hi.x, a.lo.x), vec2(b.hi.x, b.lo.x));
  vec2 ry = dfAdd(vec2(a.hi.y, a.lo.y), vec2(b.hi.y, b.lo.y));
  vec2 rz = dfAdd(vec2(a.hi.z, a.lo.z), vec2(b.hi.z, b.lo.z));
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3Sub(DF3 a, DF3 b) { return df3Add(a, DF3(-b.hi, -b.lo)); }
DF3 df3MulF(DF3 a, float s) {
  vec2 rx = dfMulF(vec2(a.hi.x, a.lo.x), s);
  vec2 ry = dfMulF(vec2(a.hi.y, a.lo.y), s);
  vec2 rz = dfMulF(vec2(a.hi.z, a.lo.z), s);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3MulDF(DF3 a, vec2 s) {
  vec2 rx = dfMul(vec2(a.hi.x, a.lo.x), s);
  vec2 ry = dfMul(vec2(a.hi.y, a.lo.y), s);
  vec2 rz = dfMul(vec2(a.hi.z, a.lo.z), s);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
vec2 df3Dot(DF3 a, DF3 b) {
  vec2 x = dfMul(vec2(a.hi.x, a.lo.x), vec2(b.hi.x, b.lo.x));
  vec2 y = dfMul(vec2(a.hi.y, a.lo.y), vec2(b.hi.y, b.lo.y));
  vec2 z = dfMul(vec2(a.hi.z, a.lo.z), vec2(b.hi.z, b.lo.z));
  return dfAdd(dfAdd(x, y), z);
}
// box-foldのclamp: 判定はhi成分だけで行う(fold境界ぎりぎりの際どいケース
// でだけ生じうる誤差は無視できるほど稀——README参照)。範囲内ならlo成分も
// そのまま保持し、範囲外に丸めた成分だけlo=0にする。
DF3 df3ClampFold(DF3 a, float lo, float hi) {
  vec3 rHi = clamp(a.hi, lo, hi);
  vec3 inRange = step(vec3(lo), a.hi) * step(a.hi, vec3(hi));
  return DF3(rHi, a.lo * inRange);
}

// マンデルボックスの距離推定(DE)。Rrrola型の box-fold + ball-fold +
// scale+translate を ITER 回繰り返す(README「マンデルボックスのDE」参照)。
// 座標 z・p だけを df64 で保持し、dr・SCALE・MINR2・FIXEDR2・FOLD は
// float32 のままでよい(精度の危険因子は座標そのものであって dr の成長
// ではないことをNode.js上のシミュレーションで確認した——README参照)。
float mapDE(DF3 p) {
  DF3 z = p;
  float dr = 1.0;
  for (int n = 0; n < ITER; n++) {
    z = df3Sub(df3MulF(df3ClampFold(z, -FOLD, FOLD), 2.0), z);
    vec2 r2df = df3Dot(z, z);
    float r2 = dfToFloat(r2df);
    if (r2 < MINR2) {
      float t = FIXEDR2 / MINR2;
      z = df3MulF(z, t);
      dr *= t;
    } else if (r2 < FIXEDR2) {
      vec2 t = dfDiv(dfFromFloat(FIXEDR2), r2df);
      z = df3MulDF(z, t);
      dr *= dfToFloat(t);
    }
    z = df3Add(df3MulF(z, SCALE), p);
    dr = dr * abs(SCALE) + 1.0;
  }
  vec3 zf = df3ToVec3(z);
  return length(zf) / abs(dr);
}

vec3 calcNormal(DF3 p, float eps) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapDE(df3AddVec3(p, k.xyy * eps)) +
    k.yyx * mapDE(df3AddVec3(p, k.yyx * eps)) +
    k.yxy * mapDE(df3AddVec3(p, k.yxy * eps)) +
    k.xxx * mapDE(df3AddVec3(p, k.xxx * eps))
  );
}

// 参考サイトの incandescenceFunc: 座標軸±GLOW_RADIUS上の6点を中心とした
// 白熱光源。反復深度に関係なく「ワールド座標のどこにいるか」だけで灯る点
// なので、同じ1点に潜り続けるこのプロトタイプでもサイクルごとに灯る/
// 灯らないの違いが出る。
float glowPoints(vec3 p) {
  float amt = 0.0;
  vec3 ax = vec3(GLOW_RADIUS, 0.0, 0.0);
  amt += pow(max(1.0 - length(p - ax) / GLOW_RADIUS, 0.0), 2.0);
  amt += pow(max(1.0 - length(p + ax) / GLOW_RADIUS, 0.0), 2.0);
  ax = vec3(0.0, GLOW_RADIUS, 0.0);
  amt += pow(max(1.0 - length(p - ax) / GLOW_RADIUS, 0.0), 2.0);
  amt += pow(max(1.0 - length(p + ax) / GLOW_RADIUS, 0.0), 2.0);
  ax = vec3(0.0, 0.0, GLOW_RADIUS);
  amt += pow(max(1.0 - length(p - ax) / GLOW_RADIUS, 0.0), 2.0);
  amt += pow(max(1.0 - length(p + ax) / GLOW_RADIUS, 0.0), 2.0);
  return amt;
}

// 参考サイトの ambientFunc + diffuseFunc + incandescenceFunc + growFunc を
// この順で加算合成(スペキュラ・シャドウ・大域照明・反射は参考サイトでも
// 実効的に寄与がないため省略)。iterate はレイマーチで消費したステップ数の
// 割合(参考サイトの ray.iterate)で、細部ほど1に近づきグローが強く乗る。
// ズーム段数を問わず自己相似の細部が常に画面を占めるこのプロトタイプでは、
// 参考サイトの smoothstep(0, 0.95, ...) では閾値が厳しすぎ、100倍ズーム
// 以降ほとんど発火しなくなっていたため、閾値を大きく緩めている。
vec3 shade(vec3 p, vec3 n, float iterate) {
  vec3 col = AMBIENT_INTENSITY * BASE_COLOR;
  float diff = max(dot(n, LIGHT_DIR), 0.0);
  col = clamp(col + DIFFUSE_INTENSITY * diff * BASE_COLOR, 0.0, 1.0);
  col = clamp(col + INC_INTENSITY * GLOW_COLOR * glowPoints(p), 0.0, 1.0);
  float growCoef = smoothstep(GROW_ITER_LO, GROW_ITER_HI, iterate);
  col += GROW_INTENSITY * growCoef * GLOW_COLOR;
  return col * BRIGHTNESS;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec3 rd = normalize(uv.x * uR + uv.y * uU + FOCAL * uF);
  DF3 p0 = DF3(uP0_hi, uP0_lo);
  // ro = p0 + camOffset をここで一度だけ補正加算しておく。camOffset自体は
  // 通常のfloat32(その大きさ=dist基準の相対精度で十分)だが、これを
  // 先にuCamOffset + rd*tとして素のfloat32加算で合成してからp0に足すと、
  // p0への合成で守ったはずの精度が「dist基準のfloat32丸め」で先に失われて
  // しまう(cam方向とtの打ち消し合いがdist未満の桁を捨ててしまうため)。
  // rd*t は毎ステップ ro(既にdf64で確定済み)へ直接、補正加算で足し込む。
  DF3 ro = df3AddVec3(p0, uCamOffset);

  // 1ピクセルが投影される角度サイズ(ラジアン相当)。表面判定のイプシロンを
  // これに比例させることで、画面上どの距離でも「そのピクセルで解像できる
  // 限界」まで細部を残す(README「遠景でのっぺりする問題」参照)。
  float pixelAngle = 1.0 / (FOCAL * uResolution.y);

  float t = 0.0;
  bool hit = false;
  float iterate = 1.0;
  float hitEps = SURF_EPS_MIN;
  for (int i = 0; i < MAX_STEPS; i++) {
    float surfEps = max(SURF_EPS_MIN, t * pixelAngle * SURF_EPS_PIXEL_MULT);
    DF3 p = df3AddVec3(ro, rd * t);
    float d = mapDE(p);
    if (d < surfEps) { hit = true; iterate = float(i) / float(MAX_STEPS); hitEps = surfEps; break; }
    t += d * STEP_SAFETY;
    if (t > uMaxDist) break;
  }

  vec3 fogColor = skyColor();
  vec3 col;
  if (hit) {
    DF3 p = df3AddVec3(ro, rd * t);
    vec3 n = calcNormal(p, hitEps * 0.5);
    col = shade(df3ToVec3(p), n, iterate);
  } else {
    col = fogColor;
  }
  float relT = t / uMaxDist;
  float fogAmt = 1.0 - exp(-relT * FOG_K);
  col = mix(col, fogColor, clamp(fogAmt, 0.0, 1.0));
  // 参考サイトの gammaFunc は pow(col, 2.2)(逆数ではない)で、暗部を
  // 強く締めてコントラストを上げる独特の実装。見た目を合わせるため踏襲。
  col = pow(clamp(col, 0.0, 1.0), vec3(2.2));
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
  P0hi: gl.getUniformLocation(program, "uP0_hi"),
  P0lo: gl.getUniformLocation(program, "uP0_lo"),
  camOffset: gl.getUniformLocation(program, "uCamOffset"),
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
// 見回し(自動首振り+ドラッグ)はこの基準方向に対するクォータニオン回転
// として最後に上乗せする(README「カメラ」参照)。カメラ位置 P は常に
// 基準方向 F0 の軸上のままで、見回しは F/R/U という「見る向き」だけを
// 回す——移動そのものには影響しない。
// ----------------------------------------------------------------------------
function baseFrame(viewDir) {
  const F0 = viewDir;
  const worldUp = Math.abs(F0[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const R0 = vnormalize(vcross(F0, worldUp));
  const U0 = vcross(R0, F0);
  return { F0, R0, U0 };
}

// lookQuat は基準フレーム(F0,R0,U0)に上乗せする見回し回転(自動首振り+
// ドラッグをクォータニオンとして合成したもの)。
function buildCameraFrame(p0, viewDir, dist, lookQuat) {
  const { F0, R0, U0 } = baseFrame(viewDir);
  const F = qRotateVec(lookQuat, F0);
  const R = qRotateVec(lookQuat, R0);
  const U = qRotateVec(lookQuat, U0);
  const P = vadd(p0, vscale(F0, -dist));
  return { P, F, R, U };
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------
let autoYaw = 0;
let dragQuat = Q_IDENTITY; // ドラッグによる見回し(クォータニオンで累積、制限なし)
// ドラッグの回転軸(現在のカメラのright/up)は毎フレームのレンダリング結果を
// そのまま使う。マウス座標の差分だけでは「今どちらを向いているか」が
// わからないため、直近の描画で確定した実際のright/upを基準にすることで、
// 画面奥行き方向に対して常に直感的な操作感になる。
let lastCamR = [1, 0, 0], lastCamU = [0, 1, 0];
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
  // yawは「現在のup」まわり、pitchは「現在のright」まわりの微小回転として
  // 都度合成する(クォータニオンの積は可換ではないため順序はyaw→pitchで
  // 固定)。角度に上限を設けないため、ドラッグし続ければ上下逆さまや
  // 真後ろを向くところまで含めて任意方向を向ける。
  const yawQ = qFromAxisAngle(lastCamU, dx * CONFIG.DRAG_YAW_SENSITIVITY);
  const pitchQ = qFromAxisAngle(lastCamR, -dy * CONFIG.DRAG_PITCH_SENSITIVITY);
  dragQuat = qNormalize(qMul(pitchQ, qMul(yawQ, dragQuat)));
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
        // 画面が暗転している間にカメラの向きも基準方向へリセットする。
        // ドラッグでの見回し・自動首振りの蓄積を次のダイブへ持ち越さない。
        dragQuat = Q_IDENTITY;
        autoYaw = 0;
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
    // 自動首振り(基準の上方向まわりの一定回転)とドラッグ(クォータニオン
    // で累積・制限なし)を合成する。autoQuatは基準フレーム(viewDir由来)
    // に対する回転、dragQuatはその上にさらに乗る自由な見回し。
    const { U0 } = baseFrame(target.viewDir);
    const autoQuat = qFromAxisAngle(U0, autoYaw);
    const lookQuat = qNormalize(qMul(dragQuat, autoQuat));
    const cam = buildCameraFrame(target.p0, target.viewDir, dist, lookQuat);
    // ドラッグの次回の回転軸には、手ブレを含まない安定したこのフレームを
    // 使う(手ブレの高周波な揺れを軸に混ぜるとドラッグの感触が不安定に
    // なるため)。
    lastCamR = cam.R;
    lastCamU = cam.U;

    // 手持ちカメラのような微小なランダム揺れを、カメラ自身のF/R/U軸まわりの
    // 回転として最後に上乗せする(実時間基準なのでフレームレートに依らない、
    // README「カメラ」参照)。位置には影響させない。
    const shakeT = now * 0.001 * CONFIG.SHAKE_SPEED;
    const shakeYaw = shakeNoise(shakeT, 0) * CONFIG.SHAKE_AMPLITUDE;
    const shakePitch = shakeNoise(shakeT, 10) * CONFIG.SHAKE_AMPLITUDE;
    const shakeRoll = shakeNoise(shakeT, 20) * CONFIG.SHAKE_AMPLITUDE * CONFIG.SHAKE_ROLL_MULT;
    const shakeQuat = qNormalize(qMul(
      qFromAxisAngle(cam.F, shakeRoll),
      qMul(qFromAxisAngle(cam.U, shakeYaw), qFromAxisAngle(cam.R, shakePitch))
    ));
    const shakenF = qRotateVec(shakeQuat, cam.F);
    const shakenR = qRotateVec(shakeQuat, cam.R);
    const shakenU = qRotateVec(shakeQuat, cam.U);

    const maxDist = dist * CONFIG.FAR_MULT;
    // p0はdf64の(hi,lo)としてGPUへ渡し、camOffset(=カメラ位置-p0、
    // JSの倍精度でも常にdistのオーダーでしか無いので精度は失われない)は
    // 通常のfloat32で渡す。GPU側でこの2つをdf64の補正加算で合成することで、
    // CPU側の倍精度(53bit)がボトルネックにならないようにしている
    // (README「df64(double-float)による倍精度」参照)。
    const p0Split = splitVec3(target.p0);
    const camOffset = vsub(cam.P, target.p0);

    gl.useProgram(program);
    gl.bindVertexArray(emptyVAO);
    gl.uniform2f(uLoc.resolution, fullW, fullH);
    gl.uniform3fv(uLoc.P0hi, p0Split.hi);
    gl.uniform3fv(uLoc.P0lo, p0Split.lo);
    gl.uniform3fv(uLoc.camOffset, camOffset);
    gl.uniform3fv(uLoc.F, shakenF);
    gl.uniform3fv(uLoc.R, shakenR);
    gl.uniform3fv(uLoc.U, shakenU);
    gl.uniform1f(uLoc.maxDist, maxDist);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    updateHUD(dist);
  } catch (err) {
    console.error(err);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
