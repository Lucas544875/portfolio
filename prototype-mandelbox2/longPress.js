class LongPress {
  constructor(keyCode){
    this.keyCode = keyCode;
  }
  static keyary = Array(90);

  static keyDown(e){
    let keyCode = e.keyCode;
    LongPress.keyary[keyCode] = true;
  }
  
  static keyUp(e){
    let keyCode = e.keyCode;
    LongPress.keyary[keyCode] = false;
  }

  get pressed(){
    if (LongPress.keyary[this.keyCode] === undefined){
      LongPress.keyary[this.keyCode] = false;
    }
    return LongPress.keyary[this.keyCode];
  }
}