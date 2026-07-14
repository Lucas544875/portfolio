import '../style.css';
import './mandelbox-full.css';
import vertexShaderSrc from './mandelbox-full.vert?raw';
import fragmentShaderSrc from './mandelbox-full.frag?raw';
import { Quatarnion } from '../blocks/mandelbox/quaternion.js';

// prototype-mandelbox2/raymarch.js の移植版。/works/mandelbox/ はサイトの
// 共有WebGL2レンダラ・ブロック基盤を使わず、参考実装をほぼそのまま(ズームイン/
// ダイブ・ズームHUD・ホイールでの速度調整・一時停止ボタンも含めて)独立した
// ページとして動かす。トップページAboutの背景(site/src/blocks/mandelbox/)は
// ズームインしない軽量な別実装で、意図的にシェーダー/挙動を分けている。
// 変更点は「シェーダーソースを<script>タグ経由のグローバル変数ではなく
// ?rawインポートで受け取る」「QuatarnionをESモジュールとしてimportする」の
// 2点のみで、カメラ制御・レイマーチのロジックは元のまま。

// global
let c, cw, ch, gl, fadeOverlay, hint, zoomReadout, zoomBarFill, zoomPhaseEl, pauseBtn;
let mouseflag=false;
let centorx;
let centory;
let uniLocation = {};
let vAttLocation = [];
let attStride = [];
let cDir;

// 全画面表示。タッチ端末では描画負荷を抑えるためレンダースケール・DPR上限を
// 落とす(main.jsのプロトタイプと同じ方針)。
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
const RENDER_SCALE = isCoarsePointer ? 0.55 : 0.85;
const DPR_CAP = isCoarsePointer ? 1.5 : 2.0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  cw = Math.max(2, Math.floor(window.innerWidth * dpr * RENDER_SCALE));
  ch = Math.max(1, Math.floor(window.innerHeight * dpr * RENDER_SCALE));
  c.width = cw;
  c.height = ch;
  if (gl) gl.viewport(0, 0, cw, ch);
}

// ----------------------------------------------------------------------------
// マンデルボックスのDE(mandelbox.fragのmandelBox()と全く同じ式)。
// 潜る先の1点(target.p0, target.viewDir)をサイクルごとにJS側で選び直す
// (pickTarget())ためだけに使う。GPU側の反復をCPU側でもう一度なぞる
// だけなので、毎サイクル1回・数百ステップ程度のコストは無視できる。
// ----------------------------------------------------------------------------
const SCALE = -2.18;
const MINR2 = 0.60;
const FIXEDR2 = 2.65;
const FOLD = 1.14;
const ITER = 16;
// Node.js実測(対角方向最大~3.95)に安全マージンを見た値。
const BOUND_RADIUS = 4.2;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function jsDE(x0, y0, z0) {
  let x = x0, y = y0, z = z0;
  let dr = 1.0;
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
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// mandelbox.fragのLightDirと同じ(=光源のある方向)。平行光線そのものの
// 進行方向はこの逆(-LIGHT_DIR)になる。
const LIGHT_DIR = vnormalize([2, 1, 1]);

// JSの倍精度(number)を、GPUへdf64として渡すためのfloat32ペア(hi,lo)に
// 分割する(prototype-mandelboxのmain.jsと同じ手法)。
function splitFloat(x) {
  const hi = Math.fround(x);
  const lo = Math.fround(x - hi);
  return [hi, lo];
}
function splitVec3(v) {
  const sx = splitFloat(v[0]), sy = splitFloat(v[1]), sz = splitFloat(v[2]);
  return { hi: [sx[0], sy[0], sz[0]], lo: [sx[1], sy[1], sz[1]] };
}

// Quatarnion.normalize()は二乗ノルムで割ってしまう実装のため使わず、
// 正しい .norm(平方根)で割る。
function normalizeQuat(q) { return q.scale(1 / q.norm); }
function qRotateVec(q, v) {
  return Quatarnion.vec(v[0], v[1], v[2]).turn(q).tovec();
}

// ヒットしきい値。緩すぎるとp0が表面から外れた点になり、締めすぎると
// 単純なsphere tracingでは800ステップ以内に到達できず全滅する
// (元プロトタイプでの実測に基づく値をそのまま採用)。
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
  for (let i = 0; i < 20; i++) {
    const v = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const l2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (l2 > 0.05 && l2 <= 1) return vnormalize(v);
  }
  return [0, 1, 0];
}

