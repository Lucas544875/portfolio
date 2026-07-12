// ============================================================================
// ガラスの破片 — プロトタイプ #4
//
// - 「たくさん浮かぶガラスの破片」を、レイマーチではなくラスタライズ(インスタンス
//   描画)で表現する。プロトタイプ#3(結晶)は単一のSDFをレイマーチしたが、
//   同じ手法で個数を増やすと「各破片ごとに内部を進んで屈折の出口を探す」
//   コストが破片数に比例して跳ね上がるため、多数の破片には向かない。
//   代わりに正八面体メッシュ1個をジオメトリインスタンシングで100〜150個複製し、
//   各破片の反射・屈折は「背景(プロシージャルな空間)を反射・屈折ベクトルの
//   方向でサンプルする」という#3と同じ近似トリックを流用する
// - 各破片は同じ正八面体の頂点データを共有しつつ、インスタンスごとに
//   (1) 頂点ごとの放射方向ジッター、(2) 軸ごとの非等方スケール、(3) ランダムな
//   自転軸・位相・速度、を頂点シェーダー内で適用することで、1つのVBO/IBOだけから
//   見た目の異なる不揃いな破片群を作っている(追加のジオメトリ生成コード不要)
// - 法線は頂点属性を持たず、dFdx/dFdy によるスクリーンスペース微分から
//   その場で求める。これにより三角形ごとに完全にフラットな(=鋭いファセットの)
//   陰影になり、インデックス共有ジオメトリのままでも面ごとの鋭い輝きが出る
// - 屈折はチャンネル(R/G/B)ごとにわずかに異なる屈折率で `refract()` を実際に
//   計算し、それぞれ別方向で背景をサンプルする。これが色収差(ファセットの縁に
//   出る虹色のにじみ)そのものになる
// - 不透明(alpha=1)で深度テスト・深度書き込みを有効にして描画する。多数の
//   半透明ジオメトリを正しい前後関係でブレンドするにはソートが要るが、
//   反射・屈折の色そのものが「背景がねじれて透けて見える」効果を担っているため、
//   本当に半透明にしなくても十分ガラスらしく見える。かつソート問題を完全に回避できる
// - 屈折が常にプロシージャルな背景しか映さないと「奥にある別の破片」が透けて見えず
//   チープに見えるため、毎フレーム2パスで描画する: (1) 通常の絵をオフスクリーンの
//   テクスチャに一度描き(capture pass)、(2) 本番描画ではチャンネルごとの屈折方向を
//   ワールド座標でuViewProj射影してスクリーンUVを求め、そのテクスチャを直接サンプルする
//   (screen-space refraction)。これにより屈折の先に本当に他の破片(や背景)が映る。
//   1バウンス分の近似(そのテクスチャ自体はプロシージャル背景だけを映したcaptureなので
//   再帰的な多重屈折にはならない)だが、コストは2倍描画するだけで済む
// - captureテクスチャはRGBA8(driver安定重視。プロトタイプ#2の教訓と同じ)で、HDRの
//   ハイライトはReinhardトーンマップ(col/(col+1))だけ適用して0〜1に圧縮してから
//   保存し、サンプル時に逆関数(enc/(1-enc))で線形空間に戻す。ガンマ補正は最終出力
//   時にのみ1回だけかける
// - カメラはプロトタイプ#1・#2・#3と同じ「自動でゆっくり周回 → ドラッグで
//   ハンドオフ」という設計
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
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.65 : 1.0, // 破片の画面占有率は小さいので、フルスクリーンをレイマーチする#3ほど解像度を落とさなくても軽い
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,
  SHARD_COUNT: isCoarsePointer ? 60 : 150,
  FIELD_MIN_RADIUS: 0.5, // カメラが寄っても破片の内側にすぐ突入しないよう中心付近は空けておく
  FIELD_MAX_RADIUS: 3.6,
  SIZE_MIN: 0.07,
  SIZE_MAX: 0.2,
  STRETCH_MIN: 1.4, // 破片らしい細長さを出すため、ランダムに選んだ1軸だけ強く伸ばす
  STRETCH_MAX: 2.3,
  JITTER_STRENGTH: 0.5, // 正八面体の各頂点を放射方向に±50%までランダムにずらし、不揃いな破片形状にする
  REFRACT_PEEK_DEPTH: 1.1, // 屈折が「奥のどれくらい先」を覗き込むかのワールド座標での仮想距離。大きいほど遠くの破片が映るがスクリーン外に外れやすい
  // クリスタルガラス(鉛ガラス、酸化鉛約24%相当)の物理量。ソーダ石灰ガラスは屈折率
  // n≈1.5・アッベ数(分散の指標)≈59だが、鉛クリスタルはnがより高く(重厚な輝き)、
  // アッベ数がより低い(=分散が強く虹色のきらめきが出やすい)。ここでは代表値として
  // n_d(緑=555nm付近の屈折率)を1.54〜1.56、アッベ数を38に設定している
  CRYSTAL_IOR_MIN: 1.54,
  CRYSTAL_IOR_MAX: 1.56,
  CRYSTAL_ABBE_NUMBER: 38,
  SPIN_SPEED_MIN: 0.12,
  SPIN_SPEED_MAX: 0.45,
  FOV: 1.7,
  CAM_DIST: 5.6,
  NEAR: 0.05,
  FAR: 24.0,
  AUTOPLAY_YAW_SPEED: 0.07, // 空間全体をゆっくり周回して眺める演出
  AUTOPLAY_PITCH_AMPLITUDE: 0.16,
  AUTOPLAY_PITCH_SPEED: 0.24,
  DRAG_YAW_SENSITIVITY: 0.009,
  DRAG_PITCH_SENSITIVITY: 0.009,
  PITCH_LIMIT: 1.2,
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
    uniforms[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

function useProgram(p) {
  gl.useProgram(p.program);
  return p.uniforms;
}

// ----------------------------------------------------------------------------
// Shared GLSL: 環境(背景)関数。フルスクリーン背景パスと、破片の反射・屈折の
// サンプル先の両方から同じ関数を呼ぶことで、「破片に映っているもの」と
// 「実際の背景」が常に一致するようにしている
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

// 深宇宙のような暗いグラデーションに、3つの「スタジオ光源」風の光点と、
// まばらな塵の光点を重ねる。追加のレイマーチを行わない安価な方向ベースの関数
vec3 background (vec3 rd) {
  float depth = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.014, 0.02, 0.036), vec3(0.05, 0.065, 0.11), depth);

  for (int i = 0; i < 3; i++) {
    vec3 ld = keyLightDir(i);
    vec3 lc = keyLightColor(i);
    float d = max(dot(rd, ld), 0.0);
    col += lc * pow(d, 420.0) * 2.2; // 光源そのもの: 小さく鋭いコア
    col += lc * 0.05 * pow(d, 40.0); // すぐ周りの締まったハロー(広がりすぎない)
  }

  vec2 uv = rd.xy / (abs(rd.z) + 0.35) + vec2(uTime * 0.004, uTime * 0.0025);
  vec2 id = floor(uv * 30.0);
  vec2 f = fract(uv * 30.0) - 0.5;
  float h = hash21(id);
  float speck = smoothstep(0.05, 0.0, length(f) - 0.05) * step(0.95, h);
  col += speck * vec3(0.6, 0.7, 0.85) * (0.4 + 0.6 * hash21(id + 3.0));

  return col;
}

