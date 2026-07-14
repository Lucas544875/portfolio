#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uRes;    // このブロックのviewportサイズ(canvas絶対px)
uniform vec2 uOrigin; // このブロックのviewport原点(canvas絶対px)
uniform float uFade;  // 次の地点への切り替え時の暗転(0=通常, 1=真っ暗)

// mandelbox.fragが縮小したオフスクリーンFBOへ描いた結果を、最終的な
// このブロックのviewport解像度へバイリニアで引き伸ばして貼るだけのパス。
void main(){
  vec2 uv = (gl_FragCoord.xy - uOrigin) / uRes;
  fragColor = texture(uTex, uv) * (1.0 - uFade);
}
