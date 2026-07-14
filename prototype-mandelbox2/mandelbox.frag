let fragmentShader =`
precision mediump float;
uniform float time;
uniform vec2  resolution;
uniform vec3  cDir;
uniform vec3  cPos;

const float PI = 3.14159265;
const float E = 2.71828182;
const float INFINITY = 1.e20;
const float FOV = 30.0 * 0.5 * PI / 180.0;//field of view
const vec3 LightDir = normalize(vec3(2.0,1.0,1.0));
const int Iteration =128;
const int MAX_REFRECT = 2;

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

void sphereFold(inout vec3 z, inout float dz) {
  float minRadius2=0.60;//定数
  float fixedRadius2=2.65;//定数
	float r2 = dot(z,z);
	if (r2<minRadius2) { 
		// linear inner scaling
		float temp = fixedRadius2/(minRadius2);
		z *= temp;
		dz*= temp;
	} else if (r2<fixedRadius2) { 
		// this is the actual sphere inversion
		float temp =fixedRadius2/r2;
		z *= temp;
		dz*= temp;
	}
}

void boxFold(inout vec3 z, inout float dz) {
  float foldingLimit=1.14;//定数0.6
	z = clamp(z, -foldingLimit, foldingLimit) * 2.0 - z;
}

float mandelBox(vec3 z){
  float Scale = -2.18 ;//定数1.9
	vec3 offset = z;
	float dr = 1.0;
	for (int n = 0; n < 16; n++) {
		boxFold(z,dr);       // Reflect
		sphereFold(z,dr);    // Sphere Inversion
    z=Scale*z + offset;  // Scale & Translate
    dr = dr*abs(Scale)+1.0;
	}
	float r = length(z);
	return r/abs(dr);
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

vec3 normal(vec3 p){
  float d = 0.0001;
  return normalize(vec3(
    distanceFunction(p + vec3(  d, 0.0, 0.0)).dist - distanceFunction(p + vec3( -d, 0.0, 0.0)).dist,
    distanceFunction(p + vec3(0.0,   d, 0.0)).dist - distanceFunction(p + vec3(0.0,  -d, 0.0)).dist,
    distanceFunction(p + vec3(0.0, 0.0,   d)).dist - distanceFunction(p + vec3(0.0, 0.0,  -d)).dist
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


void raymarch(inout rayobj ray){
  for(int i = 0; i < Iteration; i++){
    dfstruct df = distanceFunction(ray.rPos);
    ray.distance = df.dist;
    if(ray.distance < 0.001){
      ray.normal = normal(ray.rPos);
      ray.objectID = df.id;
      ray.iterate = float(i)/float(Iteration);
      return;
    }
    ray.len += ray.distance;
    if(ray.len > 100.0){
      ray.objectID = 98;
      ray.iterate = float(i)/float(Iteration);
      return;
    }
    ray.rPos += ray.distance * ray.direction;
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
  raymarch(ray2);
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
    rays[i+1] = rayobj(rays[i].rPos+rays[i].normal*0.001,direction,0.0,0.0,0.0,99,0,vec3(0.0),vec3(0.0));
    raymarch(rays[i+1]);
    rays[i+1].material = materialOf(rays[i+1].objectID);

    if(abs(rays[i].distance) >= 0.001){//脱出
      escape = i;
      break;
    }
  }

  for (int i = MAX_REFRECT;i >= 1;i--){
    if (i>escape){continue;}

    if(abs(ray.distance) < 0.001){//物体表面にいる場合
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
  rayobj ray = rayobj(cPos,direction,0.0,0.0,0.0,99,0,vec3(0.0),vec3(0.0));
  raymarch(ray);
  ray.material = materialOf(ray.objectID);

  //エフェクト
  if(abs(ray.distance) < 0.001){//物体表面にいる場合
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
`