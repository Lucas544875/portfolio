// ============================================================================
// 溶ける文字 — プロトタイプ #4
//
// - WebGL2 + stable-fluids で水(染料=dye)をシミュレーションする土台は
//   ../prototype/(KanjiVGなぞりプロトタイプ)のfluidエンジンを流用している
// - 「なぞる」代わりに、明朝体フォントで文字をCanvas 2Dに描画してアルファマスク
//   テクスチャにし、水面のランダムな位置に一気に注入(スタンプ)して
//   「ぱっと現れる」演出にする(外部アセット・fetch不要で完結する)
// - 現れた文字は「保持(ほぼ減衰しない)」→「溶解(減衰を強める)」の
//   2段階のdissipation切り替えで、しばらく形を保ってから溶け込んでいく
//   アーク(弧)を作る。これを一定周期で繰り返す
// - ページを開くと何もしなくても自動でループする。ポインタ/タッチで水面に
//   触れると、渦とごく薄いインクの滲みを追加できる(任意の演出)
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

if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
  fallback.classList.remove("hidden");
  throw new Error("WebGL2 float render targets are not supported.");
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  SIM_RESOLUTION: isCoarsePointer ? 96 : 128,
  DYE_RESOLUTION: isCoarsePointer ? 640 : 1024,
  DPR_CAP: isCoarsePointer ? 1.5 : 2.0,
  VELOCITY_DISSIPATION: 0.99,
  PRESSURE_DISSIPATION: 0.8,
  PRESSURE_ITERATIONS: isCoarsePointer ? 14 : 20,
  CURL: 6, // ../prototype/ の9だとこの用途では渦が強すぎ、保持フェーズでも文字がすぐ崩れてしまった

  // 文字が現れてから消えるまでの1サイクルを4段階の秒数で構成する:
  //   出現(APPEAR) → 保持(HOLD、ほぼ減衰しない) → 溶解(DISSOLVE、一気に減衰) → 間(GAP、無地の水)
  APPEAR_DURATION: 0.4,
  HOLD_DURATION: 2.2,
  DISSOLVE_DURATION: 3.6,
  GAP_DURATION: 0.7,
  DENSITY_DISSIPATION_HOLD: 0.9997, // 保持フェーズ: 形がほぼ崩れない
  DENSITY_DISSIPATION_DISSOLVE: 0.965, // 溶解フェーズ: ここで一気に薄くなる

  APPEAR_PEAK: 1.15, // 出現時に積み上げるインクの目標濃度(1.0よりわずかに濃く撃って発光感を出す)
  GLYPH_RASTER_SIZE: 512, // 文字を描画するオフスクリーンcanvasの解像度(起動時に1回だけ)
  GLYPH_SIZE_MIN: 0.24, // 画面短辺に対する比率
  GLYPH_SIZE_MAX: 0.32,
  ROTATION_JITTER: 0.12, // ラジアン。毎回わずかに傾きを変えて機械的な反復感を減らす

  AMBIENT_INTERVAL_MIN: 0.5,
  AMBIENT_INTERVAL_MAX: 1.3,
  AMBIENT_FORCE: 850,
  AMBIENT_FORCE_HOLD_MULT: 0.1, // 保持フェーズは水流をほぼ止め、渦で文字が早期に崩れないようにする
  AMBIENT_FORCE_DISSOLVE_MULT: 1.8, // 溶解フェーズはここで水流を強め、「押し流されて溶ける」感を出す
  AMBIENT_RADIUS: 0.0022,

  USER_SPLAT_RADIUS: 0.0028,
  USER_DYE_RADIUS: 0.01,
  USER_DYE_INTENSITY: 0.022, // ドラッグは連続してsplatが重なる上に渦がインクを細い筋に濃縮するため、かなり控えめにしないと白飽和する
  SPLAT_FORCE: 600,
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

