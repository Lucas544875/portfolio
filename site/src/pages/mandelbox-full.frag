precision highp float;
uniform float time;
uniform vec2  resolution;
uniform vec3  cDir;
uniform vec3  uP0_hi; // 潜る先の1点 p0 の上位(float32丸め)成分
uniform vec3  uP0_lo; // p0 の残差(下位)成分。uP0_hiと合わせてdf64のp0を成す
uniform vec3  uCamOffset; // カメラ位置 - p0

const float PI = 3.14159265;
const float E = 2.71828182;
const float INFINITY = 1.e20;
const float FOV = 30.0 * 0.5 * PI / 180.0;//field of view
const vec3 LightDir = normalize(vec3(2.0,1.0,1.0));
const int Iteration = 280;
const int MAX_REFRECT = 2;
const float STEP_SAFETY = 0.93; // オーバーシュート対策の安全率(prototype-mandelboxと同じ)

// 表面判定のイプシロンは固定値ではなく、レイの進行距離(ray.len)×1ピクセルが
// 投影される角度サイズ、で決める。遠くのレイほど1ピクセルが指すワールド座標上
// の幅が広がるため、固定の小さいイプシロンのままだと遠景で細部を解像しきれず
// 表面が点在するノイズになる。EPS_MINはDIST_MIN(raymarch.js側、5e-5)より
// 十分小さい絶対下限で、通常はt*pixelAngle*EPS_PIXEL_MULTの方が支配的になる。
const float EPS_PIXEL_MULT = 1.5;
const float EPS_MIN = 5e-8;
const float EPS_MAX = 0.1;

float pixelAngle(){
  return FOV * 2.0 / min(resolution.x, resolution.y);
}

float hitEps(float len){
  return clamp(len * pixelAngle() * EPS_PIXEL_MULT, EPS_MIN, EPS_MAX);
}

// ----------------------------------------------------------------------------
// df64: float32の(hi, lo)ペアで倍精度相当を再現する「double-float」演算
// (prototype-mandelboxのmain.jsから移植)。WebGL1にはハードウェアのdouble型が
// 無いため、座標だけをこの表現で持ち回ることで、素のfloat32では相対オフセット
// ~1e-6程度で崩れる精度を~1e-12〜1e-14付近まで伸ばす。
// ----------------------------------------------------------------------------
vec2 twoSum(float a, float b) {
  float s = a + b;
  float v = s - a;
  float e = (a - (s - v)) + (b - v);
  return vec2(s, e);
}
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  float e = b - (s - a);
  return vec2(s, e);
}
void split32(float a, out float hi, out float lo) {
  float c = 4097.0 * a; // 2^12+1: float32(24bit仮数部)向けのVeltkamp分割定数
  hi = c - (c - a);
  lo = a - hi;
}
vec2 twoProd(float a, float b) {
  float p = a * b;
  float aHi, aLo, bHi, bLo;
  split32(a, aHi, aLo);
  split32(b, bHi, bLo);
  float e = ((aHi * bHi - p) + aHi * bLo + aLo * bHi) + aLo * bLo;
  return vec2(p, e);
}
vec2 dfAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  s.y += a.y + b.y;
  return quickTwoSum(s.x, s.y);
}
vec2 dfAddF(vec2 a, float b) {
  vec2 s = twoSum(a.x, b);
  s.y += a.y;
  return quickTwoSum(s.x, s.y);
}
vec2 dfSub(vec2 a, vec2 b) { return dfAdd(a, vec2(-b.x, -b.y)); }
vec2 dfMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  p.y += a.x * b.y + a.y * b.x;
  return quickTwoSum(p.x, p.y);
}
vec2 dfMulF(vec2 a, float b) {
  vec2 p = twoProd(a.x, b);
  p.y += a.y * b;
  return quickTwoSum(p.x, p.y);
}
vec2 dfDiv(vec2 a, vec2 b) {
  float q1 = a.x / b.x;
  vec2 r = dfSub(a, dfMulF(b, q1));
  float q2 = r.x / b.x;
  r = dfSub(r, dfMulF(b, q2));
  float q3 = r.x / b.x;
  vec2 q = quickTwoSum(q1, q2);
  return dfAddF(q, q3);
}
vec2 dfFromFloat(float a) { return vec2(a, 0.0); }
float dfToFloat(vec2 a) { return a.x + a.y; }

