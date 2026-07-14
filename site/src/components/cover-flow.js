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
  let dragStartTarget = null;
  stage.addEventListener('pointerdown', (e) => {
    dragStartX = e.clientX;
    dragStartTarget = e.target;
  });
  stage.addEventListener('pointerup', (e) => {
    if (dragStartX === null) return;
    const delta = e.clientX - dragStartX;
    const startedOnItem = dragStartTarget && dragStartTarget.closest('.cf-item');
    dragStartX = null;
    dragStartTarget = null;

    if (delta > DRAG_THRESHOLD) { goTo(current - 1); return; }
    if (delta < -DRAG_THRESHOLD) { goTo(current + 1); return; }
    if (startedOnItem) return; // アイテム自体のクリックは各itemのclickハンドラに任せる

    // 束になった左右の余白(アイテムの隙間)をクリックした場合もその側へ1つ送る
    const rect = stage.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    goTo(clickX < rect.width / 2 ? current - 1 : current + 1);
  });
  stage.addEventListener('pointerleave', () => {
    dragStartX = null;
    dragStartTarget = null;
  });

  // マウスホイール/トラックパッドのスクロールでの送り操作
  let wheelLocked = false;
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (wheelLocked || Math.abs(delta) < 4) return;
    wheelLocked = true;
    goTo(current + (delta > 0 ? 1 : -1));
    setTimeout(() => { wheelLocked = false; }, 400);
  }, { passive: false });

  layout();
}