function blit(targetFBO) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ----------------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------------
const baseVertexShader = `#version 300 es
  precision highp float;
  in vec2 aPosition;
  out vec2 vUv;
  out vec2 vL;
  out vec2 vR;
  out vec2 vT;
  out vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// 汎用ガウシアン・スプラット。velocity(dx,dyを積む)にもdye(色を積む)にも同じ
// シェーダーを使い回す(呼び出し側でどちらのFBOに向けて描くかだけを切り替える)。
const splatShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  out vec4 fragColor;
  void main () {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    float d = exp(-dot(p, p) / radius);
    vec3 base = texture(uTarget, vUv).xyz;
    fragColor = vec4(base + d * color, 1.0);
  }
`;

// 明朝体フォントで描画した文字のアルファマスク(uGlyph)を、指定した位置・大きさ・
// 回転でdyeフィールドへ加算する「文字の型を押し当てるスタンプ」。
// なぞる代わりに、これを出現フェーズの数フレームだけ呼んで一気に濃度を積み上げる。
const stampShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTarget;
  uniform sampler2D uGlyph;
  uniform vec2 uCenter;
  uniform float uAspect;
  uniform float uHalfSize;
  uniform float uRotation;
  uniform float uAmount;
  uniform vec3 uColor;
  out vec4 fragColor;
  void main () {
    vec2 d = vUv - uCenter;
    d.x *= uAspect;
    float s = sin(uRotation), c = cos(uRotation);
    vec2 r = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
    vec2 guv = r / (uHalfSize * 2.0) + 0.5;
    float mask = 0.0;
    if (guv.x >= 0.0 && guv.x <= 1.0 && guv.y >= 0.0 && guv.y <= 1.0) {
      mask = texture(uGlyph, guv).a;
    }
    vec3 base = texture(uTarget, vUv).rgb;
    fragColor = vec4(base + mask * uAmount * uColor, 1.0);
  }
`;

const advectionShader = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  out vec4 fragColor;
  void main () {
    vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
    vec4 result = texture(uSource, coord);
    fragColor = dissipation * result;
  }
`;

const divergenceShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vL;
  in vec2 vR;
  in vec2 vT;
  in vec2 vB;
  uniform sampler2D uVelocity;
  out vec4 fragColor;
  void main () {
    float L = texture(uVelocity, vL).x;
    float R = texture(uVelocity, vR).x;
    float T = texture(uVelocity, vT).y;
    float B = texture(uVelocity, vB).y;
    vec2 C = texture(uVelocity, vUv).xy;
    if (vL.x < 0.0) L = -C.x;
    if (vR.x > 1.0) R = -C.x;
    if (vT.y > 1.0) T = -C.y;
    if (vB.y < 0.0) B = -C.y;
    float div = 0.5 * (R - L + T - B);
    fragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const curlShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vL;
  in vec2 vR;
  in vec2 vT;
  in vec2 vB;
  uniform sampler2D uVelocity;
  out vec4 fragColor;
  void main () {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float T = texture(uVelocity, vT).x;
    float B = texture(uVelocity, vB).x;
    float vort = R - L - T + B;
    fragColor = vec4(0.5 * vort, 0.0, 0.0, 1.0);
  }
`;

const vorticityShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vL;
  in vec2 vR;
  in vec2 vT;
  in vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curlStrength;
  uniform float dt;
  out vec4 fragColor;
  void main () {
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float T = texture(uCurl, vT).x;
    float B = texture(uCurl, vB).x;
    float C = texture(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curlStrength * C;
    force.y *= -1.0;
    vec2 vel = texture(uVelocity, vUv).xy;
    vel += force * dt;
    vel = clamp(vel, -1000.0, 1000.0);
    fragColor = vec4(vel, 0.0, 1.0);
  }
`;

const pressureShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vL;
  in vec2 vR;
  in vec2 vT;
  in vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  out vec4 fragColor;
  void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    float divergence = texture(uDivergence, vUv).x;
    float pressure = (L + R + T + B - divergence) * 0.25;
    fragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const gradientSubtractShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vL;
  in vec2 vR;
  in vec2 vT;
  in vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  out vec4 fragColor;
  void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    vec2 velocity = texture(uVelocity, vUv).xy;
    velocity -= vec2(R - L, T - B);
    fragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const clearShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  out vec4 fragColor;
  void main () {
    fragColor = value * texture(uTexture, vUv);
  }
`;

// インクを「発光する染料」として加算合成する。背景は完全な黒ではなく、
// ごく淡いノイズのうねりを敷いた深い水底にして、インクが無い場所も
// 完全に均一にならないようにしている。
const displayShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uDye;
  uniform sampler2D uVelocity;
  uniform float uTime;
  out vec4 fragColor;

  float hash (vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise (vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main () {
    vec3 dye = texture(uDye, vUv).rgb;
    vec2 vel = texture(uVelocity, vUv).xy;

    vec2 distortedUv = vUv + vel * 0.0006;
    float n = noise(distortedUv * 3.0 + uTime * 0.02);
    vec3 water = mix(vec3(0.006, 0.011, 0.022), vec3(0.013, 0.021, 0.038), n);

    float glow = smoothstep(0.02, 0.55, dot(dye, vec3(0.34)));
    vec3 col = water + dye * 1.1 + dye * glow * 0.3;

    col = col / (col + vec3(1.0));
    col = pow(col, vec3(1.0 / 2.2));

    float vig = smoothstep(1.2, 0.3, length(vUv - 0.5) * 1.4);
    col *= mix(0.6, 1.0, vig);

    fragColor = vec4(col, 1.0);
  }
`;

const splatProgram = createProgram(baseVertexShader, splatShader);
const stampProgram = createProgram(baseVertexShader, stampShader);
const advectionProgram = createProgram(baseVertexShader, advectionShader);
const divergenceProgram = createProgram(baseVertexShader, divergenceShader);
const curlProgram = createProgram(baseVertexShader, curlShader);
const vorticityProgram = createProgram(baseVertexShader, vorticityShader);
const pressureProgram = createProgram(baseVertexShader, pressureShader);
const gradientSubtractProgram = createProgram(baseVertexShader, gradientSubtractShader);
const clearProgram = createProgram(baseVertexShader, clearShader);
const displayProgram = createProgram(baseVertexShader, displayShader);

// ----------------------------------------------------------------------------
// Framebuffers
// ----------------------------------------------------------------------------
function createFBO(w, h, internalFormat, format, type, filter) {
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return {
    texture,
    fbo,
    width: w,
    height: h,
    texelSizeX: 1 / w,
    texelSizeY: 1 / h,
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return id;
    },
  };
}

function createDoubleFBO(w, h, internalFormat, format, type, filter) {
  let fbo1 = createFBO(w, h, internalFormat, format, type, filter);
  let fbo2 = createFBO(w, h, internalFormat, format, type, filter);
  return {
    width: w,
    height: h,
    texelSizeX: fbo1.texelSizeX,
    texelSizeY: fbo1.texelSizeY,
    get read() {
      return fbo1;
    },
    get write() {
      return fbo2;
    },
    swap() {
      const tmp = fbo1;
      fbo1 = fbo2;
      fbo2 = tmp;
    },
  };
}

