// Works一覧サブページ(/works/)専用のインタラクティブなカバーフロー
// (CSS 3D transformのみ、WebGLは使わない)。詳細は cover-flow.css 冒頭のコメント参照。
// メインページのworks-bブロックには非インタラクティブな自動再生版
// (cover-flow-auto.js)を使う。
import { applyCoverFlowLayout, MAX_VISIBLE_OFFSET } from './cover-flow-core.js';

const DRAG_THRESHOLD = 40; // これ以上ドラッグしたら隣へ送る(px)

export function initCoverFlow(root) {
  const items = Array.from(root.querySelectorAll('.cf-track .cf-item'));
  const titleEl = root.querySelector('.cf-caption-title');
  const descEl = root.querySelector('.cf-caption-desc');
  const linkEl = root.querySelector('.cf-caption-link');
  const prevBtn = root.querySelector('.cf-prev');
  const nextBtn = root.querySelector('.cf-next');
  const stage = root.querySelector('.cf-stage');

  let current = 0;

  function layout() {
    applyCoverFlowLayout(items, current);
    items.forEach((item, i) => {
      const visible = Math.abs(i - current) <= MAX_VISIBLE_OFFSET;
      item.style.pointerEvents = visible ? 'auto' : 'none';
    });

    const focused = items[current];
    titleEl.textContent = focused.dataset.title;
    descEl.textContent = focused.dataset.desc;
    linkEl.href = focused.dataset.href;
  }

  function goTo(index) {
    current = Math.min(Math.max(index, 0), items.length - 1);
    layout();
  }

  items.forEach((item, i) => {
    item.addEventListener('click', () => goTo(i));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') goTo(i);
    });
  });

  prevBtn.addEventListener('click', () => goTo(current - 1));
  nextBtn.addEventListener('click', () => goTo(current + 1));

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') goTo(current - 1);
    if (e.key === 'ArrowRight') goTo(current + 1);
  });

  // ドラッグ/スワイプでの送り操作(マウス・タッチ共通)
  let dragStartX = null;
  stage.addEventListener('pointerdown', (e) => {
    dragStartX = e.clientX;
  });
  stage.addEventListener('pointerup', (e) => {
    if (dragStartX === null) return;
    const delta = e.clientX - dragStartX;
    dragStartX = null;
    if (delta > DRAG_THRESHOLD) goTo(current - 1);
    else if (delta < -DRAG_THRESHOLD) goTo(current + 1);
  });
  stage.addEventListener('pointerleave', () => {
    dragStartX = null;
  });

  layout();
}
