import mandelboxFragSrc from './mandelbox.frag?raw';
import blitFragSrc from './blit.frag?raw';
import vertSrc from '../shared/quad.vert?raw';
import { createProgram, createFullscreenTriangle, bindFullscreenTriangle } from '../../gl/glUtils.js';
import { Quatarnion } from './quaternion.js';

// prototype-mandelbox2(マンデルボックスのレイマーチ参考実装)を
// About/works-mandelboxブロックの見せ場として移植したもの。参考実装との主な違い:
//   - ズームイン(dive)は行わない。カメラはp0を中心に固定距離(OVERVIEW_DIST)を
//     保ったまま周回する「p0中心にこちらが回る」オービットカメラで、
//     STAY_DURATIONごとに暗転→別の地点へフェードする(deep zoomに必要だった
//     精度・ステップ数を要求しないため軽量)。
//   - ズームHUD/一時停止ボタン/ホイールでの速度調整など、独立ページとしての
//     UIは持たない。ドラッグでの見回しは自動オービットに上乗せする追加の
//     yaw/pitchとして残す。
//   - レイマーチ自体は縮小した専用オフスクリーンFBOに描き、最後に共有
//     canvasの実サイズへバイリニアで引き伸ばす(rain-windowブロックと同じ
//     「内部解像度を落として負荷を抑える」手法)。
//   - 共有レンダラの1ブロックとして動くため、自前canvas/rAF/リサイズ処理は
//     持たず、ctx(time/dt/width/height/originX/Y/dpr/reducedMotion/isLowPower)
//     を経由する。

// ---- マンデルボックスDE(mandelbox.fragのmandelBox()と同じ式)。CPU側では
// pickTarget()が「潜って絵になる1点」を探すためだけに使う。1回数百ステップ
// 程度で無視できるコスト。----
const MB_SCALE = -2.18;
const MB_MINR2 = 0.60;
const MB_FIXEDR2 = 2.65;
const MB_FOLD = 1.14;
const MB_ITER = 16;
const BOUND_RADIUS = 4.2; // Node.js実測(対角方向最大~3.95)に安全マージンを見た値

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function jsDE(x0, y0, z0) {
  let x = x0, y = y0, z = z0;
  let dr = 1.0;
  for (let n = 0; n < MB_ITER; n++) {
    x = clamp(x, -MB_FOLD, MB_FOLD) * 2 - x;
    y = clamp(y, -MB_FOLD, MB_FOLD) * 2 - y;
    z = clamp(z, -MB_FOLD, MB_FOLD) * 2 - z;
    const r2 = x * x + y * y + z * z;
    if (r2 < MB_MINR2) {
      const t = MB_FIXEDR2 / MB_MINR2;
      x *= t; y *= t; z *= t; dr *= t;
    } else if (r2 < MB_FIXEDR2) {
      const t = MB_FIXEDR2 / r2;
      x *= t; y *= t; z *= t; dr *= t;
    }
    x = x * MB_SCALE + x0;
    y = y * MB_SCALE + y0;
    z = z * MB_SCALE + z0;
    dr = dr * Math.abs(MB_SCALE) + 1.0;
  }
  const r = Math.sqrt(x * x + y * y + z * z);
  return r / Math.abs(dr);
}

function vnormalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function vcross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

const LIGHT_DIR = vnormalize([2, 1, 1]); // mandelbox.fragのLightDirと同じ

// JSの倍精度を、GPUへdf64として渡すためのfloat32ペア(hi,lo)に分割する。
function splitFloat(x) {
  const hi = Math.fround(x);
  const lo = Math.fround(x - hi);
  return [hi, lo];
}
function splitVec3(v) {
  const sx = splitFloat(v[0]), sy = splitFloat(v[1]), sz = splitFloat(v[2]);
  return { hi: [sx[0], sy[0], sz[0]], lo: [sx[1], sy[1], sz[1]] };
}

function normalizeQuat(q) { return q.scale(1 / q.norm); }
function qRotateVec(q, v) { return Quatarnion.vec(v[0], v[1], v[2]).turn(q).tovec(); }

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

