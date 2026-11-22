/* 患者页离线缓存：页面「先给缓存、后台更新」，医院配置「先联网、4 秒不通再用缓存」。只缓存本站的 index、config 和 img 项目图片。 */
const V = 'companion-sw-2026.11.39';
const key = u => { const p = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname; return new Request(u.origin + p); };
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
    const r = e.request, u = new URL(r.url);
    if (r.method !== 'GET' || u.origin !== self.origin) return;
    const isImg = /\/img\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(u.pathname), isCfg = /\/config\/[^/]+\.json$/.test(u.pathname), isPage = r.mode === 'navigate' || /\/index\.html$/.test(u.pathname);
    if (!isCfg && !isPage && !isImg) return;
    if (isImg) {
        /* 项目图片：先用缓存，没有再联网并存起来；最多缓存 60 张，超出时不再新增（避免占满手机空间） */
        e.respondWith(caches.open(V).then(async c => {
            const k0 = new Request(u.origin + u.pathname), hit = await c.match(k0);
            if (hit) return hit;
            const res = await fetch(r);
            if (res.ok) { const n = (await c.keys()).filter(q => /\/img\//.test(q.url)).length; if (n < 60) c.put(k0, res.clone()); }
            return res;
        }));
        return;
    }
    const k = key(u);
    if (isPage) {
        e.respondWith(caches.open(V).then(async c => {
            const hit = await c.match(k);
            const net = fetch(r).then(res => { if (res.ok) c.put(k, res.clone()); return res; });
            if (hit) { e.waitUntil(net.catch(() => 0)); return hit; }
            return net;
        }));
    } else {
        e.respondWith(caches.open(V).then(async c => {
            const key2 = new Request(u.origin + u.pathname);
            const net = fetch(r).then(res => { if (res.ok) c.put(key2, res.clone()); return res; });
            const to = new Promise((_, rej) => setTimeout(rej, 4000));
            try { return await Promise.race([net, to]); }
            catch (err) { const hit = await c.match(key2); if (hit) { e.waitUntil(net.catch(() => 0)); return hit; } return net; }
        }));
    }
});
