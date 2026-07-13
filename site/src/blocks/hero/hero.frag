#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform vec2 uOrigin;    // このブロックのviewport原点（canvas絶対px）
uniform float uTime;
uniform vec2 uMouse;     // 0..1
uniform float uWarp;

// --- hash / value noise / fBM ---
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0., a=.5;
  for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.02; a*=.5; }
  return v;
}

// iq palette
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a+b*cos(6.28318*(c*t+d)); }
vec3 palette(float t){
  return pal(t, vec3(.15,.45,.55),vec3(.55,.5,.5),vec3(1.,1.,1.),vec3(0.,.12,.22)); // teal/cyan deep
}

void main(){
  vec2 fragCoord = gl_FragCoord.xy - uOrigin;
  vec2 uv = (fragCoord - .5*uRes)/uRes.y;
  float t = uTime;

  // mouse influence
  vec2 m = (uMouse - .5) * 2.0;
  uv += m * 0.15;

  float warpAmt = uWarp;
  // domain warping (iq style): q -> r -> final  (time係数強め = speed感マシマシ)
  vec2 q = vec2(fbm(uv + vec2(0.0,0.0) + t*0.25),
                fbm(uv + vec2(5.2,1.3) - t*0.25));
  vec2 r = vec2(fbm(uv + warpAmt*q + vec2(1.7,9.2) + t*0.4 + m*0.5),
                fbm(uv + warpAmt*q + vec2(8.3,2.8) - t*0.33 + m*0.4));
  float f = fbm(uv + warpAmt*r + 0.3*sin(t*0.2+r.yx*3.0));

  vec3 col = palette(f + t*0.05 + length(r)*0.3);
  col = mix(col, palette(dot(r,r)), clamp(dot(q,q),0.,1.));
  col *= 0.6 + 0.6*f;             // contrast
  col += 0.08*length(r);          // subtle glow

  // vignette
  vec2 vg = fragCoord/uRes;
  col *= 0.5 + 0.5*pow(16.*vg.x*vg.y*(1.-vg.x)*(1.-vg.y), 0.25);

  o = vec4(col,1.);
}
