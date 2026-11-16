/**
 * 侧栏会话搜索的聚焦请求通道
 * ============================================================================
 *  Ctrl/Cmd+K 由命令面板统一监听，面板里的"聚焦会话搜索"通过这里请求侧栏聚焦
 *  —— 路径只有一条，不会出现两个组件抢同一个快捷键。
 *  模块级 ref：不需要跨组件传 props，也不会因为 useSidebar() 每次新建实例而丢失。
 */
import { ref } from 'vue';

const request = ref(0);

export function requestSidebarSearchFocus(): void {
  request.value += 1;
}

export function sidebarSearchRequest() {
  return request;
}
