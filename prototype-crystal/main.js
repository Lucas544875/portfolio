// ============================================================================
// 結晶 — レイマーチ・プロトタイプ #3
//
// - 正八面体(宝石カットの基本形)と立方体の交差(max)を基本プリミティブとして、
//   (1) 固定オフセットで5個複製してunionした「結晶クラスター」本体と、
//   (2) mod()によるドメインリピティションで無限に複製した「漂う結晶片」を組み合わせる。
//   smooth minのような滑らかなブレンドは使わず、鋭いファセットのエッジを保ったまま
//   コストも抑えている(詳細はREADMEの「レイマーチ特有の複製表現について」参照)
// - 法線はSDFの中心差分から求め、フレネル項で背景色(=環境)との反射を混ぜて
//   「屈折レイを飛ばさずにガラスっぽく見せる」。真の屈折・反射の多重レイマーチは
//   行わない(コストが跳ね上がるため)
// - 内部解像度をCSS表示サイズより落として描画し、ブラウザの拡大縮小(CSSの
//   width/height指定によるアップスケール)に任せる。レイマーチはピクセル数に
//   直接コストが比例するため、モバイルで負荷を抑える上でここが最も効く
// - ページを開くとカメラが自動でゆっくり周回し、ユーザーのドラッグ操作に
//   引き継ぐ(プロトタイプ#1・#2と同じ「自動再生→ハンドオフ」の設計)
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

// タッチ主体の端末(≒モバイル)かどうかで内部解像度・ステップ数を切り替える
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  RENDER_SCALE: isCoarsePointer ? 0.46 : 0.62, // 表示サイズに対する内部解像度の倍率。レイマーチの負荷はここに直接比例する
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0, // devicePixelRatioをそのまま使うと高DPIモバイルで内部解像度が跳ね上がる
  MAX_STEPS: isCoarsePointer ? 48 : 64, // 複数プリミティブのunionぶん、単一プリミティブ版より少し多めのステップが要る
  MAX_DIST: 14.0,
  SURF_DIST: 0.0015,
  STEP_RELAX: 0.85, // 各プリミティブ(近似八面体)の安全な過小評価をminで束ねているだけなので、単一形状の頃と同程度の緩和率で足りる
  FOV: 1.7,
  CAM_DIST: 3.8,
  SELF_SPIN_SPEED: 0.05, // 結晶自体のゆっくりした自転(rad/sec)。カメラの周回と独立して「生きている」感を出す
  AUTOPLAY_YAW_SPEED: 0.1, // 自動再生時のカメラ周回速度(rad/sec)
  AUTOPLAY_PITCH_AMPLITUDE: 0.12,
  AUTOPLAY_PITCH_SPEED: 0.35,
  DRAG_YAW_SENSITIVITY: 0.009,
  DRAG_PITCH_SENSITIVITY: 0.009,
  PITCH_LIMIT: 1.2, // ジンバル的な破綻(cross(up, forward)が縮退する極)を避けるための可動域上限
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

const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

function blit() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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

