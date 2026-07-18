// ============================================================================
// VAPORWAVE — レイマーチ・グリッドの夕暮れ
//
// - fbmノイズの山岳地形(中央は平原)をハイトフィールド・レイマーチングし、
//   ネオングリッドをエミッシブとして重ねる。ライティングは行わず、
//   発光 + 距離フォグ + 高さのティントだけで構成する(ワイヤーフレーム的な見た目)
// - 空はグラデーション + ストライプの太陽 + 瞬く星をレイ方向からプロシージャルに生成
// - シーンを低解像度FBOに描き、フルスクリーンのポストパスで
//   VHS風の質感(バレル歪み・色収差・走査線・行ジッタ・グレイン・ビネット)を乗せる
// - インタラクション:
//     ポインタ移動      → 視点のパララックス
//     ホイール          → 前進速度
//     ボタン            → パレット切替(DUSK/MIDNIGHT/DAWN)
// ============================================================================

const canvas = document.getElementById("glcanvas");
const hint = document.getElementById("hint");
const fallback = document.getElementById("fallback");
const paletteName = document.getElementById("paletteName");

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

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  SCENE_SCALE: 0.66, // レイマーチは重いので低解像度FBOに描き、ポストで引き伸ばす
  MAX_DPR: 1.75,
  FOV: 1.25, // 焦点距離(大きいほど狭角)
  CAM_HEIGHT: 1.05,
  SPEED_DEFAULT: 2.2,
  SPEED_MIN: 0.4,
  SPEED_MAX: 11.0,
  LOOK_YAW_RANGE: 0.42, // ポインタ位置 → ヨー(rad)
  LOOK_PITCH_RANGE: 0.2,
  // イージングは毎秒の収束レート(フレームレート非依存)
  LOOK_RATE: 2.7,
  PALETTE_RATE: 2.1,
  SPEED_RATE: 1.8,
};

// パレット: [skyTop, skyHorizon, sunTop, sunBottom, grid]
const PALETTES = [
  {
    name: "DUSK",
    colors: [
      [0.078, 0.016, 0.157],
      [0.95, 0.30, 0.42],
      [1.0, 0.83, 0.10],
      [1.0, 0.16, 0.46],
      [1.0, 0.18, 0.63],
    ],
  },
  {
    name: "MIDNIGHT",
    colors: [
      [0.008, 0.008, 0.10],
      [0.08, 0.42, 0.85],
      [0.72, 0.40, 1.0],
      [0.086, 0.88, 1.0],
      [0.086, 0.95, 1.0],
    ],
  },
  {
    name: "DAWN",
    colors: [
      [0.0, 0.106, 0.18],
      [0.34, 0.75, 0.60],
      [1.0, 0.98, 0.59],
      [1.0, 0.44, 0.81],
      [0.02, 1.0, 0.63],
    ],
  },
];

