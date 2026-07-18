import sceneFragSrc from './scene.frag?raw';
import postFragSrc from './post.frag?raw';
import vertSrc from '../shared/quad.vert?raw';
import { createProgram, createFullscreenTriangle, bindFullscreenTriangle } from '../../gl/glUtils.js';

// prototype-vaporwave(レイマーチ・グリッドの夕暮れ)をworks-dブロックとして
// 移植したもの。参考実装との主な違い:
//   - ホイールでの速度調整は持たない(速度は一定)
//   - パレット切替はボタンDOMを持たず、cyclePalette()メソッドとして公開する
//     (サブページ側がボタンを用意して呼ぶ。トップページでは呼ばれずDUSK固定)
//   - ポインタ移動のパララックスのみ残す。共有レンダラのonPointerMoveは
//     slot外のポインタも渡してくるため、u/vをクランプして使う
//   - シーンは縮小した専用オフスクリーンFBOに描き、VHSポストパスで共有
//     canvasの実サイズへ引き伸ばす(mandelbox/rain-windowと同じ手法)
//   - 自前canvas/rAF/リサイズ処理は持たず、ctx経由で動く

const SPEED = 2.2; // 前進速度
const CAM_HEIGHT = 1.05;
const LOOK_YAW_RANGE = 0.42; // ポインタ位置 → ヨー(rad)
const LOOK_PITCH_RANGE = 0.2;
const LOOK_RATE = 2.7; // 視点イージングの毎秒の収束レート
const PALETTE_RATE = 2.1; // パレット補間の毎秒の収束レート

// パレット: [skyTop, skyHorizon, sunTop, sunBottom, grid]
export const PALETTES = [
  {
    name: 'DUSK',
    colors: [
      [0.078, 0.016, 0.157],
      [0.95, 0.30, 0.42],
      [1.0, 0.83, 0.10],
      [1.0, 0.16, 0.46],
      [1.0, 0.18, 0.63],
    ],
  },
  {
    name: 'MIDNIGHT',
    colors: [
      [0.008, 0.008, 0.10],
      [0.08, 0.42, 0.85],
      [0.72, 0.40, 1.0],
      [0.086, 0.88, 1.0],
      [0.086, 0.95, 1.0],
    ],
  },
  {
    name: 'DAWN',
    colors: [
      [0.0, 0.106, 0.18],
      [0.34, 0.75, 0.60],
      [1.0, 0.98, 0.59],
      [1.0, 0.44, 0.81],
      [0.02, 1.0, 0.63],
    ],
  },
];

