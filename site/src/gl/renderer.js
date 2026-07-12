import { VisibilityManager } from './visibility.js';

// SharedGLRenderer
// ----------------
// ページ全体でWebGL2コンテキストを1つだけ持つ共有レンダラ。
// 各「ブロック」(Hero、Worksの各作品など)はDOM上のslot要素を1つ持ち、
// 毎フレーム slot.getBoundingClientRect() から viewport/scissor を計算して
// 同じcanvas上の対応する矩形にだけ描画する。
//
// これにより、作品をいくつ並べてもWebGLコンテキストは1つのまま
// （ブラウザの同時コンテキスト上限8〜16に抵触しない）。
//
// block インターフェース:
//   id: string
//   slotEl: HTMLElement        描画先の矩形を決めるDOM要素
//   active: boolean            VisibilityManagerが書き換える（画面内かどうか）
//   createResources(gl)        プログラム/バッファ等を作成。コンテキストrestore時にも呼ばれる
//   destroyResources(gl)?      任意。unregister時に呼ばれる
//   render(gl, ctx)            ctx: { time, dt, width, height, originX, originY, dpr, reducedMotion, isLowPower }
//                              originX/originYはcanvas全体に対するviewportの原点(px)。
//                              gl_FragCoordは常にcanvas全体の絶対座標なので、
//                              シェーダー側でこれを引いてブロックローカル座標にすること。
//   onPointerMove(u, v, evt)?  任意。u,vはslot内正規化座標（左下原点）
export class SharedGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });

    this.supported = !!this.gl;
    if (!this.supported) {
      document.body.classList.add('no-webgl');
      return;
    }

    this._blocks = new Map(); // id -> block
    this.visibility = new VisibilityManager();

    this._time = 0;
    this._last = 0;
    this._running = false;
    this._rafId = null;

    this.dpr = 1;
    this.reducedMotion = false;
    this.isLowPower = false;

    this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._updateMotionPreference();
    this._motionQuery.addEventListener('change', this._updateMotionPreference);

    this._resize();
    window.addEventListener('resize', this._resize);
    window.addEventListener('pointermove', this._onPointerMove);

    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
  }

  _updateMotionPreference = () => {
    this.reducedMotion = this._motionQuery.matches;
  };

  _resize = () => {
    // Hero確定仕様と同じDPR方針: min(dpr, 幅<700 ? 1.2 : 2)
    this.dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.2 : 2);
    this.isLowPower = window.innerWidth < 700 || (navigator.hardwareConcurrency != null && navigator.hardwareConcurrency <= 4);
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * this.dpr));
  };

  _onPointerMove = (e) => {
    for (const block of this._blocks.values()) {
      if (!block.active || !block.onPointerMove) continue;
      const rect = block.slotEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const u = (e.clientX - rect.left) / rect.width;
      const v = 1 - (e.clientY - rect.top) / rect.height;
      block.onPointerMove(u, v, e);
    }
  };

  _onContextLost = (e) => {
    e.preventDefault();
    this._stop();
  };

  _onContextRestored = () => {
    for (const block of this._blocks.values()) {
      block.createResources(this.gl);
    }
    this._start();
  };

  register(block) {
    block.createResources(this.gl);
    this._blocks.set(block.id, block);
    this.visibility.observe(block);
  }

  unregister(id) {
    const block = this._blocks.get(id);
    if (!block) return;
    this.visibility.unobserve(block);
    block.destroyResources?.(this.gl);
    this._blocks.delete(id);
  }

  start() {
    this._start();
  }

  _start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._rafId = requestAnimationFrame(this._tick);
  }

  _stop() {
    this._running = false;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _tick = (now) => {
    if (!this._running) return;
    const gl = this.gl;
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    if (!this.reducedMotion) this._time += dt;

    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.01, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);

    const viewportH = window.innerHeight;
    for (const block of this._blocks.values()) {
      if (!block.active) continue;
      const rect = block.slotEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= viewportH) continue; // 実際には画面外(rootMarginの先行分など)

      const dpr = this.dpr;
      const x = Math.round(rect.left * dpr);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      const y = this.canvas.height - Math.round(rect.top * dpr) - h; // GLは左下原点

      gl.viewport(x, y, w, h);
      gl.scissor(x, y, w, h);
      block.render(gl, {
        time: this._time,
        dt,
        width: w,
        height: h,
        // gl_FragCoordはcanvas全体の絶対ピクセル座標（ビューポート原点ではない）なので、
        // シェーダー側でuvを組み立てる際はこのoriginを引く必要がある
        originX: x,
        originY: y,
        dpr,
        reducedMotion: this.reducedMotion,
        isLowPower: this.isLowPower,
      });
    }

    this._rafId = requestAnimationFrame(this._tick);
  };
}
