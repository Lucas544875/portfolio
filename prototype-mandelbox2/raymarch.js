// global
let c, cw, ch, gl, eCheck;
let mouseflag=false;
let centorx;
let centory;
let startTime;
let tempTime =0;
let timenow = new Date().getTime();
let uniLocation = [];
let vAttLocation = [];
let attStride = [];
let run = true;
let cDir;
let cPos;
const maxpitch = Math.sin(5/12*Math.PI);
//key
//w=87,a=65,s=83,d=68,z=90,x=88
//u=85,h=72,j=74,k=75,n=78,m=77,o=79,p=80
let keyW = new LongPress(87);
let keyA = new LongPress(65);
let keyS = new LongPress(83);
let keyD = new LongPress(68);
let keyQ = new LongPress(81);
let keyE = new LongPress(69);
let recorder;

// onload
window.onload = function(){
  // エレメントを取得
  c = document.getElementById('canvas');
  eCheck = document.getElementById('check');

  // キャンバスサイズの設定
  ch=645;cw=860;
  c.height=ch;
  c.width=cw;

  //視点の設定
  cDir=Quatarnion.vec(-1,0,0);
  cPos=Quatarnion.vec(11,0,0);

  //録画の設定
  let rstart = document.getElementById('recStart');
  let rstop = document.getElementById('recStop');
  let stream = canvas.captureStream();
  recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9'});
  var anchor = document.getElementById('downloadlink');
	//録画終了時に動画ファイルのダウンロードリンクを生成
	recorder.ondataavailable = function(e) {
    console.log("data-available");
		var videoBlob = new Blob([e.data], { type: e.data.type });
		blobUrl = window.URL.createObjectURL(videoBlob);
		anchor.download = 'movie.webm';
		anchor.href = blobUrl;
		anchor.style.display = 'block';
	}

  //エクスポートの設定
  //let exportButton = document.getElementById("shaderExport");
  //function save(){
  //  let txt = "let fragmentShader =`"+ fragmentShader + '`'
  //  const blob = new Blob([txt], { type: 'text/plain' });
  //  const a = document.createElement('a');
  //  a.href =  URL.createObjectURL(blob);
  //  a.download = 'shader.txt';
  //  a.click();
  //}

  // イベントリスナー登録
  eCheck.addEventListener('change', checkChange, true);
  document.addEventListener("mousedown",mouseDown,true);
  document.addEventListener("mouseup",mouseUp,true);
  document.addEventListener("keydown",LongPress.keyDown,true);
  document.addEventListener("keyup",LongPress.keyUp,true);
  c.addEventListener('mousemove', mouseMove, true);
  rstart.addEventListener('click',() => recorder.start());
  rstop.addEventListener('click',() => recorder.stop());
  //exportButton.addEventListener('click',save)

  // WebGL コンテキストを取得
  gl = c.getContext('webgl');
  
  // シェーダのコンパイル
  let prg = create_program(create_shader('vs'), create_shader('fs'));

  //unifoem,atteibute変数の設定
  uniLocation[0] = gl.getUniformLocation(prg, 'time');
  uniLocation[1] = gl.getUniformLocation(prg, 'resolution');
  uniLocation[2] = gl.getUniformLocation(prg, 'cDir');
  uniLocation[3] = gl.getUniformLocation(prg, 'cPos');

  vAttLocation[0] = gl.getAttribLocation(prg, 'position');
  attStride[0] = 3;

  // 頂点データ
  let position = [
    -1.0,  1.0,  0.0,
     1.0,  1.0,  0.0,
    -1.0, -1.0,  0.0,
     1.0, -1.0,  0.0
  ];
  let index = [
      0, 2, 1,
      1, 2, 3
  ];

  //vbo
  let vPosition = create_vbo(position);
  
  //vboのバインド attribute属性の設定 増えてきたら関数化する
  gl.bindBuffer(gl.ARRAY_BUFFER, vPosition);
  gl.enableVertexAttribArray(vAttLocation[0]);
  gl.vertexAttribPointer(vAttLocation[0], attStride[0], gl.FLOAT, false, 0, 0);
  
  //iboの生成
  let vIndex = create_ibo(index);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vIndex);
  
  // その他の初期化
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  startTime = new Date().getTime();
  
  // レンダリング
  render();
};

