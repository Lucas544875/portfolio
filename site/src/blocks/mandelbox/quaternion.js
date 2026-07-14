// prototype-mandelbox2/quaternion.js の移植(ESモジュール化のみ、ロジックは変更なし)。
export class Quatarnion {
  constructor(w, i, j, k) {
    this.w = w;
    this.i = i;
    this.j = j;
    this.k = k;
  }

  add(q2) {
    return new Quatarnion(this.w + q2.w, this.i + q2.i, this.j + q2.j, this.k + q2.k);
  }

  scale(k) {
    return new Quatarnion(k * this.w, k * this.i, k * this.j, k * this.k);
  }

  times(q2) {
    return new Quatarnion(
      this.w * q2.w - this.i * q2.i - this.j * q2.j - this.k * q2.k,
      this.w * q2.i + this.i * q2.w + this.j * q2.k - this.k * q2.j,
      this.w * q2.j - this.i * q2.k + this.j * q2.w + this.k * q2.i,
      this.w * q2.k + this.i * q2.j - this.j * q2.i + this.k * q2.w,
    );
  }

  inverse() {
    return new Quatarnion(this.w, -this.i, -this.j, -this.k);
  }

  normalize() {
    const r = this.w ** 2 + this.i ** 2 + this.j ** 2 + this.k ** 2;
    return new Quatarnion(this.w / r, this.i / r, this.j / r, this.k / r);
  }

  cross(q2) {
    return new Quatarnion(
      0,
      this.j * q2.k - this.k * q2.j,
      this.k * q2.i - this.i * q2.k,
      this.i * q2.j - this.j * q2.i,
    );
  }

  static rotation(theta, x, y, z) {
    const c = Math.cos(theta / 2);
    const s = Math.sin(theta / 2);
    return new Quatarnion(c, x * s, y * s, z * s).normalize();
  }

  static vec(x, y, z) {
    return new Quatarnion(0, x, y, z);
  }

  turn(q) {
    return q.times(this).times(q.inverse());
  }

  tovec() {
    return [this.i, this.j, this.k];
  }

  get norm() {
    return Math.sqrt(this.w * this.w + this.i * this.i + this.j * this.j + this.k * this.k);
  }
}
