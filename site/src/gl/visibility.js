// ブロックのslotElをIntersectionObserverで監視し、画面内に入っているかを
// block.active に反映するだけの薄いラッパー。実際のGL描画スキップはrenderer側が行う。
export class VisibilityManager {
  constructor({ rootMargin = '15% 0px' } = {}) {
    this._observer = new IntersectionObserver(this._onIntersect, { root: null, rootMargin, threshold: 0 });
    this._blocks = new Map(); // element -> block
  }

  _onIntersect = (entries) => {
    for (const entry of entries) {
      const block = this._blocks.get(entry.target);
      if (block) block.active = entry.isIntersecting;
    }
  };

  observe(block) {
    block.active = false;
    this._blocks.set(block.slotEl, block);
    this._observer.observe(block.slotEl);
  }

  unobserve(block) {
    this._observer.unobserve(block.slotEl);
    this._blocks.delete(block.slotEl);
  }

  destroy() {
    this._observer.disconnect();
    this._blocks.clear();
  }
}