function render(){
  if (run === false) {
    return;
  }
  let moment = (new Date().getTime() - timenow)/1000;
  timenow = new Date().getTime();
  //WASDによる移動操作
  if(keyW.pressed){
    cPos = cPos.add(cDir.scale(5*moment));
  }
  if(keyS.pressed){
    cPos = cPos.add(cDir.scale(-5*moment));
  }
  if(keyA.pressed){
    let xaxes=cDir.cross(Quatarnion.vec(0,0,1));
    cPos = cPos.add(xaxes.scale(-moment));
  }
  if(keyD.pressed){
    let xaxes=cDir.cross(Quatarnion.vec(0,0,1));
    cPos = cPos.add(xaxes.scale(moment));
  }
  if(keyQ.pressed){
    let xaxes=cDir.cross(Quatarnion.vec(0,0,1));
    let yaxes=xaxes.cross(cDir);
    cPos = cPos.add(yaxes.scale(moment));
  }
  if(keyE.pressed){
    let xaxes=cDir.cross(Quatarnion.vec(0,0,1));
    let yaxes=xaxes.cross(cDir);
    cPos = cPos.add(yaxes.scale(-moment));
  }

  window.requestAnimationFrame(render, c);
  // 時間管理
  
  // カラーバッファをクリア
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // uniform 関連
  gl.uniform1f(uniLocation[0], (timenow - startTime + tempTime) * 0.001);
  gl.uniform2fv(uniLocation[1], [cw, ch]);
  gl.uniform3fv(uniLocation[2], cDir.tovec());
  gl.uniform3fv(uniLocation[3], cPos.tovec());

  // 描画
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  gl.flush();
}

function create_shader(id){
  // シェーダを格納する変数
  let shader;
  
  // HTMLからscriptタグへの参照を取得
  let scriptElement = document.getElementById(id);
  
  // scriptタグが存在しない場合は抜ける
  if(!scriptElement){return;}
  
  // scriptタグのclass属性をチェック
  switch(scriptElement.className){
    
    // 頂点シェーダの場合
    case 'x-shader/x-vertex':
      shader = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(shader, vertexShader);
      break;
    // フラグメントシェーダの場合
    case 'x-shader/x-fragment':
      shader = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(shader, fragmentShader);
      break;
    default :
      return;
  }
  
  // シェーダをコンパイルする
  gl.compileShader(shader);
  
  // シェーダが正しくコンパイルされたかチェック
  if(gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
    // 成功していたらシェーダを返して終了
    return shader;
  }else{
    // 失敗していたらエラーログをアラートする
    alert(gl.getShaderInfoLog(shader));
  }
}

function create_program(vs, fs){
  // プログラムオブジェクトの生成
  let program = gl.createProgram();
  
  // プログラムオブジェクトにシェーダを割り当てる
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  
  // シェーダをリンク
  gl.linkProgram(program);
  
  // シェーダのリンクが正しく行なわれたかチェック
  if(gl.getProgramParameter(program, gl.LINK_STATUS)){
  
    // 成功していたらプログラムオブジェクトを有効にする
    gl.useProgram(program);
    
    // プログラムオブジェクトを返して終了
    return program;
  }else{
  
    // 失敗していたらエラーログをアラートする
    alert(gl.getProgramInfoLog(program));
  }
}

function create_vbo(data){
  // バッファオブジェクトの生成
  let vbo = gl.createBuffer();
  
  // バッファをバインドする
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  
  // バッファにデータをセット
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  
  // バッファのバインドを無効化
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  
  // 生成した VBO を返して終了
  return vbo;
}

// IBOを生成する関数
function create_ibo(data){
  // バッファオブジェクトの生成
  let ibo = gl.createBuffer();
  
  // バッファをバインドする
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  
  // バッファにデータをセット
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Int16Array(data), gl.STATIC_DRAW);
  
  // バッファのバインドを無効化
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  
  // 生成したIBOを返して終了
  return ibo;
}

//check box チェックされている間だけレンダリング
function checkChange(e) {
  run = e.currentTarget.checked;
  console.log(run);
  if(run){
    startTime = new Date().getTime();
    render();
  }else{
    tempTime += timenow - startTime;
  }
};

//マウスインターフェース
function mouseMove(e){
  if (mouseflag){
    if (Math.abs(e.offsetX)===1 || Math.abs(e.offsetY)===1) {
      mouseflag=false;
      return;
    };
    let dx =(-0.7 * (e.offsetX-centorx) / cw);
    let dy =(0.7 * (e.offsetY-centory) / ch);
    centorx=e.offsetX;
    centory=e.offsetY;
    cRotate(dx,dy);
  };
};

function mouseDown(e) {
  if (run===false){return;};
  mouseflag=true;
  centorx=e.offsetX;
  centory=e.offsetY;
};

function mouseUp(e) {
  mouseflag=false;
};

function cRotate(dx,dy) {
  let roty=Quatarnion.rotation(-dx*Math.PI,0,0,1);
  let xaxes=cDir.cross(Quatarnion.vec(0,0,1)).tovec();
  let rotx = new Quatarnion(1,0,0,0);
  if (cDir.k*Math.sign(dy) < maxpitch) {
    rotx=Quatarnion.rotation(dy*Math.PI,xaxes[0],xaxes[1],xaxes[2]);
  }
  cDir=cDir.turn(roty.times(rotx));
};
