#version 300 es
precision highp float;
out vec4 outColor;

// prototype-vaporwave のシーンパス。専用の縮小FBOへ描くため、
// gl_FragCoordはFBOローカル座標のままでよい(uOrigin補正はポストパス側で行う)。
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uLook;    // (yaw, pitch)
uniform vec3 uCamPos;
// パレット(JS側で補間された現在値。DUSK/MIDNIGHT/DAWNはindex.js参照)
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunTop;
uniform vec3 uSunBottom;
uniform vec3 uGridCol;

const float FOV = 1.25;
const float FAR = 70.0;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// 中央に平原、左右に fbm の山岳。
// カメラから遠いほど高さを絞り、遠方でレイが山に捕まらず空へ抜けるようにする
float terrain(vec2 xz) {
  float valley = smoothstep(2.0, 7.0, abs(xz.x));
  float m = fbm(xz * vec2(0.18, 0.12));
  float falloff = 1.0 - smoothstep(10.0, 40.0, distance(xz, uCamPos.xz));
  return valley * m * m * 5.5 * falloff;
}

float march(vec3 ro, vec3 rd, out vec3 hitPos) {
  float t = 0.05;
  for (int i = 0; i < 200; i++) {
    vec3 p = ro + rd * t;
    float dy = p.y - terrain(p.xz);
    if (dy < 0.002 * t) {
      // 2分法で少し詰めてグリッド線のにじみを抑える
      float t0 = t - max(0.02, dy * 0.5);
      for (int j = 0; j < 4; j++) {
        float tm = 0.5 * (t0 + t);
        vec3 pm = ro + rd * tm;
        if (pm.y - terrain(pm.xz) < 0.0) t = tm; else t0 = tm;
      }
      hitPos = ro + rd * t;
      return t;
    }
    t += max(0.02, dy * 0.45);
    if (t > FAR) break;
  }
  hitPos = ro + rd * FAR;
  return -1.0;
}

vec3 skyColor(vec3 rd) {
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.45, rd.y));

  // 太陽(ストライプ入りのディスク)。視線方向は -Z が正面
  vec3 sd = normalize(vec3(0.0, 0.115, -1.0));
  float ang = acos(clamp(dot(rd, sd), -1.0, 1.0));
  float sunR = 0.21;
  float disc = smoothstep(sunR, sunR - 0.012, ang);
  float rel = clamp((rd.y - (sd.y - sunR)) / (sunR * 2.0), 0.0, 1.0); // 0=下端, 1=上端
  // 下端ほどストライプの欠けを強く
  float band = 0.5 + 0.5 * sin(rd.y * 90.0 + uTime * 0.7);
  float gaps = smoothstep(0.75, 0.05, rel);
  float stripes = mix(1.0, smoothstep(0.42, 0.52, band), gaps);
  vec3 sunCol = mix(uSunBottom, uSunTop, rel);
  float pulse = 0.92 + 0.08 * sin(uTime * 0.9); // ゆっくりした鼓動
  col += sunCol * disc * stripes * 1.3 * pulse;
  col += sunCol * exp(-ang * 3.2) * 0.4 * (1.0 - disc * 0.7) * pulse; // ハロー(ディスク内は弱く)

  // 星(地平線近くと太陽周辺は出さない)
  vec2 su = vec2(atan(rd.x, -rd.z) * 22.0, rd.y * 42.0);
  vec2 cell = floor(su);
  float star = step(0.994, hash21(cell));
  vec2 fp = fract(su) - 0.5;
  float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + hash21(cell + 7.7) * 40.0);
  float starMask = smoothstep(0.18, 0.0, length(fp)) * star * twinkle;
  starMask *= smoothstep(0.12, 0.3, rd.y) * smoothstep(sunR * 2.2, sunR * 3.4, ang);
  col += vec3(0.9, 0.9, 1.0) * starMask;

  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 ndc = uv * 2.0 - 1.0;
  ndc.x *= uRes.x / uRes.y;

  // ピッチ → ヨーの順で回転
  vec3 rd = normalize(vec3(ndc.x, ndc.y, -FOV));
  float cp = cos(uLook.y), sp = sin(uLook.y);
  rd.yz = mat2(cp, -sp, sp, cp) * rd.yz;
  float cy = cos(uLook.x), sy = sin(uLook.x);
  rd.xz = mat2(cy, -sy, sy, cy) * rd.xz;

  vec3 ro = uCamPos;

  vec3 col;
  vec3 p;
  // 山の最大高さより十分上を向いているレイはマーチせず空へ
  float t = (rd.y > 0.35) ? -1.0 : march(ro, rd, p);

  // 地平線のフォグ色。正面(太陽方向)ほど太陽の色がにじむ
  float sunAmount = pow(max(dot(normalize(rd.xz), vec2(0.0, -1.0)), 0.0), 8.0);
  vec3 fogCol = uSkyHorizon * 0.75 + uSunBottom * sunAmount * 0.6;

  if (t > 0.0) {
    float h = terrain(p.xz);

    // グリッド線: 整数座標に近いほど明るい。距離とともに太らせてエイリアスを抑える
    vec2 gr = abs(fract(p.xz) - 0.5);
    float lw = 0.46 - min(t * 0.004, 0.1);
    float line = smoothstep(lw, 0.5, max(gr.x, gr.y));
    line = pow(line, 1.6);

    vec3 ground = mix(vec3(0.012, 0.006, 0.03), uSkyTop * 0.35, smoothstep(0.0, 2.8, h));
    float fade = exp(-t * 0.05);
    float pulse = 0.9 + 0.25 * sin(uTime * 0.9 + p.z * 0.05);
    col = ground;
    col += uGridCol * line * 1.35 * fade * pulse;
    col = mix(col, fogCol, 1.0 - exp(-t * 0.028));
  } else {
    col = skyColor(rd);
    // 地平線ぎわのにじみ
    col += fogCol * exp(-abs(rd.y) * 18.0) * 0.5;
  }

  // トーンマッピング(ネオンの飽和を柔らかく)
  col = 1.0 - exp(-col * 1.7);
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}