// フォールバック(乱数探索が万一全滅した場合の既知の有効点)。
const FALLBACK_TARGET = {
  p0: [2.212921, 1.099011, 0.307275],
  viewDir: vnormalize([-0.836792, 0.260298, -0.481689]),
};

// 潜る先の1点を選ぶ。probe原点をバウンディング球の外側にランダムに置き、
// ほぼ原点方向(+わずかなジッター)へレイを飛ばして命中点を採用する。
function pickTarget() {
  const probeR = BOUND_RADIUS * 2.4;
  for (let attempt = 0; attempt < 48; attempt++) {
    const dir0 = randomUnitVector();
    const probeOrigin = vscale(dir0, probeR);
    const jitter = randomUnitVector();
    const aim = vnormalize(vadd(vscale(dir0, -1), vscale(jitter, 0.18)));
    // 逆光(視線が光源のある方向を向く)になる候補は避ける。平行光線の
    // 進行方向(-LIGHT_DIR)と視線(aim)の内積が正、つまり視線が光源方向
    // (LIGHT_DIR)を向いていない(dot(LIGHT_DIR, aim) < 0)場合のみ残す。
    if (vdot(LIGHT_DIR, aim) >= 0) continue;
    const res = jsRaymarch(probeOrigin, aim, probeR * 2.5);
    if (!res.hit) continue;
    const distFromOrigin = Math.hypot(res.p[0], res.p[1], res.p[2]);
    if (distFromOrigin < BOUND_RADIUS * 0.25 || distFromOrigin > BOUND_RADIUS * 1.4) continue;
    return { p0: res.p, viewDir: aim };
  }
  return FALLBACK_TARGET;
}

// 一番最初のズームだけ用: 参考サイトと同じ導入アングル(+X側から原点方向を
// 見る)の雰囲気を保ちつつ、実際に潜れる隙間を探す。真後ろの(-1,0,0)を
// そのまま使うと、原点手前(x≈2.3付近)にある壁に正面衝突してしまい、
// ダイブのごく序盤(全体の約13%地点)で早々に真っ暗になる——原点(0,0,0)
// はDE上の不動点(ゼロ点)ではあるが、外側から辿り着ける「表側」の点では
// ないため。+X方向を中心に視線を少しだけジッターさせて何本かプローブを
// 飛ばし、実際に一番奥まで届いた(=隙間を通って一番原点に近づけた)
// 方向とその命中点をそのままp0として採用する。
function pickOriginGapDir() {
  const probeR = BOUND_RADIUS * 2.4;
  const baseDir0 = [1, 0, 0]; // 参考サイトと同じ導入方向(+X側から-Xを見る)
  let best = null;
  for (let attempt = 0; attempt < 96; attempt++) {
    const jitter = randomUnitVector();
    const dir0 = vnormalize(vadd(baseDir0, vscale(jitter, 0.35)));
    const probeOrigin = vscale(dir0, probeR);
    const aim = vscale(dir0, -1);
    if (vdot(LIGHT_DIR, aim) >= 0) continue; // 逆光は避ける
    const res = jsRaymarch(probeOrigin, aim, probeR * 2.5);
    if (!res.hit) continue;
    const distFromOrigin = Math.hypot(res.p[0], res.p[1], res.p[2]);
    if (!best || distFromOrigin < best.distFromOrigin) {
      best = { p0: res.p, viewDir: aim, distFromOrigin };
    }
  }
  return best ? { p0: best.p0, viewDir: best.viewDir } : { p0: [0, 0, 0], viewDir: [-1, 0, 0] };
}

