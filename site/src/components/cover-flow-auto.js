// メインページのworks-cブロック用、非インタラクティブな自動再生カバーフロー。
// 個々の作品へのリンクは持たず、見た目のみ(ブロック全体が/works/への
// リンクになっている前提)。詳細は cover-flow.css 冒頭のコメント参照。
import { applyCoverFlowLayout } from './cover-flow-core.js';

const AUTOPLAY_INTERVAL_MS = 2000;

export function initCoverFlowAuto(root) {
  const items = Array.from(root.querySelectorAll('.cf-track .cf-item'));
  if (items.length === 0) return;

  let current = 0;
  let timer = null;

  function advance() {
    current = (current + 1) % items.length;
    applyCoverFlowLayout(items, current);
  }

  function start() {
    if (timer) return;
    timer = setInterval(advance, AUTOPLAY_INTERVAL_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // ホバー中は止めて、じっくり見られるようにする
  root.addEventListener('pointerenter', stop);
  root.addEventListener('pointerleave', start);

  applyCoverFlowLayout(items, current);
  start();
}
