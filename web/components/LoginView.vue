<script setup lang="ts">
/**
 * LabOps 专用登录页 —— 移植自心灵共鸣舱 LogIn.html 的成熟角色动画实现
 * ============================================================================
 *  · 表演层：public/login-characters.css + public/login-characters.js（原样移植，
 *    含状态机/眨眼/偷瞄/捂眼/惊呆节拍/成功转场，与演示录屏逐帧一致）
 *  · 接线：登录组件挂载后动态加载 js（脚本在加载时绑定 #username/#password/#pwdToggle
 *    并自启）；对外只调 triggerSadState / playSuccessTransition 两个接口
 *  · 边界：本地演示门面（任意账号 + ≥4 位密码），无真实身份校验；会话内记住登录
 */
import { onMounted, ref } from 'vue';

declare global {
  interface Window {
    LoginCharacters?: {
      triggerSadState: (ms?: number) => void;
      playSuccessTransition: (cb: () => void) => void;
      setRegisterMode: (on: boolean) => void;
      rebind: () => void;
    };
  }
}

const emit = defineEmits<{ done: [account: string] }>();
const account = ref('');
const password = ref('');
const errMsg = ref('');
const submitting = ref(false);
let booted = false;

onMounted(() => {
  if (!booted && !window.LoginCharacters) {
    booted = true;
    const s = document.createElement('script');
    // ⚠️ public/ 里的文件名是固定的，必须带版本参数，否则浏览器会一直用旧缓存
    //    （2026-10-04 实际踩过：改了本文件但用户侧"没反应"）
    //    改 public/login-characters.js 时把这里和 index.html 的 css 版本一起往上加
    s.src = '/login-characters.js?v=20261004b';
    s.addEventListener('load', () => window.LoginCharacters && window.LoginCharacters.rebind());
    document.body.appendChild(s); // 挂载后加载：rebind 确保 #username/#password/#pwdToggle 绑定生效
  }
});
function fail(msg: string): void {
  errMsg.value = msg;
  window.LoginCharacters?.triggerSadState(2000);
  const u = document.getElementById('username');
  const p = document.getElementById('password');
  [u, p].forEach((el) => el && el.classList.add('shake'));
  window.setTimeout(() => {
    [u, p].forEach((el) => el && el.classList.remove('shake'));
  }, 320);
}
function submit(): void {
  if (submitting.value) return;
  if (!account.value.trim()) return fail('请输入账号（演示模式任意账号即可）');
  if (password.value.length < 4) return fail('密码至少 4 位（本地演示，无身份校验）');
  submitting.value = true;
  window.LoginCharacters?.playSuccessTransition(() => {
    document.querySelectorAll('.success-veil').forEach((v) => v.remove()); // SPA 内跳转：转场层手动移除
    emit('done', account.value.trim());
  });
}
</script>

<template>
  <div class="login">
    <main class="login-shell">
      <!-- 左栏：角色舞台（DOM 结构与 login-characters.js 的节点契约完全一致） -->
      <div class="char-stage" aria-hidden="true">
        <span class="char-spot char-spot-a"></span>
        <span class="char-spot char-spot-b"></span>
        <span class="char-ground"></span>
        <div class="characters">
          <div class="char char-purple">
            <div class="char-bob"><div class="char-tilt"><div class="char-body">
              <div class="char-eyes">
                <span class="char-eye"><i class="char-pupil"></i></span>
                <span class="char-eye"><i class="char-pupil"></i></span>
              </div>
              <div class="char-mouth-wrap"><span class="char-mouth m-flat"></span></div>
            </div></div></div>
          </div>
          <div class="char char-black">
            <div class="char-bob"><div class="char-tilt"><div class="char-body">
              <div class="char-eyes">
                <span class="char-eye"><i class="char-pupil"></i></span>
                <span class="char-eye"><i class="char-pupil"></i></span>
              </div>
              <div class="char-mouth-wrap"><span class="char-mouth m-flat"></span></div>
            </div></div></div>
          </div>
          <div class="char char-orange">
            <div class="char-bob"><div class="char-tilt"><div class="char-body">
              <div class="char-eyes">
                <span class="char-eye"><i class="char-pupil"></i></span>
                <span class="char-eye"><i class="char-pupil"></i></span>
              </div>
              <div class="char-mouth-wrap"><span class="char-mouth m-flat"></span></div>
            </div></div></div>
          </div>
          <div class="char char-yellow">
            <div class="char-bob"><div class="char-tilt"><div class="char-body">
              <div class="char-eyes">
                <span class="char-eye"><i class="char-pupil"></i></span>
                <span class="char-eye"><i class="char-pupil"></i></span>
              </div>
              <div class="char-mouth-wrap"><span class="char-mouth m-flat"></span></div>
            </div></div></div>
          </div>
        </div>
      </div>

      <!-- 右栏：登录卡片（玻璃拟态） -->
      <section class="login-card">
        <div class="brand">
          <h1>启真实验室助手</h1>
          <div class="slogan">实 验 室 事 务 · 一 句 话 交 办</div>
        </div>

        <div class="form-group">
          <label class="field-label" for="username">账号</label>
          <input type="text" id="username" v-model="account" placeholder="请输入账号（演示模式任意账号）">
        </div>
        <div class="form-group pwd-field" id="pwdGroup">
          <label class="field-label" for="password">密码</label>
          <div class="pwd-field-inner">
            <input type="password" id="password" v-model="password" placeholder="输入您的密码（≥4 位）">
            <button type="button" class="pwd-toggle" id="pwdToggle" aria-label="显示或隐藏密码" aria-pressed="false">
              <span class="t-show">显示</span><span class="t-hide">隐藏</span>
            </button>
          </div>
        </div>
        <div v-if="errMsg" id="pwdError" class="error-msg" role="alert">{{ errMsg }}</div>

        <button class="login-btn" @click="submit">登录</button>
        <p class="gate-note">本地演示模式 · 登录为产品门面，无身份校验</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* ===== 页面基调：粉色渐变 + 玻璃拟态卡片（与心灵共鸣舱登录页同源） ===== */