const FALLBACK_TARGET = {
  p0: [2.212921, 1.099011, 0.307275],
  viewDir: vnormalize([-0.836792, 0.260298, -0.481689]),
};

// 見せる先の1点を選ぶ(2周目以降)。バウンディング球の外側からほぼ原点方向へ
// レイを飛ばし、命中点を採用する。
function pickTarget() {
  const probeR = BOUND_RADIUS * 2.4;
  for (let attempt = 0; attempt < 48; attempt++) {
    const dir0 = randomUnitVector();
    const probeOrigin = vscale(dir0, probeR);
    const jitter = randomUnitVector();
    const aim = vnormalize(vadd(vscale(dir0, -1), vscale(jitter, 0.18)));
    if (vdot(LIGHT_DIR, aim) >= 0) continue; // 逆光は避ける
    const res = jsRaymarch(probeOrigin, aim, probeR * 2.5);
    if (!res.hit) continue;
    const distFromOrigin = Math.hypot(res.p[0], res.p[1], res.p[2]);
    if (distFromOrigin < BOUND_RADIUS * 0.25 || distFromOrigin > BOUND_RADIUS * 1.4) continue;
    return { p0: res.p, viewDir: aim };
  }
  return FALLBACK_TARGET;
}

// 一番最初だけ: +X側から原点方向を見る導入アングルのまま、実際に潜れる
// 隙間を探す(原点への正面衝突を避ける)。
function pickOriginGapDir() {
  const probeR = BOUND_RADIUS * 2.4;
  const baseDir0 = [1, 0, 0];
  let best = null;
  for (let attempt = 0; attempt < 96; attempt++) {
    const jitter = randomUnitVector();
    const dir0 = vnormalize(vadd(baseDir0, vscale(jitter, 0.35)));
    const probeOrigin = vscale(dir0, probeR);
    const aim = vscale(dir0, -1);
    if (vdot(LIGHT_DIR, aim) >= 0) continue;
    const res = jsRaymarch(probeOrigin, aim, probeR * 2.5);
    if (!res.hit) continue;
    const distFromOrigin = Math.hypot(res.p[0], res.p[1], res.p[2]);
    if (!best || distFromOrigin < best.distFromOrigin) {
      best = { p0: res.p, viewDir: aim, distFromOrigin };
    }
  }
  return best ? { p0: best.p0, viewDir: best.viewDir } : { p0: [0, 0, 0], viewDir: [-1, 0, 0] };
}

// カメラ: p0を中心に固定距離(OVERVIEW_DIST)を保ったまま周回し、常にp0を
// 見続ける「p0を中心にこちらが回る」オービットカメラ。yaw→pitchの順に
// 基準方向(target.viewDir)からの回転として適用する(標準的なオイラー角
// カメラと同じ順序: まず世界upまわりのyaw、次にその結果のrightまわりの
// pitch)。mandelbox.frag側がcDirとworldUp(Z軸)からxAxes/yAxesを毎フレーム
// 自前で作り直すため、JS側から渡すのはcDirの1本だけでよい。
function baseFrame(viewDir) {
  const worldUp = [0, 0, 1]; // mandelbox.fragの座標系(Z-up)に合わせる
  const R0 = vnormalize(vcross(viewDir, worldUp));
  const U0 = vnormalize(vcross(R0, viewDir));
  return { R0, U0 };
}

function currentViewDir(baseViewDir, yaw, pitch) {
  const { R0, U0 } = baseFrame(baseViewDir);
  const yawQ = Quatarnion.rotation(yaw, U0[0], U0[1], U0[2]);
  const yawedViewDir = vnormalize(qRotateVec(yawQ, baseViewDir));
  const yawedR = vnormalize(qRotateVec(yawQ, R0));
  const pitchQ = Quatarnion.rotation(pitch, yawedR[0], yawedR[1], yawedR[2]);
  return vnormalize(qRotateVec(pitchQ, yawedViewDir));
}

