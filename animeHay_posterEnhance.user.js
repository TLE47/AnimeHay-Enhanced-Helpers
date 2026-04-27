// ==UserScript==
// @name         AnimeHay Real Upscale
// @version      7.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @description  GPU 4× upscale, GM_setValue cache (1000+ posters), live status UI
// @author       TLE47
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─── Config ───────────────────────────────────────────────────────────────
    const SCALE      = 4;
    const MAX_ACTIVE = 4;
    const MAX_CACHED = 1500;
    const LRU_KEY    = '__ahu_lru__';
    const META_KEY   = '__ahu_meta__';

    const QUEUE = [];
    let active  = 0;

    // ─── Session stats ────────────────────────────────────────────────────────
    const session = { hits: 0, misses: 0, queued: 0, done: 0 };

    // ─── CSS ──────────────────────────────────────────────────────────────────
    GM_addStyle(`
        .mc__poster img {
            image-rendering: auto;
            border-radius: 4px;
            transition: transform 0.2s ease, opacity 0.25s ease;
        }
        .mc__poster img[data-upscaling] { opacity: 0.8; }
        .mc__poster:hover img { transform: scale(1.04); position: relative; z-index: 2; }
        .mc__poster { overflow: visible !important; }

        #ahu-pill {
            position: fixed; bottom: 18px; right: 18px;
            z-index: 2147483647; font-family: system-ui, sans-serif;
            font-size: 12px; user-select: none; cursor: pointer;
        }
        #ahu-pill-bar {
            display: flex; align-items: center; gap: 7px;
            padding: 6px 14px; border-radius: 999px;
            background: rgba(30,30,35,0.88); backdrop-filter: blur(8px);
            color: #e8e8e8; box-shadow: 0 2px 10px rgba(0,0,0,0.35);
            transition: background 0.25s, box-shadow 0.25s; white-space: nowrap;
        }
        #ahu-pill-bar.active { background: rgba(15,110,86,0.92); }
        #ahu-pill-bar.done   { background: rgba(30,30,35,0.7); }
        #ahu-dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: #4ec99a; flex-shrink: 0; transition: background 0.3s;
        }
        #ahu-pill-bar.active #ahu-dot { background: #fff; animation: ahu-pulse 1s ease-in-out infinite; }
        #ahu-pill-bar.done   #ahu-dot { background: #4ec99a; }
        @keyframes ahu-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }

        #ahu-panel {
            display: none; position: absolute; bottom: calc(100% + 8px); right: 0;
            width: 220px; background: rgba(20,20,24,0.96); backdrop-filter: blur(12px);
            border-radius: 12px; padding: 14px 16px; color: #e0e0e0;
            box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        }
        #ahu-panel.open { display: block; }
        #ahu-panel h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: #fff; letter-spacing: 0.02em; }
        .ahu-row {
            display: flex; justify-content: space-between;
            padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.07); font-size: 12px;
        }
        .ahu-row:last-of-type { border-bottom: none; }
        .ahu-row span:last-child { color: #4ec99a; font-weight: 500; }
        .ahu-row span:last-child.warn { color: #f0a04a; }
        #ahu-progress-wrap {
            margin: 8px 0 2px; height: 4px;
            background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;
        }
        #ahu-progress-bar { height: 100%; background: #4ec99a; border-radius: 2px; width: 0%; transition: width 0.3s ease; }
        #ahu-clear-btn {
            margin-top: 10px; width: 100%; padding: 6px 0;
            background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.3);
            border-radius: 6px; color: #ff7070; font-size: 11px; cursor: pointer; transition: background 0.2s;
        }
        #ahu-clear-btn:hover { background: rgba(255,80,80,0.28); }
    `);

    // ─── GUI ──────────────────────────────────────────────────────────────────
    const pill = document.createElement('div');
    pill.id = 'ahu-pill';
    pill.innerHTML = `
        <div id="ahu-panel">
            <h3>AHU Upscale</h3>
            <div id="ahu-progress-wrap"><div id="ahu-progress-bar"></div></div>
            <div class="ahu-row"><span>Session</span><span id="ahu-s-session">—</span></div>
            <div class="ahu-row"><span>Cache hits</span><span id="ahu-s-hits">—</span></div>
            <div class="ahu-row"><span>Total cached</span><span id="ahu-s-total">—</span></div>
            <div class="ahu-row"><span>Storage used</span><span id="ahu-s-size">—</span></div>
            <button id="ahu-clear-btn">Clear cache</button>
        </div>
        <div id="ahu-pill-bar">
            <span id="ahu-dot"></span>
            <span id="ahu-pill-label">AHU ready</span>
        </div>`;
    document.body.appendChild(pill);

    const pillBar   = document.getElementById('ahu-pill-bar');
    const pillLabel = document.getElementById('ahu-pill-label');
    const panel     = document.getElementById('ahu-panel');
    const progBar   = document.getElementById('ahu-progress-bar');

    pill.addEventListener('click', async e => {
        e.stopPropagation();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) await refreshPanel();
    });
    document.addEventListener('click', () => panel.classList.remove('open'));

    document.getElementById('ahu-clear-btn').addEventListener('click', async e => {
        e.stopPropagation();
        await clearCache();
        await refreshPanel();
        pillLabel.textContent = 'Cache cleared';
        setTimeout(() => updatePill(), 2000);
    });

    function updatePill() {
        const total    = session.queued;
        const done     = session.done;
        const pct      = total > 0 ? Math.round((done / total) * 100) : 100;
        const isActive = active > 0 || QUEUE.length > 0;
        progBar.style.width = pct + '%';
        if (isActive) {
            pillBar.className = 'active';
            pillLabel.textContent = `↑ ${done}/${total} — ${pct}%`;
        } else if (total > 0) {
            pillBar.className = 'done';
            pillLabel.textContent = `✦ ${session.hits} hits · ${session.misses} upscaled`;
        } else {
            pillBar.className = '';
            pillLabel.textContent = 'AHU ready';
        }
    }

    async function refreshPanel() {
        const meta  = getLRUandMeta();
        const lru   = meta.lru;
        const bytes = meta.bytes;
        const mb    = (bytes / 1024 / 1024).toFixed(1);
        const total = session.hits + session.misses;
        const hitRate = total > 0 ? Math.round(session.hits / total * 100) : 0;

        document.getElementById('ahu-s-session').textContent = `${session.done} processed`;
        document.getElementById('ahu-s-hits').textContent    = `${session.hits} / ${total} (${hitRate}%)`;

        const totalEl = document.getElementById('ahu-s-total');
        totalEl.textContent = `${lru.length} posters`;
        totalEl.className   = lru.length > MAX_CACHED * 0.9 ? 'warn' : '';
        document.getElementById('ahu-s-size').textContent = `${mb} MB`;

        const pct = session.queued > 0 ? Math.round(session.done / session.queued * 100) : 100;
        progBar.style.width = pct + '%';
    }

    // ─── GM Storage helpers ───────────────────────────────────────────────────
    // In-memory LRU + meta cache to avoid repeated GM_getValue calls
    let _lruCache  = null;  // string[]
    let _metaCache = null;  // { totalBytes: number }

    function getLRUandMeta() {
        if (!_lruCache) {
            try { _lruCache = JSON.parse(GM_getValue(LRU_KEY, '[]')); }
            catch { _lruCache = []; }
        }
        if (!_metaCache) {
            try { _metaCache = JSON.parse(GM_getValue(META_KEY, '{}')); }
            catch { _metaCache = {}; }
        }
        return { lru: _lruCache, bytes: _metaCache.totalBytes || 0 };
    }

    function flushLRU() {
        GM_setValue(LRU_KEY, JSON.stringify(_lruCache));
    }
    function flushMeta() {
        GM_setValue(META_KEY, JSON.stringify(_metaCache));
    }

    function cacheGet(key) {
        getLRUandMeta();
        const val = GM_getValue('ahu_img_' + key, null);
        if (!val) return null;

        // Promote to tail in LRU
        const pos = _lruCache.indexOf(key);
        if (pos !== -1) { _lruCache.splice(pos, 1); _lruCache.push(key); flushLRU(); }
        return val;
    }

    function cacheSet(key, dataURL) {
        getLRUandMeta();
        const bytes = dataURL.length * 2;

        // Evict oldest until under MAX_CACHED
        while (_lruCache.length >= MAX_CACHED) {
            const evict = _lruCache.shift();
            const old   = GM_getValue('ahu_img_' + evict, null);
            if (old) _metaCache.totalBytes = (_metaCache.totalBytes || 0) - old.length * 2;
            GM_deleteValue('ahu_img_' + evict);
        }

        GM_setValue('ahu_img_' + key, dataURL);

        const pos = _lruCache.indexOf(key);
        if (pos !== -1) _lruCache.splice(pos, 1);
        _lruCache.push(key);

        _metaCache.totalBytes = (_metaCache.totalBytes || 0) + bytes;

        flushLRU();
        flushMeta();
    }

    function clearCache() {
        getLRUandMeta();
        for (const key of _lruCache) GM_deleteValue('ahu_img_' + key);
        _lruCache  = [];
        _metaCache = {};
        flushLRU();
        flushMeta();
    }

    // ─── Key derivation ───────────────────────────────────────────────────────
    function titleKey(text) {
        return text
            .trim().toLowerCase()
            .replace(/[^a-z0-9\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF]+/g, '_')
            .slice(0, 120) + `_x${SCALE}`;
    }

    function getPosterTitle(img) {
        const poster = img.closest('.mc__poster');
        if (!poster) return null;
        const card   = poster.closest('[class*="item"]') || poster.parentElement;
        const nameEl = card?.querySelector('.mc_name, [class*="mc_name"]');
        return nameEl?.textContent?.trim() || null;
    }

    // ─── GM_xmlhttpRequest image fetch (bypasses CORS) ────────────────────────
    function fetchImageViaGM(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload(resp) {
                    if (resp.status < 200 || resp.status >= 300) { reject(new Error('HTTP ' + resp.status)); return; }
                    const blobUrl = URL.createObjectURL(resp.response);
                    const img = new Image();
                    img.onload  = () => { URL.revokeObjectURL(blobUrl); resolve(img); };
                    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('img load')); };
                    img.src = blobUrl;
                },
                onerror: reject,
            });
        });
    }

    // ─── WebGL setup ──────────────────────────────────────────────────────────
    // FIX: separate GL canvas from the readback 2D canvas
    const glCanvas   = document.createElement('canvas');
    const readCanvas = document.createElement('canvas');  // dedicated 2D canvas for readback
    const gl = glCanvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: false, depth: false, stencil: false,
    });

    function makeProgram(vertSrc, fragSrc) {
        function compile(type, src) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.warn('[AHU] Shader error:', gl.getShaderInfoLog(s));
            }
            return s;
        }
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vertSrc));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
        gl.linkProgram(p);
        return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
    }

    function makeTexture(source) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        return tex;
    }

    function makeFramebuffer(w, h) {
        const tex = makeTexture(null);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { fb, tex };
    }

    function deleteFB(f) {
        if (!f) return;
        gl.deleteTexture(f.tex);
        gl.deleteFramebuffer(f.fb);
    }

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    const VERT = `attribute vec2 a_pos;varying vec2 v_uv;
        void main(){v_uv=a_pos*0.5+0.5;v_uv.y=1.0-v_uv.y;gl_Position=vec4(a_pos,0.0,1.0);}`;

    const bicubicProg = makeProgram(VERT, `
        precision highp float;
        uniform sampler2D u_tex;uniform vec2 u_texSize;varying vec2 v_uv;
        float cubic(float t){float a=abs(t);
            if(a<1.0)return(1.5*a-2.5)*a*a+1.0;
            if(a<2.0)return((-0.5*a+2.5)*a-4.0)*a+2.0;
            return 0.0;}
        void main(){
            vec2 px=v_uv*u_texSize-0.5;vec2 f=fract(px);vec2 i0=floor(px);
            vec4 col=vec4(0.0);float ws=0.0;
            for(int ky=-1;ky<=2;ky++){float wy=cubic(float(ky)-f.y);
                for(int kx=-1;kx<=2;kx++){float wx=cubic(float(kx)-f.x);
                    vec2 sxy=clamp(i0+vec2(float(kx),float(ky)),vec2(0.0),u_texSize-1.0);
                    col+=texture2D(u_tex,(sxy+0.5)/u_texSize)*wx*wy;ws+=wx*wy;}}
            gl_FragColor=clamp(col/ws,0.0,1.0);}`);

    const sharpenProg = makeProgram(VERT, `
        precision highp float;
        uniform sampler2D u_tex;uniform vec2 u_texSize;varying vec2 v_uv;
        float luma(vec4 c){return dot(c.rgb,vec3(0.299,0.587,0.114));}
        void main(){
            vec2 px=1.0/u_texSize;
            vec4 c=texture2D(u_tex,v_uv);
            vec4 n=texture2D(u_tex,v_uv+vec2(0,-px.y)),s=texture2D(u_tex,v_uv+vec2(0,px.y));
            vec4 e=texture2D(u_tex,v_uv+vec2(px.x,0)),w=texture2D(u_tex,v_uv+vec2(-px.x,0));
            vec4 sharp=clamp(5.0*c-n-s-e-w,0.0,1.0);
            vec4 nw=texture2D(u_tex,v_uv+vec2(-px.x,-px.y)),ne=texture2D(u_tex,v_uv+vec2(px.x,-px.y));
            vec4 sw2=texture2D(u_tex,v_uv+vec2(-px.x,px.y)),se=texture2D(u_tex,v_uv+vec2(px.x,px.y));
            float gx=luma(-nw-2.0*w-sw2+ne+2.0*e+se),gy=luma(-nw-2.0*n-ne+sw2+2.0*s+se);
            float edge=clamp(sqrt(gx*gx+gy*gy)*4.0,0.0,1.0);
            gl_FragColor=mix(c,sharp,edge*0.72);}`);

    const glReady = !!(gl && bicubicProg && sharpenProg);

    function runPass(prog, srcTex, srcW, srcH, dstFb, dstW, dstH) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb);
        gl.viewport(0, 0, dstW, dstH);
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
        // FIX: pass source texture size to bicubic (was incorrectly passing dst size)
        gl.uniform2f(gl.getUniformLocation(prog, 'u_texSize'), srcW, srcH);
        const loc = gl.getAttribLocation(prog, 'a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function upscaleWebGL(imgEl, sw, sh) {
        // FIX: track all allocated resources for proper cleanup
        const srcTex = makeTexture(imgEl);
        const steps  = Math.log2(SCALE);

        let curTex = srcTex, curW = sw, curH = sh;
        let pingFB = null, pongFB = null;

        for (let step = 0; step < steps; step++) {
            const nw = curW * 2, nh = curH * 2;
            // Reuse or create ping
            if (!pingFB) pingFB = makeFramebuffer(nw, nh);
            else {
                // resize existing texture
                gl.bindTexture(gl.TEXTURE_2D, pingFB.tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }
            runPass(bicubicProg, curTex, curW, curH, pingFB.fb, nw, nh);
            // Free previous intermediate (but not the original srcTex yet)
            if (curTex !== srcTex) gl.deleteTexture(curTex);
            curTex = pingFB.tex; curW = nw; curH = nh;
            [pingFB, pongFB] = [pongFB, pingFB];
        }

        // Sharpen pass into a new framebuffer
        const sharpFB = makeFramebuffer(curW, curH);
        runPass(sharpenProg, curTex, curW, curH, sharpFB.fb, curW, curH);

        // Read pixels from sharpFB
        const pixels = new Uint8Array(curW * curH * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sharpFB.fb);
        gl.readPixels(0, 0, curW, curH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Flip Y (WebGL is bottom-up, canvas is top-down)
        const flipped = new Uint8ClampedArray(curW * curH * 4);
        for (let row = 0; row < curH; row++) {
            const s = (curH - 1 - row) * curW * 4, d = row * curW * 4;
            flipped.set(pixels.subarray(s, s + curW * 4), d);
        }

        // FIX: use separate readCanvas (2D), not glCanvas (WebGL context)
        readCanvas.width  = curW;
        readCanvas.height = curH;
        readCanvas.getContext('2d').putImageData(new ImageData(flipped, curW, curH), 0, 0);

        // Cleanup GL resources
        gl.deleteTexture(srcTex);
        deleteFB(sharpFB);
        if (pingFB) deleteFB(pingFB);  // pingFB may hold intermediate after swap

        try { return readCanvas.toDataURL('image/webp', 0.92) || readCanvas.toDataURL('image/png'); }
        catch { return null; }
    }

    // ─── CPU Worker fallback ──────────────────────────────────────────────────
    const workerSrc = `
        function cubic(t){const a=t<0?-t:t;if(a<1)return(1.5*a-2.5)*a*a+1;if(a<2)return((-0.5*a+2.5)*a-4)*a+2;return 0;}
        function bicubicPass(src,sw,sh){
            const dw=sw*2,dh=sh*2,dst=new Uint8ClampedArray(dw*dh*4);
            for(let dy=0;dy<dh;dy++){
                const srcY=(dy+0.5)*(sh/dh)-0.5,sy0=Math.floor(srcY),fy=srcY-sy0;
                for(let dx=0;dx<dw;dx++){
                    const srcX=(dx+0.5)*(sw/dw)-0.5,sx0=Math.floor(srcX),fx=srcX-sx0;
                    let r=0,g=0,b=0,a=0;
                    for(let ky=-1;ky<=2;ky++){
                        const wy=cubic(ky-fy),py=Math.min(Math.max(sy0+ky,0),sh-1);
                        for(let kx=-1;kx<=2;kx++){
                            const wx=cubic(kx-fx),px=Math.min(Math.max(sx0+kx,0),sw-1);
                            const off=(py*sw+px)*4,w=wx*wy;
                            r+=src[off]*w;g+=src[off+1]*w;b+=src[off+2]*w;a+=src[off+3]*w;}}
                    const i=(dy*dw+dx)*4;
                    dst[i  ]=Math.min(255,Math.max(0,r+0.5));
                    dst[i+1]=Math.min(255,Math.max(0,g+0.5));
                    dst[i+2]=Math.min(255,Math.max(0,b+0.5));
                    dst[i+3]=Math.min(255,Math.max(0,a+0.5));}}
            return{pixels:dst,w:dw,h:dh};}
        function adaptiveSharpen(src,w,h){
            const dst=new Uint8ClampedArray(w*h*4);
            function luma(o){return 0.299*src[o]+0.587*src[o+1]+0.114*src[o+2];}
            function px(x,y){return(Math.min(Math.max(y,0),h-1)*w+Math.min(Math.max(x,0),w-1))*4;}
            for(let y=0;y<h;y++)for(let x=0;x<w;x++){
                const c=px(x,y),n=px(x,y-1),s=px(x,y+1),e=px(x+1,y),ww=px(x-1,y);
                const nw=px(x-1,y-1),ne=px(x+1,y-1),sw2=px(x-1,y+1),se=px(x+1,y+1);
                const gx=luma(ne)-luma(nw)+2*(luma(e)-luma(ww))+luma(se)-luma(sw2);
                const gy=luma(sw2)-luma(nw)+2*(luma(s)-luma(n))+luma(se)-luma(ne);
                const edge=Math.min(1,Math.sqrt(gx*gx+gy*gy)/255*4);
                const i=(y*w+x)*4;
                for(let ch=0;ch<3;ch++){
                    const sharp=Math.min(255,Math.max(0,5*src[c+ch]-src[n+ch]-src[s+ch]-src[e+ch]-src[ww+ch]));
                    dst[i+ch]=Math.round(src[c+ch]+(sharp-src[c+ch])*edge*0.72);}
                dst[i+3]=src[c+3];}
            return dst;}
        self.onmessage=function(e){
            const{id,pixels,sw,sh,scale}=e.data;
            const steps=Math.log2(scale);
            let cur=new Uint8ClampedArray(pixels),cw=sw,ch=sh;
            for(let i=0;i<steps;i++){const r=bicubicPass(cur,cw,ch);cur=r.pixels;cw=r.w;ch=r.h;}
            const final=adaptiveSharpen(cur,cw,ch);
            self.postMessage({id,dst:final,dw:cw,dh:ch},[final.buffer]);};`;

    const workerURL  = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    const POOL_SIZE  = Math.min(4, navigator.hardwareConcurrency || 2);
    const workers    = Array.from({ length: POOL_SIZE }, () => new Worker(workerURL));
    const workerBusy = new Array(POOL_SIZE).fill(false);
    const workerCBs  = new Map();
    let   jobId      = 0;

    workers.forEach((w, idx) => {
        w.onmessage = ({ data: { id, dst, dw, dh } }) => {
            workerBusy[idx] = false;
            workerCBs.get(id)?.resolve({ dst, dw, dh });
            workerCBs.delete(id);
        };
        w.onerror = (err) => {
            console.warn('[AHU] Worker error:', err);
            workerBusy[idx] = false;
            // reject all pending for this worker — find by iterating (rare case)
            for (const [id, cb] of workerCBs) {
                // we don't track which worker owns which job, so just resolve empty to unblock
                cb.reject(new Error('worker error'));
                workerCBs.delete(id);
            }
        };
    });

    function getFreeWorkerIdx() {
        return workers.findIndex((_, i) => !workerBusy[i]);
    }

    function upscaleWorker(pixels, sw, sh) {
        return new Promise((resolve, reject) => {
            const id  = jobId++;
            const idx = getFreeWorkerIdx();
            if (idx === -1) { reject(new Error('no free worker')); return; }
            workerBusy[idx] = true;
            workerCBs.set(id, { resolve, reject });
            workers[idx].postMessage(
                { id, pixels: pixels.buffer, sw, sh, scale: SCALE },
                [pixels.buffer]
            );
        });
    }

    // ─── Core: cache-first ────────────────────────────────────────────────────
    async function processImg(img) {
        if (img.dataset.upscaled || img.dataset.upscaling) return;
        const src = img.src;
        if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;

        const title    = getPosterTitle(img);
        const cacheKey = title
            ? titleKey(title)
            : titleKey(src.replace(/[?#].*$/, '').split('/').pop());

        // ── Cache hit ─────────────────────────────────────────────────────────
        const cached = cacheGet(cacheKey);
        if (cached) {
            img.src = cached;
            img.dataset.upscaled = '1';
            session.hits++;
            session.done++;
            updatePill();
            if (panel.classList.contains('open')) refreshPanel();
            return;
        }

        // ── Cache miss: upscale ───────────────────────────────────────────────
        img.dataset.upscaling = '1';
        active++;
        updatePill();

        // FIX: use GM_xmlhttpRequest to bypass CORS instead of relying on crossOrigin
        let tmp = null;
        try { tmp = await fetchImageViaGM(src); } catch { /* fall through */ }

        // Fallback: try native img with crossOrigin
        if (!tmp) {
            tmp = await new Promise((res) => {
                const t     = new Image();
                t.crossOrigin = 'anonymous';
                t.onload  = () => res(t);
                t.onerror = () => res(null);
                t.src = src;
            });
        }

        if (!tmp) { cleanup(img); return; }
        const sw = tmp.naturalWidth, sh = tmp.naturalHeight;
        if (!sw || !sh) { cleanup(img); return; }

        let dataURL = null;

        // GPU path
        if (glReady) {
            try { dataURL = upscaleWebGL(tmp, sw, sh); } catch (e) { console.warn('[AHU] WebGL upscale failed:', e); }
        }

        // CPU worker fallback
        if (!dataURL) {
            try {
                const sc  = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
                sc.getContext('2d').drawImage(tmp, 0, 0);
                const pixels = sc.getContext('2d').getImageData(0, 0, sw, sh).data;
                const { dst, dw, dh } = await upscaleWorker(new Uint8ClampedArray(pixels), sw, sh);
                const dc = Object.assign(document.createElement('canvas'), { width: dw, height: dh });
                dc.getContext('2d').putImageData(new ImageData(dst, dw, dh), 0, 0);
                dataURL = dc.toDataURL('image/webp', 0.92) || dc.toDataURL('image/png');
            } catch (e) { console.warn('[AHU] Worker upscale failed:', e); }
        }

        if (dataURL) {
            img.src = dataURL;
            img.dataset.upscaled = '1';
            session.misses++;
            cacheSet(cacheKey, dataURL);
        }

        cleanup(img);
        if (panel.classList.contains('open')) refreshPanel();
    }

    function cleanup(img) {
        delete img.dataset.upscaling;
        active--;
        session.done++;
        updatePill();
        drainQueue();
    }

    // FIX: guard against double-enqueue more efficiently with a WeakSet
    const queued = new WeakSet();

    function enqueue(img) {
        if (img.dataset.upscaled || img.dataset.upscaling) return;
        if (queued.has(img)) return;
        queued.add(img);
        QUEUE.push(img);
        session.queued++;
        updatePill();
        drainQueue();
    }

    function drainQueue() {
        // Drain synchronously up to MAX_ACTIVE; processImg is async so each call
        // returns immediately — active counter ensures we don't over-schedule
        while (active < MAX_ACTIVE && QUEUE.length > 0) {
            const img = QUEUE.shift();
            processImg(img);  // intentionally not awaited — runs concurrently
        }
    }

    // ─── Intersection Observer ────────────────────────────────────────────────
    const io = new IntersectionObserver(entries => {
        for (const e of entries)
            if (e.isIntersecting) { io.unobserve(e.target); enqueue(e.target); }
    }, { rootMargin: '200px' });

    function observeImg(img) {
        if (img.dataset.upscaled || img.dataset.upscaling) return;

        if (img.complete) {
            if (img.naturalWidth > 0) {
                // Image is fully loaded — observe immediately
                io.observe(img);
            } else {
                // complete but naturalWidth=0: broken or not yet decoded
                // FIX: re-attach load listener so we catch it when it actually loads
                img.addEventListener('load', () => {
                    if (img.naturalWidth > 0) io.observe(img);
                }, { once: true });
                // Also watch for src change via decode (handles lazy-load placeholder swaps)
                img.addEventListener('error', () => {}, { once: true });
            }
        } else {
            img.addEventListener('load', () => {
                if (img.naturalWidth > 0) io.observe(img);
            }, { once: true });
        }
    }

    // Observe all current poster images
    document.querySelectorAll('.mc__poster img').forEach(observeImg);

    // Watch for dynamically added images
    new MutationObserver(mutations => {
        for (const m of mutations)
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.('.mc__poster img')) observeImg(node);
                node.querySelectorAll?.('.mc__poster img').forEach(observeImg);
            }
    }).observe(document.body, { childList: true, subtree: true });

    // Initial pill state from stored meta
    const initMeta = getLRUandMeta();
    if (initMeta.bytes > 0) updatePill();

})();
