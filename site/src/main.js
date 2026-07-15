import './style.css';
import { SharedGLRenderer } from './gl/renderer.js';
import { createHeroBlock } from './blocks/hero/index.js';
import { createMandelboxBlock } from './blocks/mandelbox/index.js';
import { createRainWindowBlock } from './blocks/rain-window/index.js';
import { initCoverFlowAuto } from './components/cover-flow-auto.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

initCoverFlowAuto(document.getElementById('works-c'));

if (renderer.supported) {
  renderer.register(createHeroBlock(document.getElementById('hero')));
  renderer.register(createMandelboxBlock(document.getElementById('works-a')));
  renderer.register(createRainWindowBlock(document.getElementById('works-b')));

  renderer.start();
} else {
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