// ----------------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------------
const VERT = `#version 300 es
void main() {
  // フルスクリーントライアングル
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SCENE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uLook;    // (yaw, pitch)
uniform vec3 uCamPos;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunTop;
uniform vec3 uSunBottom;
uniform vec3 uGridCol;

const float FOV = ${CONFIG.FOV.toFixed(3)};
const float FAR = 70.0;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// 中央に平原、左右に fbm の山岳。
// カメラから遠いほど高さを絞り、遠方でレイが山に捕まらず空へ抜けるようにする
float terrain(vec2 xz) {
  float valley = smoothstep(2.0, 7.0, abs(xz.x));
  float m = fbm(xz * vec2(0.18, 0.12));
  float falloff = 1.0 - smoothstep(10.0, 40.0, distance(xz, uCamPos.xz));
  return valley * m * m * 5.5 * falloff;
}

float march(vec3 ro, vec3 rd, out vec3 hitPos) {
  float t = 0.05;
  for (int i = 0; i < 170; i++) {
    vec3 p = ro + rd * t;
    float dy = p.y - terrain(p.xz);
    if (dy < 0.002 * t) {
      // 2分法で少し詰めてグリッド線のにじみを抑える
      float t0 = t - max(0.02, dy * 0.5);
      for (int j = 0; j < 4; j++) {
        float tm = 0.5 * (t0 + t);
        vec3 pm = ro + rd * tm;
        if (pm.y - terrain(pm.xz) < 0.0) t = tm; else t0 = tm;
      }
      hitPos = ro + rd * t;
      return t;
    }
    t += max(0.02, dy * 0.45);
    if (t > FAR) break;
  }
  hitPos = ro + rd * FAR;
  return -1.0;
}

vec3 skyColor(vec3 rd) {
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.45, rd.y));

  // 太陽(ストライプ入りのディスク)。視線方向は -Z が正面
  vec3 sd = normalize(vec3(0.0, 0.115, -1.0));
  float ang = acos(clamp(dot(rd, sd), -1.0, 1.0));
  float sunR = 0.21;
  float disc = smoothstep(sunR, sunR - 0.012, ang);
  float rel = clamp((rd.y - (sd.y - sunR)) / (sunR * 2.0), 0.0, 1.0); // 0=下端, 1=上端
  // 下端ほどストライプの欠けを強く
  float band = 0.5 + 0.5 * sin(rd.y * 90.0 + uTime * 0.7);
  float gaps = smoothstep(0.75, 0.05, rel);
  float stripes = mix(1.0, smoothstep(0.42, 0.52, band), gaps);
  vec3 sunCol = mix(uSunBottom, uSunTop, rel);
  float pulse = 0.92 + 0.08 * sin(uTime * 0.9); // ゆっくりした鼓動
  col += sunCol * disc * stripes * 1.3 * pulse;
  col += sunCol * exp(-ang * 3.2) * 0.4 * (1.0 - disc * 0.7) * pulse; // ハロー(ディスク内は弱く)

  // 星(地平線近くと太陽周辺は出さない)
  vec2 su = vec2(atan(rd.x, -rd.z) * 22.0, rd.y * 42.0);
  vec2 cell = floor(su);
  float star = step(0.994, hash21(cell));
  vec2 fp = fract(su) - 0.5;
  float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + hash21(cell + 7.7) * 40.0);
  float starMask = smoothstep(0.18, 0.0, length(fp)) * star * twinkle;
  starMask *= smoothstep(0.12, 0.3, rd.y) * smoothstep(sunR * 2.2, sunR * 3.4, ang);
  col += vec3(0.9, 0.9, 1.0) * starMask;

  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 ndc = uv * 2.0 - 1.0;
  ndc.x *= uRes.x / uRes.y;

  // ピッチ → ヨーの順で回転
  vec3 rd = normalize(vec3(ndc.x, ndc.y, -FOV));
  float cp = cos(uLook.y), sp = sin(uLook.y);
  rd.yz = mat2(cp, -sp, sp, cp) * rd.yz;
  float cy = cos(uLook.x), sy = sin(uLook.x);
  rd.xz = mat2(cy, -sy, sy, cy) * rd.xz;

  vec3 ro = uCamPos;

  vec3 col;
  vec3 p;
  // 山の最大高さより十分上を向いているレイはマーチせず空へ
  float t = (rd.y > 0.35) ? -1.0 : march(ro, rd, p);

  // 地平線のフォグ色。正面(太陽方向)ほど太陽の色がにじむ
  float sunAmount = pow(max(dot(normalize(rd.xz), vec2(0.0, -1.0)), 0.0), 8.0);
  vec3 fogCol = uSkyHorizon * 0.75 + uSunBottom * sunAmount * 0.6;

  if (t > 0.0) {
    float h = terrain(p.xz);

    // グリッド線: 整数座標に近いほど明るい。距離とともに太らせてエイリアスを抑える
    vec2 gr = abs(fract(p.xz) - 0.5);
    float lw = 0.46 - min(t * 0.004, 0.1);
    float line = smoothstep(lw, 0.5, max(gr.x, gr.y));
    line = pow(line, 1.6);

    vec3 ground = mix(vec3(0.012, 0.006, 0.03), uSkyTop * 0.35, smoothstep(0.0, 2.8, h));
    float fade = exp(-t * 0.05);
    float pulse = 0.9 + 0.25 * sin(uTime * 0.9 + p.z * 0.05);
    col = ground;
    col += uGridCol * line * 1.35 * fade * pulse;
    col = mix(col, fogCol, 1.0 - exp(-t * 0.028));
  } else {
    col = skyColor(rd);
    // 地平線ぎわのにじみ
    col += fogCol * exp(-abs(rd.y) * 18.0) * 0.5;
  }

  // トーンマッピング(ネオンの飽和を柔らかく)
  col = 1.0 - exp(-col * 1.7);
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}`;

