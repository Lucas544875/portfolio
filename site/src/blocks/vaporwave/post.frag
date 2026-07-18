#version 300 es
precision highp float;
out vec4 outColor;

// prototype-vaporwave のVHSポストパス。共有canvasのブロックviewportへ描くため、
// gl_FragCoord(canvas絶対座標)からuOriginを引いてブロックローカル座標にする。
uniform sampler2D uScene;
uniform vec2 uRes;     // ブロックviewportのサイズ(px)
uniform vec2 uOrigin;  // canvas全体に対するviewport原点(px)
uniform float uTime;

float hash11(float p) {
  p = fract(p * 443.8975);
  p += p * (p + 19.19);
  return fract(p * p);
}
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 fc = gl_FragCoord.xy - uOrigin;
  vec2 uv = fc / uRes;

  // バレル歪み(ブラウン管の膨らみ)
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.031 * dot(c, c);
  uv = c * 0.5 + 0.5;

  // 行単位のジッタ。ときどきバーストして大きくズレる
  float lineId = floor(fc.y / 3.0);
  float burst = step(0.965, hash11(floor(uTime * 2.7))); // たまに起こる大ノイズ
  float jitterAmp = 0.0012 + burst * 0.011;
  uv.x += (hash21(vec2(lineId, floor(uTime * 17.0))) - 0.5) * jitterAmp;

  // ゆっくり流れるトラッキングバー
  float bar = smoothstep(0.06, 0.0, abs(fract(uv.y * 0.7 + uTime * 0.05) - 0.5) - 0.42);

  // 色収差(中心から離れるほど強い)
  vec2 ca = c * (0.0038 + burst * 0.004);
  vec3 col;
  col.r = texture(uScene, uv + ca).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - ca).b;

  // 画面外は黒
  vec2 outside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  col *= outside.x * outside.y;

  // 走査線 + グレイン + トラッキングバーのうっすらした持ち上げ
  float scan = 1.0 - 0.14 * (0.5 + 0.5 * sin(fc.y * 2.1));
  float grain = (hash21(uv * uRes + fract(uTime) * 337.0) - 0.5) * 0.077;
  col = col * scan + grain + bar * 0.025;

  // ビネット
  float vig = smoothstep(1.55, 0.45, length(c));
  col *= vig;

  outColor = vec4(col, 1.0);
}
