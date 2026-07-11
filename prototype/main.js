// ============================================================================
// 「結露したガラスの向こう側」ヒーロー・プロトタイプ
//
// - WebGL2 + stable-fluids 風シミュレーションで「結露ガラス」を表現
// - 名前の漢字(KanjiVG のストロークパス)を正しい筆順でなぞり、
//   なぞった軌跡だけガラスの曇りが拭われて奥の景色が見える
// - ユーザーはポインタ/タッチでも自由にガラスを拭ける
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

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1024,
  DENSITY_DISSIPATION: 0.994, // 拭った跡がゆっくり曇りへ戻る速度
  VELOCITY_DISSIPATION: 0.992,
  PRESSURE_DISSIPATION: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 9,
  AUTOPLAY_SPLAT_RADIUS: 0.00012, // 指でなぞる筆跡は細く
  AUTOPLAY_VELOCITY_SCALE: 90, // 筆跡が渦で崩れすぎないよう抑えた力
  USER_SPLAT_RADIUS: 0.018,
  SPLAT_FORCE: 3200,
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

// fullscreen quad
const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
  gl.STATIC_DRAW
);
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

const displayShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uDye;
  uniform sampler2D uVelocity;
  uniform float uTime;
  uniform vec2 uResolution;
  out vec4 fragColor;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  vec3 backgroundScene(vec2 uv, float t) {
    vec2 p = uv * 2.0 - 1.0;
    p.x *= uResolution.x / uResolution.y;
    vec3 col = vec3(0.015, 0.02, 0.045);
    vec2 c1 = vec2(sin(t * 0.11) * 0.65, cos(t * 0.09) * 0.45);
    vec2 c2 = vec2(cos(t * 0.08) * 0.55 + 0.25, sin(t * 0.12) * 0.5 - 0.2);
    vec2 c3 = vec2(sin(t * 0.15 + 2.0) * 0.4 - 0.4, cos(t * 0.07 + 1.0) * 0.5 + 0.3);
    col += vec3(0.15, 0.32, 0.55) * smoothstep(0.9, 0.0, length(p - c1));
    col += vec3(0.5, 0.22, 0.42) * smoothstep(0.75, 0.0, length(p - c2)) * 0.8;
    col += vec3(0.12, 0.42, 0.4) * smoothstep(0.8, 0.0, length(p - c3)) * 0.7;
    float grain = (noise(uv * 500.0 + t * 0.6) - 0.5) * 0.03;
    col += grain;
    return col;
  }

  vec3 fogLayer(vec2 uv, float t) {
    float n1 = noise(uv * 6.0 + vec2(t * 0.02, t * 0.015));
    float n2 = noise(uv * 16.0 - vec2(t * 0.01, t * 0.025));
    float density = n1 * 0.6 + n2 * 0.4;
    return mix(vec3(0.75, 0.79, 0.84), vec3(0.85, 0.88, 0.93), density);
  }

  void main () {
    vec2 uv = vUv;
    float clarity = clamp(texture(uDye, uv).r, 0.0, 1.0);
    vec2 vel = texture(uVelocity, uv).xy;

    vec2 distorted = uv + vel * 0.0018;
    vec3 scene = backgroundScene(distorted, uTime);
    vec3 fog = fogLayer(uv, uTime);

    float speck = step(0.986, hash(floor(uv * vec2(900.0, 500.0))));
    fog += speck * (1.0 - clarity) * vec3(0.9, 0.95, 1.0) * 0.5;

    float mixAmt = smoothstep(0.05, 0.6, clarity);
    vec3 col = mix(fog, scene, mixAmt);

    float edge = fwidth(clarity) * 5.0;
    col += edge * vec3(0.55, 0.7, 0.85);

    float vig = smoothstep(1.15, 0.3, length(uv - 0.5) * 1.4);
    col *= mix(0.55, 1.0, vig);

    fragColor = vec4(col, 1.0);
  }
`;

const copyShader = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTexture;
  out vec4 fragColor;
  void main () {
    fragColor = texture(uTexture, vUv);
  }
`;

