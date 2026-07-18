import '../style.css';
import { SharedGLRenderer } from '../gl/renderer.js';
import { createVaporwaveBlock } from '../blocks/vaporwave/index.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

if (renderer.supported) {
  const block = createVaporwaveBlock(document.getElementById('vaporwave-stage'));
  renderer.register(block);
  renderer.start();

  // パレット切替: ブロックのcyclePalette()を呼び、名前を中央にフラッシュ表示
  const paletteName = document.getElementById('paletteName');
  let paletteNameTimer = 0;
  document.getElementById('cyclePalette').addEventListener('click', () => {
    paletteName.textContent = block.cyclePalette();
    paletteName.classList.add('show');
    clearTimeout(paletteNameTimer);
    paletteNameTimer = setTimeout(() => paletteName.classList.remove('show'), 1400);
  });
} else {
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
