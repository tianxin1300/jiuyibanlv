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
    return fetch(url, { method: opts.method || "GET", headers: authHeaders(opts.headers), body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return ({}); }).then(function (j) { return { ok: r.ok, status: r.status, data: j }; }); });
  }

  /* ---------- TTS 朗读 ---------- */
  var ttsOn = (function () { try { return localStorage.getItem("ca_tts") === "1"; } catch (e) { return false; } })();
  function setTts(on) {
    ttsOn = !!on;
    try { localStorage.setItem("ca_tts", ttsOn ? "1" : "0"); } catch (e) {}
    document.querySelectorAll(".ca-spk").forEach(function (b) { b.classList.toggle("on", ttsOn); b.textContent = ttsOn ? "🔊" : "🔈"; });
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
  function vbtn(title, cls, txt, onclick) {
    var b = document.createElement("button"); b.type = "button"; b.title = title; b.className = cls; b.textContent = txt;
    b.style.cssText = "border:1px solid rgba(148,163,184,.5);background:#fff;color:#334155;border-radius:10px;padding:6px 10px;font-size:13px;cursor:pointer;line-height:1";
    b.onclick = onclick; return b;
  }
  function injectVoiceButtons(bar, getInput) {
    if (!bar || bar.querySelector(".ca-mic, .ca-spk")) return;
    if (voiceSupported) {
      var mic = vbtn("语音输入", "ca-mic", "🎤", function () { var ta = getInput(); openVoice(function (t) { if (ta) { ta.value = (ta.value ? ta.value + " " : "") + t; ta.focus(); } }); });
      bar.insertBefore(mic, bar.firstChild);
    }
    var spk = vbtn("朗读回复", "ca-spk" + (ttsOn ? " on" : ""), ttsOn ? "🔊" : "🔈", function () { setTts(!ttsOn); if (ttsOn) speak("已开启朗读，下次回复会自动读出来。"); });
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
  function ensureBell() {
    if (document.getElementById("caBell")) return;
    var b = document.createElement("button"); b.id = "caBell"; b.type = "button"; b.title = "提醒";
    b.setAttribute("aria-label", "提醒");
    b.style.cssText = "position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);right:12px;z-index:8000;width:40px;height:40px;border-radius:50%;border:0;background:var(--accent,#2563eb);color:#fff;font-size:18px;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,.4);display:flex;align-items:center;justify-content:center";
    b.innerHTML = '🔔<span id="caBellBadge" style="position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;font-size:10px;min-width:16px;height:16px;border-radius:8px;display:none;align-items:center;justify-content:center;padding:0 3px;font-weight:700"></span>';
    b.onclick = togglePanel; document.body.appendChild(b); updateBadge();
  }
  function updateBadge() {
    var bd = document.getElementById("caBellBadge"); if (!bd) return;
    var n = (rem.list || []).filter(function (t) { return !t.done; }).length;
    if (n > 0) { bd.style.display = "flex"; bd.textContent = n > 99 ? "99+" : String(n); } else bd.style.display = "none";
  }
  function panelEl() { return document.getElementById("caRemPanel"); }
  function togglePanel() { var p = panelEl(); if (p) { p.style.display = p.style.display === "none" ? "block" : "none"; if (p.style.display !== "none") renderPanel(); } else { ensurePanel(); renderPanel(); } }
  function ensurePanel() {
    if (panelEl()) return;
    var p = document.createElement("div"); p.id = "caRemPanel";
    p.style.cssText = "position:fixed;top:calc(env(safe-area-inset-top,0px) + 58px);right:12px;z-index:8001;width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow-y:auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:14px;font-size:14px;color:#0f172a;display:none";
    document.body.appendChild(p);
  }
  function renderPanel() {
    var p = panelEl(); if (!p) return;
    var rows = (rem.list || []).filter(function (t) { return !t.done; }).map(function (t) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f5f9"><div style="flex:1"><div style="font-weight:600;font-size:13px">' + escHtml(t.text) + '</div>' + (t.due ? '<div style="font-size:12px;color:#64748b">⏰ ' + escHtml(t.due) + '</div>' : '<div style="font-size:12px;color:#94a3b8">未设提醒时间</div>') + '</div><button data-rm-done="' + escHtml(t.id) + '" style="border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:8px;padding:3px 8px;font-size:12px;cursor:pointer">完成</button><button data-rm-del="' + escHtml(t.id) + '" style="border:0;background:#fef2f2;color:#b91c1c;border-radius:8px;padding:3px 8px;font-size:12px;cursor:pointer">删</button></div>';
    }).join("");
    p.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b style="font-size:15px">提醒</b><button id="caRemClose" style="border:0;background:none;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1">×</button></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:10px"><input id="caRemText" placeholder="提醒内容" style="flex:1;border:1px solid #e2e8f0;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px"><input id="caRemWhen" placeholder="时间：明天上午9点 / 10分钟后" style="width:130px;border:1px solid #e2e8f0;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px"><button id="caRemAdd" style="border:0;background:var(--accent,#2563eb);color:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;font-weight:600">添加</button></div>'
      + '<div id="caRemList">' + (rows || '<div style="color:#94a3b8;font-size:13px;padding:12px 0;text-align:center">还没有提醒。让 AI 帮你记，或在上面添加。</div>') + '</div>'
      + '<div style="font-size:11px;color:#94a3b8;margin-top:8px;line-height:1.5">到点会在浏览器通知（需保持页面打开并允许通知）。关闭浏览器后收不到。</div>';
    p.querySelector("#caRemClose").onclick = function () { p.style.display = "none"; };
    p.querySelector("#caRemAdd").onclick = function () {
      var text = (p.querySelector("#caRemText").value || "").trim();
      var when = (p.querySelector("#caRemWhen").value || "").trim();
      if (!text) return;
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
    flash.style.cssText = "position:fixed;left:50%;top:70px;transform:translateX(-50%);background:#fff;border:1px solid #e2e8f0;border-left:4px solid var(--accent,#2563eb);border-radius:10px;padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:8500;max-width:90vw;font-size:14px";
    flash.innerHTML = "<b>⏰ 提醒</b><div>" + escHtml(t.text) + "</div>";
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
  setInterval(function () { enhanceStaticPanels(); scanDynamic(); speakNew(); }, 800);
})();