// MAX_STEPSはループの上限としてconstに埋め込む(動的なuniformを上限に使う書き方は
// 一部のモバイルGPUドライバのGLSLコンパイラで最適化・安定性の問題を起こしやすいため)。
function buildFragmentShaderSource(maxSteps) {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uYaw;
uniform float uPitch;
uniform float uCamDist;
uniform float uFov;
uniform float uMaxDist;
uniform float uSurfDist;
uniform float uStepRelax;
uniform float uSelfSpinSpeed;
out vec4 fragColor;

mat3 rotY (float a) {
  float s = sin(a), c = cos(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

float sdBox (vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// 正八面体(|x|+|y|+|z|=s)の8面それぞれへの平面距離の最小値。
// 稜・頂点付近では真のSDFよりわずかに小さい値になる(=安全な過小評価。
// レイが面を突き抜けることはなく、稜付近で歩幅がやや小さくなるだけ)ため、
// IQ版の分岐込みの厳密実装より軽い近似としてそのまま採用している。
float sdOctahedronApprox (vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.5773502692;
}

float hash21 (vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 結晶クラスター本体: 主結晶(カット入りの八面体)1個に、同じ八面体プリミティブを
// 縮小・オフセットしただけの副結晶4個をunion(min)で癒着させる。
// 最初はabs+scaleを繰り返す無限IFS折り畳みを試したが、パラメータの選び方次第で
// 空間全体を埋め尽くす「無限結晶壁」になってしまい、画面いっぱいのタイル状ノイズと化した
// (単一の結晶が主役という構図が壊れる上、境界の折り目が対称面にできる暗いスジも出た)。
// 有限個の固定オフセットで明示的に複製する方式なら、境界(=カメラのフレーミング)が
// 常に予測可能なまま「複数の結晶が寄り添って生えている」密度だけを上げられる。
float sdCrystalCluster (vec3 p) {
  float d = max(sdOctahedronApprox(p, 1.0), sdBox(p, vec3(0.66)));
  d = min(d, sdOctahedronApprox(p - vec3(0.95, 0.5, -0.3), 0.5));
  d = min(d, sdOctahedronApprox(p - vec3(-0.85, -0.4, 0.45), 0.46));
  d = min(d, sdOctahedronApprox(p - vec3(-0.5, 0.8, 0.25), 0.38));
  d = min(d, sdOctahedronApprox(p - vec3(0.35, -0.85, -0.55), 0.42));
  return d;
}

// 主結晶の周囲に浮かぶ小さな結晶片。mod()で空間そのものを繰り返す
// ドメインリピティションにより、同じ1個のプリミティブを評価するだけで
// 実質無限個のインスタンスを配置できる(追加のジオメトリ・描画コール不要)。
// セルごとにhashでサイズと位置を散らし、格子の規則性が目立たないようにしている。
float sdSatelliteShards (vec3 p) {
  vec3 q = p;
  mat2 rot = mat2(0.825, -0.565, 0.565, 0.825); // 主結晶の格子と噛み合わないよう斜めにねじる
  q.xz = rot * q.xz;

  vec3 cell = vec3(2.6, 2.15, 2.6);
  vec3 cellId = floor((q + 0.5 * cell) / cell);
  vec3 r = mod(q + 0.5 * cell, cell) - 0.5 * cell;

  vec2 h = vec2(hash21(cellId.xy + cellId.z * 3.1), hash21(cellId.yz - cellId.x * 5.7));
  r -= (vec3(h.x, hash21(cellId.zx + 9.1), h.y) - 0.5) * cell * 0.55;
  float size = 0.1 + 0.16 * hash21(cellId.xz + 1.7);

  float shard = sdOctahedronApprox(r, size);
  float keepOut = 2.15 - length(p); // 主結晶クラスターの内部・至近には出さない(重なって見た目が濁るのを防ぐ)
  return max(shard, keepOut);
}

float map (vec3 p) {
  p = rotY(uTime * uSelfSpinSpeed) * p;
  return min(sdCrystalCluster(p), sdSatelliteShards(p));
}

vec3 calcNormal (vec3 p) {
  const vec2 e = vec2(0.0016, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}

// 背景: 追加のレイマーチは一切行わない安いパス。
// 上下でわずかに色が変わるグラデーションに、方向ベクトルをセル分割してハッシュを振った
// まばらな塵の光点を重ねる(画面空間ではなく方向rdベースなので、反射に使っても自然に繋がる)。
vec3 background (vec3 rd) {
  float depth = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.012, 0.016, 0.03), vec3(0.03, 0.05, 0.075), depth);

  vec2 uv = rd.xy / (abs(rd.z) + 0.35) + vec2(uTime * 0.01, uTime * 0.006);
  vec2 id = floor(uv * 26.0);
  vec2 f = fract(uv * 26.0) - 0.5;
  float h = hash21(id);
  float speck = smoothstep(0.06, 0.0, length(f) - 0.06) * step(0.93, h);
  col += speck * vec3(0.5, 0.6, 0.7) * (0.4 + 0.6 * hash21(id + 7.0));

  return col;
}

void main () {
  vec2 uv = vUv;
  uv.x *= uResolution.x / uResolution.y;

  float cy = cos(uYaw), sy = sin(uYaw);
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 ro = uCamDist * vec3(cp * sy, sp, cp * cy);
  vec3 forward = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);
  vec3 rd = normalize(forward * uFov + right * uv.x + up * uv.y);

  float t = 0.0;
  float d = 0.0;
  bool hit = false;
  for (int i = 0; i < ${maxSteps}; i++) {
    vec3 p = ro + rd * t;
    d = map(p);
    if (d < uSurfDist) {
      hit = true;
      break;
    }
    t += d * uStepRelax;
    if (t > uMaxDist) break;
  }

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 viewDir = -rd;
    vec3 lightDir = normalize(vec3(0.5, 0.8, -0.3));

    float ndv = clamp(dot(n, viewDir), 0.0, 1.0);
    // チャンネルごとにフレネル指数をわずかにずらし、エッジに安い色収差(虹色の縁)を出す
    vec3 fresnel = vec3(
      pow(1.0 - ndv, 4.2),
      pow(1.0 - ndv, 5.0),
      pow(1.0 - ndv, 5.8)
    );

    vec3 baseTint = vec3(0.05, 0.09, 0.14);
    vec3 refl = reflect(rd, n);
    vec3 envColor = background(refl) * 4.5;

    float diff = clamp(dot(n, lightDir), 0.0, 1.0);
    float spec = pow(clamp(dot(reflect(-lightDir, n), viewDir), 0.0, 1.0), 48.0);

    // 冷たいガラスの反対側から、暖色のリム光をわずかに透過させる。
    // 単色の反射だけだと「艶消しの石」に見えてしまうため、色温度のコントラストで宝石らしさを足す
    vec3 rimLightDir = normalize(vec3(-0.6, -0.35, 0.7));
    float rim = pow(1.0 - ndv, 2.5) * clamp(dot(n, rimLightDir), 0.0, 1.0);

    col = baseTint + diff * vec3(0.10, 0.13, 0.16);
    col = mix(col, envColor, clamp(fresnel, 0.0, 1.0));
    col += rim * vec3(0.95, 0.55, 0.25) * 0.9;
    col += spec * vec3(1.0, 0.98, 0.9) * 1.6;

    float fog = 1.0 - exp(-t * 0.05);
    col = mix(col, background(rd), fog * 0.6);
  } else {
    col = background(rd);
  }

  // 簡易トーンマッピング + ガンマ補正
  col = col / (col + vec3(1.0));
  col = pow(col, vec3(1.0 / 2.2));

  // ビネット(中心を明るく、四隅を落として奥行きを強調)
  float vig = smoothstep(0.35, 1.15, length(vUv));
  col *= mix(1.0, 0.7, vig);

  fragColor = vec4(col, 1.0);
}
`;
}

const raymarchProgram = createProgram(vertexShaderSource, buildFragmentShaderSource(CONFIG.MAX_STEPS));

// ----------------------------------------------------------------------------
// Resize: 内部解像度を表示サイズより落として描画し、CSSの拡大に任せる
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
// Camera: 自動周回 → ドラッグでのハンドオフ(プロトタイプ#1・#2と同じ設計)
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

  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = useProgram(raymarchProgram);
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  gl.uniform1f(u.uTime, t);
  gl.uniform1f(u.uYaw, camera.yaw);
  gl.uniform1f(u.uPitch, camera.pitch);
  gl.uniform1f(u.uCamDist, CONFIG.CAM_DIST);
  gl.uniform1f(u.uFov, CONFIG.FOV);
  gl.uniform1f(u.uMaxDist, CONFIG.MAX_DIST);
  gl.uniform1f(u.uSurfDist, CONFIG.SURF_DIST);
  gl.uniform1f(u.uStepRelax, CONFIG.STEP_RELAX);
  gl.uniform1f(u.uSelfSpinSpeed, CONFIG.SELF_SPIN_SPEED);
  blit();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