// isLowPower時はFBO解像度をさらに落として負荷を抑える(他ブロックと同じ方針)
const RENDER_SCALE = 0.66;
const LOW_POWER_RENDER_SCALE = 0.45;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function createVaporwaveBlock(slotEl) {
  let sceneProgram, postProgram, triBuffer;
  let sceneUniforms, postUniforms;
  let fbo = null; // { texture, framebuffer, width, height }
  let fboSizeW = 0;
  let fboSizeH = 0;

  let dist = 0; // 前進距離の積分(camZ = -dist)
  const look = [0, 0];
  const targetLook = [0, 0];

  let paletteIndex = 0;
  const palette = PALETTES[0].colors.map((c) => c.slice()); // 現在値(補間される)

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
    id: 'vaporwave',
    slotEl,
    active: false,

    createResources(gl) {
      sceneProgram = createProgram(gl, vertSrc, sceneFragSrc);
      postProgram = createProgram(gl, vertSrc, postFragSrc);
      triBuffer = createFullscreenTriangle(gl);

      sceneUniforms = {
        res: gl.getUniformLocation(sceneProgram, 'uRes'),
        time: gl.getUniformLocation(sceneProgram, 'uTime'),
        look: gl.getUniformLocation(sceneProgram, 'uLook'),
        camPos: gl.getUniformLocation(sceneProgram, 'uCamPos'),
        skyTop: gl.getUniformLocation(sceneProgram, 'uSkyTop'),
        skyHorizon: gl.getUniformLocation(sceneProgram, 'uSkyHorizon'),
        sunTop: gl.getUniformLocation(sceneProgram, 'uSunTop'),
        sunBottom: gl.getUniformLocation(sceneProgram, 'uSunBottom'),
        gridCol: gl.getUniformLocation(sceneProgram, 'uGridCol'),
      };
      postUniforms = {
        scene: gl.getUniformLocation(postProgram, 'uScene'),
        res: gl.getUniformLocation(postProgram, 'uRes'),
        origin: gl.getUniformLocation(postProgram, 'uOrigin'),
        time: gl.getUniformLocation(postProgram, 'uTime'),
      };

      fbo = null;
      fboSizeW = 0;
      fboSizeH = 0;
    },

    destroyResources(gl) {
      destroyFBO(gl);
      gl.deleteProgram(sceneProgram);
      gl.deleteProgram(postProgram);
      gl.deleteBuffer(triBuffer);
    },

    render(gl, ctx) {
      const dt = ctx.reducedMotion ? 0 : ctx.dt;
      dist += SPEED * dt;

      // 視点のパララックスはインタラクションへの応答なのでreducedMotionでも
      // イージングは進める(heroブロックのマウス追従と同じ扱い)
      const lookK = 1 - Math.exp(-LOOK_RATE * ctx.dt);
      look[0] += (targetLook[0] - look[0]) * lookK;
      look[1] += (targetLook[1] - look[1]) * lookK;

      // パレットの補間(切替もインタラクションへの応答なのでctx.dtで進める)
      const target = PALETTES[paletteIndex].colors;
      const palK = 1 - Math.exp(-PALETTE_RATE * ctx.dt);
      for (let i = 0; i < target.length; i++) {
        for (let k = 0; k < 3; k++) {
          palette[i][k] += (target[i][k] - palette[i][k]) * palK;
        }
      }

      const bob = 0.05 * Math.sin(ctx.time * 0.5);
      const camPos = [0, CAM_HEIGHT + bob, -dist];

      const scale = ctx.isLowPower ? LOW_POWER_RENDER_SCALE : RENDER_SCALE;
      const fboW = Math.max(2, Math.round(ctx.width * scale));
      const fboH = Math.max(2, Math.round(ctx.height * scale));
      if (!fbo || fboSizeW !== fboW || fboSizeH !== fboH) {
        destroyFBO(gl);
        fbo = createFBO(gl, fboW, fboH);
        fboSizeW = fboW;
        fboSizeH = fboH;
      }

      // --- pass 1: シーンを縮小オフスクリーンFBOへ ---
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);
      gl.viewport(0, 0, fbo.width, fbo.height);
      gl.useProgram(sceneProgram);
      bindFullscreenTriangle(gl, triBuffer, sceneProgram, 'p');
      gl.uniform2f(sceneUniforms.res, fbo.width, fbo.height);
      gl.uniform1f(sceneUniforms.time, ctx.time);
      gl.uniform2f(sceneUniforms.look, look[0], look[1]);
      gl.uniform3fv(sceneUniforms.camPos, camPos);
      gl.uniform3fv(sceneUniforms.skyTop, palette[0]);
      gl.uniform3fv(sceneUniforms.skyHorizon, palette[1]);
      gl.uniform3fv(sceneUniforms.sunTop, palette[2]);
      gl.uniform3fv(sceneUniforms.sunBottom, palette[3]);
      gl.uniform3fv(sceneUniforms.gridCol, palette[4]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // --- pass 2: VHSポストで共有canvasのこのブロックのviewportへ ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(ctx.originX, ctx.originY, ctx.width, ctx.height);
      gl.viewport(ctx.originX, ctx.originY, ctx.width, ctx.height);
      gl.useProgram(postProgram);
      bindFullscreenTriangle(gl, triBuffer, postProgram, 'p');
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
      gl.uniform1i(postUniforms.scene, 0);
      gl.uniform2f(postUniforms.res, ctx.width, ctx.height);
      gl.uniform2f(postUniforms.origin, ctx.originX, ctx.originY);
      gl.uniform1f(postUniforms.time, ctx.time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    onPointerMove(u, v) {
      const nx = clamp01(u) - 0.5;
      const ny = 0.5 - clamp01(v); // 参考実装は上原点のY正規化なので変換する
      targetLook[0] = -nx * LOOK_YAW_RANGE;
      targetLook[1] = -ny * LOOK_PITCH_RANGE;
    },

    // 次のパレットへ切り替え、その名前を返す(サブページのボタンから呼ぶ)
    cyclePalette() {
      paletteIndex = (paletteIndex + 1) % PALETTES.length;
      return PALETTES[paletteIndex].name;
    },
  };
}