// ----------------------------------------------------------------------------
// カメラ: p0を通る1本の視線の上を前後するだけ(mandelbox.frag側はcDirから
// xAxes/yAxesを毎フラグメント自前で作り直すので、JS側もcDirの1本だけ渡せば
// よく、R/Uをuniformで送る必要はない)。位置はp0(df64のhi/lo)+camOffset
// (float32、dist基準の小さな相対オフセット)としてGPU側で合成する
// (prototype-mandelbox/README.md「df64(double-float)による倍精度」と
// 同じ設計)。ドラッグ・自動首振り・手ブレはすべてこの基準方向への
// クォータニオン回転として上乗せする。
// ----------------------------------------------------------------------------
function baseFrame(viewDir) {
  // mandelbox.fragの座標系はZ-up(cross(cDir, vec3(0,0,1)))なので合わせる。
  const worldUp = [0, 0, 1];
  const R0 = vnormalize(vcross(viewDir, worldUp));
  const U0 = vnormalize(vcross(R0, viewDir));
  return { F0: viewDir, R0, U0 };
}

function buildCameraFrame(p0, viewDir, dist, lookQuat) {
  const { F0, R0, U0 } = baseFrame(viewDir);
  const F = qRotateVec(lookQuat, F0);
  const R = qRotateVec(lookQuat, R0);
  const U = qRotateVec(lookQuat, U0);
  const P = vadd(p0, vscale(F0, -dist));
  return { P, F, R, U };
}

// ----------------------------------------------------------------------------
// ズームサイクルの状態機械(overview→dive→fade→…)
// ----------------------------------------------------------------------------
const OVERVIEW_DIST = 11.0; // 参考サイト自身の初期カメラ距離(11,0,0)と一致
// mandelbox.fragにもprototype-mandelboxと同じdf64(double-float)を移植した
// ため、DIST_MINもprototype-mandelbox(main.js)と同じ値まで潜れる。
const DIST_MIN = 5e-5;
const ORBIT_DURATION = 4.0; // 秒。overviewフェーズの長さ
const DIVE_DURATION = 23.0; // 秒。diveフェーズの長さ(prototype-mandelboxと同じズーム幅なので同じ秒数にした)
const FADE_DURATION = 1.1; // 秒。次の1点へ切り替える際のフェード
const AUTO_YAW_SPEED = 0.006; // rad/秒。サイクル全体を通した緩やかな自動首振り

const WHEEL_SPEED_MULT_RANGE = [0.35, 3.2];
const WHEEL_SENSITIVITY = 0.0011;

// 一番最初のズームだけは参考サイトの初期視点(cPos=(11,0,0), cDir=(-1,0,0))
// に近いアングルで始める(pickOriginGapDir参照)。2周目以降(フェードで
// 切り替わった後)はこれまで通りpickTarget()でランダムに選ぶ。
let target = pickOriginGapDir();
let cycleT = 0;
let phase = "overview"; // "overview" | "dive" | "fade"
let fadeT = 0;
let fadeAlpha = 0;
let pickedNewThisFade = false;
let autoYaw = 0;
let dragQuat = new Quatarnion(1, 0, 0, 0); // ドラッグによる見回し(累積、制限なし)
// ドラッグ・手ブレの回転軸には直近の描画で確定した実際のright/upを使う
// (マウス座標の差分だけでは「今どちらを向いているか」がわからないため)。
let lastCamR = [1, 0, 0], lastCamU = [0, 0, 1];
let speedMult = 1.0;
// 一時停止中はupdateCycle()を呼ばないことでcycleT/phase/autoYaw等を完全に
// 凍結する(ドラッグでの見回しはそのまま効く)。lastTimeはframe()の先頭で
// 毎フレーム更新し続けるため、再開時に大きなdtが一気に流れ込むことはない。
let paused = false;