// vec3を成分ごとにdf64で保持する「倍精度座標」。
struct DF3 { vec3 hi; vec3 lo; };

vec3 df3ToVec3(DF3 a) { return a.hi + a.lo; }

DF3 df3AddVec3(DF3 a, vec3 b) {
  vec2 rx = dfAddF(vec2(a.hi.x, a.lo.x), b.x);
  vec2 ry = dfAddF(vec2(a.hi.y, a.lo.y), b.y);
  vec2 rz = dfAddF(vec2(a.hi.z, a.lo.z), b.z);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3Add(DF3 a, DF3 b) {
  vec2 rx = dfAdd(vec2(a.hi.x, a.lo.x), vec2(b.hi.x, b.lo.x));
  vec2 ry = dfAdd(vec2(a.hi.y, a.lo.y), vec2(b.hi.y, b.lo.y));
  vec2 rz = dfAdd(vec2(a.hi.z, a.lo.z), vec2(b.hi.z, b.lo.z));
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3Sub(DF3 a, DF3 b) { return df3Add(a, DF3(-b.hi, -b.lo)); }
DF3 df3MulF(DF3 a, float s) {
  vec2 rx = dfMulF(vec2(a.hi.x, a.lo.x), s);
  vec2 ry = dfMulF(vec2(a.hi.y, a.lo.y), s);
  vec2 rz = dfMulF(vec2(a.hi.z, a.lo.z), s);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
DF3 df3MulDF(DF3 a, vec2 s) {
  vec2 rx = dfMul(vec2(a.hi.x, a.lo.x), s);
  vec2 ry = dfMul(vec2(a.hi.y, a.lo.y), s);
  vec2 rz = dfMul(vec2(a.hi.z, a.lo.z), s);
  return DF3(vec3(rx.x, ry.x, rz.x), vec3(rx.y, ry.y, rz.y));
}
vec2 df3Dot(DF3 a, DF3 b) {
  vec2 x = dfMul(vec2(a.hi.x, a.lo.x), vec2(b.hi.x, b.lo.x));
  vec2 y = dfMul(vec2(a.hi.y, a.lo.y), vec2(b.hi.y, b.lo.y));
  vec2 z = dfMul(vec2(a.hi.z, a.lo.z), vec2(b.hi.z, b.lo.z));
  return dfAdd(dfAdd(x, y), z);
}
// box-foldのclamp: 判定はhi成分だけで行う(fold境界ぎりぎりの際どいケースでだけ
// 生じうる誤差は無視できるほど稀)。範囲内ならlo成分もそのまま保持し、範囲外に
// 丸めた成分だけlo=0にする。
DF3 df3ClampFold(DF3 a, float lo, float hi) {
  vec3 rHi = clamp(a.hi, lo, hi);
  vec3 inRange = step(vec3(lo), a.hi) * step(a.hi, vec3(hi));
  return DF3(rHi, a.lo * inRange);
}
DF3 df3FromVec3(vec3 v) { return DF3(v, vec3(0.0)); }

struct rayobj{
  vec3  rPos;     //レイの場所
  vec3  direction;//方向
  float distance; //距離関数の返り値
  float len;      //出発点からの距離
  float iterate;  //レイマーチの反復回数
  int   objectID;  //オブジェクトID
  int   material; //マテリアルID
  vec3  normal;   //法線ベクトル
  vec3  fragColor;//色
};

struct effectConfig{
  bool reflect;    //反射
  bool ambient;    //アンビエント
  bool specular;   //ハイライト(鏡面反射)
  bool diffuse;    //拡散光
  bool incandescence;//白熱光
  bool shadow;     //ソフトシャドウ
  bool globallight;//大域照明
  bool grow;       //グロー
  bool fog;        //霧
  bool gamma;      //ガンマ補正
};

const effectConfig effect = effectConfig(
  false, //反射
  true,  //アンビエント
  false, //ハイライト(鏡面反射)
  true, //拡散光
  true,  //白熱光
  false,  //ソフトシャドウ
  false, //大域照明
  true, //グロー
  false,  //霧
  true   //ガンマ補正
);

struct dfstruct{
  float dist;
  int   id;
};


//quaternion
vec4 times(vec4 q1,vec4 q2){
  return vec4 (
    q1[0]*q2[0] - q1[1]*q2[1] - q1[2]*q2[2] - q1[3]*q2[3],
    q1[0]*q2[1] + q1[1]*q2[0] + q1[2]*q2[3] - q1[3]*q2[2],
    q1[0]*q2[2] - q1[1]*q2[3] + q1[2]*q2[0] + q1[3]*q2[1],
    q1[0]*q2[3] + q1[1]*q2[2] - q1[2]*q2[1] + q1[3]*q2[0]
  );
}

vec4 inverse(vec4 q){
  return vec4(q[0],-q[1],-q[2],-q[3]);
}

vec4 rotation(float theta,vec3 v){
  float c = cos(theta/2.0);
  float s = sin(theta/2.0);
  return normalize(vec4(c,v.x*s,v.y*s,v.z*s));
}

vec4 turn(vec4 v,vec4 rot){
  return times(times(rot,v),inverse(rot));
}


vec3 hsv(float h, float s, float v) {
  // h: 0.0 - 2PI, s: 0.0 - 1.0, v: 0.0 - 1.0, 円柱モデル
  return ((clamp(abs(fract(mod(h,2.0*PI)+vec3(0,2,1)/3.)*6.-3.)-1.,0.,1.)-1.)*s+1.)*v;
}

float manhattan (vec3 p,vec3 q){
  return abs(p.x-q.x)+abs(p.y-q.y)+abs(p.z-q.z);
}

float chebyshev (vec3 p,vec3 q){
  return max(max(abs(p.x-q.x),abs(p.y-q.y)),abs(p.z-q.z));
}

vec3 Hadamard(vec3 v,vec3 w){ //アダマール積
  return vec3(
    v.x * w.x,
    v.y * w.y,
    v.z * w.z
  );
}


//primitives
float sphere(vec3 z,vec3 center,float radius){
  return length(z-center)-radius;
}

float sphere1(vec3 z){
  vec3 p = vec3(mod(z.x,3.0),mod(z.y,3.0),z.z);
  return sphere(p, vec3(1.5,1.5,0.0), 0.8);
}

float plane(vec3 z,vec3 normal,float offset){
	return dot(z,normalize(normal)) - offset;
}

float floor1(vec3 z){//plane
  return plane(z,vec3(0.0,0.0,1.0), -0.8);
}

float plane1(vec3 z){//plane
  return plane(z,vec3(0.0,0.0,1.0),1.0);
}

// マンデルボックスのDEパラメータ。素のfloat32版(sphereFold/boxFold/mandelBox)と
// df64版(mandelBoxDF)の両方から参照し、数値が二重管理でずれないようにする。
const float MB_SCALE = -2.18;
const float MB_MINR2 = 0.60;
const float MB_FIXEDR2 = 2.65;
const float MB_FOLD = 1.14;
const int MB_ITER = 16;

void sphereFold(inout vec3 z, inout float dz) {
	float r2 = dot(z,z);
	if (r2<MB_MINR2) {
		// linear inner scaling
		float temp = MB_FIXEDR2/(MB_MINR2);
		z *= temp;
		dz*= temp;
	} else if (r2<MB_FIXEDR2) {
		// this is the actual sphere inversion
		float temp =MB_FIXEDR2/r2;
		z *= temp;
		dz*= temp;
	}
}

void boxFold(inout vec3 z, inout float dz) {
	z = clamp(z, -MB_FOLD, MB_FOLD) * 2.0 - z;
}

float mandelBox(vec3 z){
	vec3 offset = z;
	float dr = 1.0;
	for (int n = 0; n < MB_ITER; n++) {
		boxFold(z,dr);       // Reflect
		sphereFold(z,dr);    // Sphere Inversion
    z=MB_SCALE*z + offset;  // Scale & Translate
    dr = dr*abs(MB_SCALE)+1.0;
	}
	float r = length(z);
	return r/abs(dr);
}

// mandelBox()のdf64版(prototype-mandelboxのmapDEと同じ式)。座標zだけをdf64で
// 保持し、dr・MB_SCALE等はfloat32のままでよい(精度の危険因子は座標そのもの
// であってdrの成長ではない)。
float mandelBoxDF(DF3 p){
  DF3 z = p;
  float dr = 1.0;
  for (int n = 0; n < MB_ITER; n++) {
    z = df3Sub(df3MulF(df3ClampFold(z, -MB_FOLD, MB_FOLD), 2.0), z);
    vec2 r2df = df3Dot(z, z);
    float r2 = dfToFloat(r2df);
    if (r2 < MB_MINR2) {
      float t = MB_FIXEDR2 / MB_MINR2;
      z = df3MulF(z, t);
      dr *= t;
    } else if (r2 < MB_FIXEDR2) {
      vec2 t = dfDiv(dfFromFloat(MB_FIXEDR2), r2df);
      z = df3MulDF(z, t);
      dr *= dfToFloat(t);
    }
    z = df3Add(df3MulF(z, MB_SCALE), p);
    dr = dr * abs(MB_SCALE) + 1.0;
  }
  vec3 zf = df3ToVec3(z);
  return length(zf) / abs(dr);
}

float sdCross(vec3 p, float c) {
	p = abs(p);
	float dxy = max(p.x, p.y);
	float dyz = max(p.y, p.z);
	float dxz = max(p.x, p.z);
	return min(dxy, min(dyz, dxz)) - c;
}

float sdBox(vec3 p, vec3 b) {
	p = abs(p) - b;
	return length(max(p, 0.0)) + min(max(p.x, max(p.y, p.z)), 0.0);
}

float _mengerSponge(vec3 p, float scale, float width) {
	float d = sdBox(p, vec3(1.0));
	float s = 1.0;
	for (int i = 0; i < 7; i++) {
		vec3 a = mod(p * s, 2.0) - 1.0;
		s *= scale;
		vec3 r = 1.0 - scale * abs(a);
		float c = sdCross(r, width) / s;
		d = max(d, c);
	}
	return d;
}

float mengerSponge(vec3 p) {
	float scale = 3.0;
	float width = 1.0;
	return _mengerSponge(p,scale,width);
}

float pseudoKleinian(vec3 p) {
	vec3 csize = vec3(0.90756, 0.92436, 0.90756);
	float size = 1.0;
	vec3 c = vec3(0.0);
	float defactor = 1.0;
	vec3 offset = vec3(0.0);
	vec3 ap = p + 1.0;
	for (int i = 0; i < 10; i++) {
		ap = p;
		p = 2.0 * clamp(p, -csize, csize) - p;
		float r2 = dot(p, p);
		float k = max(size / r2, 1.0);
		p *= k;
		defactor *= k;
		p += c;
	}
	float r = abs(0.5 * abs(p.z - offset.z) / defactor);
	return r;
}

dfstruct dfmax(dfstruct df1, dfstruct df2){ //共通部分
  if (df1.dist < df2.dist){
    return df2;
  }else{
    return df1;
  }
}

dfstruct dfmin(dfstruct df1, dfstruct df2){//和集合
  if (df1.dist < df2.dist){
    return df1;
  }else{
    return df2;
  }
}

dfstruct distanceFunction(vec3 z){
  dfstruct mandelBox = dfstruct(mandelBox(z),0);
  return mandelBox;
}

dfstruct distanceFunction(DF3 z){
  dfstruct mandelBox = dfstruct(mandelBoxDF(z),0);
  return mandelBox;
}

//マテリアルの設定
const int SAIHATE = 0;
const int CYAN = 1;
const int WHITE = 2;
const int GRID = 3;
const int MANDEL = 4;
const int BROWN = 5;
const int NORMAL = 6;
const int LESSSTEP = 97;
const int DEBUG = 98;
const int ERROR = 99;

//マテリアルの設定
int materialOf(int objectID){
  if (objectID == 0){
    return BROWN;
  }else if (objectID == 98){
    return SAIHATE;
  }else if (objectID == 99){
    return LESSSTEP;
  }else{
    return ERROR;
  }
}

vec3 normal(vec3 p, float d){
  return normalize(vec3(
    distanceFunction(p + vec3(  d, 0.0, 0.0)).dist - distanceFunction(p + vec3( -d, 0.0, 0.0)).dist,
    distanceFunction(p + vec3(0.0,   d, 0.0)).dist - distanceFunction(p + vec3(0.0,  -d, 0.0)).dist,
    distanceFunction(p + vec3(0.0, 0.0,   d)).dist - distanceFunction(p + vec3(0.0, 0.0,  -d)).dist
  ));
}

vec3 normal(vec3 p){
  return normal(p, 0.0001);
}

// 法線の差分ステップ幅もヒットエプシロンと同じ倍率精度基準で決める必要が
// あるため、rPos(hi/lo)まわりの微小オフセットをdf64の補正加算で足し込む。
vec3 normal(DF3 p, float d){
  return normalize(vec3(
    distanceFunction(df3AddVec3(p, vec3(  d, 0.0, 0.0))).dist - distanceFunction(df3AddVec3(p, vec3( -d, 0.0, 0.0))).dist,
    distanceFunction(df3AddVec3(p, vec3(0.0,   d, 0.0))).dist - distanceFunction(df3AddVec3(p, vec3(0.0,  -d, 0.0))).dist,
    distanceFunction(df3AddVec3(p, vec3(0.0, 0.0,   d))).dist - distanceFunction(df3AddVec3(p, vec3(0.0, 0.0,  -d))).dist
  ));
}


vec3 gridCol(vec3 rPos){
  return mix(vec3(0.3),vec3(step(fract(2.0*rPos.x),0.05),step(fract(2.0*rPos.y),0.05),step(fract(2.0*rPos.z),0.05)),0.5);
}

vec3 debugCol(vec3 rPos){
  return fract(rPos);
}

vec3 kadoCol(vec3 rPos){
  return normal(rPos)*0.66 + vec3(0.33);
}

vec3 normalCol(vec3 rPos){
  return abs(normal(rPos));
}

vec3 color(rayobj ray){
  if (ray.material == GRID){
    return gridCol(ray.rPos);
  }else if (ray.material == WHITE){
    return vec3(1.0,1.0,1.0);
  }else if (ray.material == DEBUG){
    return debugCol(ray.rPos);
  }else if (ray.material == MANDEL){
    return kadoCol(ray.rPos);
  }else if (ray.material == LESSSTEP){
    return vec3(0.0);
  }else if (ray.material == BROWN){
    return vec3(0.454, 0.301, 0.211);
  }else if (ray.material == NORMAL){
    return normalCol(ray.rPos);
  }else if (ray.material == SAIHATE){
    return vec3(0.0);
    //return vec3(160.0,216.0,239.0)/256.0;
  }else{
    return vec3(1.0,0.0,0.0);
  }
}

float refrectance(int material){
  if (material == CYAN){
    return 0.1;
  }else if (material == WHITE){
    return 0.6;
  }else if (material == DEBUG){
    return 0.3;
  }else if (material == GRID){
    return 0.3;
  }else if (material == MANDEL){
    return 0.3;
  }else if (material == NORMAL){
    return 0.4;
  }else{
    return 0.0;
  }
}


// roはレイ原点(df64)。毎ステップ ro + direction*ray.len をdf64の補正加算で
// 組み直すことで位置を求める(素のfloat32でray.rPosへ距離を毎回加算していく
// と、O(1)の座標が持てるulp幅より小さい前進が丸めで消えてしまい、深く潜った
// ところで精度が頭打ちになる——prototype-mandelboxのmain.js参照)。ray.lenは
// スカラーなのでこの丸め問題を受けず、通常のfloat32のまま安全に累積できる。
void raymarch(inout rayobj ray, DF3 ro){
  for(int i = 0; i < Iteration; i++){
    DF3 p = df3AddVec3(ro, ray.direction * ray.len);
    dfstruct df = distanceFunction(p);
    ray.distance = df.dist;
    if(ray.distance < hitEps(ray.len)){
      ray.rPos = df3ToVec3(p);
      ray.normal = normal(p, hitEps(ray.len) * 0.5);
      ray.objectID = df.id;
      ray.iterate = float(i)/float(Iteration);
      return;
    }
    ray.len += ray.distance * STEP_SAFETY;
    if(ray.len > 100.0){
      ray.rPos = df3ToVec3(p);
      ray.objectID = 98;
      ray.iterate = float(i)/float(Iteration);
      return;
    }
  }
  ray.objectID = 99;
  ray.iterate = 1.0;
}

//ライティング
void ambientFunc(inout rayobj ray){//アンビエント
  vec3 baseColor = color(ray);
  vec3 ambColor = vec3(1.0);
  float ambIntensity =  0.7;
  ray.fragColor += ambIntensity * Hadamard(baseColor,ambColor);
  ray.fragColor = clamp(ray.fragColor,0.0,1.0);
}

void specularFunc(inout rayobj ray){//鏡面反射
  float t = -dot(ray.direction,ray.normal);
  vec3 reflection=ray.direction+2.0*t*ray.normal;
  float x = dot(reflection,LightDir);
  float specular=1.0/(50.0*(1.001-clamp(x,0.0,1.0)));
  ray.fragColor = clamp(ray.fragColor+specular,0.0,1.0);
}

void diffuseFunc(inout rayobj ray){//拡散光
  vec3 color = color(ray);
  vec3 lightColor = vec3(1.0);//(0.741, 0.741, 0.717);
  float diffIntensity = 1.1;
  float diffuse = max(0.0,dot(LightDir, ray.normal));
  ray.fragColor += diffIntensity * diffuse * Hadamard(color,lightColor);
  ray.fragColor = clamp(ray.fragColor,0.0,1.0);
}

void _incandescenceFunc(inout rayobj ray, vec3 incandescenceColor, vec3 incCenter, float incRadius, float incIntensity){ 
  vec3 color = pow(max((1.0 - (length(incCenter - ray.rPos)/incRadius)),0.0),2.0) * incIntensity * incandescenceColor;
  ray.fragColor += color;
  ray.fragColor = clamp(ray.fragColor,0.0,1.0);
}

void incandescenceFunc(inout rayobj ray){ //白熱光
  vec3 incandescenceColor = vec3(1.000, 0.501, 0.200);
  vec3 incCenter0 = vec3( 2.0,0.0,0.0);
  vec3 incCenter1 = vec3(-2.0,0.0,0.0);
  vec3 incCenter2 = vec3(0.0, 2.0,0.0);
  vec3 incCenter3 = vec3(0.0,-2.0,0.0);
  vec3 incCenter4 = vec3(0.0,0.0, 2.0);
  vec3 incCenter5 = vec3(0.0,0.0,-2.0);
  float incRadius = 2.0;
  float incIntensity = 1.5;
  _incandescenceFunc(ray, incandescenceColor, incCenter0, incRadius, incIntensity);
  _incandescenceFunc(ray, incandescenceColor, incCenter1, incRadius, incIntensity);
  _incandescenceFunc(ray, incandescenceColor, incCenter2, incRadius, incIntensity);
  _incandescenceFunc(ray, incandescenceColor, incCenter3, incRadius, incIntensity);
  _incandescenceFunc(ray, incandescenceColor, incCenter4, incRadius, incIntensity);
  _incandescenceFunc(ray, incandescenceColor, incCenter5, incRadius, incIntensity);
}

const float shadowCoef = 0.4;
void shadowFunc(inout rayobj ray){
  if (dot(ray.normal, LightDir)<0.0){return;}
  float h = 0.0;
  float c = 0.0;
  float r = 1.0;
  for(float t = 0.0; t < 50.0; t++){
    h = distanceFunction(ray.rPos + ray.normal*0.001 + LightDir * c).dist;
    if(h < 0.001){
      ray.fragColor *= shadowCoef;
      return;
    }
    r = min(r, h * 200.0 / c);
    c += h;
  }
  ray.fragColor *= mix(shadowCoef, 1.0, r);
  return;
}

void globallightFunc(inout rayobj ray){//大域照明
  vec3 origin = ray.rPos+ray.normal*0.001;
  rayobj ray2 = rayobj(origin,ray.normal,0.0,0.0,0.0,99,0,vec3(0.0),vec3(0.0));
  raymarch(ray2, df3FromVec3(origin));
  float near = 0.10;
  ray.fragColor *= clamp(min(near,ray2.len)/near,0.0,1.0);
}

void skysphereFunc(inout rayobj ray){//天球
  if (ray.objectID == 98){
    ray.fragColor += color(ray);
  }
}

void lessStepFunc(inout rayobj ray){
  if (ray.objectID == 99){
    ray.fragColor += color(ray);
  }
}

const float growIntencity = 1.0;
void growFunc(inout rayobj ray){//グロー
  float coef = smoothstep(0.0,0.95,ray.iterate);
  const vec3 growCol = vec3(1.000, 0.501, 0.200);
  vec3 grow = growIntencity * coef * growCol;
  ray.fragColor += grow;
}

const float minRadius = 60.0;
const float maxRadius = 80.0;
void fogFunc(inout rayobj ray){//霧
  rayobj ray2 = ray;
  ray2.material = SAIHATE;
  vec3 fogColor = color(ray2);
  float fogcoef = clamp((ray.len-minRadius)/(maxRadius-minRadius),0.0,1.0);
  ray.fragColor = mix(ray.fragColor, fogColor, fogcoef);
}

void gammaFunc(inout rayobj ray){//ガンマ補正
  ray.fragColor=pow(ray.fragColor,vec3(2.2));
}

void reflectFunc(inout rayobj ray){//反射
  rayobj rays[MAX_REFRECT+1];
  rays[0] = ray;
  int escape = MAX_REFRECT;
  for (int i = 0;i<MAX_REFRECT;i++){
    float dot = -dot(rays[i].direction,rays[i].normal);
    vec3 direction=rays[i].direction+2.0*dot*rays[i].normal;//refrect
    vec3 bounceOrigin = rays[i].rPos+rays[i].normal*0.001;
    rays[i+1] = rayobj(bounceOrigin,direction,0.0,0.0,0.0,99,0,vec3(0.0),vec3(0.0));
    raymarch(rays[i+1], df3FromVec3(bounceOrigin));
    rays[i+1].material = materialOf(rays[i+1].objectID);

    if(abs(rays[i].distance) >= hitEps(rays[i].len)){//脱出
      escape = i;
      break;
    }
  }

  for (int i = MAX_REFRECT;i >= 1;i--){
    if (i>escape){continue;}

    if(abs(ray.distance) < hitEps(ray.len)){//物体表面にいる場合
      if(effect.ambient){
        ambientFunc(rays[i]);
      }
      if (effect.specular){
        specularFunc(rays[i]);
      }
      if (effect.diffuse){
        diffuseFunc(rays[i]);
      }
      if (effect.incandescence){
        incandescenceFunc(rays[i]);
      }
      if (effect.shadow){
        shadowFunc(rays[i]);
      }
      if (effect.globallight){
        globallightFunc(rays[i]);
      }
    }else{//描写範囲外 or ステップ数不足
      skysphereFunc(rays[i]);
    }
    //全体
    if (effect.grow){
      growFunc(rays[i]);
    }
    if (effect.fog){
      fogFunc(rays[i]);
    }

    float refrectance = refrectance(rays[i-1].material);
    rays[i-1].fragColor += refrectance*rays[i].fragColor;
  }
  ray.fragColor += rays[0].fragColor;
}

void main(void){
  // fragment position
  vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);
  //fix:真上真下が見えない
  vec3 xAxes = normalize(cross(cDir,vec3(0.0,0.0,1.0)));
  vec3 yAxes = normalize(-cross(cDir,xAxes));
  vec4 rot = normalize(times(rotation(-p.x*FOV,yAxes),rotation(p.y*FOV,xAxes)));
  vec3 direction = normalize(turn(vec4(0,cDir),rot).yzw);

  //レイの定義と移動
  DF3 p0 = DF3(uP0_hi, uP0_lo);
  DF3 ro = df3AddVec3(p0, uCamOffset);
  rayobj ray = rayobj(vec3(0.0),direction,0.0,0.0,0.0,99,0,vec3(0.0),vec3(0.0));
  raymarch(ray, ro);
  ray.material = materialOf(ray.objectID);

  //エフェクト
  if(abs(ray.distance) < hitEps(ray.len)){//物体表面にいる場合
    if (effect.reflect){
      reflectFunc(ray);
    }
    if(effect.ambient){
      ambientFunc(ray);
    }
    if (effect.specular){
      specularFunc(ray);
    }
    if (effect.diffuse){
      diffuseFunc(ray);
    }
    if (effect.incandescence){
      incandescenceFunc(ray);
    }
    if (effect.shadow){
      shadowFunc(ray);
    }
    if (effect.globallight){
      globallightFunc(ray);
    }
  }else{//描写範囲外 or ステップ数不足
    skysphereFunc(ray);
    lessStepFunc(ray);
  }
  //全体
  if (effect.grow){
    growFunc(ray);
  }
  if (effect.fog){
    fogFunc(ray);
  }
  if (effect.gamma){
    gammaFunc(ray);
  }
  gl_FragColor = vec4(ray.fragColor,1.0);
}