// 一部のドライバはEXT_color_buffer_floatを報告していても、単一/2チャンネルの
// float テクスチャ(R16F/RG16F)への実際のレンダリングには対応していないことが
// ある。試しにレンダリングしてダメならRGBA16Fへ段階的にフォールバックする。
function supportRenderTextureFormat(internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

function getSupportedFormat(internalFormat, format, type) {
  if (supportRenderTextureFormat(internalFormat, format, type)) {
    return { internalFormat, format };
  }
  if (internalFormat === gl.R16F) {
    console.warn("R16F render target unsupported, falling back to RG16F");
    return getSupportedFormat(gl.RG16F, gl.RG, type);
  }
  if (internalFormat === gl.RG16F) {
    console.warn("RG16F render target unsupported, falling back to RGBA16F");
    return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
  }
  console.error("RGBA16F render target unsupported — fluid simulation cannot render.");
  return { internalFormat, format };
}

function getResolution(resolution) {
  let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
  const min = Math.round(resolution);
  const max = Math.round(resolution * aspectRatio);
  if (gl.drawingBufferWidth > gl.drawingBufferHeight) {
    return { width: max, height: min };
  }
  return { width: min, height: max };
}

let velocity, dye, divergence, curl, pressure;

function initFramebuffers() {
  const simRes = getResolution(CONFIG.SIM_RESOLUTION);
  const dyeRes = getResolution(CONFIG.DYE_RESOLUTION);
  const texType = gl.HALF_FLOAT;

  const rgFmt = getSupportedFormat(gl.RG16F, gl.RG, texType);
  const rFmt = getSupportedFormat(gl.R16F, gl.RED, texType);
  const rgbaFmt = getSupportedFormat(gl.RGBA16F, gl.RGBA, texType);

  velocity = createDoubleFBO(simRes.width, simRes.height, rgFmt.internalFormat, rgFmt.format, texType, gl.LINEAR);
  dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgbaFmt.internalFormat, rgbaFmt.format, texType, gl.LINEAR);
  divergence = createFBO(simRes.width, simRes.height, rFmt.internalFormat, rFmt.format, texType, gl.NEAREST);
  curl = createFBO(simRes.width, simRes.height, rFmt.internalFormat, rFmt.format, texType, gl.NEAREST);
  pressure = createDoubleFBO(simRes.width, simRes.height, rFmt.internalFormat, rFmt.format, texType, gl.NEAREST);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

resizeCanvas();
initFramebuffers();

window.addEventListener("resize", () => {
  if (resizeCanvas()) initFramebuffers();
});

// ----------------------------------------------------------------------------
// Splats: velocityのみ/dyeのみをそれぞれ個別に打てるようにしておく
// (文字のスタンプは専用シェーダーを使うため、汎用splatはアンビエントな
// 水流やユーザー操作の淡いインクにしか使わない)
// ----------------------------------------------------------------------------
function splatVelocity(x, y, dx, dy, radius) {
  gl.viewport(0, 0, velocity.width, velocity.height);
  const u = useProgram(splatProgram);
  gl.uniform1i(u.uTarget, velocity.read.attach(0));
  gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(u.point, x, y);
  gl.uniform3f(u.color, dx, dy, 0.0);
  gl.uniform1f(u.radius, radius);
  blit(velocity.write.fbo);
  velocity.swap();
}

function splatDye(x, y, r, g, b, radius) {
  gl.viewport(0, 0, dye.width, dye.height);
  const u = useProgram(splatProgram);
  gl.uniform1i(u.uTarget, dye.read.attach(0));
  gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(u.point, x, y);
  gl.uniform3f(u.color, r, g, b);
  gl.uniform1f(u.radius, radius);
  blit(dye.write.fbo);
  dye.swap();
}

function stampGlyph(texture, centerU, centerV, halfSize, rotation, amount, color) {
  gl.viewport(0, 0, dye.width, dye.height);
  const u = useProgram(stampProgram);
  gl.uniform1i(u.uTarget, dye.read.attach(0));
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(u.uGlyph, 1);
  gl.uniform2f(u.uCenter, centerU, centerV);
  gl.uniform1f(u.uAspect, canvas.width / canvas.height);
  gl.uniform1f(u.uHalfSize, halfSize);
  gl.uniform1f(u.uRotation, rotation);
  gl.uniform1f(u.uAmount, amount);
  gl.uniform3f(u.uColor, color[0], color[1], color[2]);
  blit(dye.write.fbo);
  dye.swap();
}

// ----------------------------------------------------------------------------
// Simulation step
// ----------------------------------------------------------------------------
function stepSimulation(dt, densityDissipationBase) {
  gl.disable(gl.BLEND);

  // dissipation系のuniformは元々「60fps・1フレームあたり」の値として定義して
  // いるため、実際のフレームレートに関わらず実時間で同じ速さになるよう
  // dtでべき乗補正する。
  const densityDissipation = Math.pow(densityDissipationBase, dt * 60);
  const velocityDissipation = Math.pow(CONFIG.VELOCITY_DISSIPATION, dt * 60);

  gl.viewport(0, 0, velocity.width, velocity.height);

  let u = useProgram(curlProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  blit(curl.fbo);

  u = useProgram(vorticityProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  gl.uniform1i(u.uCurl, curl.attach(1));
  gl.uniform1f(u.curlStrength, CONFIG.CURL);
  gl.uniform1f(u.dt, dt);
  blit(velocity.write.fbo);
  velocity.swap();

  u = useProgram(divergenceProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  blit(divergence.fbo);

  u = useProgram(clearProgram);
  gl.uniform1i(u.uTexture, pressure.read.attach(0));
  gl.uniform1f(u.value, CONFIG.PRESSURE_DISSIPATION);
  blit(pressure.write.fbo);
  pressure.swap();

  u = useProgram(pressureProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uDivergence, divergence.attach(0));
  for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(u.uPressure, pressure.read.attach(1));
    blit(pressure.write.fbo);
    pressure.swap();
  }

  u = useProgram(gradientSubtractProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uPressure, pressure.read.attach(0));
  gl.uniform1i(u.uVelocity, velocity.read.attach(1));
  blit(velocity.write.fbo);
  velocity.swap();

  u = useProgram(advectionProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  gl.uniform1i(u.uSource, velocity.read.attach(0));
  gl.uniform1f(u.dt, dt);
  gl.uniform1f(u.dissipation, velocityDissipation);
  blit(velocity.write.fbo);
  velocity.swap();

  gl.viewport(0, 0, dye.width, dye.height);
  u = useProgram(advectionProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  gl.uniform1i(u.uSource, dye.read.attach(1));
  gl.uniform1f(u.dt, dt);
  gl.uniform1f(u.dissipation, densityDissipation);
  blit(dye.write.fbo);
  dye.swap();
}

function render(t) {
  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = useProgram(displayProgram);
  gl.uniform1i(u.uDye, dye.read.attach(0));
  gl.uniform1i(u.uVelocity, velocity.read.attach(1));
  gl.uniform1f(u.uTime, t);
  blit(null);
}

// ----------------------------------------------------------------------------
// 文字グリフ: Canvas 2Dで明朝体フォントの文字を直接描画し、そのアルファ
// チャンネルをアルファマスクのテクスチャとして使う。KanjiVGのSVGアセットや
// fetch/名前空間パッチは不要になり、文字の追加も文字列を足すだけで済む。
// ----------------------------------------------------------------------------
const MINCHO_FONT_STACK =
  '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif JP", "MS Mincho", serif';

function createGlyphTexture(char, size) {
  const offCanvas = document.createElement("canvas");
  offCanvas.width = size;
  offCanvas.height = size;
  const ctx = offCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(size * 0.72)}px ${MINCHO_FONT_STACK}`;
  // 明朝体は仮想ボディの中心と字面の視覚的重心がわずかにずれるため、
  // 光学的な中央に寄せるよう少しだけ下にオフセットする
  ctx.fillText(char, size / 2, size / 2 + size * 0.04);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // キャンバスの行0(見た目の上端)がテクスチャv=0に来てしまうと、vUvは画面下端が0の
  // 慣習(このファイル全体で使っている慣習)と噛み合わず文字が上下反転する。反転して回避する。
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offCanvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return texture;
}

// 「ガラスの向こうに沈んでいく」というサイト全体のトーンに寄せた4字。
// 各インクの色もサイトの寒色パレットの中でわずかに個性が出るよう変えてある。
const CHAR_POOL = [
  { char: "水", color: [0.32, 0.68, 0.92] },
  { char: "光", color: [0.85, 0.78, 0.5] },
  { char: "夢", color: [0.68, 0.52, 0.88] },
  { char: "深", color: [0.26, 0.46, 0.82] },
];

// ----------------------------------------------------------------------------
// Cycle: 出現 → 保持 → 溶解 → 間、を繰り返す
// ----------------------------------------------------------------------------
function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const cycle = {
  enabled: false,
  order: [],
  orderPos: 0,
  timer: 0,
  current: null,
};

function startNextCycle() {
  if (cycle.orderPos >= cycle.order.length) {
    // 同じ文字が連続しないよう、直前の最後の1個を次のシャッフル先頭に
    // 来させない簡易な工夫として、シャッフルし直すだけにしている
    // (プールが4種なので連続の目立ちやすさは低いが、念のため)
    cycle.order = shuffledIndices(CHAR_POOL.length);
    cycle.orderPos = 0;
  }
  const entry = CHAR_POOL[cycle.order[cycle.orderPos]];
  cycle.orderPos++;

  const vmin = Math.min(window.innerWidth, window.innerHeight);
  const sizeRatio = randomRange(CONFIG.GLYPH_SIZE_MIN, CONFIG.GLYPH_SIZE_MAX);
  const sizePx = vmin * sizeRatio;
  const marginPx = sizePx * 0.75;
  const cx = randomRange(marginPx, Math.max(marginPx, window.innerWidth - marginPx));
  const cy = randomRange(marginPx, Math.max(marginPx, window.innerHeight - marginPx));

  cycle.current = {
    entry,
    centerU: cx / window.innerWidth,
    centerV: 1 - cy / window.innerHeight,
    halfSize: sizePx / window.innerHeight / 2,
    rotation: randomRange(-CONFIG.ROTATION_JITTER, CONFIG.ROTATION_JITTER),
  };
  cycle.timer = 0;
}

function currentPhase(timer) {
  if (timer < CONFIG.APPEAR_DURATION) return "appear";
  if (timer < CONFIG.APPEAR_DURATION + CONFIG.HOLD_DURATION) return "hold";
  if (timer < CONFIG.APPEAR_DURATION + CONFIG.HOLD_DURATION + CONFIG.DISSOLVE_DURATION) return "dissolve";
  return "gap";
}

const CYCLE_TOTAL =
  CONFIG.APPEAR_DURATION + CONFIG.HOLD_DURATION + CONFIG.DISSOLVE_DURATION + CONFIG.GAP_DURATION;

function updateCycle(dt) {
  if (!cycle.enabled) return "hold";
  if (!cycle.current) startNextCycle();

  const phase = currentPhase(cycle.timer);

  if (phase === "appear") {
    const glyphTex = glyphTextures.get(cycle.current.entry.char);
    if (glyphTex) {
      const amount = (dt / CONFIG.APPEAR_DURATION) * CONFIG.APPEAR_PEAK;
      stampGlyph(
        glyphTex,
        cycle.current.centerU,
        cycle.current.centerV,
        cycle.current.halfSize,
        cycle.current.rotation,
        amount,
        cycle.current.entry.color
      );
    }
  }

  cycle.timer += dt;
  if (cycle.timer >= CYCLE_TOTAL) {
    startNextCycle();
  }

  return phase;
}

function densityDissipationForPhase(phase) {
  return phase === "dissolve" || phase === "gap"
    ? CONFIG.DENSITY_DISSIPATION_DISSOLVE
    : CONFIG.DENSITY_DISSIPATION_HOLD;
}

// ----------------------------------------------------------------------------
// アンビエントな水流: ユーザー操作が無くても、水面が完全な静止画にならないよう
// ランダムな位置にごく弱い渦を継続的に注入する
// ----------------------------------------------------------------------------
let ambientAccumulator = 0;
let nextAmbientInterval = randomRange(CONFIG.AMBIENT_INTERVAL_MIN, CONFIG.AMBIENT_INTERVAL_MAX);

function updateAmbientTurbulence(dt, phase) {
  ambientAccumulator += dt;
  if (ambientAccumulator < nextAmbientInterval) return;
  ambientAccumulator = 0;
  nextAmbientInterval = randomRange(CONFIG.AMBIENT_INTERVAL_MIN, CONFIG.AMBIENT_INTERVAL_MAX);

  // 保持フェーズは水流をほぼ止めて文字の形を守り、溶解フェーズ(+間)で
  // 一気に強めて「渦に押し流されて溶ける」動きを作る
  const mult = phase === "dissolve" || phase === "gap" ? CONFIG.AMBIENT_FORCE_DISSOLVE_MULT : CONFIG.AMBIENT_FORCE_HOLD_MULT;
  const angle = Math.random() * Math.PI * 2;
  const force = CONFIG.AMBIENT_FORCE * mult * (0.6 + Math.random() * 0.8);
  splatVelocity(Math.random(), Math.random(), Math.cos(angle) * force, Math.sin(angle) * force, CONFIG.AMBIENT_RADIUS);
}

// ----------------------------------------------------------------------------
// Pointer / touch: 触れると水流とごく薄いインクの滲みが加わる(任意の演出)
// ----------------------------------------------------------------------------
const pointerState = { down: false, x: 0, y: 0 };

function toUV(clientX, clientY) {
  const dpr = canvas.width / window.innerWidth;
  const u = (clientX * dpr) / canvas.width;
  const v = 1 - (clientY * dpr) / canvas.height;
  return { u, v };
}

function handlePointerDown(clientX, clientY) {
  hint.classList.add("faded");
  const { u, v } = toUV(clientX, clientY);
  pointerState.down = true;
  pointerState.x = u;
  pointerState.y = v;
  splatVelocity(u, v, 0, 0, CONFIG.USER_SPLAT_RADIUS * 0.6);
  splatDye(u, v, CONFIG.USER_DYE_INTENSITY, CONFIG.USER_DYE_INTENSITY * 1.05, CONFIG.USER_DYE_INTENSITY * 1.1, CONFIG.USER_DYE_RADIUS * 0.4);
}

function handlePointerMove(clientX, clientY) {
  if (!pointerState.down) return;
  const { u, v } = toUV(clientX, clientY);
  const dx = (u - pointerState.x) * CONFIG.SPLAT_FORCE;
  const dy = (v - pointerState.y) * CONFIG.SPLAT_FORCE;
  splatVelocity(u, v, dx, dy, CONFIG.USER_SPLAT_RADIUS);
  splatDye(u, v, CONFIG.USER_DYE_INTENSITY, CONFIG.USER_DYE_INTENSITY * 1.05, CONFIG.USER_DYE_INTENSITY * 1.1, CONFIG.USER_DYE_RADIUS);
  pointerState.x = u;
  pointerState.y = v;
}

function handlePointerUp() {
  pointerState.down = false;
}

canvas.addEventListener("pointerdown", (e) => handlePointerDown(e.clientX, e.clientY));
canvas.addEventListener("pointermove", (e) => handlePointerMove(e.clientX, e.clientY));
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
let glyphTextures = new Map();
let lastTime = performance.now();
const startTime = lastTime;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  const t = (now - startTime) / 1000;
  lastTime = now;

  let phase = "hold";
  try {
    phase = updateCycle(dt);
  } catch (err) {
    console.error("Character cycle step failed — disabling cycle, fluid still runs:", err);
    cycle.enabled = false;
  }

  updateAmbientTurbulence(dt, phase);
  stepSimulation(dt, densityDissipationForPhase(phase));
  render(t);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// フォントの文字は同期的に描画・アップロードできるため、fetch完了を待つ必要がない。
try {
  CHAR_POOL.forEach((entry) => glyphTextures.set(entry.char, createGlyphTexture(entry.char, CONFIG.GLYPH_RASTER_SIZE)));
  // 準備ができてから少し間を置いて最初の文字を出す(いきなり過ぎないように)
  setTimeout(() => {
    cycle.enabled = true;
  }, 700);
} catch (err) {
  console.error("Failed to create glyph textures — character cycle disabled, fluid still runs:", err);
}
