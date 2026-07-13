import '../style.css';
import { SharedGLRenderer } from '../gl/renderer.js';
import { createRainWindowBlock } from '../blocks/rain-window/index.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

if (renderer.supported) {
  renderer.register(createRainWindowBlock(document.getElementById('rain-window-stage')));
  renderer.start();
} else {
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
