import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 作品ごとの詳細サブページをマルチページ構成で追加していく前提の設定。
// 新しいサブページを増やす場合はここにエントリを足す。
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        rainWindow: resolve(__dirname, 'works/rain-window/index.html'),
      },
    },
  },
});