.login {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  position: relative;
  background: linear-gradient(180deg, #fafafa 0%, #f0f0f0 100%);
  font-family: 'Outfit', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: var(--text);
  overflow-x: hidden;
}
.login-shell {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
}
/* ---- 卡片 ---- */
.login-card {
  flex: 0 0 400px;
  width: 400px;
  max-width: 400px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-1);
  padding: 28px 24px;
  position: relative;
  z-index: 10;
}
.brand {
  text-align: center;
  margin-bottom: 22px;
}
.brand h1 {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 1px;
  margin-bottom: 6px;
  color: var(--text);
}
.brand .slogan {
  font-size: 14px;
  letter-spacing: 2px;
  color: var(--text-faint);
}
/* ---- 表单 ---- */
.form-group { margin-bottom: 16px; }
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #a08d97;
  margin-bottom: 6px;
}
.form-group input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font-size: 14.5px;
  color: var(--text);
  background: var(--surface-2);
  outline: none;
  transition: border-color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.form-group input:focus {
  border-color: var(--primary);
  background: var(--surface);
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.05);
}
.form-group input::placeholder { color: #b3bfcd; }
input[type='password']::-ms-reveal,
input[type='password']::-ms-clear { display: none; }
.pwd-field-inner { position: relative; }
.pwd-field-inner input { padding-right: 60px; }
.pwd-toggle {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
.pwd-toggle:hover { color: var(--text); background: var(--surface-3); }
.pwd-toggle .t-hide { display: none; }
.pwd-toggle[aria-pressed='true'] .t-show { display: none; }
.pwd-toggle[aria-pressed='true'] .t-hide { display: inline; }
.error-msg {
  color: var(--danger);
  font-size: 12px;
  margin: -6px 0 12px;
  min-height: 14px;
}
.login-btn {
  width: 100%;
  height: 46px;
  border: 0;
  border-radius: 10px;
  background: var(--primary);
  color: var(--primary-contrast);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: transform 0.3s, box-shadow 0.3s, background 0.3s;
}
.login-btn:hover:not(:disabled) {
  background: var(--primary-hover);
}
.login-btn:disabled { opacity: 0.7; cursor: default; }
.gate-note {
  margin: 16px 0 0;
  text-align: center;
  font-size: 11px;
  color: #9c7f8c;
}
/* shake（登录失败时输入框抖动，配合角色悲伤态） */
.shake { animation: shake-anim 0.3s ease-in-out; }
@keyframes shake-anim {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}
/* ---- 响应式 ---- */
@media (max-width: 1023px) {
  .login-shell { max-width: 420px; }
  .char-stage { display: none; }
  .login-card { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  }
</style>



<style>
/* ===== LabOps 风格适配（实验室仪器风）：角色保留 lib 原色，只调造型；转场改墨色 ===== */
.login .char-stage {
  background: linear-gradient(180deg, #f7f7f7 0%, #ececec 100%);
  box-shadow: var(--shadow-1);
  border: 1px solid var(--border);
}
/* 造型去"可爱"：大圆角 → 仪器方直圆角；去高光；阴影中性 */
.login .char-purple .char-body {
  border-radius: 14px 14px 8px 8px;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.12);
}
.login .char-black .char-body {
  border-radius: 12px;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.12);
}
.login .char-orange .char-body {
  border-radius: 14px 14px 8px 8px;
  height: 78%;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.1);
}
.login .char-yellow .char-body {
  border-radius: 12px 12px 6px 6px;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.1);
}
.login .char-body::after {
  display: none; /* 去掉果冻高光 */
}
.login .char-ground {
  background: rgba(0, 0, 0, 0.1);
}
.login .char-spot {
  background: #d9d9d9;
}
/* 转场层由 lib 挂在 body 上（.login 外），必须全局覆盖才能命中 */
.success-veil {
  background: rgba(23, 23, 23, 0.4);
}
.success-circle {
  background: linear-gradient(180deg, #34343c 0%, #171717 100%);
  box-shadow: 0 0 60px rgba(0, 0, 0, 0.35);
}
</style>