function currentDist(t) {
  if (t <= ORBIT_DURATION) return OVERVIEW_DIST;
  const u = clamp((t - ORBIT_DURATION) / DIVE_DURATION, 0, 1);
  return OVERVIEW_DIST * Math.pow(DIST_MIN / OVERVIEW_DIST, u);
}

function updateCycle(dt) {
  if (phase === "fade") {
    fadeT += dt;
    const half = FADE_DURATION * 0.5;
    if (fadeT < half) {
      fadeAlpha = fadeT / half;
    } else if (fadeT < FADE_DURATION) {
      if (!pickedNewThisFade) {
        target = pickTarget();
        cycleT = 0;
        // 画面が暗転している間にカメラの向きも基準方向へリセットする。
        dragQuat = new Quatarnion(1, 0, 0, 0);
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
    if (cycleT > ORBIT_DURATION + DIVE_DURATION) {
      phase = "fade";
      fadeT = 0;
      fadeAlpha = 0;
      pickedNewThisFade = false;
    } else {
      phase = cycleT <= ORBIT_DURATION ? "overview" : "dive";
    }
  }
  autoYaw += AUTO_YAW_SPEED * dt;
  if (fadeOverlay) fadeOverlay.style.opacity = fadeAlpha.toFixed(3);
}

// 初期化。元プロトタイプはクラシックscript(同期実行)なのでwindow.onloadで
// 安全だったが、ここでは<script type="module">(deferred)経由で読み込まれる
// ため、DOMContentLoaded〜loadの間にすでにDOMは揃っている。window.onloadを
// 待つと、対象リソースが無いページではload発火のタイミング次第で
// ハンドラの登録自体が間に合わない(loadを取りこぼす)ことがあるため、
// 即時実行に変更した。中身は元プロトタイプと同じ。
(function init(){
  // エレメントを取得
  c = document.getElementById('canvas');
  fadeOverlay = document.getElementById('fadeOverlay');
  hint = document.getElementById('hint');
  zoomReadout = document.getElementById('zoomReadout');
  zoomBarFill = document.getElementById('zoomBarFill');
  zoomPhaseEl = document.getElementById('zoomPhase');
  pauseBtn = document.getElementById('pauseBtn');

  // WebGL コンテキストを取得
  gl = c.getContext('webgl');

  // キャンバスサイズの設定(全画面。リサイズにも追従)
  resize();
  window.addEventListener('resize', resize);

  // イベントリスナー登録
  document.addEventListener("mousedown",mouseDown,true);
  document.addEventListener("mouseup",mouseUp,true);
  c.addEventListener('mousemove', mouseMove, true);
  c.addEventListener('wheel', onWheel, { passive: false });
  pauseBtn.addEventListener('click', togglePause);
  document.addEventListener('keydown', onKeyDown);

  // シェーダのコンパイル
  let prg = create_program(create_shader(gl.VERTEX_SHADER, vertexShaderSrc), create_shader(gl.FRAGMENT_SHADER, fragmentShaderSrc));

  //unifoem,atteibute変数の設定
  uniLocation.time = gl.getUniformLocation(prg, 'time');
  uniLocation.resolution = gl.getUniformLocation(prg, 'resolution');
  uniLocation.cDir = gl.getUniformLocation(prg, 'cDir');
  uniLocation.p0hi = gl.getUniformLocation(prg, 'uP0_hi');
  uniLocation.p0lo = gl.getUniformLocation(prg, 'uP0_lo');
  uniLocation.camOffset = gl.getUniformLocation(prg, 'uCamOffset');

  vAttLocation[0] = gl.getAttribLocation(prg, 'position');
  attStride[0] = 3;

  // 頂点データ
  let position = [
    -1.0,  1.0,  0.0,
     1.0,  1.0,  0.0,
    -1.0, -1.0,  0.0,
     1.0, -1.0,  0.0
  ];
  let index = [
      0, 2, 1,
      1, 2, 3
  ];

  //vbo
  let vPosition = create_vbo(position);

  //vboのバインド attribute属性の設定 増えてきたら関数化する
  gl.bindBuffer(gl.ARRAY_BUFFER, vPosition);
  gl.enableVertexAttribArray(vAttLocation[0]);
  gl.vertexAttribPointer(vAttLocation[0], attStride[0], gl.FLOAT, false, 0, 0);

  //iboの生成
  let vIndex = create_ibo(index);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vIndex);

  // その他の初期化
  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  // ヒントは一定時間操作が無ければ自動的に消す。
  setTimeout(() => { if (!userEngaged) hint.classList.add('faded'); }, 7000);

  // レンダリング
  requestAnimationFrame(frame);
})();

let lastTime = performance.now();
function frame(now){
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (!paused) updateCycle(dt);
  const dist = currentDist(cycleT);
  // 自動首振り(基準の上方向まわりの一定回転)とドラッグ(クォータニオンで
  // 累積・制限なし)を合成する。
  const { U0 } = baseFrame(target.viewDir);
  const autoQuat = Quatarnion.rotation(autoYaw, U0[0], U0[1], U0[2]);
  const lookQuat = normalizeQuat(dragQuat.times(autoQuat));
  const cam = buildCameraFrame(target.p0, target.viewDir, dist, lookQuat);
  // ドラッグ・手ブレの次回の回転軸には、手ブレを含まない安定したこの
  // フレームを使う。
  lastCamR = cam.R;
  lastCamU = cam.U;

  cDir = Quatarnion.vec(cam.F[0], cam.F[1], cam.F[2]);

  // p0はdf64の(hi,lo)としてGPUへ渡し、camOffset(=カメラ位置-p0、JSの倍精度
  // でも常にdistのオーダーでしか無いので精度は失われない)は通常のfloat32で
  // 渡す。GPU側でこの2つをdf64の補正加算で合成することで、CPU側の倍精度
  // (53bit)がボトルネックにならないようにしている。
  const p0Split = splitVec3(target.p0);
  const camOffset = vsub(cam.P, target.p0);

  requestAnimationFrame(frame);

  // カラーバッファをクリア
  gl.clear(gl.COLOR_BUFFER_BIT);

  // uniform 関連
  gl.uniform1f(uniLocation.time, now * 0.001);
  gl.uniform2fv(uniLocation.resolution, [cw, ch]);
  gl.uniform3fv(uniLocation.cDir, cDir.tovec());
  gl.uniform3fv(uniLocation.p0hi, p0Split.hi);
  gl.uniform3fv(uniLocation.p0lo, p0Split.lo);
  gl.uniform3fv(uniLocation.camOffset, camOffset);

  // 描画
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  gl.flush();

  updateHUD(dist);
}

function create_shader(type, source){
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.error(gl.getShaderInfoLog(shader));
  return null;
}

function create_program(vs, fs){
  // プログラムオブジェクトの生成
  let program = gl.createProgram();

  // プログラムオブジェクトにシェーダを割り当てる
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);

  // シェーダをリンク
  gl.linkProgram(program);

  // シェーダのリンクが正しく行なわれたかチェック
  if(gl.getProgramParameter(program, gl.LINK_STATUS)){

    // 成功していたらプログラムオブジェクトを有効にする
    gl.useProgram(program);

    // プログラムオブジェクトを返して終了
    return program;
  }else{

    // 失敗していたらエラーログをアラートする
    console.error(gl.getProgramInfoLog(program));
  }
}

