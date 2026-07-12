import './style.css';
import { SharedGLRenderer } from './gl/renderer.js';
import { createHeroBlock } from './blocks/hero/index.js';
import { createPlaceholderBlock } from './blocks/placeholder/index.js';

const canvas = document.getElementById('gl-canvas');
const renderer = new SharedGLRenderer(canvas);

if (renderer.supported) {
  renderer.register(createHeroBlock(document.getElementById('hero')));
  renderer.register(createPlaceholderBlock('works-a', document.getElementById('works-a'), 0.0));
  renderer.register(createPlaceholderBlock('works-b', document.getElementById('works-b'), 0.33));

  renderer.start();
} else {
  console.warn('WebGL2 not supported: falling back to static background (see .no-webgl in style.css).');
}