const POST_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uTime;

float hash11(float p) {
  p = fract(p * 443.8975);
  p += p * (p + 19.19);
  return fract(p * p);
}
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;

  // バレル歪み(ブラウン管の膨らみ)
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.031 * dot(c, c);
  uv = c * 0.5 + 0.5;

  // 行単位のジッタ。ときどきバーストして大きくズレる
  float lineId = floor(gl_FragCoord.y / 3.0);
  float burst = step(0.965, hash11(floor(uTime * 2.7))); // たまに起こる大ノイズ
  float jitterAmp = 0.0012 + burst * 0.011;
  uv.x += (hash21(vec2(lineId, floor(uTime * 17.0))) - 0.5) * jitterAmp;

  // ゆっくり流れるトラッキングバー
  float bar = smoothstep(0.06, 0.0, abs(fract(uv.y * 0.7 + uTime * 0.05) - 0.5) - 0.42);

  // 色収差(中心から離れるほど強い)
  vec2 ca = c * (0.0038 + burst * 0.004);
  vec3 col;
  col.r = texture(uScene, uv + ca).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - ca).b;

  // 画面外は黒
  vec2 outside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  col *= outside.x * outside.y;

  // 走査線 + グレイン + トラッキングバーのうっすらした持ち上げ
  float scan = 1.0 - 0.14 * (0.5 + 0.5 * sin(gl_FragCoord.y * 2.1));
  float grain = (hash21(uv * uRes + fract(uTime) * 337.0) - 0.5) * 0.077;
  col = col * scan + grain + bar * 0.025;

  // ビネット
  float vig = smoothstep(1.55, 0.45, length(c));
  col *= vig;

  outColor = vec4(col, 1.0);
}`;

// ----------------------------------------------------------------------------
// GL boilerplate
// ----------------------------------------------------------------------------
function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

function makeProgram(fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  return prog;
}

const sceneProg = makeProgram(SCENE_FRAG);
const postProg = makeProgram(POST_FRAG);

function uniformMap(prog, names) {
  const m = {};
  for (const n of names) m[n] = gl.getUniformLocation(prog, n);
  return m;
}

const sceneU = uniformMap(sceneProg, [
  "uRes", "uTime", "uLook", "uCamPos",
  "uSkyTop", "uSkyHorizon", "uSunTop", "uSunBottom", "uGridCol",
]);
const postU = uniformMap(postProg, ["uScene", "uRes", "uTime"]);

// シーン描画先のFBO
const sceneTex = gl.createTexture();
const sceneFbo = gl.createFramebuffer();
let sceneW = 0, sceneH = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h && sceneW > 0) return;
  canvas.width = w;
  canvas.height = h;
  sceneW = Math.max(2, Math.round(w * CONFIG.SCENE_SCALE));
  sceneH = Math.max(2, Math.round(h * CONFIG.SCENE_SCALE));
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sceneW, sceneH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
window.addEventListener("resize", resize);

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const state = {
  time: 0,
  dist: 0, // 前進距離の積分(camZ = -dist)
  speed: CONFIG.SPEED_DEFAULT,
  targetSpeed: CONFIG.SPEED_DEFAULT,
  look: [0, 0],
  targetLook: [0, 0],
  paletteIndex: 0,
  palette: PALETTES[0].colors.map((c) => c.slice()), // 現在値(補間される)
  interacted: false,
};

function camPos() {
  const bob = 0.05 * Math.sin(state.time * 0.5);
  return [0, CONFIG.CAM_HEIGHT + bob, -state.dist];
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------
function markInteracted() {
  if (!state.interacted) {
    state.interacted = true;
    setTimeout(() => hint.classList.add("faded"), 2500);
  }
}

canvas.addEventListener("pointerdown", () => {
  markInteracted();
});

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width - 0.5;
  const ny = (e.clientY - rect.top) / rect.height - 0.5;
  state.targetLook[0] = -nx * CONFIG.LOOK_YAW_RANGE;
  state.targetLook[1] = -ny * CONFIG.LOOK_PITCH_RANGE;
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    markInteracted();
    state.targetSpeed = Math.min(
      CONFIG.SPEED_MAX,
      Math.max(CONFIG.SPEED_MIN, state.targetSpeed - e.deltaY * 0.004)
    );
  },
  { passive: false }
);

let paletteNameTimer = 0;
document.getElementById("cyclePalette").addEventListener("click", () => {
  state.paletteIndex = (state.paletteIndex + 1) % PALETTES.length;
  paletteName.textContent = PALETTES[state.paletteIndex].name;
  paletteName.classList.add("show");
  clearTimeout(paletteNameTimer);
  paletteNameTimer = setTimeout(() => paletteName.classList.remove("show"), 1400);
});

// ----------------------------------------------------------------------------
// Render loop
// ----------------------------------------------------------------------------
const startMs = performance.now();
let prevMs = startMs;

function frame(nowMs) {
  const dt = Math.min((nowMs - prevMs) / 1000, 0.1);
  prevMs = nowMs;
  state.time = (nowMs - startMs) / 1000;

  // 前進・視点のスムージング(時間ベースでフレームレート非依存)
  const ease = (rate) => 1 - Math.exp(-rate * dt);
  state.speed += (state.targetSpeed - state.speed) * ease(CONFIG.SPEED_RATE);
  state.dist += state.speed * dt;
  const lookK = ease(CONFIG.LOOK_RATE);
  state.look[0] += (state.targetLook[0] - state.look[0]) * lookK;
  state.look[1] += (state.targetLook[1] - state.look[1]) * lookK;

  // パレットの補間
  const target = PALETTES[state.paletteIndex].colors;
  const palK = ease(CONFIG.PALETTE_RATE);
  for (let i = 0; i < target.length; i++) {
    for (let k = 0; k < 3; k++) {
      state.palette[i][k] += (target[i][k] - state.palette[i][k]) * palK;
    }
  }

  resize();

  // --- パス1: シーンを低解像度FBOへ ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
  gl.viewport(0, 0, sceneW, sceneH);
  gl.useProgram(sceneProg);
  gl.uniform2f(sceneU.uRes, sceneW, sceneH);
  gl.uniform1f(sceneU.uTime, state.time);
  gl.uniform2f(sceneU.uLook, state.look[0], state.look[1]);
  gl.uniform3fv(sceneU.uCamPos, camPos());
  const [skyTop, skyHorizon, sunTop, sunBottom, grid] = state.palette;
  gl.uniform3fv(sceneU.uSkyTop, skyTop);
  gl.uniform3fv(sceneU.uSkyHorizon, skyHorizon);
  gl.uniform3fv(sceneU.uSunTop, sunTop);
  gl.uniform3fv(sceneU.uSunBottom, sunBottom);
  gl.uniform3fv(sceneU.uGridCol, grid);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- パス2: VHSポストプロセスで画面へ ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(postProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.uniform1i(postU.uScene, 0);
  gl.uniform2f(postU.uRes, canvas.width, canvas.height);
  gl.uniform1f(postU.uTime, state.time);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);