function create_vbo(data){
  // バッファオブジェクトの生成
  let vbo = gl.createBuffer();

  // バッファをバインドする
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

  // バッファにデータをセット
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);

  // バッファのバインドを無効化
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  // 生成した VBO を返して終了
  return vbo;
}

// IBOを生成する関数
function create_ibo(data){
  // バッファオブジェクトの生成
  let ibo = gl.createBuffer();

  // バッファをバインドする
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

  // バッファにデータをセット
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Int16Array(data), gl.STATIC_DRAW);

  // バッファのバインドを無効化
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  // 生成したIBOを返して終了
  return ibo;
}

// ズーム進捗(overviewで0、DIST_MINで1)。対数スケールで一定速度に潜る
// 設計に合わせ、log10距離で線形補間する。HUDの表示に使う。
function zoomProgress(dist) {
  const zoomExp = Math.log10(Math.max(OVERVIEW_DIST / dist, 1));
  const maxExp = Math.log10(OVERVIEW_DIST / DIST_MIN);
  return clamp(zoomExp / maxExp, 0, 1);
}

function updateHUD(dist) {
  const zoomFactor = OVERVIEW_DIST / dist;
  const zoomExp = Math.log10(Math.max(zoomFactor, 1));
  zoomReadout.textContent = `10^${zoomExp.toFixed(2)}×`;
  zoomBarFill.style.width = `${zoomProgress(dist) * 100}%`;
  const phaseLabel =
    phase === "overview" ? "全体像を確認中…" :
    phase === "fade" ? "次のポイントへ移動中…" :
    "同じ地点へズームイン中…";
  zoomPhaseEl.textContent = paused ? `${phaseLabel}(一時停止中)` : phaseLabel;
}

