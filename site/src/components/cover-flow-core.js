// カバーフローの見た目(3D配置)を計算する共通ロジック。
// インタラクティブ版(cover-flow.js)と自動再生版(cover-flow-auto.js)の両方から使う。
export const OFFSET_X = 170; // 中心からの1枚あたりの水平オフセット(px)
export const DEPTH_Z = -260; // 中心以外を奥に押し込む距離(px)
export const ROTATE_DEG = 50; // 中心以外の回転角
export const SIDE_SCALE = 0.72;
export const MAX_VISIBLE_OFFSET = 3; // これより離れた枚数は完全に隠す

export function applyCoverFlowLayout(items, current) {
  items.forEach((item, i) => {
    const offset = i - current;
    const abs = Math.abs(offset);
    const dir = Math.sign(offset);
    const visible = abs <= MAX_VISIBLE_OFFSET;

    const tx = offset * OFFSET_X;
    const tz = offset === 0 ? 0 : DEPTH_Z;
    const ry = offset === 0 ? 0 : -dir * ROTATE_DEG;
    const scale = offset === 0 ? 1 : SIDE_SCALE;

    item.style.transform = `translate3d(${tx}px, 0, ${tz}px) rotateY(${ry}deg) scale(${scale})`;
    item.style.opacity = visible ? String(Math.max(1 - abs * 0.22, 0)) : '0';
    item.style.zIndex = String(100 - abs);
    item.setAttribute('aria-current', offset === 0 ? 'true' : 'false');
  });
}
