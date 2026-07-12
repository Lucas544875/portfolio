#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform float uTime;
uniform float uHue;

// Heroと同系統のiqパレットを色相だけずらして使う、軽量なプレースホルダ用シェーダー。
// fbmは使わず、基盤（複数ブロックの可視判定/scissor切り替え）の検証が目的なので計算は最小限にする。
vec3 palette(float t){
  vec3 a = vec3(.15,.45,.55), b = vec3(.55,.5,.5), c = vec3(1.,1.,1.), d = vec3(0.,.12,.22) + uHue;
  return a + b*cos(6.28318*(c*t+d));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - uOrigin - .5*uRes)/uRes.y;
  float t = uTime * 0.3;
  float f = sin(uv.x*3.0 + t) * cos(uv.y*3.0 - t*0.7);
  vec3 col = palette(f*0.5 + 0.5 + t*0.05);
  col *= 0.55 + 0.45*(1.0 - length(uv));
  o = vec4(col, 1.);
}