const splatProgram = createProgram(baseVertexShader, splatShader);
const advectionProgram = createProgram(baseVertexShader, advectionShader);
const divergenceProgram = createProgram(baseVertexShader, divergenceShader);
const curlProgram = createProgram(baseVertexShader, curlShader);
const vorticityProgram = createProgram(baseVertexShader, vorticityShader);
const pressureProgram = createProgram(baseVertexShader, pressureShader);
const gradientSubtractProgram = createProgram(baseVertexShader, gradientSubtractShader);
const clearProgram = createProgram(baseVertexShader, clearShader);
const displayProgram = createProgram(baseVertexShader, displayShader);
const copyProgram = createProgram(baseVertexShader, copyShader);

function useProgram(p) {
  gl.useProgram(p.program);
  return p.uniforms;
}

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

// 一部のドライバ(特に Windows/ANGLE 経由)は EXT_color_buffer_float を
// 報告していても、単一/2チャンネルの float テクスチャ(R16F / RG16F)への
// レンダリングには実は対応していないことがある。その場合フレームバッファが
// 不完全になり、描き込みが黙って no-op になる(=なぞっても何も起きない)。
// 実際にテストレンダリングして、ダメなら RGBA16F にフォールバックする。
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
// Simulation step
// ----------------------------------------------------------------------------
function splat(x, y, dx, dy, dyeColor, radius) {
  gl.viewport(0, 0, velocity.width, velocity.height);
  let u = useProgram(splatProgram);
  gl.uniform1i(u.uTarget, velocity.read.attach(0));
  gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(u.point, x, y);
  gl.uniform3f(u.color, dx, dy, 0.0);
  gl.uniform1f(u.radius, radius);
  blit(velocity.write.fbo);
  velocity.swap();

  gl.viewport(0, 0, dye.width, dye.height);
  u = useProgram(splatProgram);
  gl.uniform1i(u.uTarget, dye.read.attach(0));
  gl.uniform2f(u.point, x, y);
  gl.uniform3f(u.color, dyeColor, dyeColor, dyeColor);
  gl.uniform1f(u.radius, radius);
  blit(dye.write.fbo);
  dye.swap();
}

function stepSimulation(dt) {
  gl.disable(gl.BLEND);

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
  gl.uniform1f(u.dissipation, CONFIG.VELOCITY_DISSIPATION);
  blit(velocity.write.fbo);
  velocity.swap();

  gl.viewport(0, 0, dye.width, dye.height);
  u = useProgram(advectionProgram);
  gl.uniform2f(u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(u.uVelocity, velocity.read.attach(0));
  gl.uniform1i(u.uSource, dye.read.attach(1));
  gl.uniform1f(u.dt, dt);
  gl.uniform1f(u.dissipation, CONFIG.DENSITY_DISSIPATION);
  blit(dye.write.fbo);
  dye.swap();
}

let startTime = performance.now();

function render() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  const u = useProgram(displayProgram);
  gl.uniform1i(u.uDye, dye.read.attach(0));
  gl.uniform1i(u.uVelocity, velocity.read.attach(1));
  gl.uniform1f(u.uTime, (performance.now() - startTime) / 1000);
  gl.uniform2f(u.uResolution, canvas.width, canvas.height);
  blit(null);
}

// ----------------------------------------------------------------------------
// KanjiVG: load stroke paths and sample points along each stroke
// ----------------------------------------------------------------------------
const hiddenHost = document.createElement("div");
hiddenHost.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;";
document.body.appendChild(hiddenHost);

