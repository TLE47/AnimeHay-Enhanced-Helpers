// ==UserScript==
// @name         AnimeHay EchoSkip – Audio OST Skipper
// @version      3.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_echoSkipper.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_echoSkipper.user.js
// @description  Acoustic fingerprint-based OP/ED skipper with Jikan API OST integration
// @author       TLE47 (refactored)
// @include      /.*animehay.*/
// @include      /^https?:\/\/([^\/]+\.)?playhydrax\.[^\/]+\/.*/
// @include      /^https?:\/\/([^\/]+\.)?ahay\.stream\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      graphql.anilist.co
// @connect      api.jikan.moe
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    /* ==================== CONFIG ==================== */
    const CFG = {
        FFT_SIZE: 1024,
        SAMPLE_RATE_HZ: 4,
        SIG_DURATION_S: 8,
        MATCH_WINDOW_S: 360,
        MATCH_INTERVAL_MS: 500,
        DEFAULT_THRESHOLD: 0.82,
        DEFAULT_SKIP_DUR: 89,
        ANTI_SPOILER_S: 120,
        // Ring buffer size = 2× the flat signature length so we always have a
        // full window to slide over. Computed once in initRingSize().
        RING_CAP: 0, // filled by initRingSize()
    };

    // Pre-compute ring capacity (64 bands × SIG_DURATION_S × SAMPLE_RATE_HZ × 2)
    CFG.RING_CAP = 64 * CFG.SIG_DURATION_S * CFG.SAMPLE_RATE_HZ * 2;

    /* ==================== ENVIRONMENT ==================== */
    const isMainPage = window.self === window.top;
    const $ = (s, ctx = document) => ctx.querySelector(s);
    const video = () => $('video');

    // ─── Cross-frame messaging ────────────────────────────────────────────────
    // All messages are namespaced with `type` starting with "ECHO_".
    // Main page never directly manipulates iframe DOM and vice-versa.

    function toIframes(msg) {
        document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow.postMessage(msg, '*'); } catch (_) { }
        });
    }
    function toParent(msg) {
        try { window.parent.postMessage(msg, '*'); } catch (_) { }
    }

    /* ==================== TITLE / KEY ==================== */
    let iframeTitle = '';

    function getCleanTitle() {
        const raw = isMainPage ? document.title : iframeTitle;
        if (!raw) return null;
        const m = raw.match(/Phim\s+(.+?)\s+Tập/i);
        return m ? m[1].trim() : raw.trim();
    }

    function getSeriesKey() {
        const t = getCleanTitle();
        if (!t) return null;
        return t.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/gi, '')
            .replace(/\b(xem phim|phim|tap|vietsub|thuyet minh|long tieng|tron bo|movie|ova|tv|animehay|anime)\b/gi, '')
            .replace(/\s+/g, '_').trim() || null;
    }

    /* ==================== PERSISTENCE ==================== */
    const loadLib = () => {
        try { const d = GM_getValue('echoLib', {}); return typeof d === 'object' ? d : {}; }
        catch (_) { return {}; }
    };
    const saveLib = l => GM_setValue('echoLib', l);

    const DEFAULT_UI = { minimized: true, left: null, top: null, threshold: CFG.DEFAULT_THRESHOLD, opacity: 0.9 };
    const loadUI = () => ({ ...DEFAULT_UI, ...GM_getValue('echoUI', {}) });
    const saveUI = u => GM_setValue('echoUI', u);

    let lib = loadLib();
    let ui = loadUI();

    /* ==================== JIKAN OST FETCH ==================== */
    function fetchThemes(title, callback) {
        const key = getSeriesKey();
        if (lib[key]?.themes) { callback(lib[key].themes); return; }

        setStatus('🔍 Searching OST on Jikan…');
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`,
            onload(res) {
                try {
                    const id = JSON.parse(res.responseText)?.data?.[0]?.mal_id;
                    if (!id) { callback(null); return; }
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://api.jikan.moe/v4/anime/${id}/themes`,
                        onload(res2) {
                            try {
                                const d = JSON.parse(res2.responseText)?.data;
                                if (!d) { callback(null); return; }
                                const themes = { op: d.openings || [], ed: d.endings || [] };
                                if (!lib[key]) lib[key] = {};
                                lib[key].themes = themes;
                                saveLib(lib);
                                callback(themes);
                            } catch (_) { callback(null); }
                        },
                        onerror() { callback(null); },
                    });
                } catch (_) { callback(null); }
            },
            onerror() { callback(null); },
        });
    }

    /* ==================== AUDIO ENGINE (iframe only) ==================== */
    let audioCtx = null, analyser = null;
    let isRecording = false;
    let recordBuffer = [];

    function initAudio(vid) {
        if (audioCtx) return true;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = CFG.FFT_SIZE;
            analyser.smoothingTimeConstant = 0.3;
            const src = audioCtx.createMediaElementSource(vid);
            src.connect(analyser);
            analyser.connect(audioCtx.destination);
            return true;
        } catch (_) { return false; }
    }

    function getFreqSnapshot() {
        const bins = analyser.frequencyBinCount; // = FFT_SIZE / 2
        const raw = new Float32Array(bins);
        analyser.getFloatFrequencyData(raw);
        const BANDS = 64, step = Math.floor(bins / BANDS);
        const out = new Float32Array(BANDS);
        for (let i = 0; i < BANDS; i++) {
            let s = 0;
            for (let j = 0; j < step; j++) s += raw[i * step + j];
            out[i] = s / step;
        }
        return out;
    }

    // ─── Recording ────────────────────────────────────────────────────────────
    function iframeStartRecording(type) {
        const vid = video();
        if (!vid) { toParent({ type: 'ECHO_RECORD_STATUS', msg: '❌ No video in iframe' }); return; }
        if (!initAudio(vid)) { toParent({ type: 'ECHO_RECORD_STATUS', msg: '❌ Audio init failed' }); return; }
        if (audioCtx.state === 'suspended') audioCtx.resume();

        isRecording = true;
        recordBuffer = [];
        const startTime = vid.currentTime;
        toParent({ type: 'ECHO_RECORD_STATUS', msg: `🔴 Recording ${type.toUpperCase()}… (${CFG.SIG_DURATION_S}s)` });

        const target = CFG.SIG_DURATION_S * CFG.SAMPLE_RATE_HZ;
        const ivl = setInterval(() => {
            if (!isRecording || vid.paused) return;
            recordBuffer.push(Array.from(getFreqSnapshot()));
            if (recordBuffer.length >= target) {
                clearInterval(ivl);
                isRecording = false;
                toParent({
                    type: 'ECHO_RECORD_DONE',
                    recType: type,
                    frames: recordBuffer,
                    startTime,
                    endTime: vid.currentTime,
                });
            }
        }, 1000 / CFG.SAMPLE_RATE_HZ);
    }

    /* ==================== CORRELATION ENGINE ==================== */
    // Pre-flattened cached signature arrays — updated whenever a new lib entry
    // is loaded so we don't re-flatten on every 500 ms tick.
    let cachedFlat = { op: null, ed: null };

    function flattenSig(sig) {
        if (!sig) return null;
        const len = sig.length * sig[0].length;
        const out = new Float32Array(len);
        let i = 0;
        for (const frame of sig) for (const v of frame) out[i++] = v;
        return out;
    }

    function loadCachedFlats(entry) {
        cachedFlat.op = flattenSig(entry?.op_sig ?? null);
        cachedFlat.ed = flattenSig(entry?.ed_sig ?? null);
    }

    function pearson(a, b, len) {
        // a and b are Float32Arrays of the same length `len`
        let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
        for (let i = 0; i < len; i++) {
            sumA += a[i]; sumB += b[i];
            sumAB += a[i] * b[i];
            sumA2 += a[i] * a[i]; sumB2 += b[i] * b[i];
        }
        const num = len * sumAB - sumA * sumB;
        const den = Math.sqrt((len * sumA2 - sumA * sumA) * (len * sumB2 - sumB * sumB));
        return den === 0 ? 0 : num / den;
    }

    // Fixed-capacity circular ring buffer (avoids slice/splice on every tick)
    class RingBuffer {
        constructor(cap) {
            this.buf = new Float32Array(cap);
            this.cap = cap;
            this.pos = 0;
            this.size = 0;
        }
        push(arr) {
            for (const v of arr) {
                this.buf[this.pos] = v;
                this.pos = (this.pos + 1) % this.cap;
                if (this.size < this.cap) this.size++;
            }
        }
        // Copy the last `n` elements into `out` (a Float32Array of length n).
        // Returns false if we don't have enough data yet.
        tail(out, n) {
            if (this.size < n) return false;
            const start = (this.pos - n + this.cap) % this.cap;
            for (let i = 0; i < n; i++) {
                out[i] = this.buf[(start + i) % this.cap];
            }
            return true;
        }
        reset() { this.pos = 0; this.size = 0; }
    }

    let ring = new RingBuffer(CFG.RING_CAP);
    // Scratch buffer reused every tick instead of allocating a new one
    let scratchOp = null, scratchEd = null;

    /* ==================== LISTENING (iframe only) ==================== */
    let listenIvl = null;
    let isListening = false;
    let hasSkippedOP = false;
    let hasSkippedED = false;
    let activeEntry = null; // lib entry currently being listened against
    let activeThresh = CFG.DEFAULT_THRESHOLD;

    function iframeStartListening(libEntry, threshold) {
        if (isListening) return;
        const vid = video();
        if (!vid || !initAudio(vid)) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        activeEntry = libEntry;
        activeThresh = threshold;
        isListening = true;
        hasSkippedOP = false;
        hasSkippedED = false;
        ring.reset();

        // Pre-build scratch buffers sized to each signature
        loadCachedFlats(libEntry);
        if (cachedFlat.op) scratchOp = new Float32Array(cachedFlat.op.length);
        if (cachedFlat.ed) scratchEd = new Float32Array(cachedFlat.ed.length);

        listenIvl = setInterval(() => {
            const v = video();
            if (!v || v.paused || isRecording) return;

            const t = v.currentTime;
            const dur = v.duration || 0;

            // Anti-spoiler: don't try to match near the end
            if (dur > 0 && t > dur - CFG.ANTI_SPOILER_S) return;

            ring.push(getFreqSnapshot());

            // OP matching (only in first MATCH_WINDOW_S)
            if (cachedFlat.op && !hasSkippedOP && t < CFG.MATCH_WINDOW_S) {
                const n = cachedFlat.op.length;
                if (ring.tail(scratchOp, n)) {
                    const corr = pearson(scratchOp, cachedFlat.op, n);
                    toParent({ type: 'ECHO_CORR_UPDATE', corr });
                    if (corr >= activeThresh) {
                        hasSkippedOP = true;
                        const skipTo = t + (libEntry.op_dur ?? CFG.DEFAULT_SKIP_DUR);
                        toParent({ type: 'ECHO_SKIP_TRIGGER', skipType: 'op', skipTo });
                    }
                }
            }

            // ED matching (only in last 30% of episode)
            if (cachedFlat.ed && !hasSkippedED && dur > 0 && t > dur * 0.7) {
                const n = cachedFlat.ed.length;
                if (ring.tail(scratchEd, n)) {
                    const corr = pearson(scratchEd, cachedFlat.ed, n);
                    toParent({ type: 'ECHO_CORR_UPDATE', corr });
                    if (corr >= activeThresh) {
                        hasSkippedED = true;
                        const skipTo = t + (libEntry.ed_dur ?? CFG.DEFAULT_SKIP_DUR);
                        toParent({ type: 'ECHO_SKIP_TRIGGER', skipType: 'ed', skipTo });
                    }
                }
            }
        }, CFG.MATCH_INTERVAL_MS);
    }

    function stopListening() {
        if (listenIvl) { clearInterval(listenIvl); listenIvl = null; }
        isListening = false;
        ring.reset();
    }

    /* ==================== MESSAGE ROUTING ==================== */
    // Single consolidated listener per context — no duplicate registrations.

    if (isMainPage) {
        // Push title to iframes every 2 s
        setInterval(() => toIframes({ type: 'ECHO_TITLE', title: document.title }), 2000);

        window.addEventListener('message', e => {
            const d = e.data;
            if (!d?.type?.startsWith('ECHO_')) return;

            if (d.type === 'ECHO_RECORD_DONE') {
                pendingRecord = { type: d.recType, frames: d.frames, startTime: d.startTime, endTime: d.endTime };
                showConfirmationUI();
                setStatus('✅ Recorded. Replay & confirm.');

            } else if (d.type === 'ECHO_RECORD_STATUS') {
                setStatus(d.msg);

            } else if (d.type === 'ECHO_CORR_UPDATE') {
                updateMeter(d.corr);

            } else if (d.type === 'ECHO_SKIP_TRIGGER') {
                const key = getSeriesKey();
                if (!key || !lib[key]) return;
                if (lib[key].autoSkip !== false) {
                    toIframes({ type: 'ECHO_CMD_JUMP', skipTo: d.skipTo });
                    setStatus(`🚀 ${d.skipType.toUpperCase()} Auto-Skipped!`);
                } else {
                    showManualPrompt(d.skipType, d.skipTo);
                }

            } else if (d.type === 'ECHO_IFRAME_READY') {
                // Iframe signalled it has a video — push lib entry if available
                maybeSendListenCmd();
            }
        });

    } else {
        // Iframe context
        window.addEventListener('message', e => {
            const d = e.data;
            if (!d?.type?.startsWith('ECHO_')) return;

            if (d.type === 'ECHO_TITLE') iframeTitle = d.title;
            else if (d.type === 'ECHO_CMD_RECORD') iframeStartRecording(d.recType);
            else if (d.type === 'ECHO_CMD_LISTEN') iframeStartListening(d.libEntry, d.threshold);
            else if (d.type === 'ECHO_CMD_STOP') stopListening();
            else if (d.type === 'ECHO_CMD_JUMP') { const v = video(); if (v) v.currentTime = Math.min(d.skipTo, v.duration || d.skipTo); }
            else if (d.type === 'ECHO_CMD_REPLAY') { const v = video(); if (v) { v.currentTime = d.startTime; v.play(); } }
            else if (d.type === 'ECHO_SHOW_PROMPT') showManualPrompt(d.skipType, d.skipTo);
        });
    }

    /* ==================== MAIN PAGE: LISTEN TRIGGER ==================== */
    // Tracks whether the iframe has been told to listen for the current episode.
    // Reset whenever we detect a video change (via the video observer).
    let sentListenCmd = false;

    function maybeSendListenCmd() {
        if (sentListenCmd) return;
        const key = getSeriesKey();
        if (!key || !lib[key]) return;
        const entry = lib[key];
        if (!entry.op_sig && !entry.ed_sig) return;

        sentListenCmd = true;
        toIframes({ type: 'ECHO_CMD_LISTEN', libEntry: entry, threshold: ui.threshold });
        setStatus('👂 Listening…');
    }

    /* ==================== MANUAL SKIP PROMPT ==================== */
    function showManualPrompt(type, skipTo) {
        // Show in the current context (works in both main page and iframe)
        let prompt = $('#echo-manual-prompt');
        if (!prompt) {
            prompt = document.createElement('div');
            prompt.id = 'echo-manual-prompt';
            prompt.style.cssText = [
                'position:fixed;bottom:80px;right:30px;',
                'background:rgba(0,0,0,.85);color:#fff;',
                'padding:10px 15px;border-radius:8px;z-index:999999;',
                'font-family:sans-serif;border:1px solid #e94560;',
                'box-shadow:0 4px 15px rgba(233,69,96,.5);',
                'display:flex;gap:10px;align-items:center;cursor:pointer;',
                'transition:transform .2s;',
            ].join('');
            prompt.innerHTML = `<span>⏭️ Skip <b id="emp-type"></b></span>`;
            prompt.addEventListener('mouseover', () => prompt.style.transform = 'scale(1.05)');
            prompt.addEventListener('mouseout', () => prompt.style.transform = 'scale(1)');
            document.body.appendChild(prompt);
        }

        prompt.querySelector('#emp-type').textContent = type.toUpperCase();
        prompt.style.display = 'flex';

        const handler = () => {
            const v = video();
            if (v) v.currentTime = Math.min(skipTo, v.duration || skipTo);
            prompt.style.display = 'none';
            if (isMainPage) setStatus(`🚀 ${type.toUpperCase()} Manually Skipped!`);
        };
        // Remove old handler before adding to avoid stacking listeners
        prompt.replaceWith(prompt.cloneNode(true));
        const fresh = $('#echo-manual-prompt');
        fresh.querySelector('#emp-type').textContent = type.toUpperCase();
        fresh.addEventListener('click', handler, { once: true });
        fresh.addEventListener('mouseover', () => fresh.style.transform = 'scale(1.05)');
        fresh.addEventListener('mouseout', () => fresh.style.transform = 'scale(1)');

        setTimeout(() => { fresh.style.display = 'none'; }, 15000);
    }

    /* ==================== VIDEO OBSERVER ==================== */
    let currentVideo = null;

    const videoObs = new MutationObserver(() => {
        const v = video();
        if (!v || v === currentVideo) return;
        currentVideo = v;
        sentListenCmd = false; // reset so we can re-send for this episode

        if (isMainPage) {
            // When new video appears, give iframe a moment to initialise then push cmd
            setTimeout(maybeSendListenCmd, 1500);
        } else {
            // Iframe: stop old listener and signal parent a video is ready
            stopListening();
            v.addEventListener('ended', stopListening);
            toParent({ type: 'ECHO_IFRAME_READY' });
        }
    });
    videoObs.observe(document.body, { childList: true, subtree: true });

    /* ==================== GUI (main page only) ==================== */
    if (!isMainPage) return; // iframe context exits here

    let pendingRecord = null;

    function setStatus(msg) {
        const el = $('#echo-status');
        if (el) el.textContent = msg;
    }

    function updateMeter(val) {
        const bar = $('#echo-meter-fill');
        if (!bar) return;
        bar.style.width = Math.max(0, Math.min(100, val * 100)) + '%';
        bar.style.background = val >= ui.threshold ? '#4caf50' : (val > 0.5 ? '#ff9800' : '#555');
    }

    function refreshInfo() {
        const el = $('#echo-info');
        const ostEl = $('#echo-ost-names');
        if (!el) return;

        const key = getSeriesKey();
        const entry = key ? lib[key] : null;

        if (!key) { el.textContent = 'No title detected'; if (ostEl) ostEl.innerHTML = ''; return; }
        if (!entry) { el.textContent = `"${key}" — No signatures`; if (ostEl) ostEl.innerHTML = ''; return; }

        const parts = [];
        if (entry.op_sig) parts.push(`OP ✓ (${entry.op_dur ?? CFG.DEFAULT_SKIP_DUR}s)`);
        if (entry.ed_sig) parts.push(`ED ✓ (${entry.ed_dur ?? CFG.DEFAULT_SKIP_DUR}s)`);
        el.textContent = parts.length ? parts.join(' · ') : 'No signatures';

        const toggleBtn = $('#echo-auto-toggle');
        if (toggleBtn) {
            const isAuto = entry.autoSkip !== false;
            toggleBtn.textContent = isAuto ? '🤖 Auto Skip: ON' : '🖐 Manual Skip: ON';
            toggleBtn.className = isAuto ? 'echo-btn go' : 'echo-btn';
        }

        if (ostEl) {
            const title = getCleanTitle();
            if (title && !entry.themes) {
                fetchThemes(title, themes => renderThemes(themes, ostEl));
            } else {
                renderThemes(entry.themes, ostEl);
            }
        }
    }

    function renderThemes(themes, container) {
        if (!themes) { container.innerHTML = '<div style="color:#888;">No OST data found.</div>'; return; }
        let html = '';
        if (themes.op?.length) html += `<div title="${themes.op.join('\n')}">🎵 <b>OP:</b> ${themes.op[0].substring(0, 40)}…</div>`;
        if (themes.ed?.length) html += `<div title="${themes.ed.join('\n')}">🎵 <b>ED:</b> ${themes.ed[0].substring(0, 40)}…</div>`;
        container.innerHTML = html;
    }

    function showConfirmationUI() {
        const box = $('#echo-confirm-box');
        if (box) {
            box.style.display = 'block';
            $('#echo-confirm-text').textContent = `Review ${pendingRecord.type.toUpperCase()} sample`;
        }
    }
    function hideConfirmationUI() {
        const box = $('#echo-confirm-box');
        if (box) box.style.display = 'none';
    }

    function savePendingSignature() {
        if (!pendingRecord) return;
        const key = getSeriesKey();
        if (!key) return;
        if (!lib[key]) lib[key] = {};
        lib[key][pendingRecord.type + '_sig'] = pendingRecord.frames;
        lib[key][pendingRecord.type + '_dur'] = lib[key][pendingRecord.type + '_dur'] ?? CFG.DEFAULT_SKIP_DUR;
        lib[key].autoSkip = lib[key].autoSkip ?? true;
        saveLib(lib);
        setStatus(`✅ ${pendingRecord.type.toUpperCase()} signature saved.`);
        pendingRecord = null;
        hideConfirmationUI();
        refreshInfo();
    }

    // ─── Inject CSS ───────────────────────────────────────────────────────────
    const css = document.createElement('style');
    css.textContent = `
        #echo-skip { position:fixed; bottom:20px; left:20px; width:280px; background:#1a1a2e; color:#eee; font-family:system-ui,sans-serif; border-radius:12px; z-index:999999; box-shadow:0 8px 32px rgba(0,0,0,.6); border:1px solid #333; overflow:hidden; }
        #echo-header { padding:8px 12px; background:#16213e; cursor:move; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; user-select:none; }
        #echo-header span { font-weight:bold; font-size:13px; color:#e94560; }
        #echo-body { padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
        #echo-body.hidden { display:none !important; }
        .echo-row { display:flex; gap:6px; align-items:center; }
        .echo-row input[type=number] { flex:1; min-width:0; background:#0f3460; color:#fff; border:1px solid #444; border-radius:6px; padding:5px 8px; outline:none; font-size:12px; }
        .echo-btn { background:#0f3460; color:#fff; border:1px solid #444; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:11px; white-space:nowrap; transition:filter .15s; }
        .echo-btn:hover { filter:brightness(1.4); }
        .echo-btn.rec  { background:#b91c1c; }
        .echo-btn.rec:hover { background:#dc2626; }
        .echo-btn.go   { background:#166534; }
        .echo-btn.warn { background:#b45309; }
        .echo-btn.del  { background:#7f1d1d; font-size:10px; }
        #echo-meter { width:100%; height:8px; background:#222; border-radius:4px; overflow:hidden; }
        #echo-meter-fill { height:100%; width:0; background:#555; transition:width .3s,background .3s; border-radius:4px; }
        #echo-info  { font-size:10px; color:#888; text-align:center; font-weight:bold; }
        #echo-ost-names { font-size:9px; color:#aaa; line-height:1.4; background:#111827; padding:4px; border-radius:4px; margin-top:2px; }
        #echo-status { font-size:11px; color:#aaa; text-align:center; margin-top:2px; }
        .echo-slider { display:flex; align-items:center; gap:6px; font-size:10px; color:#888; }
        .echo-slider input[type=range] { flex:1; accent-color:#e94560; height:4px; }
        .echo-section { border-top:1px solid #333; padding-top:6px; margin-top:2px; }
        #echo-confirm-box { display:none; background:#374151; padding:8px; border-radius:6px; border:1px dashed #fbbf24; margin-top:4px; text-align:center; }
    `;
    document.head.appendChild(css);

    // ─── Build panel HTML ─────────────────────────────────────────────────────
    const gui = document.createElement('div');
    gui.id = 'echo-skip';
    gui.style.opacity = ui.opacity;
    gui.innerHTML = `
        <div id="echo-header">
            <span>🎵 EchoSkip</span>
            <button class="echo-btn" id="echo-min" style="background:none;border:none;font-size:16px;color:#fff;padding:0;">${ui.minimized ? '+' : '−'}</button>
        </div>
        <div id="echo-body"${ui.minimized ? ' class="hidden"' : ''}>
            <div id="echo-info">Detecting title…</div>
            <div id="echo-ost-names"></div>
            <div id="echo-meter"><div id="echo-meter-fill"></div></div>

            <div class="echo-section">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:10px;color:#888;">🎤 Record Signatures</span>
                    <button class="echo-btn go" id="echo-auto-toggle" style="padding:2px 6px;font-size:9px;">🤖 Auto Skip: ON</button>
                </div>
                <div class="echo-row">
                    <button class="echo-btn rec" id="echo-rec-op">⏺ Record OP</button>
                    <button class="echo-btn rec" id="echo-rec-ed">⏺ Record ED</button>
                </div>
                <div id="echo-confirm-box">
                    <div id="echo-confirm-text" style="font-size:11px;margin-bottom:6px;"></div>
                    <div class="echo-row" style="justify-content:center;">
                        <button class="echo-btn warn" id="echo-replay-btn">▶️ Replay</button>
                        <button class="echo-btn go"   id="echo-save-btn">✅ Save</button>
                        <button class="echo-btn del"  id="echo-cancel-btn">❌</button>
                    </div>
                </div>
            </div>

            <div class="echo-section">
                <div style="font-size:10px;color:#888;margin-bottom:4px;">⏱️ Skip Duration (seconds)</div>
                <div class="echo-row">
                    <input type="number" id="echo-op-dur" placeholder="OP (89)">
                    <input type="number" id="echo-ed-dur" placeholder="ED (89)">
                    <button class="echo-btn go" id="echo-save-dur">💾</button>
                </div>
            </div>

            <div class="echo-section">
                <div class="echo-slider">
                    <span>Sensitivity</span>
                    <input type="range" id="echo-threshold" min="0.5" max="0.95" step="0.01" value="${ui.threshold}">
                    <span id="echo-thresh-val">${Math.round(ui.threshold * 100)}%</span>
                </div>
                <div class="echo-slider" style="margin-top:4px;">
                    <span>Opacity</span>
                    <input type="range" id="echo-opacity" min="0.15" max="1" step="0.05" value="${ui.opacity}">
                    <span id="echo-opacity-val">${Math.round(ui.opacity * 100)}%</span>
                </div>
            </div>

            <div class="echo-row" style="justify-content:center;margin-top:4px;">
                <button class="echo-btn del" id="echo-clear">🗑️ Clear</button>
                <button class="echo-btn"     id="echo-export" style="font-size:10px;">📤 Export</button>
                <button class="echo-btn"     id="echo-import" style="font-size:10px;">📥 Import</button>
            </div>

            <div id="echo-status">Ready</div>
        </div>
    `;
    document.body.appendChild(gui);

    // Restore saved position
    if (ui.left !== null) { gui.style.left = ui.left + 'px'; gui.style.top = ui.top + 'px'; gui.style.bottom = 'auto'; }

    // ─── Panel controls ───────────────────────────────────────────────────────
    $('#echo-min').addEventListener('click', () => {
        const body = $('#echo-body');
        const hidden = body.classList.toggle('hidden');
        ui.minimized = hidden;
        $('#echo-min').textContent = hidden ? '+' : '−';
        saveUI(ui);
    });

    // Drag (use addEventListener, not onmousemove, to avoid global clobber)
    let dragging = false, off = { x: 0, y: 0 };
    $('#echo-header').addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        off = { x: e.clientX - gui.offsetLeft, y: e.clientY - gui.offsetTop };
    });
    window.addEventListener('mousemove', e => {
        if (!dragging) return;
        gui.style.left = (e.clientX - off.x) + 'px';
        gui.style.top = (e.clientY - off.y) + 'px';
        gui.style.bottom = 'auto'; gui.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        ui.left = gui.offsetLeft; ui.top = gui.offsetTop;
        saveUI(ui);
    });

    $('#echo-rec-op').addEventListener('click', () => {
        setStatus(`🔴 Recording OP… (${CFG.SIG_DURATION_S}s)`);
        toIframes({ type: 'ECHO_CMD_RECORD', recType: 'op' });
    });
    $('#echo-rec-ed').addEventListener('click', () => {
        setStatus(`🔴 Recording ED… (${CFG.SIG_DURATION_S}s)`);
        toIframes({ type: 'ECHO_CMD_RECORD', recType: 'ed' });
    });

    $('#echo-replay-btn').addEventListener('click', () => {
        if (pendingRecord) toIframes({ type: 'ECHO_CMD_REPLAY', startTime: pendingRecord.startTime });
    });
    $('#echo-save-btn').addEventListener('click', savePendingSignature);
    $('#echo-cancel-btn').addEventListener('click', () => {
        pendingRecord = null;
        hideConfirmationUI();
        setStatus('Cancelled.');
    });

    $('#echo-auto-toggle').addEventListener('click', () => {
        const key = getSeriesKey();
        if (!key || !lib[key]) { setStatus('❌ Record a signature first'); return; }
        lib[key].autoSkip = lib[key].autoSkip === false ? true : false;
        saveLib(lib);
        refreshInfo();
    });

    $('#echo-save-dur').addEventListener('click', () => {
        const key = getSeriesKey();
        if (!key || !lib[key]) { setStatus('❌ Record a signature first'); return; }
        const op = parseInt($('#echo-op-dur').value);
        const ed = parseInt($('#echo-ed-dur').value);
        if (!isNaN(op)) lib[key].op_dur = op;
        if (!isNaN(ed)) lib[key].ed_dur = ed;
        saveLib(lib);
        setStatus('✅ Durations saved');
        refreshInfo();
    });

    $('#echo-threshold').addEventListener('input', e => {
        ui.threshold = parseFloat(e.target.value);
        $('#echo-thresh-val').textContent = Math.round(ui.threshold * 100) + '%';
        saveUI(ui);
    });

    $('#echo-opacity').addEventListener('input', e => {
        ui.opacity = parseFloat(e.target.value);
        gui.style.opacity = ui.opacity;
        $('#echo-opacity-val').textContent = Math.round(ui.opacity * 100) + '%';
        saveUI(ui);
    });

    $('#echo-clear').addEventListener('click', () => {
        const key = getSeriesKey();
        if (key && lib[key]) { delete lib[key]; saveLib(lib); setStatus('🗑️ Cleared'); refreshInfo(); }
    });

    $('#echo-export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(lib, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'echoSkip_library.json';
        a.click();
    });

    $('#echo-import').addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.addEventListener('change', e => {
            const reader = new FileReader();
            reader.addEventListener('load', ev => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    for (const [k, v] of Object.entries(imported)) {
                        if (!lib[k]) {
                            lib[k] = v;
                        } else {
                            // Deep merge: don't drop themes, sigs, or durations
                            for (const field of ['op_sig', 'op_dur', 'ed_sig', 'ed_dur', 'themes', 'autoSkip']) {
                                if (v[field] !== undefined && lib[k][field] === undefined) {
                                    lib[k][field] = v[field];
                                }
                            }
                        }
                    }
                    saveLib(lib);
                    setStatus(`✅ Merged ${Object.keys(imported).length} entries`);
                    refreshInfo();
                } catch (_) { setStatus('❌ Invalid file'); }
            });
            reader.readAsText(e.target.files[0]);
        });
        inp.click();
    });

    // ─── Initial info load ────────────────────────────────────────────────────
    setTimeout(() => {
        refreshInfo();
        const key = getSeriesKey();
        if (!key || !lib[key]) return;
        if (lib[key].op_dur) $('#echo-op-dur').value = lib[key].op_dur;
        if (lib[key].ed_dur) $('#echo-ed-dur').value = lib[key].ed_dur;
    }, 1500);

})();