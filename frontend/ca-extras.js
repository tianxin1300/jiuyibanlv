/* ca-extras.js — 三端共享：浏览器提醒（铃铛 + 到点通知）+ 语音输入/朗读。
   无依赖，随页面加载。后端地址取 window.CARE_API_BASE_URL（deploy-config.js）。 */
(function () {
  if (window.__CA_EXTRAS__) return; window.__CA_EXTRAS__ = true;

  var base = function () { return String(window.CARE_API_BASE_URL || window.API_BASE || location.origin || "").replace(/\/+$/, ""); };
  var uid = (function () {
    try {
      var u = localStorage.getItem("ca_uid");
      if (!u) { u = "u" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem("ca_uid", u); }
      return u;
    } catch (e) { return "u" + Math.random().toString(36).slice(2, 12); }
  })();
  var token = function () { try { return localStorage.getItem("admin_token") || localStorage.getItem("staff_token") || localStorage.getItem("care_token") || ""; } catch (e) { return ""; } };
  function authHeaders(extra) {
    var h = { "Content-Type": "application/json" }; var t = token(); if (t) h.Authorization = "Bearer " + t;
    if (extra) for (var k in extra) h[k] = extra[k]; return h;
  }
  function api(path, opts) {
    opts = opts || {};
    var url = base() + path;
    var q = opts.query || {}; q.uid = uid; var t = token(); if (t) q.token = t;
    var qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(q[k] == null ? "" : q[k]); }).join("&");
    if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
    // 后端 POST 只从请求体取 uid（跨域不放行自定义请求头），所以体里必须带上，不能只拼在 URL 上
    var payload = null;
    if (opts.body) { payload = { uid: uid }; for (var bk in opts.body) payload[bk] = opts.body[bk]; }
    return fetch(url, { method: opts.method || "GET", headers: authHeaders(opts.headers), body: payload ? JSON.stringify(payload) : undefined })
      .then(function (r) { return r.json().catch(function () { return ({}); }).then(function (j) { return { ok: r.ok, status: r.status, data: j }; }); });
  }

  /* 线条图标（24 格 / 描边 1.8 / 圆角，与页面其它图标同一规格） */
  var ICON_MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>';
  var ICON_SPK_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10"/></svg>';
  var ICON_SPK_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>';

  /* ---------- TTS 朗读 ---------- */
  var ttsOn = (function () { try { return localStorage.getItem("ca_tts") === "1"; } catch (e) { return false; } })();
  function setTts(on) {
    ttsOn = !!on;
    try { localStorage.setItem("ca_tts", ttsOn ? "1" : "0"); } catch (e) {}
    document.querySelectorAll(".ca-spk").forEach(function (b) { b.classList.toggle("on", ttsOn); b.innerHTML = ttsOn ? ICON_SPK_ON : ICON_SPK_OFF; b.setAttribute("aria-pressed", ttsOn ? "true" : "false"); });
  }
  function speak(text) {
    if (!ttsOn || !text) return;
    try {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text).replace(/[*_`>#]/g, "").slice(0, 600));
      u.lang = "zh-CN"; u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------- STT 语音输入（浏览器完成，不上传录音）---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceSupported = !!SR;
  function openVoice(onFinal) {
    if (!SR) { alert("这个浏览器不支持语音识别。请用 Safari（iPhone/iPad）或最新版 Chrome / Edge 打开本页。"); return; }
    if (document.getElementById("caVoiceModal")) return;
    var o = document.createElement("div"); o.id = "caVoiceModal";
    o.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px";
    o.innerHTML = '<div style="background:#fff;border-radius:16px;padding:20px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)"><b style="font-size:16px">语音输入</b><p style="font-size:13px;color:#64748b;margin:6px 0 12px;line-height:1.6">点「开始说话」，说完点「停止」，识别出的文字会填到输入框。识别由浏览器完成，本站不上传你的录音。</p><div id="caVoiceTx" style="min-height:64px;padding:10px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;color:#0f172a;background:#f8fafc">（还没开始）</div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button id="caVoiceNo" style="border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:10px;padding:8px 16px;cursor:pointer;font:inherit">取消</button><button id="caVoiceGo" style="border:0;background:var(--accent,#2563eb);color:#fff;border-radius:10px;padding:8px 18px;cursor:pointer;font:inherit;font-weight:600">开始说话</button></div></div>';
    document.body.appendChild(o);
    var tx = o.querySelector("#caVoiceTx"), go = o.querySelector("#caVoiceGo"), rec = null, finalTxt = "", started = false;
    var close = function () { try { rec && rec.abort(); } catch (e) {} o.remove(); };
    o.querySelector("#caVoiceNo").onclick = close;
    go.onclick = function () {
      if (started) { try { rec.stop(); } catch (e) {} return; }
      finalTxt = "";
      try { rec = new SR(); } catch (e) { tx.textContent = "无法启动：" + (e.message || e); return; }
      rec.lang = "zh-CN"; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      rec.onstart = function () { started = true; tx.innerHTML = '<span style="color:#2563eb">● 正在听，请说话…</span>'; go.textContent = "停止"; };
      rec.onresult = function (ev) { var inter = ""; for (var i = ev.resultIndex; i < ev.results.length; i++) { var r = ev.results[i]; if (r.isFinal) finalTxt += r[0].transcript; else inter += r[0].transcript; } tx.textContent = (finalTxt + inter) || "…"; };
      rec.onerror = function (ev) { started = false; go.textContent = "开始说话"; tx.innerHTML = '<span style="color:#dc2626">识别出错：' + (ev.error || "未知") + '。请检查麦克风权限后重试。</span>'; try { rec.stop(); } catch (e) {} };
      rec.onend = function () {
        started = false; go.textContent = "开始说话";
        if (finalTxt.trim()) { onFinal(finalTxt.trim()); close(); }
      };
      try { rec.start(); } catch (e) { tx.textContent = "启动失败：" + (e.message || e); }
    };
  }

  /* ---------- 给输入条注入 🎤 / 🔊 按钮 ---------- */
  function vbtn(title, cls, icon, onclick) {
    injectStyle();
    var b = document.createElement("button"); b.type = "button"; b.title = title; b.className = cls; b.innerHTML = icon;
    b.setAttribute("aria-label", title); b.onclick = onclick; return b;
  }
  function injectVoiceButtons(bar, getInput) {
    if (!bar || bar.querySelector(".ca-mic, .ca-spk")) return;
    var nativeMic = !!bar.querySelector('[data-act="aivoice"]');   // 页面自带「语音」按钮时，不再重复注入麦克风
    if (voiceSupported && !nativeMic) {
      var mic = vbtn("语音输入", "ca-mic", ICON_MIC, function () { var ta = getInput(); openVoice(function (t) { if (ta) { ta.value = (ta.value ? ta.value + " " : "") + t; ta.focus(); } }); });
      bar.insertBefore(mic, bar.firstChild);
    }
    var spk = vbtn("朗读回复", "ca-spk" + (ttsOn ? " on" : ""), ttsOn ? ICON_SPK_ON : ICON_SPK_OFF, function () { setTts(!ttsOn); if (ttsOn) speak("已开启朗读，下次回复会自动读出来。"); });
    bar.insertBefore(spk, bar.firstChild);
  }
  function enhanceStaticPanels() {
    document.querySelectorAll(".ca-ft").forEach(function (ft) {
      if (ft.querySelector(".ca-mic, .ca-spk")) return;
      var input = ft.querySelector("textarea");
      var row = document.createElement("div"); row.className = "ca-voicerow"; row.style.cssText = "display:flex;gap:6px;margin-bottom:6px";
      ft.insertBefore(row, ft.firstChild);
      injectVoiceButtons(row, function () { return input; });
    });
  }
  function scanDynamic() {
    var sb = document.querySelector('[data-care="send"]'); if (sb) { var b1 = sb.closest(".bar"); if (b1) injectVoiceButtons(b1, function () { return document.getElementById("careInput"); }); }
    var ab = document.querySelector('[data-act="aisend"]'); if (ab) { var b2 = ab.closest(".bar"); if (b2) injectVoiceButtons(b2, function () { return document.getElementById("aiin"); }); }
  }

  /* ---------- 朗读新回复（按内容去重，经得起页面重渲染）---------- */
  var spokenTexts = new Set(), warmedUp = false;
  function speakNew() {
    document.querySelectorAll(".ca-b.a, .aib.a, .care-msg.ai").forEach(function (el) {
      var t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length < 2) return;
      if (/^(正在查|正在思考|处理中|…|\.)/.test(t)) return;
      var h = t.replace(/\s+/g, " ").slice(0, 300);
      if (spokenTexts.has(h)) return;
      spokenTexts.add(h);
      if (spokenTexts.size > 300) { var first = spokenTexts.values().next().value; spokenTexts.delete(first); }
      if (!warmedUp) return;
      speak(t);
    });
  }

  /* ---------- 提醒铃铛 + 面板 ---------- */
  var rem = { list: [] };
  /* 铃铛与面板的样式：深蓝玻璃 + 蓝紫渐变，和患者端「深海·科技」主题一致；自带颜色，三端通用 */
  function injectStyle() {
    if (document.getElementById("caRemStyle")) return;
    var s = document.createElement("style"); s.id = "caRemStyle";
    s.textContent = [
      "#caBell{position:relative;flex:none;width:36px;height:36px;min-height:0!important;padding:0!important;border-radius:50%;border:1px solid rgba(150,166,255,.38);background:rgba(18,28,104,.72);color:#dfe6ff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 6px 20px -8px rgba(100,110,255,.7);transition:transform .15s,box-shadow .2s}",
      "#caBell.fixed{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;z-index:8000;width:40px;height:40px}",
      "#caBell:active{transform:scale(.94)}",
      "#caBell svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",
      "#caBell.has{color:#fff;border-color:rgba(170,186,255,.7);box-shadow:0 0 0 3px rgba(123,147,255,.18),0 6px 22px -6px rgba(120,120,255,.9)}",
      "#caBell.has svg{animation:caRing 4.5s ease-in-out infinite;transform-origin:50% 12%}",
      "@keyframes caRing{0%,86%,100%{transform:rotate(0)}89%{transform:rotate(14deg)}92%{transform:rotate(-12deg)}95%{transform:rotate(8deg)}98%{transform:rotate(-4deg)}}",
      "@media (prefers-reduced-motion:reduce){#caBell.has svg{animation:none}}",
      "#caBellBadge{position:absolute;top:-3px;right:-3px;background:linear-gradient(135deg,#ff8a5c,#ff4f8b);color:#fff;font-size:10px;min-width:16px;height:16px;border-radius:8px;display:none;align-items:center;justify-content:center;padding:0 4px;font-weight:700;box-shadow:0 2px 8px rgba(255,79,139,.55)}",
      "#caRemPanel{position:fixed;top:calc(env(safe-area-inset-top,0px) + 56px);right:12px;z-index:8001;width:340px;max-width:calc(100vw - 24px);max-height:72vh;overflow-y:auto;background:linear-gradient(160deg,rgba(24,38,122,.97),rgba(10,16,72,.97));border:1px solid rgba(150,166,255,.3);border-radius:18px;box-shadow:0 24px 60px -24px rgba(0,0,40,.9);padding:16px;font-size:14px;color:#e9edff;display:none;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);color-scheme:dark}",
      "#caRemPanel .rm-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}",
      "#caRemPanel .rm-h b{font-size:16px;letter-spacing:.02em;color:#f4f6ff}",
      "#caRemPanel .rm-x{border:0;background:rgba(255,255,255,.08);color:#b7c3f3;width:30px;height:30px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer}",
      ".ca-mic,.ca-spk{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;border:1px solid rgba(148,163,184,.5);background:#fff;color:#334155;border-radius:10px;cursor:pointer;flex:none}",
      ".ca-mic svg,.ca-spk svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",
      ".ca-spk.on{color:#2563eb;border-color:#2563eb}",
      "textarea{transition:height .16s ease}",
      "@media (prefers-reduced-motion:reduce){textarea{transition:none!important}}",
      "#caRemPanel textarea{display:block;min-height:44px;line-height:1.5;overflow:hidden}",
      "#caRemPanel input,#caRemPanel textarea{width:100%;box-sizing:border-box;background:rgba(4,9,50,.6);border:1px solid rgba(150,166,255,.28);color:#eef1ff;-webkit-text-fill-color:#eef1ff;border-radius:11px;padding:10px 12px;font:inherit;font-size:15px;outline:0}",
      "#caRemPanel input:focus,#caRemPanel textarea:focus{border-color:#8aa2ff;box-shadow:0 0 0 3px rgba(122,146,255,.25)}",
      "#caRemPanel input::placeholder,#caRemPanel textarea::placeholder{color:#7d8bc6;-webkit-text-fill-color:#7d8bc6}",
      "#caRemPanel .rm-q{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}",
      "#caRemPanel .rm-q button{border:1px solid rgba(150,166,255,.28);background:rgba(255,255,255,.06);color:#cdd6ff;border-radius:999px;padding:7px 12px;font:inherit;font-size:12.5px;cursor:pointer}",
      "#caRemPanel .rm-q button:active{background:rgba(123,147,255,.28);color:#fff}",
      "#caRemPanel .rm-row{display:flex;gap:8px;align-items:stretch;margin-top:8px}",
      "#caRemPanel .rm-row input{flex:1;min-width:0;width:auto}",
      "#caRemPanel .rm-add{flex:none;border:0;background:linear-gradient(135deg,#4f6bff,#8a5cff);color:#fff;border-radius:11px;padding:0 18px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 20px -10px rgba(110,110,255,.9)}",
      "#caRemPanel .rm-hint{font-size:11.5px;color:#8f9cd6;margin-top:6px}",
      "#caRemPanel .rm-list{margin-top:10px}",
      "#caRemPanel .rm-it{display:flex;gap:8px;align-items:center;padding:11px 0;border-bottom:1px solid rgba(146,163,255,.14)}",
      "#caRemPanel .rm-it:last-child{border-bottom:0}",
      "#caRemPanel .rm-m{flex:1;min-width:0}",
      "#caRemPanel .rm-t{font-weight:600;font-size:14px;color:#f1f4ff;word-break:break-word}",
      "#caRemPanel .rm-d{font-size:12px;color:#9db1ff;margin-top:3px}",
      "#caRemPanel .rm-d::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:#ffe86b;box-shadow:0 0 6px #ffe86b;margin-right:6px;vertical-align:1px}",
      "#caRemPanel .rm-d.n{color:#7f8cc4}#caRemPanel .rm-d.n::before{background:#6f7cb8;box-shadow:none}",
      "#caRemPanel .rm-ok,#caRemPanel .rm-del{flex:none;min-width:46px;min-height:36px;border-radius:10px;font:inherit;font-size:12.5px;cursor:pointer}",
      "#caRemPanel .rm-ok{border:1px solid rgba(150,170,255,.35);background:rgba(255,255,255,.06);color:#dfe6ff}",
      "#caRemPanel .rm-del{border:1px solid rgba(255,120,120,.35);background:rgba(255,90,90,.12);color:#ffb3ab}",
      "#caRemPanel .rm-empty{color:#8f9cd6;font-size:13px;padding:16px 0;text-align:center}",
      "#caRemPanel .rm-ft{font-size:11px;color:#7f8cc4;margin-top:10px;line-height:1.55}"
    ].join("\n");
    document.head.appendChild(s);
  }
  function ensureBell() {
    if (document.getElementById("caBell")) return;
    injectStyle();
    var b = document.createElement("button"); b.id = "caBell"; b.type = "button"; b.title = "提醒";
    b.setAttribute("aria-label", "提醒");
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span id="caBellBadge"></span>';
    b.onclick = togglePanel;
    var host = document.querySelector("#authBar .authbar-in");      // 患者端：放进顶栏，不再悬浮遮挡「退出登录」
    if (host) host.appendChild(b); else { b.className = "fixed"; document.body.appendChild(b); }
    updateBadge();
  }
  function updateBadge() {
    var bd = document.getElementById("caBellBadge"); if (!bd) return;
    var n = (rem.list || []).filter(function (t) { return !t.done; }).length;
    var bell = document.getElementById("caBell"); if (bell) bell.classList.toggle("has", n > 0);
    if (n > 0) { bd.style.display = "flex"; bd.textContent = n > 99 ? "99+" : String(n); } else bd.style.display = "none";
  }
  function panelEl() { return document.getElementById("caRemPanel"); }
  function togglePanel() { var p = panelEl(); if (p) { p.style.display = p.style.display === "none" ? "block" : "none"; if (p.style.display !== "none") renderPanel(); } else { ensurePanel(); renderPanel(); panelEl().style.display = "block"; } }
  function ensurePanel() {
    if (panelEl()) return;
    injectStyle();
    var p = document.createElement("div"); p.id = "caRemPanel";
    p.style.display = "none";
    document.body.appendChild(p);
  }
  /* 时间一律按北京时间处理（后端也按北京时间解析），选择器、快捷按钮、最小值口径一致 */
  function bjStr(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 16); }
  function quickWhen(k) {
    var now = Date.now();
    if (k === "10m") return bjStr(now + 10 * 60e3);
    var bj = new Date(now + 8 * 3600e3), y = bj.getUTCFullYear(), m = bj.getUTCMonth(), d = bj.getUTCDate();
    var at = function (dd, h) { return Date.UTC(y, m, dd, h, 0) - 8 * 3600e3; };
    if (k === "tn") { var t = at(d, 20); if (t <= now + 60e3) t = at(d + 1, 20); return bjStr(t); }
    return bjStr(at(d + 1, 9));
  }
  function renderPanel() {
    var p = panelEl(); if (!p) return;
    var oldText = p.querySelector("#caRemText"), oldWhen = p.querySelector("#caRemWhen");
    var keepText = oldText ? oldText.value : "", keepWhen = oldWhen ? oldWhen.value : "";   // 刷新列表时别把已填的内容冲掉
    var rows = (rem.list || []).filter(function (t) { return !t.done; }).map(function (t) {
      return '<div class="rm-it"><div class="rm-m"><div class="rm-t">' + escHtml(t.text) + '</div>'
        + (t.due ? '<div class="rm-d">' + escHtml(t.due) + '</div>' : '<div class="rm-d n">未设提醒时间</div>')
        + '</div><button class="rm-ok" data-rm-done="' + escHtml(t.id) + '">完成</button><button class="rm-del" data-rm-del="' + escHtml(t.id) + '">删除</button></div>';
    }).join("");
    p.innerHTML = '<div class="rm-h"><b>提醒</b><button class="rm-x" id="caRemClose" aria-label="关闭">×</button></div>'
      + '<textarea id="caRemText" rows="1" placeholder="提醒内容，例如：就医" maxlength="200"></textarea>'
      + '<div class="rm-q"><button type="button" data-q="10m">10 分钟后</button><button type="button" data-q="tn">今晚 8 点</button><button type="button" data-q="tm">明早 9 点</button></div>'
      + '<div class="rm-row"><input id="caRemWhen" type="datetime-local" step="60" min="' + bjStr(Date.now()) + '" aria-label="提醒时间（可不选）"><button id="caRemAdd" class="rm-add">添加</button></div>'
      + '<div class="rm-hint">点上面的快捷时间，或自己选；不选时间就只记待办，不提醒（北京时间）。</div>'
      + '<div class="rm-list" id="caRemList">' + (rows || '<div class="rm-empty">还没有提醒。让 AI 帮你记，或在上面添加。</div>') + '</div>'
      + '<div class="rm-ft">到点会在浏览器通知（需保持页面打开并允许通知）。关闭浏览器后收不到。</div>';
    p.querySelector("#caRemText").value = keepText; p.querySelector("#caRemWhen").value = keepWhen;
    p.querySelector("#caRemClose").onclick = function () { p.style.display = "none"; };
    p.querySelectorAll("[data-q]").forEach(function (b) { b.onclick = function () { p.querySelector("#caRemWhen").value = quickWhen(b.getAttribute("data-q")); }; });
    p.querySelector("#caRemAdd").onclick = function () {
      var text = (p.querySelector("#caRemText").value || "").trim();
      var when = (p.querySelector("#caRemWhen").value || "").trim();   // datetime-local 形如 2026-12-03T09:00，后端可直接解析
      if (!text) { p.querySelector("#caRemText").focus(); return; }
      addReminder(text, when).then(function (ok) { if (ok) { p.querySelector("#caRemText").value = ""; p.querySelector("#caRemWhen").value = ""; } });
    };
    p.querySelectorAll("[data-rm-done]").forEach(function (b) { b.onclick = function () { doneReminder(b.getAttribute("data-rm-done")); }; });
    p.querySelectorAll("[data-rm-del]").forEach(function (b) { b.onclick = function () { if (confirm("删除这条提醒？")) delReminder(b.getAttribute("data-rm-del")); }; });
  }
  function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function refreshReminders() {
    return api("/api/reminders", { method: "GET" }).then(function (r) {
      if (r.data && r.data.ok) { rem.list = r.data.items || []; updateBadge(); if (panelEl() && panelEl().style.display !== "none") renderPanel(); }
    }).catch(function () {});
  }
  function addReminder(text, when) {
    return api("/api/reminders", { method: "POST", body: { text: text, when: when } }).then(function (r) {
      if (r.data && r.data.ok) { refreshReminders(); speak("已记下提醒：" + text); return true; }
      alert(r.data && r.data.msg ? r.data.msg : "创建提醒失败"); return false;
    });
  }
  function doneReminder(id) { return api("/api/reminders/done", { method: "POST", body: { id: id } }).then(refreshReminders); }
  function delReminder(id) { return api("/api/reminders/delete", { method: "POST", body: { id: id } }).then(refreshReminders); }
  function notifyReminder(t) {
    speak("提醒：" + t.text);
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("就医伴侣提醒", { body: t.text + (t.due ? "（原定 " + t.due + "）" : ""), tag: t.id }); } catch (e) {}
    var flash = document.createElement("div");
    flash.style.cssText = "position:fixed;left:50%;top:70px;transform:translateX(-50%);background:linear-gradient(160deg,rgba(24,38,122,.98),rgba(10,16,72,.98));color:#eef1ff;border:1px solid rgba(150,166,255,.35);border-left:4px solid #ffe86b;border-radius:14px;padding:11px 16px;box-shadow:0 16px 40px -14px rgba(0,0,40,.8);z-index:8500;max-width:90vw;font-size:14px";
    flash.innerHTML = "<b>提醒</b><div>" + escHtml(t.text) + "</div>";
    document.body.appendChild(flash);
    setTimeout(function () { flash.style.transition = "opacity .5s"; flash.style.opacity = "0"; setTimeout(function () { flash.remove(); }, 500); }, 9000);
  }
  function pollDue() {
    api("/api/reminders/due", { method: "GET" }).then(function (r) {
      if (r.data && r.data.ok && Array.isArray(r.data.due) && r.data.due.length) {
        r.data.due.forEach(notifyReminder);
        refreshReminders();
      }
    }).catch(function () {});
  }
  function reqNotifPerm() { try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) {} }

  /* ---------- 暴露给页面 ---------- */
  window.CA = {
    uid: uid,
    base: base,
    refreshReminders: refreshReminders,
    addReminder: addReminder,
    speak: speak,
    openVoice: openVoice,
    tts: function () { return ttsOn; }
  };

  /* ---------- 启动 ---------- */
  /* ---------- 输入框自适应高度：随输入长高，删字回弹 ---------- */
  function fitTa(t) {
    if (!t || t.tagName !== "TEXTAREA" || t.hasAttribute("data-no-grow")) return;
    if (!t.clientWidth) return;                                   // 隐藏中（折叠/未显示），显示后再算
    var key = t.value + "|" + t.clientWidth;
    if (t._caKey === key) return; t._caKey = key;                 // 内容和宽度没变就不重算，避免无谓重排
    var min = parseFloat(getComputedStyle(t).minHeight) || 0;
    var max = Math.max(min, Math.round(window.innerHeight * 0.45));
    var border = t.offsetHeight - t.clientHeight, prev = t.offsetHeight;
    t.style.transition = "none"; t.style.height = "auto";
    var need = t.scrollHeight + border;
    var h = Math.max(min, Math.min(need, max));
    t.style.height = prev + "px"; void t.offsetHeight;            // 从当前高度出发，才有长高/回弹动画
    t.style.transition = ""; t.style.height = h + "px";
    t.style.overflowY = need > max ? "auto" : "hidden";
  }
  function fitAllTa() { var l = document.getElementsByTagName("textarea"); for (var i = 0; i < l.length; i++) fitTa(l[i]); }
  document.addEventListener("input", function (e) { if (e.target && e.target.tagName === "TEXTAREA") fitTa(e.target); }, true);
  document.addEventListener("focusin", function (e) { if (e.target && e.target.tagName === "TEXTAREA") fitTa(e.target); }, true);
  document.addEventListener("toggle", function () { requestAnimationFrame(fitAllTa); }, true);
  window.addEventListener("resize", function () { clearTimeout(fitAllTa._t); fitAllTa._t = setTimeout(fitAllTa, 120); });
  try {                                                           // 程序里 ta.value = "" 清空（如发送后）也要回弹
    var vd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (vd && vd.set) Object.defineProperty(HTMLTextAreaElement.prototype, "value", { configurable: true, get: vd.get, set: function (v) { vd.set.call(this, v); var el = this; requestAnimationFrame(function () { fitTa(el); }); } });
  } catch (e) {}

  function boot() {
    ensureBell();
    enhanceStaticPanels();
    scanDynamic();
    speakNew();
    refreshReminders();
    setTimeout(function () { warmedUp = true; }, 2500);
    setTimeout(pollDue, 6000);
    setInterval(pollDue, 45000);
    // 用户第一次交互时请求通知权限（浏览器策略要求）
    var once = function () { reqNotifPerm(); document.removeEventListener("click", once); document.removeEventListener("keydown", once); };
    document.addEventListener("click", once); document.addEventListener("keydown", once);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 动态渲染的输入条 / 新回复：用观察器兜底（患者端 CARE_UI 每次发消息会重渲染）
  setInterval(function () { enhanceStaticPanels(); scanDynamic(); speakNew(); fitAllTa(); }, 800);
})();
