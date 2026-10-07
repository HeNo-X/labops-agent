import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

const SERVER_PORT = process.env.PORT || '8787';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    // SSE 走 dev 代理：这里必须关闭压缩缓冲，否则 answer_delta 会攒成一坨才到前端
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
        ws: false
      }
    }
  },
  build: {
    rolldownOptions:{input:{desktop:fileURLToPath(new URL('./index.html',import.meta.url)),mobile:fileURLToPath(new URL('./mobile.html',import.meta.url))}},
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022'
  }
});