function samplePath(pathEl, spacing = 1.4) {
  const len = pathEl.getTotalLength();
  const n = Math.max(2, Math.round(len / spacing));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = pathEl.getPointAtLength((i / n) * len);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

async function loadKanjiStrokes(codepoint) {
  const url = `./assets/kanjivg/${codepoint}.svg`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`KanjiVG fetch failed for ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  // KanjiVGのファイルは xmlns:kvg 宣言を内部DTDサブセットの #FIXED デフォルト属性
  // 経由でしか与えていない。これはDTDを処理するパーサー(Chrome等)でしか解決されず、
  // それ以外(Firefox等)では "kvg:" 接頭辞が未宣言とみなされ parsererror になる。
  // <svg> タグへ明示的に xmlns:kvg を注入してから parse することで回避する。
  const patchedText = text.replace(/<svg\b/, '<svg xmlns:kvg="http://kanjivg.tagaini.net"');
  const parsedDoc = new DOMParser().parseFromString(patchedText, "image/svg+xml");
  if (parsedDoc.querySelector("parsererror")) {
    throw new Error(`${url} failed to parse as XML: ${parsedDoc.querySelector("parsererror").textContent.trim()}`);
  }
  const svgSource = parsedDoc.querySelector("svg");
  if (!svgSource) {
    throw new Error(`${url} did not contain a <svg> root (got 404/error page instead?)`);
  }
  const svgEl = document.importNode(svgSource, true);
  hiddenHost.appendChild(svgEl);

  const vb = svgEl.viewBox.baseVal;
  const pathEls = Array.from(svgEl.querySelectorAll('g[id^="kvg:StrokePaths_"] path'));
  hiddenHost.removeChild(svgEl);

  if (pathEls.length === 0) {
    throw new Error(`No stroke paths found in ${url} (unexpected KanjiVG structure)`);
  }
  const strokes = pathEls.map((p) => samplePath(p));
  return { strokes, viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height } };
}

// 「創作」— プロトタイプ用のプレースホルダー(実名は今後差し替え)
const KANJI_CODEPOINTS = ["05275", "04f5c"];

function layoutForChar(index, total) {
  const vmin = Math.min(window.innerWidth, window.innerHeight);
  const charSize = vmin * 0.32;
  const gap = charSize * 0.18;
  const totalWidth = charSize * total + gap * (total - 1);
  const startX = (window.innerWidth - totalWidth) / 2;
  const originY = (window.innerHeight - charSize) / 2;
  const originX = startX + index * (charSize + gap);
  return { originX, originY, charSize };
}

function strokePointToUV(charData, index, total, pt) {
  const { originX, originY, charSize } = layoutForChar(index, total);
  const vb = charData.viewBox;
  const px = originX + ((pt.x - vb.x) / vb.width) * charSize;
  const py = originY + ((pt.y - vb.y) / vb.height) * charSize;
  const dpr = canvas.width / window.innerWidth;
  const u = (px * dpr) / canvas.width;
  const v = 1 - (py * dpr) / canvas.height;
  return { u, v };
}

// ----------------------------------------------------------------------------
// Autoplay tracer: なぞって拭う演出
// ----------------------------------------------------------------------------
const autoplay = {
  enabled: true,
  data: [],
  charIndex: 0,
  strokeIndex: 0,
  pointIndex: 0,
  progress: 0,
  paused: true,
  pauseTimer: 0.6,
  speed: 260, // points per second
};

// 指先を表す共通のカーソル要素。オートプレイ中も、ユーザーがポインタ/タッチで
// 操作している間も、これで現在位置を可視化する(canvas 自体は cursor:none)。
function makeFingerCursor() {
  const el = document.createElement("div");
  el.style.cssText = `
    position: fixed; width: 22px; height: 22px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.85), rgba(255,255,255,0) 70%);
    pointer-events: none; transform: translate(-50%, -50%); z-index: 5;
    transition: opacity 0.2s ease; opacity: 0;
  `;
  document.body.appendChild(el);
  return el;
}
const fingerCursor = makeFingerCursor();

function setFingerCursor(clientX, clientY, opacity) {
  fingerCursor.style.opacity = String(opacity);
  fingerCursor.style.left = `${clientX}px`;
  fingerCursor.style.top = `${clientY}px`;
}

function updateAutoplay(dt) {
  if (!autoplay.enabled || autoplay.data.length === 0) return;

  const charData = autoplay.data[autoplay.charIndex];
  if (!charData) {
    autoplay.enabled = false;
    fingerCursor.style.opacity = "0";
    hint.classList.remove("faded");
    return;
  }

  if (autoplay.paused) {
    autoplay.pauseTimer -= dt;
    if (autoplay.pauseTimer <= 0) autoplay.paused = false;
    return;
  }

  const stroke = charData.strokes[autoplay.strokeIndex];
  autoplay.progress += dt * autoplay.speed;
  while (autoplay.progress >= 1 && autoplay.pointIndex < stroke.length - 1) {
    autoplay.progress -= 1;
    autoplay.pointIndex++;
  }

  const pt = stroke[autoplay.pointIndex];
  const prevPt = stroke[Math.max(0, autoplay.pointIndex - 1)];
  const cur = strokePointToUV(charData, autoplay.charIndex, autoplay.data.length, pt);
  const prev = strokePointToUV(charData, autoplay.charIndex, autoplay.data.length, prevPt);

  const vx = (cur.u - prev.u) * CONFIG.AUTOPLAY_VELOCITY_SCALE;
  const vy = (cur.v - prev.v) * CONFIG.AUTOPLAY_VELOCITY_SCALE;
  splat(cur.u, cur.v, vx, vy, 1.0, CONFIG.AUTOPLAY_SPLAT_RADIUS);

  setFingerCursor(cur.u * window.innerWidth, (1 - cur.v) * window.innerHeight, 0.9);

  if (autoplay.pointIndex >= stroke.length - 1) {
    autoplay.strokeIndex++;
    autoplay.pointIndex = 0;
    autoplay.progress = 0;
    autoplay.paused = true;
    autoplay.pauseTimer = 0.07;

    if (autoplay.strokeIndex >= charData.strokes.length) {
      autoplay.strokeIndex = 0;
      autoplay.charIndex++;
      autoplay.pauseTimer = 0.22;
    }
  }
}

// ----------------------------------------------------------------------------
// Pointer / touch: 自由にガラスを拭う
// ----------------------------------------------------------------------------
const pointerState = { down: false, x: 0, y: 0, hasMoved: false };

function toUV(clientX, clientY) {
  const dpr = canvas.width / window.innerWidth;
  const u = (clientX * dpr) / canvas.width;
  const v = 1 - (clientY * dpr) / canvas.height;
  return { u, v };
}

function stopAutoplayForUser() {
  if (autoplay.enabled) {
    autoplay.enabled = false;
  }
  hint.classList.add("faded");
}

function handlePointerDown(clientX, clientY) {
  stopAutoplayForUser();
  const { u, v } = toUV(clientX, clientY);
  pointerState.down = true;
  pointerState.x = u;
  pointerState.y = v;
  pointerState.hasMoved = false;
  splat(u, v, 0, 0, 1.0, CONFIG.USER_SPLAT_RADIUS * 0.6);
  setFingerCursor(clientX, clientY, 1.0);
}

function handlePointerMove(clientX, clientY) {
  if (!autoplay.enabled) {
    setFingerCursor(clientX, clientY, pointerState.down ? 1.0 : 0.55);
  }
  if (!pointerState.down) return;
  const { u, v } = toUV(clientX, clientY);
  const dx = (u - pointerState.x) * CONFIG.SPLAT_FORCE;
  const dy = (v - pointerState.y) * CONFIG.SPLAT_FORCE;
  splat(u, v, dx, dy, 1.0, CONFIG.USER_SPLAT_RADIUS);
  pointerState.x = u;
  pointerState.y = v;
  pointerState.hasMoved = true;
}

function handlePointerUp() {
  pointerState.down = false;
}

canvas.addEventListener("pointerdown", (e) => handlePointerDown(e.clientX, e.clientY));
canvas.addEventListener("pointermove", (e) => handlePointerMove(e.clientX, e.clientY));
canvas.addEventListener("pointerleave", () => {
  if (!pointerState.down) fingerCursor.style.opacity = "0";
});
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
let lastTime = performance.now();

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;

  // なぞり演出(KanjiVGデータ依存)が万一失敗しても、ガラスの流体表現・
  // 自由な拭き取りは常に動き続けるようにする。
  try {
    updateAutoplay(dt);
  } catch (err) {
    console.error("Kanji trace step failed — disabling intro trace, fluid glass still runs:", err);
    autoplay.enabled = false;
  }

  stepSimulation(dt);
  render();

  requestAnimationFrame(frame);
}

// 流体シミュレーション自体はKanjiVGの読み込みを待たずに即座に動かす。
requestAnimationFrame(frame);

Promise.all(KANJI_CODEPOINTS.map(loadKanjiStrokes))
  .then((data) => {
    autoplay.data = data;
  })
  .catch((err) => {
    console.error("Failed to load KanjiVG stroke data — name trace disabled, fluid glass still runs:", err);
    autoplay.enabled = false;
    hint.classList.remove("faded");
  });
