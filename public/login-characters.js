/* ============================================================
   登录页角色动画系统（交互层）
   - 只读取表单事件，不介入任何登录 / 注册业务逻辑
   - 对外接口：
       LoginCharacters.triggerSadState(ms)        登录失败 → 全体悲伤脸
       LoginCharacters.playSuccessTransition(cb)  登录成功 → 粉色扩散转场
   - 状态优先级：error > 明文偷看 > 密文回避 > 账号聚焦 > 待机
   - 密码框节奏：聚焦先"惊呆"约 0.5s，随后集体扭开回避；
     点击显示密码 → 各自偷看表情；失焦 → 放松恢复待机
   ============================================================ */
(function () {
    'use strict';

    var stage = document.querySelector('.char-stage');
    if (!stage) return;

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    var BLINK_MIN = 3000, BLINK_MAX = 7000;   // 眨眼间隔 3~7s
    var GLANCE_MIN = 2000, GLANCE_MAX = 5000; // 偷瞄间隔 2~5s

    /* ---------- 角色节点收集 ---------- */
    var TILT_SCALE = { purple: 1, black: 1, orange: .45, yellow: .45 };
    var CHARS = {};
    ['purple', 'black', 'orange', 'yellow'].forEach(function (id) {
        var el = stage.querySelector('.char-' + id);
        if (!el) return;
        CHARS[id] = {
            id: id,
            el: el,
            tilt: el.querySelector('.char-tilt'),
            eyes: el.querySelector('.char-eyes'),
            pupils: Array.prototype.slice.call(el.querySelectorAll('.char-pupil')),
            mouth: el.querySelector('.char-mouth'),
            cx: 0, cy: 0,
            force: null
        };
    });
    var IDS = Object.keys(CHARS);
    if (!IDS.length) return;

    /* ---------- 状态 ---------- */
    var state = {
        accountFocused: false,   // 账号框聚焦
        passwordFocused: false,  // 密码框聚焦
        showPassword: false,     // 是否明文
        coverBeat: false,        // 密文态：是否已过"惊呆"停顿拍
        error: false,            // 登录失败
        registerMode: false,     // 注册 Tab 激活（降级为待机）
        mode: ''
    };
    var COVER_BEAT = 480;        // 聚焦密码框后"惊呆"停顿时长(ms)

    /* ---------- 定时器统一治理 ---------- */
    var timers = [];
    var blinkTimers = {};
    var errorTimer = null;
    var glanceTimer = null;
    var glanceHoldTimer = null;
    var geometryTimer = null;
    var focusSyncTimer = null;   // 焦点校验专用：不能被 clearAllTimers 清掉，否则焦点状态会卡死

    function later(fn, ms) {
        var t = setTimeout(fn, ms);
        timers.push(t);
        return t;
    }
    function clearAllTimers() {
        timers.forEach(clearTimeout);
        timers = [];
        errorTimer = null;
        glanceTimer = null;
        glanceHoldTimer = null;
    }
    /* 焦点切换后延迟校准（读 activeElement 实况，始终收敛到真实状态） */
    function scheduleFocusSync() {
        if (focusSyncTimer) clearTimeout(focusSyncTimer);
        focusSyncTimer = setTimeout(function () {
            focusSyncTimer = null;
            syncAccountFocus();
            syncPasswordFocus();
        }, 90);
    }
    function stopBlink() {
        IDS.forEach(function (id) {
            if (blinkTimers[id]) { clearTimeout(blinkTimers[id]); blinkTimers[id] = null; }
        });
    }

    /* ---------- 状态机：纯函数推算每个角色的形态 ---------- */
    function deriveCharacterState(s) {
        var out = {};
        function set(id, o) {
            out[id] = {
                eyes: 'normal', mouth: 'flat', pose: '', look: null
            };
            if (o) {
                for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out[id][k] = o[k]; }
            }
        }

        if (s.error) {
            /* 错误态：全体悲伤脸 —— 紫撇嘴、黑低落、橙"……"无语、黄眨眼不安 */
            set('purple', { mouth: 'pout', pose: 'droop' });
            set('black',  { mouth: 'frown', pose: 'droop' });
            set('orange', { eyes: 'dots', mouth: 'frown' });
            set('yellow', { eyes: 'wink', mouth: 'wave' });
        } else if (s.registerMode) {
            /* 注册 Tab：降级为待机 + 眨眼，不做特殊编排 */
            set('purple'); set('black'); set('orange'); set('yellow');
        } else if (s.passwordFocused && s.showPassword) {
            /* 明文偷看：黑色瞪眼直视、橙色捂脸偷笑、黄色单眼瞄、紫色闭眼仍不肯看 */
            set('purple', { eyes: 'squint', mouth: 'frown', pose: 'flinch', look: { x: -.9, y: -.4 } });
            set('black',  { eyes: 'wide', mouth: 'flat', look: { x: 1, y: .05 } });
            set('orange', { eyes: 'smile', mouth: 'smile', look: { x: .9, y: .1 } });
            set('yellow', { eyes: 'wink', mouth: 'flat', look: { x: .9, y: .05 } });
        } else if (s.passwordFocused) {
            if (s.coverBeat) {
                /* 密文回避：紫扭身难过、黑转身闭眼、橙闭眼下蹲、黄紧张单眼+波浪嘴 */
                set('purple', { mouth: 'frown', pose: 'flinch', look: { x: -.85, y: -.75 } });
                set('black',  { eyes: 'squint', pose: 'turn', look: { x: -1, y: -.5 } });
                set('orange', { eyes: 'squint', mouth: 'frown', pose: 'droop' });
                set('yellow', { eyes: 'wink', mouth: 'wave', look: { x: .9, y: -.05 } });
            } else {
                /* 停顿拍：刚聚焦密码框，全体惊呆盯住 */
                set('purple', { mouth: 'line', look: { x: 1, y: .05 } });
                set('black',  { eyes: 'wide', look: { x: 1, y: .05 } });
                set('orange', { eyes: 'dots', mouth: 'dot', look: { x: .9, y: .1 } });
                set('yellow', { look: { x: .9, y: .05 } });
            }
        } else if (s.accountFocused) {
            /* 账号聚焦：全员好奇围观输入（紫倾身、黑瞪眼、橙"……"） */
            set('purple', { pose: 'lean-right', look: { x: 1, y: .05 } });
            set('black',  { eyes: 'wide', look: { x: .95, y: .1 } });
            set('orange', { mouth: 'dots', look: { x: .9, y: .12 } });
            set('yellow', { look: { x: .9, y: .05 } });
        } else {
            /* 待机 */
            set('purple'); set('black'); set('orange'); set('yellow');
        }
        return out;
    }

    function computeMode(s) {
        if (s.error) return 'error';
        if (s.registerMode) return 'register';
        if (s.passwordFocused) return s.showPassword ? 'peek' : 'cover';
        if (s.accountFocused) return 'account';
        return 'idle';
    }

    function applyDerived(derived) {
        IDS.forEach(function (id) {
            var c = CHARS[id], v = derived[id];
            if (!c || !v) return;

            c.eyes.classList.remove(
                'eyes-normal', 'eyes-squint', 'eyes-smile',
                'eyes-wide', 'eyes-wink', 'eyes-dots'
            );
            c.eyes.classList.add('eyes-' + v.eyes);

            c.mouth.className = 'char-mouth m-' + v.mouth;

            c.el.classList.toggle('pose-lean-left', v.pose === 'lean-left');
            c.el.classList.toggle('pose-lean-right', v.pose === 'lean-right');
            c.el.classList.toggle('pose-flinch', v.pose === 'flinch');
            c.el.classList.toggle('pose-turn', v.pose === 'turn');
            c.el.classList.toggle('pose-droop', v.pose === 'droop');

            c.force = v.look;
        });
        updateEyes();
        updateTilt();
    }

    /* ---------- 眼珠算法：distance/angle 三角定位，支持强制视线 ---------- */
    var pointer = { x: 0, y: 0, active: false };
    var stageLeft = 0, stageTop = 0;
    var MAX_PUPIL = 4.6;

    function updateEyes() {
        IDS.forEach(function (id) {
            var c = CHARS[id];
            var dx, dy;
            if (c.force) {
                dx = c.force.x * 40;
                dy = c.force.y * 40;
            } else if (pointer.active) {
                dx = pointer.x - c.cx;
                dy = pointer.y - c.cy;
            } else {
                dx = 0; dy = 0;
            }
            var dist = Math.sqrt(dx * dx + dy * dy);
            var use = Math.min(dist, MAX_PUPIL);
            var angle = Math.atan2(dy, dx);
            var ox = Math.cos(angle) * use;
            var oy = Math.sin(angle) * use;
            if (!isFinite(ox)) ox = 0;
            if (!isFinite(oy)) oy = 0;
            c.pupils.forEach(function (p) {
                p.style.transform = 'translate(' + ox.toFixed(2) + 'px,' + oy.toFixed(2) + 'px)';
            });
        });
    }

    /* 身体倾斜：skewX(clamp(-dx/120, ±6))，transform-origin 底部 */
    function updateTilt() {
        IDS.forEach(function (id) {
            var c = CHARS[id];
            if (!c.tilt) return;
            var skew = 0;
            if (pointer.active) {
                var dx = pointer.x - c.cx;
                skew = Math.max(-6, Math.min(6, -dx / 120)) * (TILT_SCALE[id] || 1);
            }
            c.tilt.style.transform = 'skewX(' + skew.toFixed(2) + 'deg)';
        });
    }

    /* ---------- 几何缓存（避免 mousemove 触发强制重排） ---------- */
    function cacheGeometry() {
        if (!(window.innerWidth >= 1024)) return;
        var r = stage.getBoundingClientRect();
        if (!r.width) return;
        stageLeft = r.left;
        stageTop = r.top;
        IDS.forEach(function (id) {
            var c = CHARS[id];
            var er = c.eyes.getBoundingClientRect();
            c.cx = er.left + er.width / 2 - r.left;
            c.cy = er.top + er.height / 2 - r.top;
        });
    }
    function scheduleGeometryRefresh(delay) {
        if (geometryTimer) clearTimeout(geometryTimer);
        geometryTimer = setTimeout(cacheGeometry, delay || 780);
    }

    /* ---------- 眨眼：3~7s 随机递归 ---------- */
    function scheduleBlink(id) {
        blinkTimers[id] = setTimeout(function () {
            var c = CHARS[id];
            if (!c) return;
            c.eyes.classList.add('blink');
            /* 恢复用独立定时器：blink 是瞬时形态，模式切换也不应吞掉恢复 */
            setTimeout(function () { c.eyes.classList.remove('blink'); }, 150);
            scheduleBlink(id);
        }, BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN));
    }
    function startBlink() {
        if (reduceMotion) return;
        stopBlink();
        IDS.forEach(scheduleBlink);
    }

    /* ---------- 偷瞄：明文态下每 2~5s 黑色随机瞟一眼再瞄回来 ---------- */
    function scheduleGlance() {
        if (reduceMotion) return;
        glanceTimer = later(function () {
            if (state.mode !== 'peek') return;
            var c = CHARS.black;
            if (c) {
                var dirs = [
                    { x: -1, y: -.55 }, { x: -.8, y: -.8 }, { x: 1, y: -.45 },
                    { x: -.6, y: .4 }, { x: 1, y: .05 }
                ];
                c.force = dirs[Math.floor(Math.random() * dirs.length)];
                updateEyes();
            }
            glanceHoldTimer = later(function () {
                if (state.mode === 'peek' && c) {
                    c.force = { x: 1, y: .05 };
                    updateEyes();
                }
                scheduleGlance();
            }, 700 + Math.random() * 500);
        }, GLANCE_MIN + Math.random() * (GLANCE_MAX - GLANCE_MIN));
    }

    /* ---------- 渲染 ---------- */
    function render() {
        var mode = computeMode(state);
        var changed = mode !== state.mode;
        state.mode = mode;

        if (changed) {
            clearAllTimers();
            if (mode === 'cover') {
                /* 进入密文态：先"惊呆"一拍，再集体扭开回避 */
                state.coverBeat = false;
                later(function () {
                    if (state.mode !== 'cover' || state.coverBeat) return;
                    state.coverBeat = true;
                    applyDerived(deriveCharacterState(state));
                }, COVER_BEAT);
            } else {
                state.coverBeat = false;
            }
        }
        applyDerived(deriveCharacterState(state));
        if (changed) {
            startBlink();
            if (mode === 'peek') scheduleGlance();
        }
        scheduleGeometryRefresh();
    }

    /* ---------- 对外接口 ---------- */
    function triggerSadState(ms) {
        state.error = true;
        render();
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = later(function () {
            state.error = false;
            render();
        }, ms || 2000);
    }

    function playSuccessTransition(cb) {
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            if (typeof cb === 'function') cb();
        }
        if (reduceMotion) { finish(); return; }

        var veil = document.createElement('div');
        veil.className = 'success-veil';
        veil.setAttribute('aria-hidden', 'true');
        var circle = document.createElement('div');
        circle.className = 'success-circle';
        veil.appendChild(circle);
        document.body.appendChild(veil);

        // 依据视口对角线推算放大倍数，保证铺满任意分辨率
        var scale = Math.ceil(Math.sqrt(window.innerWidth * window.innerWidth +
            window.innerHeight * window.innerHeight) / 80) + 2;
        // 强制回流，让初始 scale(0) 先落地，再改目标值以触发 transition
        // （不用双层 rAF：后台标签页或渲染节流时 rAF 不推进，动画会被跳过）
        void circle.offsetWidth;
        circle.style.transform = 'scale(' + scale + ')';
        circle.style.opacity = '1';

        circle.addEventListener('transitionend', function () { setTimeout(finish, 60); });
        setTimeout(finish, 1200);   // 兜底，避免 transitionend 丢失导致卡死
    }

    window.LoginCharacters = {
        triggerSadState: triggerSadState,
        playSuccessTransition: playSuccessTransition,
        setRegisterMode: function (on) { state.registerMode = !!on; render(); },
        rebind: function () { formBound = false; bindFormEvents(); }
    };

    /* ---------- 表单事件绑定（只读，不干预业务） ----------
       R 修订：SPA 场景下脚本加载时表单可能尚未就绪，绑定支持延迟 rebind */
    var usernameInput = null;
    var passwordInput = null;
    var toggleBtn = null;
    var formBound = false;

    function bindFormEvents() {
        if (formBound) return;
        usernameInput = document.getElementById('username');
        passwordInput = document.getElementById('password');
        toggleBtn = document.getElementById('pwdToggle');
        if (!usernameInput || !passwordInput) return; // 未就绪：可由 LoginCharacters.rebind() 再次调用
        formBound = true;

        document.addEventListener('focusin', syncAccountFocus);
        document.addEventListener('focusout', scheduleFocusSync);

        if (passwordInput) {
            passwordInput.addEventListener('focus', function () {
                state.passwordFocused = true;
                render();
            });
            passwordInput.addEventListener('blur', scheduleFocusSync);
        }

        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', function (e) {
                e.preventDefault();
                var wasFocused = document.activeElement === passwordInput;
                var toText = passwordInput.type === 'password';
                passwordInput.type = toText ? 'text' : 'password';
                state.showPassword = toText;
                toggleBtn.setAttribute('aria-pressed', toText ? 'true' : 'false');
                var icon = toggleBtn.querySelector('i');
                if (icon) icon.className = toText ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
                render();
                if (wasFocused) {
                    passwordInput.focus();
                    var end = passwordInput.value.length;
                    try { passwordInput.setSelectionRange(end, end); } catch (err) {}
                }
            });
        }

        render();
        cacheGeometry();
        scheduleGeometryRefresh(300);
    }

    function syncAccountFocus() {
        var focused = document.activeElement === usernameInput;
        if (focused === state.accountFocused) return;
        state.accountFocused = focused;
        render();
    }
    function syncPasswordFocus() {
        var focused = document.activeElement === passwordInput;
        if (focused === state.passwordFocused) return;
        state.passwordFocused = focused;
        render();
    }
    /* Tab 切换（可选元素）：注册 Tab 进入待机降级，密码 Tab 复位 */
    ['tab-password', 'tab-code'].forEach(function (id) {
        var tab = document.getElementById(id);
        if (!tab) return;
        tab.addEventListener('click', function () {
            state.registerMode = (id === 'tab-code');
            if (state.registerMode) {
                state.accountFocused = false;
                state.passwordFocused = false;
                state.showPassword = false;
            }
            render();
        });
    });

    /* ---------- 鼠标跟随（触屏 / 窄屏 / 减弱动态时不启用） ---------- */
    function trackingEnabled() {
        return !coarse && !reduceMotion && window.innerWidth >= 1024;
    }
    /* 同一帧内合并眼珠与身体倾斜的更新，避免高频 mousemove 触发布局抖动 */
    var framePending = false;
    function scheduleFrame() {
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(function () {
            framePending = false;
            updateEyes();
            updateTilt();
        });
    }
    document.addEventListener('mousemove', function (e) {
        if (!trackingEnabled()) return;
        pointer.x = e.clientX - stageLeft;
        pointer.y = e.clientY - stageTop;
        pointer.active = true;
        scheduleFrame();
    }, { passive: true });
    document.addEventListener('mouseleave', function () {
        pointer.active = false;
        updateEyes();
        updateTilt();
    });

    window.addEventListener('resize', function () {
        cacheGeometry();
        scheduleGeometryRefresh(200);
    }, { passive: true });
    window.addEventListener('scroll', cacheGeometry, { passive: true });
    window.addEventListener('beforeunload', function () {
        clearAllTimers();
        stopBlink();
        if (geometryTimer) clearTimeout(geometryTimer);
        if (focusSyncTimer) clearTimeout(focusSyncTimer);
    });

    /* ---------- 启动 ---------- */
    bindFormEvents();                // R：表单元素就绪即绑定；SPA 延迟场景由 rebind() 兜底
    render();
    cacheGeometry();
    scheduleGeometryRefresh(1200);   // 入场动画结束后重新校准眼珠基准
})();