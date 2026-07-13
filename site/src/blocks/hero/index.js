import fragSrc from './hero.frag?raw';
import vertSrc from '../shared/quad.vert?raw';
import { createProgram, createFullscreenTriangle, bindFullscreenTriangle } from '../../gl/glUtils.js';

// hero_final.html の確定シェーダーをブロック化したもの。
// 固定パラメータ: warp = 1.5, speed = 0.85（元ファイルと同じ）
const WARP = 1.5;
const SPEED = 0.85;

export function createHeroBlock(slotEl) {
  let program, buffer, uniforms;
  let mouse = [0.5, 0.5];
  let mouseTarget = [0.5, 0.5];

  return {
    id: 'hero',
    slotEl,
    active: false,

    createResources(gl) {
      program = createProgram(gl, vertSrc, fragSrc);
      buffer = createFullscreenTriangle(gl);
      uniforms = {
        res: gl.getUniformLocation(program, 'uRes'),
        origin: gl.getUniformLocation(program, 'uOrigin'),
        time: gl.getUniformLocation(program, 'uTime'),
        mouse: gl.getUniformLocation(program, 'uMouse'),
        warp: gl.getUniformLocation(program, 'uWarp'),
      };
    },

    destroyResources(gl) {
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
    },

    render(gl, ctx) {
      // マウス追従イージング（reduced-motionでも一度は目標位置に寄せたいのでdt自体は使わない）
      mouse[0] += (mouseTarget[0] - mouse[0]) * 0.05;
      mouse[1] += (mouseTarget[1] - mouse[1]) * 0.05;

      gl.useProgram(program);
      bindFullscreenTriangle(gl, buffer, program, 'p');
      gl.uniform2f(uniforms.res, ctx.width, ctx.height);
      gl.uniform2f(uniforms.origin, ctx.originX, ctx.originY);
      gl.uniform1f(uniforms.time, ctx.time * SPEED);
      gl.uniform2f(uniforms.mouse, mouse[0], mouse[1]);
      gl.uniform1f(uniforms.warp, WARP);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    onPointerMove(u, v) {
      mouseTarget = [u, v];
    },
  };
}
