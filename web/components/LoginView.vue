<script setup lang="ts">
import {clientFetch,isInstalledClient} from '../client';

import {t as tr} from "../i18n";
import {responseError} from '../http';
/**
 * LabOps 专用登录页
 * ============================================================================
 *  · 表演层：public/login-characters.css + public/login-characters.js
 *    （含状态机/眨眼/偷瞄/捂眼/惊呆节拍/成功转场）
 *  · 接线：登录组件挂载后动态加载 js（脚本在加载时绑定 #username/#password/#pwdToggle
 *    并自启）；对外只调 triggerSadState / playSuccessTransition 两个接口
 *  · 正常部署复用主系统认证；仅显式 demo 模式使用沙盒登录门面
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
const props=defineProps<{mode?:'native'|'demo'}>();
// 安装版：登录页只保留一个低调的「连接设置」文字入口；
// 网页版 isInstalledClient() 恒为 false，不渲染该入口。
const installed=isInstalledClient();
function openAdvanced(): void { location.assign('/client/settings.html#advanced'); }
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
    //    修改 public/login-characters.js 时把这里和 index.html 的 css 版本一起往上加
    s.src = '/login-characters.js?v=20261004c';
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
async function submit(): Promise<void> {
  if (submitting.value) return;
  if (!account.value.trim()) return fail('请输入主系统账号');
  if (!password.value) return fail('请输入密码');
  submitting.value = true;
  if(props.mode!=='demo'){
    try{const r=await clientFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:account.value.trim(),password:password.value})});if(!r.ok)throw await responseError(r);await r.json();password.value='';}
    catch(e){submitting.value=false;return fail((e as Error).message);}
  }
  let entered = false;
  const finish = () => {
    if (entered) return;
    entered = true;
    document.querySelectorAll('.success-veil').forEach((v) => v.remove()); // SPA 内跳转：转场层手动移除
    emit('done', account.value.trim());
  };
  window.setTimeout(finish, 1800);
  if (window.LoginCharacters) window.LoginCharacters.playSuccessTransition(finish);
  else finish();
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
          <h1>{{tr("启真实验室助手")}}</h1>
          <div class="slogan">{{tr("实 验 室 事 务 · 一 句 话 交 办")}}</div>
        </div>

        <div class="form-group">
          <label class="field-label" for="username">{{tr("账号")}}</label>
          <input type="text" id="username" v-model="account" :placeholder="mode==='demo'?'演示账号':'请输入主系统账号'" autocomplete="username" @keyup.enter="submit">
        </div>
        <div class="form-group pwd-field" id="pwdGroup">
          <label class="field-label" for="password">{{tr("密码")}}</label>
          <div class="pwd-field-inner">
            <input type="password" id="password" v-model="password" :placeholder="mode==='demo'?'演示密码':'请输入主系统密码'" autocomplete="current-password" @keyup.enter="submit">
            <button type="button" class="pwd-toggle" id="pwdToggle" :aria-label="tr('显示或隐藏密码')" aria-pressed="false">
              <span class="t-show">{{tr("显示")}}</span><span class="t-hide">{{tr("隐藏")}}</span>
            </button>
          </div>
        </div>
        <div v-if="errMsg" id="pwdError" class="error-msg" role="alert">{{ errMsg }}</div>

        <button class="login-btn" :disabled="submitting" @click="submit">{{tr(submitting?'正在登录…':'登录')}}</button>
        <p class="gate-note">{{tr(mode==='demo'?'本地隔离演示模式':'使用主系统账号和密码 · 自动识别身份并连接业务数据')}}</p>
        <button v-if="installed" type="button" class="conn-link" @click="openAdvanced">{{tr("连接设置")}}</button>
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
  font-size: calc(var(--ui-font-size) * 2.0);
  font-weight: 600;
  letter-spacing: 1px;
  margin-bottom: 6px;
  color: var(--text);
}
.brand .slogan {
  font-size: calc(var(--ui-font-size) * 1.07692);
  letter-spacing: 2px;
  color: var(--text-faint);
}
/* ---- 表单 ---- */
.form-group { margin-bottom: 16px; }
.field-label {
  display: block;
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  font-size: calc(var(--ui-font-size) * 1.11538);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
  cursor: pointer;
}
.pwd-toggle:hover { color: var(--text); background: var(--surface-3); }
.pwd-toggle .t-hide { display: none; }
.pwd-toggle[aria-pressed='true'] .t-show { display: none; }
.pwd-toggle[aria-pressed='true'] .t-hide { display: inline; }
.error-msg {
  color: var(--danger);
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  font-size: calc(var(--ui-font-size) * 1.15385);
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
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: #9c7f8c;
}
/* 登录页低调文字入口：非悬浮按钮，只在安装版出现 */
.conn-link {
  display: block;
  margin: 10px auto 0;
  padding: 4px 8px;
  border: 0;
  background: none;
  color: #a89aa2;
  font: inherit;
  font-size: calc(var(--ui-font-size) * 0.84615);
  letter-spacing: 0.06em;
  text-decoration: underline;
  text-decoration-color: #d8ccd2;
  text-underline-offset: 3px;
  cursor: pointer;
}
.conn-link:hover,
.conn-link:focus-visible { color: var(--primary); text-decoration-color: var(--primary); }
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
/* 明文好奇态：全员凑近密码框 —— 比账号聚焦的 8px 倾靠明显更靠近 */
.login .pose-curious .char-body {
  transform: translateX(46px) skewX(-5deg) scale(1.02);
  transition-duration: 0.5s;
}
.login .char--purple.pose-curious .char-body {
  transform: translateX(58px) skewX(-6deg) scale(1.03);
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
