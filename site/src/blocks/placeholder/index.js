import fragSrc from './placeholder.frag?raw';
import vertSrc from '../shared/quad.vert?raw';
import { createProgram, createFullscreenTriangle, bindFullscreenTriangle } from '../../gl/glUtils.js';

// Works本体を差し込む前に、基盤（複数ブロックの登録/可視判定/scissor描画/
// スクロール遷移）が破綻しないかを確認するための軽量プレースホルダブロック。
export function createPlaceholderBlock(id, slotEl, hue = 0) {
  let program, buffer, uniforms;

  return {
    id,
    slotEl,
    active: false,

    createResources(gl) {
      program = createProgram(gl, vertSrc, fragSrc);
      buffer = createFullscreenTriangle(gl);
      uniforms = {
        res: gl.getUniformLocation(program, 'uRes'),
        origin: gl.getUniformLocation(program, 'uOrigin'),
        time: gl.getUniformLocation(program, 'uTime'),
        hue: gl.getUniformLocation(program, 'uHue'),
      };
    },

    destroyResources(gl) {
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
    },

    render(gl, ctx) {
      gl.useProgram(program);
      bindFullscreenTriangle(gl, buffer, program, 'p');
      gl.uniform2f(uniforms.res, ctx.width, ctx.height);
      gl.uniform2f(uniforms.origin, ctx.originX, ctx.originY);
      gl.uniform1f(uniforms.time, ctx.time);
      gl.uniform1f(uniforms.hue, hue);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