// 光源方向をピンポイントで狙い撃ちする鋭いスペキュラ。env の塵とは別に、
// 破片が自転してファセットが光源の方を向いた瞬間だけ強く光る「きらめき」を保証する
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

vec3 toneMapAndGamma (vec3 col) {
  return gammaCorrect(reinhard(col));
}

// captureパスで reinhard() により 0〜1 に圧縮して保存した色を、線形空間に戻す
// (reinhardの逆関数: y = x/(x+1) => x = y/(1-y))
vec3 decodeCapture (vec3 encoded) {
  return encoded / max(vec3(1.0) - encoded, vec3(0.0001));
}

float vignette (vec2 ndc, float aspect) {
  return smoothstep(0.35, 1.15, length(vec2(ndc.x * aspect, ndc.y)));
}
`;

// ----------------------------------------------------------------------------
// 背景パス: フルスクリーン1枚。カメラ方向から視線ベクトルを再構成して
// background() をそのまま描くだけ(破片の反射に写り込む空間そのもの)
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
    // 破片パスのcaptureで再利用できるよう、ガンマ補正なし・Reinhardのみで保存
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
// 破片パス: 正八面体1個をインスタンス描画で複製する
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
  // 正八面体の6頂点それぞれを、インスタンス固有のseedと頂点IDから作った乱数で
  // 放射方向(=自分自身の位置ベクトル)にずらす。同じ8面体トポロジーのまま
  // 不揃いな破片シルエットになる
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

// 屈折方向 dir の「奥」に何があるかを調べる。captureパス(まだシーンテクスチャが
// 無い1回目の描画)ではプロシージャルな背景で代用する。本番パスでは、屈折方向に
// uRefractPeekDepthだけ進んだワールド座標を再度カメラ射影してスクリーンUVを求め、
// captureパスで描いたテクスチャをそのまま覗き見る(screen-space refraction)。
// これで屈折の先に本当に他の破片が映り込む。射影がスクリーン外に出た場合や
// カメラの後ろに回った場合は、プロシージャルな背景にフォールバックする
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
  // 頂点法線を持たないので、三角形ごとにワールド座標のスクリーンスペース微分から
  // その場でフラット法線を求める。三角形単位で完全にフラットな鋭いファセットになる
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  if (dot(n, viewDir) < 0.0) n = -n;
  vec3 rd = -viewDir;

  float ndv = clamp(dot(n, viewDir), 0.0, 1.0);

  // 破片ごとに組成のわずかな個体差があるという想定で、緑(d線, 555nm付近)の屈折率
  // n_d を鉛クリスタルの実測レンジ内でランダムに振る
  float iorD = mix(uCrystalIorMin, uCrystalIorMax, fract(vSeed * 12.9898));

  // アッベ数 V_d = (n_d - 1) / (n_F - n_C) の定義から、青(F線, 486nm)と赤(C線, 656nm)の
  // 屈折率差を逆算する。Cauchyの分散式は波長に対して非線形(短波長側=青ほど強く曲がる)
  // なので、中心からの配分を対称(50/50)ではなく青寄り(60/40)にして近似している
  float dispersion = (iorD - 1.0) / uCrystalAbbeNumber;
  float iorR = iorD - 0.4 * dispersion;
  float iorG = iorD;
  float iorB = iorD + 0.6 * dispersion;

  // Schlick近似: F0 = ((n1-n2)/(n1+n2))^2 (今回は空気n=1からガラスn=iorDへの入射)。
  // 反射率をこの同じiorDから導出することで、反射と屈折が同じ物理量(屈折率)に
  // 一貫して基づくようにしている
  float f0 = pow((iorD - 1.0) / (iorD + 1.0), 2.0);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

  vec3 reflDir = reflect(rd, n);
  vec3 reflColor = background(reflDir); // 反射は#3と同じくプロシージャル環境のまま(スパークルの安定性を優先)

  // チャンネルごとに実際の分散から求めた屈折率でrefract()する。この差そのものが
  // ファセットの縁のにじみ(色収差)になる。全反射でrefractが0ベクトルを返す場合は
  // 反射色にフォールバックする(このプロトタイプは常に空気→ガラスへの入射のみを
  // 扱っており、eta=1/n<1なので理論上は起きないはずだが、数値誤差への保険として残す)
  vec3 rR = refract(rd, n, 1.0 / iorR);
  vec3 rG = refract(rd, n, 1.0 / iorG);
  vec3 rB = refract(rd, n, 1.0 / iorB);
  if (dot(rR, rR) < 0.0001) rR = reflDir;
  if (dot(rG, rG) < 0.0001) rG = reflDir;
  if (dot(rB, rB) < 0.0001) rB = reflDir;
  vec3 refrColor = vec3(sampleBehind(rR).r, sampleBehind(rG).g, sampleBehind(rB).b);

  vec3 col = mix(refrColor, reflColor, clamp(fresnel, 0.0, 1.0));

  // #3(結晶)と同じく、冷たい主光源の方向づけ(directional lift)と裏側からの
  // 暖色リム光を足す。フレネル反射だけだと光源の方を向いていない大半のファセットが
  // 単調なグレーに沈むため、この2項が「艶消しの石」に見えるのを防ぐ
  vec3 mainLightDir = normalize(vec3(0.5, 0.8, -0.3));
  float diff = clamp(dot(n, mainLightDir), 0.0, 1.0);
  col += diff * vec3(0.05, 0.065, 0.08);

  vec3 rimLightDir = normalize(vec3(-0.6, -0.35, 0.7));
  float rim = pow(1.0 - ndv, 2.2) * clamp(dot(n, rimLightDir), 0.0, 1.0);
  col += rim * vec3(0.95, 0.55, 0.25) * 0.6;

  col += sparkle(reflDir) * vec3(1.0, 0.97, 0.92) * 7.0;
  col += vec3(0.014, 0.02, 0.032); // わずかな地色。光源から外れた面が完全な黒に落ちないように

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

function randomPointInBall(minR, maxR) {
  const [x, y, z] = randomUnitVector();
  const r = minR + (maxR - minR) * Math.cbrt(Math.random());
  return [x * r, y * r, z * r];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function buildInstanceData(count) {
  const stride = 12; // offset(3) + scale(3) + axis(3) + spin(2) + seed(1)
  const data = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const [ox, oy, oz] = randomPointInBall(CONFIG.FIELD_MIN_RADIUS, CONFIG.FIELD_MAX_RADIUS);
    data[o + 0] = ox;
    data[o + 1] = oy;
    data[o + 2] = oz;

    const baseSize = lerp(CONFIG.SIZE_MIN, CONFIG.SIZE_MAX, Math.random());
    const scale = [
      baseSize * lerp(0.55, 1.0, Math.random()),
      baseSize * lerp(0.55, 1.0, Math.random()),
      baseSize * lerp(0.55, 1.0, Math.random()),
    ];
    // 破片らしい細長さを出すため、ランダムに選んだ1軸だけ強く引き伸ばす
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
gl.bufferData(gl.ARRAY_BUFFER, buildInstanceData(CONFIG.SHARD_COUNT), gl.STATIC_DRAW);

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
// 最小限の行列ヘルパー(列優先、WebGL/GLSLの規約に合わせる)
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
// シーンcapture用フレームバッファ: 屈折で「奥の破片」を映すためのscreen-space
// refractionの元ネタとして、毎フレーム1回分の絵をここに描いてから本番描画で読む
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
  // RGBA8/UNSIGNED_BYTEに固定(プロトタイプ#2で判明した、floatレンダーターゲットが
  // 一部ドライバで不安定になる問題を最初から避けるため)
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
// Camera: 自動周回 → ドラッグでのハンドオフ(プロトタイプ#1〜#3と同じ設計)
// ----------------------------------------------------------------------------
const camera = { yaw: 0.4, pitch: 0.18 };
const autoplay = { enabled: true, yawStart: camera.yaw };

function updateAutoplay(t) {
  if (!autoplay.enabled) return;
  camera.yaw = autoplay.yawStart + t * CONFIG.AUTOPLAY_YAW_SPEED;
  camera.pitch = Math.sin(t * CONFIG.AUTOPLAY_PITCH_SPEED) * CONFIG.AUTOPLAY_PITCH_AMPLITUDE;
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
// Main loop
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

    // 背景パス(深度なし)
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

    // 破片パス(深度テスト・書き込み有効。不透明として描くことでソート問題を回避)
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
    gl.drawElementsInstanced(gl.TRIANGLES, octahedronIndices.length, gl.UNSIGNED_SHORT, 0, CONFIG.SHARD_COUNT);
  }

  // パス1: 通常の絵をオフスクリーンにcapture(このパス自身の屈折はプロシージャル背景で代用)。
  // シェーダーの分岐でuSceneTexを参照しなくても、書き込み先(sceneFBO)と同じテクスチャが
  // どこかのユニットにバインドされたままだとWebGLがフィードバックループとして描画を拒否するため、
  // 前フレームのパス2で貼ったバインドを明示的に外しておく
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  drawScene(true);

  // パス2: 本番描画。破片の屈折はパス1のテクスチャをscreen-space refractionで覗く
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  drawScene(false);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
