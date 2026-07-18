import './style.css';
import { SharedGLRenderer } from './gl/renderer.js';
import { createHeroBlock } from './blocks/hero/index.js';
import { createMandelboxBlock } from './blocks/mandelbox/index.js';
import { createRainWindowBlock } from './blocks/rain-window/index.js';
import { createVaporwaveBlock } from './blocks/vaporwave/index.js';
import { initCoverFlowAuto } from './components/cover-flow-auto.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

const loadingScreen = document.getElementById('loadingScreen');
const loadingText = document.getElementById('loadingText');
const loadingFill = document.getElementById('loadingFill');

// mandelbox.js(サブページ)と同じ理由: 各ブロックのcreateResources内の
// gl.compileShader/linkProgramは同期処理でメインスレッドをブロックするため、
// 進捗イベントを取れない。ステージごとにnextPaint()を挟んで、更新した
// テキスト/バーが次のブロッキング処理の前に必ず1度は画面に反映されるようにする。
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setLoadingStage(text, progress) {
  if (loadingText) loadingText.textContent = text;
  if (loadingFill) loadingFill.style.width = `${progress}%`;
}

function hideLoadingScreen() {
  if (!loadingScreen) return;
  loadingScreen.classList.add('loading-done');
  setTimeout(() => loadingScreen.remove(), 600);
}

initCoverFlowAuto(document.getElementById('works-c'));

if (renderer.supported) {
  (async () => {
    setLoadingStage('WebGLを初期化中…', 10);
    await nextPaint();

    setLoadingStage('シェーダーをコンパイル中…', 35);
    await nextPaint();
    renderer.register(createHeroBlock(document.getElementById('hero')));

    setLoadingStage('シェーダーをコンパイル中…', 55);
    await nextPaint();
    renderer.register(createMandelboxBlock(document.getElementById('works-a')));

    setLoadingStage('シェーダーをコンパイル中…', 75);
    await nextPaint();
    // トップページでは他の全画面ブロックと縦に並ぶため、タッチドラッグは
    // 受け付けずモバイルのスワイプをページスクロールに譲る。
    renderer.register(createRainWindowBlock(document.getElementById('works-b'), { allowTouchDrag: false }));

    setLoadingStage('シェーダーをコンパイル中…', 90);
    await nextPaint();
    renderer.register(createVaporwaveBlock(document.getElementById('works-d')));

    setLoadingStage('初回描画中…', 96);
    await nextPaint();

    renderer.start();

    await nextPaint();
    setLoadingStage('完了', 100);
    hideLoadingScreen();
  })();
} else {
  hideLoadingScreen();
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
