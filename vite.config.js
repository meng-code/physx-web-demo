import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // 用相对路径，这样部署在任何子目录下都能运行
  server: { port: 5173, strictPort: true },
  // PhysX 的 WASM 包不做预打包，保持原样加载
  optimizeDeps: { exclude: ['physx-js-webidl'] },
});
