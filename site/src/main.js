import './style.css';
import { SharedGLRenderer } from './gl/renderer.js';
import { createHeroBlock } from './blocks/hero/index.js';
import { createPlaceholderBlock } from './blocks/placeholder/index.js';
import { createRainWindowBlock } from './blocks/rain-window/index.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

if (renderer.supported) {
  renderer.register(createHeroBlock(document.getElementById('hero')));
  renderer.register(createRainWindowBlock(document.getElementById('works-a')));
  renderer.register(createPlaceholderBlock('works-b', document.getElementById('works-b'), 0.33));

  renderer.start();
} else {
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
