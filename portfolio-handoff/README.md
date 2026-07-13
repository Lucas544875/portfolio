# 引き継ぎ README（まずこれを読む）

WebGL多用のサイケデリックな個人ポートフォリオを作る。チャット側で情報設計と
Heroのビジュアルを確定済み。ここからは**レンダリング基盤の実装**が主タスク。

## 読む順
1. `README.md`（このファイル）
2. `PORTFOLIO_DESIGN.md` … 決定事項・情報設計・基盤要件の全体像。**最重要。**
3. `hero_final.html` … 確定版Hero。ブラウザで開けば動く。ビジュアルの基準であり、
   基盤に載せ替える最初のブロックの元ネタ。

## 最初にやること
`PORTFOLIO_DESIGN.md` の「6. 次の一手」に従う。要点だけ再掲:

1. Vite等でプロジェクト雛形を作り、`hero_final.html` を最初のブロックとして移植。
2. **共有WebGLレンダラ + ブロック登録 + IntersectionObserverによる可視判定でオンオフ**
   する基盤の骨格を実装。WebGLコンテキスト数を増やさない設計を最優先。
   rAFループ1本、reduced-motion/モバイルfallbackを最初から組み込む。
3. Hero + プレースホルダWorks の2〜3ブロックでスクロール遷移が破綻しないか検証。
4. 基盤が固まってから実作品を差し込む。

## 重要な制約（詳細は DESIGN の §4）
- 「全作品をページ内に埋め込み、その場で触らせる」方針＝最も重い構成。
  複数WebGLの同時使用を基盤で吸収すること。context lost対策必須。
- 基調色は深いティール/シアン（Heroのpalette 2）。全体をこの寒色で統一。
- 色相の細部とAboutの文面は未確定。今は触らず、基盤を優先。

## スタックは未確定（DESIGN §5）
生WebGL2 / 軽量ラッパー(twgl/regl) / three限定利用 のいずれか。
本人はGLSL直書き志向。R3Fは今回オーバーヘッドの懸念あり。実装開始時に判断する。

## 実装状況（2026-07-13）

「次の一手」の1〜3を実装済み。`../site/` にVite雛形あり（`npm install && npm run dev`）。

- スタックは**生WebGL2**に決定（GLSL直書き志向・薄さ優先のため。ラッパー/threeは不採用）。
- `site/src/gl/renderer.js` の `SharedGLRenderer` … WebGL2コンテキストは**ページ全体で1つだけ**。
  各ブロックはDOM上のslot要素の位置を毎フレーム読み、対応する矩形に`gl.viewport`/`gl.scissor`
  で描き分ける（§4.1「単一の共有WebGLレンダラ」を文字通り実装。コンテキスト数は作品数に
  依存せず常に1）。rAFループ1本に集約、DPR方針・reduced-motion(時間停止)・
  モバイル判定・`webglcontextlost`/`restored`も一元管理済み。
- `site/src/gl/visibility.js` … IntersectionObserverで`block.active`を切り替える薄いラッパー。
  非表示ブロックはrenderer側で描画自体をスキップ。
- `site/src/blocks/hero/` … hero_final.htmlのシェーダーをそのまま移植（値は不変）。
- `site/src/blocks/placeholder/` … Works検証用の軽量プレースホルダ2種。
- headless Chromiumで描画・スクロール遷移・reduced-motionの時間停止を確認済み。

次は§6項目4（実作品を差し込む）。重い作品向けの解像度スケーリング（FBO経由）や
背景の二層構成（§4.4、Hero〜About間のシェーダー継続）は未着手だが、
`block.render`内で完結できる設計にしてあるため基盤側の作り直しは不要な見込み。
