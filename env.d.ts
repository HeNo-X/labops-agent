/// <reference types="vite/client" />

// 让不装 Volar 的编辑器也能识别 .vue 的默认导出；vue-tsc 本身不需要这个 shim。
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