// 初回操作でヒントをフェードアウトさせる。
let userEngaged = false;
function engage() {
  if (!userEngaged) {
    userEngaged = true;
    hint.classList.add('faded');
  }
}

// 一時停止(クリック・スペースキー共通)。frame()側でupdateCycle()の呼び出し
// 自体をスキップするだけなので、ドラッグでの見回しは一時停止中も効く。
function togglePause() {
  paused = !paused;
  pauseBtn.textContent = paused ? "▶" : "⏸";
  pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
  pauseBtn.setAttribute("aria-label", paused ? "再生(スペースキー)" : "一時停止(スペースキー)");
  engage();
}

function onKeyDown(e) {
  if (e.code !== "Space" && e.key !== " ") return;
  e.preventDefault(); // スペースキーの既定動作(スクロール)を止める
  togglePause();
}

//マウスインターフェース
function mouseMove(e){
  if (mouseflag){
    if (Math.abs(e.offsetX)===1 || Math.abs(e.offsetY)===1) {
      mouseflag=false;
      return;
    };
    // offsetX/YはCSSピクセル基準なので、backing resolution(cw/ch)ではなく
    // 表示サイズ(clientWidth/Height)で正規化する。
    let dx =(-0.7 * (e.offsetX-centorx) / c.clientWidth);
    let dy =(0.7 * (e.offsetY-centory) / c.clientHeight);
    centorx=e.offsetX;
    centory=e.offsetY;
    cRotate(dx,dy);
  };
};

function mouseDown(e) {
  mouseflag=true;
  centorx=e.offsetX;
  centory=e.offsetY;
  engage();
};

function mouseUp(e) {
  mouseflag=false;
};

// ドラッグによる見回し。yawはlastCamU(現在の上方向)まわり、pitchは
// lastCamR(現在の右方向)まわりの回転としてdragQuatへ都度合成する。
// クォータニオン合成なので上限を設けずどの方向へも回せる
// (元の実装にあったmaxpitchによる仰俯角クランプは撤廃)。
function cRotate(dx,dy) {
  const yawQ = Quatarnion.rotation(-dx * Math.PI, lastCamU[0], lastCamU[1], lastCamU[2]);
  const pitchQ = Quatarnion.rotation(dy * Math.PI, lastCamR[0], lastCamR[1], lastCamR[2]);
  dragQuat = normalizeQuat(pitchQ.times(yawQ.times(dragQuat)));
};

// ホイールでズームサイクルの進行速度を上げ下げする。
function onWheel(e) {
  e.preventDefault();
  engage();
  speedMult = clamp(
    speedMult * Math.exp(-e.deltaY * WHEEL_SENSITIVITY),
    WHEEL_SPEED_MULT_RANGE[0],
    WHEEL_SPEED_MULT_RANGE[1]
  );
}