const OVERVIEW_DIST = 11.0; // ズームインしない固定オービット半径
const STAY_DURATION = 13.0; // 秒。同じ地点に留まる時間
const FADE_DURATION = 1.2; // 秒。次の地点へ切り替える際の暗転
const ORBIT_AMPLITUDE = 0.9; // rad(約52°)。自動オービットの振れ幅
const ORBIT_SPEED = 0.48; // rad/秒(位相の進み方。1往復 ≈ 2π/ORBIT_SPEED ≈ 13秒)

// isLowPower時はFBO解像度をさらに落として負荷を抑える(rain-windowと同じ方針)。
const RENDER_SCALE = 0.72;
const LOW_POWER_RENDER_SCALE = 0.42;

export function createMandelboxBlock(slotEl) {
  let raymarchProgram, blitProgram, triBuffer;
  let raymarchUniforms, blitUniforms;
  let fbo = null; // { texture, framebuffer, width, height }
  let fboSizeW = 0;
  let fboSizeH = 0;

  let target = pickOriginGapDir();
  let cycleT = 0;
  let phase = 'stay'; // 'stay' | 'fade'
  let fadeT = 0;
  let fadeAlpha = 0;
  let pickedNewThisFade = false;
  let orbitPhase = 0; // ORBIT_AMPLITUDE * sin(orbitPhase) が自動オービットのyaw
  // ドラッグでの見回しは、自動オービットに上乗せする追加のyaw/pitchとして
  // 扱う(常にp0を見続けるので参考実装ほど無制限にする必要はないが、
  // p0周辺の見苦しい角度に入り込まないよう一応クランプしておく)。
  let dragYaw = 0;
  let dragPitch = 0;
  const DRAG_LIMIT = 0.3; // rad (約17°)

  function updateCycle(dt) {
    if (phase === 'fade') {
      fadeT += dt;
      const half = FADE_DURATION * 0.5;
      if (fadeT < half) {
        fadeAlpha = fadeT / half;
      } else if (fadeT < FADE_DURATION) {
        if (!pickedNewThisFade) {
          target = pickTarget();
          cycleT = 0;
          dragYaw = 0;
          dragPitch = 0;
          orbitPhase = 0;
          pickedNewThisFade = true;
        }
        fadeAlpha = 1 - (fadeT - half) / half;
      } else {
        phase = 'stay';
        fadeAlpha = 0;
        fadeT = 0;
        pickedNewThisFade = false;
      }
    } else {
      cycleT += dt;
      if (cycleT > STAY_DURATION) {
        phase = 'fade';
        fadeT = 0;
        fadeAlpha = 0;
        pickedNewThisFade = false;
      }
    }
    orbitPhase += ORBIT_SPEED * dt;
  }

  let dragging = false;
  let lastPX = 0;
  let lastPY = 0;

  function onPointerDown(e) {
    dragging = true;
    lastPX = e.clientX;
    lastPY = e.clientY;
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const rect = slotEl.getBoundingClientRect();
    const dx = -0.7 * (e.clientX - lastPX) / rect.width;
    const dy = 0.7 * (e.clientY - lastPY) / rect.height;
    lastPX = e.clientX;
    lastPY = e.clientY;
    dragYaw = clamp(dragYaw - dx * Math.PI, -DRAG_LIMIT, DRAG_LIMIT);
    dragPitch = clamp(dragPitch + dy * Math.PI, -DRAG_LIMIT, DRAG_LIMIT);
  }
  function onPointerUp() {
    dragging = false;
  }

  slotEl.addEventListener('pointerdown', onPointerDown);
  slotEl.addEventListener('pointermove', onPointerMove);
  slotEl.addEventListener('pointerleave', onPointerUp);
  window.addEventListener('pointerup', onPointerUp);

  function destroyFBO(gl) {
    if (!fbo) return;
    gl.deleteTexture(fbo.texture);
    gl.deleteFramebuffer(fbo.framebuffer);
    fbo = null;
  }

  function createFBO(gl, w, h) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    return { texture, framebuffer, width: w, height: h };
  }

  return {
    id: 'mandelbox',
    slotEl,
    active: false,

    createResources(gl) {
      raymarchProgram = createProgram(gl, vertSrc, mandelboxFragSrc);
      blitProgram = createProgram(gl, vertSrc, blitFragSrc);
      triBuffer = createFullscreenTriangle(gl);

      raymarchUniforms = {
        time: gl.getUniformLocation(raymarchProgram, 'time'),
        resolution: gl.getUniformLocation(raymarchProgram, 'resolution'),
        cDir: gl.getUniformLocation(raymarchProgram, 'cDir'),
        p0hi: gl.getUniformLocation(raymarchProgram, 'uP0_hi'),
        p0lo: gl.getUniformLocation(raymarchProgram, 'uP0_lo'),
        camOffset: gl.getUniformLocation(raymarchProgram, 'uCamOffset'),
      };
      blitUniforms = {
        tex: gl.getUniformLocation(blitProgram, 'uTex'),
        res: gl.getUniformLocation(blitProgram, 'uRes'),
        origin: gl.getUniformLocation(blitProgram, 'uOrigin'),
        fade: gl.getUniformLocation(blitProgram, 'uFade'),
      };

      fbo = null;
      fboSizeW = 0;
      fboSizeH = 0;
    },

    destroyResources(gl) {
      destroyFBO(gl);
      gl.deleteProgram(raymarchProgram);
      gl.deleteProgram(blitProgram);
      gl.deleteBuffer(triBuffer);
      slotEl.removeEventListener('pointerdown', onPointerDown);
      slotEl.removeEventListener('pointermove', onPointerMove);
      slotEl.removeEventListener('pointerleave', onPointerUp);
      window.removeEventListener('pointerup', onPointerUp);
    },

    render(gl, ctx) {
      const dt = ctx.reducedMotion ? 0 : ctx.dt;
      updateCycle(dt);

      const orbitYaw = ORBIT_AMPLITUDE * Math.sin(orbitPhase) + dragYaw;
      const viewDir = currentViewDir(target.viewDir, orbitYaw, dragPitch);
      // P(カメラ位置) = p0 - viewDir*dist なので、camOffset(=P-p0)は直接これで求まる
      const camOffset = vscale(viewDir, -OVERVIEW_DIST);

      const p0Split = splitVec3(target.p0);

      const scale = ctx.isLowPower ? LOW_POWER_RENDER_SCALE : RENDER_SCALE;
      const fboW = Math.max(2, Math.round(ctx.width * scale));
      const fboH = Math.max(2, Math.round(ctx.height * scale));
      if (!fbo || fboSizeW !== fboW || fboSizeH !== fboH) {
        destroyFBO(gl);
        fbo = createFBO(gl, fboW, fboH);
        fboSizeW = fboW;
        fboSizeH = fboH;
      }

      // --- pass 1: レイマーチを縮小オフスクリーンFBOへ ---
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);
      gl.viewport(0, 0, fbo.width, fbo.height);
      gl.useProgram(raymarchProgram);
      bindFullscreenTriangle(gl, triBuffer, raymarchProgram, 'p');
      gl.uniform1f(raymarchUniforms.time, ctx.time);
      gl.uniform2f(raymarchUniforms.resolution, fbo.width, fbo.height);
      gl.uniform3fv(raymarchUniforms.cDir, viewDir);
      gl.uniform3fv(raymarchUniforms.p0hi, p0Split.hi);
      gl.uniform3fv(raymarchUniforms.p0lo, p0Split.lo);
      gl.uniform3fv(raymarchUniforms.camOffset, camOffset);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // --- pass 2: 共有canvasのこのブロックのviewportへアップスケールして貼る ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(ctx.originX, ctx.originY, ctx.width, ctx.height);
      gl.viewport(ctx.originX, ctx.originY, ctx.width, ctx.height);
      gl.useProgram(blitProgram);
      bindFullscreenTriangle(gl, triBuffer, blitProgram, 'p');
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
      gl.uniform1i(blitUniforms.tex, 0);
      gl.uniform2f(blitUniforms.res, ctx.width, ctx.height);
      gl.uniform2f(blitUniforms.origin, ctx.originX, ctx.originY);
      gl.uniform1f(blitUniforms.fade, fadeAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
