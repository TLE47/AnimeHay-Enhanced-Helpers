// ==UserScript==
// @name         AnimeHay EchoSkip – Audio OST Skipper
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_echoSkipper.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_echoSkipper.user.js
// @description  Acoustic fingerprint-based OP/ED skipper with Jikan API OST integration
// @author       TLE47
// @include      /.*animehay.*/
// @include      /^https?:\/\/([^\/]+\.)?playhydrax\.[^\/]+\/.*/
// @include      /^https?:\/\/([^\/]+\.)?ahay\.stream\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
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
    };

    /* ==================== ENVIRONMENT ==================== */
    const isMainPage = window.self === window.top;
    const $ = (s, ctx = document) => ctx.querySelector(s);
    const video = () => $('video');

    // Cross-domain title bridge
    let iframeTitle = '';
    if (isMainPage) {
        setInterval(() => {
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'ECHO_TITLE', title: document.title }, '*'); } catch (_) { /* ignore */ }
            });
        }, 2000);
    } else {
        window.addEventListener('message', e => {
            if (e.data?.type === 'ECHO_TITLE') iframeTitle = e.data.title;
        });
    }

    /* ==================== TITLE PARSER ==================== */
    function getCleanTitle() {
        const raw = isMainPage ? document.title : iframeTitle;
        if (!raw) return null;
        const m = raw.match(/Phim\s+(.+?)\s+Tập/i);
        return m ? m[1].trim() : raw.trim();
    }

    function getSeriesKey() {
        let t = getCleanTitle();
        if (!t) return null;
        t = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/gi, '')
            .replace(/\b(xem phim|phim|tap|vietsub|thuyet minh|long tieng|tron bo|movie|ova|tv|animehay|anime)\b/gi, '')
            .replace(/\s+/g, '_').trim();
        return t || null;
    }

    /* ==================== DATA PERSISTENCE ==================== */
    const loadLib = () => { try { const d = GM_getValue('echoLib', {}); return typeof d === 'object' ? d : {}; } catch (_) { return {}; } };
    const saveLib = (lib) => GM_setValue('echoLib', lib);
    const loadUI  = () => GM_getValue('echoUI', { minimized: true, left: null, top: null, threshold: CFG.DEFAULT_THRESHOLD, opacity: 0.9 });
    const saveUI  = (ui) => GM_setValue('echoUI', ui);

    let lib = loadLib();
    let ui = loadUI();

    /* ==================== API INTEGRATION (JIKAN) ==================== */
    function fetchThemes(title, callback) {
        const key = getSeriesKey();
        if (lib[key] && lib[key].themes) {
            callback(lib[key].themes);
            return;
        }
        
        setStatus('🔍 Searching OST on Jikan...');
        GM_xmlhttpRequest({
            method: "GET",
            url: `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`,
            onload: function(res) {
                try {
                    const data = JSON.parse(res.responseText);
                    if (data.data && data.data.length > 0) {
                        const id = data.data[0].mal_id;
                        GM_xmlhttpRequest({
                            method: "GET",
                            url: `https://api.jikan.moe/v4/anime/${id}/themes`,
                            onload: function(res2) {
                                try {
                                    const themesData = JSON.parse(res2.responseText);
                                    if (themesData.data) {
                                        if (!lib[key]) lib[key] = {};
                                        lib[key].themes = {
                                            op: themesData.data.openings || [],
                                            ed: themesData.data.endings || []
                                        };
                                        saveLib(lib);
                                        callback(lib[key].themes);
                                    }
                                } catch (e) { callback(null); }
                            }
                        });
                    } else { callback(null); }
                } catch (e) { callback(null); }
            }
        });
    }

    /* ==================== AUDIO ENGINE ==================== */
    let audioCtx = null, analyser = null, sourceNode = null;
    let isRecording = false, recordType = null;
    let recordBuffer = [];
    let isListening = false, hasSkippedOP = false, hasSkippedED = false;

    // Temporary storage for confirmation
    let pendingRecord = null; 

    function initAudio(vid) {
        if (audioCtx) return true;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = CFG.FFT_SIZE;
            analyser.smoothingTimeConstant = 0.3;
            sourceNode = audioCtx.createMediaElementSource(vid);
            sourceNode.connect(analyser);
            analyser.connect(audioCtx.destination);
            return true;
        } catch (e) {
            return false;
        }
    }

    function getFreqSnapshot() {
        const bins = analyser.frequencyBinCount;
        const data = new Float32Array(bins);
        analyser.getFloatFrequencyData(data);
        const bands = 64;
        const step = Math.floor(bins / bands);
        const out = new Float32Array(bands);
        for (let i = 0; i < bands; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) sum += data[i * step + j];
            out[i] = sum / step;
        }
        return out;
    }

    function startRecording(type) {
        const vid = video();
        if (!vid) return;
        if (!initAudio(vid)) { setStatus('❌ Audio init failed'); return; }
        if (audioCtx.state === 'suspended') audioCtx.resume();

        recordType = type;
        isRecording = true;
        recordBuffer = [];
        const startTime = vid.currentTime;
        setStatus(`🔴 Recording ${type.toUpperCase()}... (${CFG.SIG_DURATION_S}s)`);

        const ivl = setInterval(() => {
            if (!isRecording || vid.paused) return; // Pause recording if video pauses
            recordBuffer.push(Array.from(getFreqSnapshot()));
            if (recordBuffer.length >= CFG.SIG_DURATION_S * CFG.SAMPLE_RATE_HZ) {
                clearInterval(ivl);
                isRecording = false;
                
                // Store in pending instead of saving directly
                pendingRecord = {
                    type: recordType,
                    frames: recordBuffer,
                    startTime: startTime,
                    endTime: vid.currentTime
                };
                
                showConfirmationUI();
                setStatus(`✅ Recorded. Please confirm sample.`);
            }
        }, 1000 / CFG.SAMPLE_RATE_HZ);
    }

    function savePendingSignature() {
        if (!pendingRecord) return;
        const key = getSeriesKey();
        if (!key) return;

        if (!lib[key]) lib[key] = {};
        lib[key][pendingRecord.type + '_sig'] = pendingRecord.frames;
        lib[key][pendingRecord.type + '_dur'] = lib[key][pendingRecord.type + '_dur'] || CFG.DEFAULT_SKIP_DUR;
        // Default auto-skip to true
        if (typeof lib[key].autoSkip === 'undefined') lib[key].autoSkip = true;
        
        saveLib(lib);
        setStatus(`✅ ${pendingRecord.type.toUpperCase()} signature saved.`);
        pendingRecord = null;
        hideConfirmationUI();
        refreshInfo();
    }

    /* ==================== CORRELATION ENGINE ==================== */
    function pearson(a, b) {
        if (a.length !== b.length || a.length === 0) return 0;
        const n = a.length;
        let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
        for (let i = 0; i < n; i++) {
            sumA += a[i]; sumB += b[i];
            sumAB += a[i] * b[i];
            sumA2 += a[i] * a[i]; sumB2 += b[i] * b[i];
        }
        const num = n * sumAB - sumA * sumB;
        const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
        return den === 0 ? 0 : num / den;
    }

    function flatten(sig) {
        const out = [];
        for (const frame of sig) out.push(...frame);
        return out;
    }

    function correlateWindow(liveBuffer, savedSig) {
        const flatSaved = flatten(savedSig);
        const sigLen = flatSaved.length;
        if (liveBuffer.length < sigLen) return 0;
        const chunk = liveBuffer.slice(liveBuffer.length - sigLen);
        return pearson(chunk, flatSaved);
    }

    /* ==================== LISTENING & MANUAL PROMPT ==================== */
    let listenIvl = null, liveRing = [];

    function triggerSkip(type, entry, t, vid) {
        const skipTo = t + (entry[type + '_dur'] || CFG.DEFAULT_SKIP_DUR);
        
        if (entry.autoSkip !== false) {
            vid.currentTime = Math.min(skipTo, vid.duration || skipTo);
            setStatus(`🚀 ${type.toUpperCase()} Auto-Skipped!`);
        } else {
            showManualPrompt(type, skipTo);
        }
    }

    function startListening() {
        const vid = video();
        if (!vid || isListening) return;
        if (!initAudio(vid)) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        isListening = true;
        liveRing = [];

        listenIvl = setInterval(() => {
            if (!video() || video().paused || isRecording) return;
            const v = video();
            const t = v.currentTime;
            const dur = v.duration || 0;

            if (dur > 0 && t > dur - CFG.ANTI_SPOILER_S) return;

            const snap = Array.from(getFreqSnapshot());
            liveRing.push(...snap);

            const key = getSeriesKey();
            if (!key || !lib[key]) return;
            const entry = lib[key];

            if (entry.op_sig && !hasSkippedOP && t < CFG.MATCH_WINDOW_S) {
                const sigLen = flatten(entry.op_sig).length;
                if (liveRing.length > sigLen * 2) liveRing.splice(0, liveRing.length - sigLen * 2);
                const corr = correlateWindow(liveRing, entry.op_sig);
                updateMeter(corr);
                if (corr >= ui.threshold) {
                    hasSkippedOP = true;
                    triggerSkip('op', entry, t, v);
                }
            }

            if (entry.ed_sig && !hasSkippedED && dur > 0 && t > dur * 0.7) {
                const corr = correlateWindow(liveRing, entry.ed_sig);
                updateMeter(corr);
                if (corr >= ui.threshold) {
                    hasSkippedED = true;
                    triggerSkip('ed', entry, t, v);
                }
            }
        }, CFG.MATCH_INTERVAL_MS);
    }

    function stopListening() {
        if (listenIvl) { clearInterval(listenIvl); listenIvl = null; }
        isListening = false;
        liveRing = [];
    }

    /* ==================== GUI (Main Page Only) ==================== */
    function setStatus(msg) {
        const el = $('#echo-status');
        if (el) el.textContent = msg;
    }
    function updateMeter(val) {
        const bar = $('#echo-meter-fill');
        if (!bar) return;
        const pct = Math.max(0, Math.min(100, val * 100));
        bar.style.width = pct + '%';
        bar.style.background = val >= ui.threshold ? '#4caf50' : (val > 0.5 ? '#ff9800' : '#555');
    }
    
    function refreshInfo() {
        const el = $('#echo-info');
        const ostEl = $('#echo-ost-names');
        if (!el) return;
        const key = getSeriesKey();
        if (!key) { 
            el.textContent = 'No title detected'; 
            if(ostEl) ostEl.innerHTML = '';
            return; 
        }
        
        const entry = lib[key];
        if (!entry) { 
            el.textContent = `"${key}" — No signatures`; 
            if(ostEl) ostEl.innerHTML = '';
            return; 
        }
        
        const parts = [];
        if (entry.op_sig) parts.push(`OP ✓ (${entry.op_dur}s)`);
        if (entry.ed_sig) parts.push(`ED ✓ (${entry.ed_dur}s)`);
        el.textContent = parts.length ? parts.join(' · ') : 'No signatures';
        
        // Auto Skip Toggle
        const toggleBtn = $('#echo-auto-toggle');
        if (toggleBtn) {
            const isAuto = entry.autoSkip !== false;
            toggleBtn.textContent = isAuto ? '🤖 Auto Skip: ON' : '🖐 Manual Skip: ON';
            toggleBtn.className = isAuto ? 'echo-btn go' : 'echo-btn';
        }

        // Fetch OST Names
        if (ostEl) {
            const title = getCleanTitle();
            if (title && !entry.themes) {
                fetchThemes(title, (themes) => {
                    renderThemes(themes, ostEl);
                });
            } else {
                renderThemes(entry.themes, ostEl);
            }
        }
    }

    function renderThemes(themes, container) {
        if (!themes) { container.innerHTML = '<div style="color:#888;">No OST data found.</div>'; return; }
        let html = '';
        if (themes.op && themes.op.length) html += `<div title="${themes.op.join('\n')}">🎵 <b>OP:</b> ${themes.op[0].substring(0,40)}...</div>`;
        if (themes.ed && themes.ed.length) html += `<div title="${themes.ed.join('\n')}">🎵 <b>ED:</b> ${themes.ed[0].substring(0,40)}...</div>`;
        container.innerHTML = html;
    }

    function showConfirmationUI() {
        if (!isMainPage) return;
        const box = $('#echo-confirm-box');
        if (box) {
            box.style.display = 'block';
            $('#echo-confirm-text').textContent = `Review ${pendingRecord.type.toUpperCase()} Sample`;
        }
    }
    
    function hideConfirmationUI() {
        if (!isMainPage) return;
        const box = $('#echo-confirm-box');
        if (box) box.style.display = 'none';
    }

    // Manual prompt UI injected into player
    function showManualPrompt(type, skipTo) {
        if (isMainPage) {
            // Tell iframe to show prompt
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'ECHO_SHOW_PROMPT', skipType: type, skipTo: skipTo }, '*'); } catch (_) {}
            });
        }
        
        // Show in current context
        let prompt = $('#echo-manual-prompt');
        if (!prompt) {
            prompt = document.createElement('div');
            prompt.id = 'echo-manual-prompt';
            prompt.style.cssText = 'position:absolute; bottom:80px; right:30px; background:rgba(0,0,0,0.8); color:#fff; padding:10px 15px; border-radius:8px; z-index:999999; font-family:sans-serif; border:1px solid #e94560; box-shadow:0 4px 15px rgba(233,69,96,0.5); display:flex; gap:10px; align-items:center; cursor:pointer; transition:transform 0.2s;';
            prompt.innerHTML = `<span>⏭️ Skip <b id="emp-type"></b></span>`;
            
            prompt.onmouseover = () => prompt.style.transform = 'scale(1.05)';
            prompt.onmouseout = () => prompt.style.transform = 'scale(1)';
            
            document.body.appendChild(prompt);
        }
        
        $('#emp-type', prompt).textContent = type.toUpperCase();
        prompt.style.display = 'flex';
        
        prompt.onclick = () => {
            const v = video();
            if (v) v.currentTime = Math.min(skipTo, v.duration || skipTo);
            prompt.style.display = 'none';
            if (isMainPage) setStatus(`🚀 ${type.toUpperCase()} Manually Skipped!`);
        };
        
        // Hide after 15 seconds
        setTimeout(() => { if (prompt) prompt.style.display = 'none'; }, 15000);
    }

    if (!isMainPage) {
        window.addEventListener('message', e => {
            if (e.data?.type === 'ECHO_SHOW_PROMPT') {
                showManualPrompt(e.data.skipType, e.data.skipTo);
            }
        });
    }

    if (isMainPage) {
        const css = document.createElement('style');
        css.textContent = `
            #echo-skip { position:fixed; bottom:20px; left:20px; width:280px; background:#1a1a2e; color:#eee; font-family:system-ui,sans-serif; border-radius:12px; z-index:999999; box-shadow:0 8px 32px rgba(0,0,0,0.6); border:1px solid #333; overflow:hidden; transition:opacity 0.15s; }
            #echo-header { padding:8px 12px; background:#16213e; cursor:move; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; user-select:none; }
            #echo-header span { font-weight:bold; font-size:13px; color:#e94560; }
            #echo-body { padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
            #echo-body.hidden { display:none !important; }
            .echo-row { display:flex; gap:6px; align-items:center; }
            .echo-row input[type=number] { flex:1; min-width:0; background:#0f3460; color:#fff; border:1px solid #444; border-radius:6px; padding:5px 8px; outline:none; font-size:12px; }
            .echo-btn { background:#0f3460; color:#fff; border:1px solid #444; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:11px; white-space:nowrap; transition:filter 0.15s; }
            .echo-btn:hover { filter:brightness(1.4); }
            .echo-btn.rec { background:#b91c1c; }
            .echo-btn.rec:hover { background:#dc2626; }
            .echo-btn.go { background:#166534; }
            .echo-btn.warn { background:#b45309; }
            .echo-btn.del { background:#7f1d1d; font-size:10px; }
            #echo-meter { width:100%; height:8px; background:#222; border-radius:4px; overflow:hidden; }
            #echo-meter-fill { height:100%; width:0%; background:#555; transition:width 0.3s, background 0.3s; border-radius:4px; }
            #echo-info { font-size:10px; color:#888; text-align:center; font-weight:bold;}
            #echo-ost-names { font-size:9px; color:#aaa; line-height:1.4; background:#111827; padding:4px; border-radius:4px; margin-top:2px;}
            #echo-status { font-size:11px; color:#aaa; text-align:center; margin-top:2px; }
            .echo-slider { display:flex; align-items:center; gap:6px; font-size:10px; color:#888; }
            .echo-slider input[type=range] { flex:1; accent-color:#e94560; height:4px; }
            .echo-section { border-top:1px solid #333; padding-top:6px; margin-top:2px; }
            #echo-confirm-box { display:none; background:#374151; padding:8px; border-radius:6px; border:1px dashed #fbbf24; margin-top:4px; text-align:center; }
        `;
        document.head.append(css);

        const gui = document.createElement('div');
        gui.id = 'echo-skip';
        gui.style.opacity = ui.opacity;
        gui.innerHTML = `
            <div id="echo-header">
                <span>🎵 EchoSkip</span>
                <div style="display:flex;gap:6px;">
                    <button class="echo-btn" id="echo-min" style="background:none;border:none;font-size:16px;color:#fff;padding:0">−</button>
                </div>
            </div>
            <div id="echo-body">
                <div id="echo-info">Detecting title…</div>
                <div id="echo-ost-names"></div>
                
                <div id="echo-meter" style="margin-top:4px;"><div id="echo-meter-fill"></div></div>

                <div class="echo-section">
                    <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                        <span style="font-size:10px;color:#888;">🎤 Record Signatures</span>
                        <button class="echo-btn go" id="echo-auto-toggle" style="padding:2px 6px; font-size:9px;">🤖 Auto Skip: ON</button>
                    </div>
                    <div class="echo-row">
                        <button class="echo-btn rec" id="echo-rec-op">⏺ Record OP</button>
                        <button class="echo-btn rec" id="echo-rec-ed">⏺ Record ED</button>
                    </div>
                    
                    <div id="echo-confirm-box">
                        <div id="echo-confirm-text" style="font-size:11px; margin-bottom:6px;"></div>
                        <div class="echo-row" style="justify-content:center;">
                            <button class="echo-btn warn" id="echo-replay-btn">▶️ Replay</button>
                            <button class="echo-btn go" id="echo-save-btn">✅ Save</button>
                            <button class="echo-btn del" id="echo-cancel-btn">❌</button>
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

                <div class="echo-row" style="justify-content:center; margin-top:4px;">
                    <button class="echo-btn del" id="echo-clear">🗑️ Clear Anime</button>
                    <button class="echo-btn" id="echo-export" style="font-size:10px">📤 Export</button>
                    <button class="echo-btn" id="echo-import" style="font-size:10px">📥 Import</button>
                </div>

                <div id="echo-status">Ready</div>
            </div>
        `;
        document.body.append(gui);

        if (ui.minimized) { $('#echo-body').classList.add('hidden'); $('#echo-min').textContent = '+'; }
        if (ui.left !== null) { gui.style.left = ui.left + 'px'; gui.style.top = ui.top + 'px'; gui.style.bottom = 'auto'; }

        $('#echo-min').onclick = () => {
            const body = $('#echo-body');
            body.classList.toggle('hidden');
            ui.minimized = body.classList.contains('hidden');
            $('#echo-min').textContent = ui.minimized ? '+' : '−';
            saveUI(ui);
        };

        let dragging = false, off = { x: 0, y: 0 };
        $('#echo-header').onmousedown = e => { if (e.target.tagName !== 'BUTTON') { dragging = true; off = { x: e.clientX - gui.offsetLeft, y: e.clientY - gui.offsetTop }; } };
        window.onmousemove = e => { if (dragging) { gui.style.left = (e.clientX - off.x) + 'px'; gui.style.top = (e.clientY - off.y) + 'px'; gui.style.bottom = 'auto'; gui.style.right = 'auto'; } };
        window.onmouseup = () => { if (dragging) { ui.left = gui.offsetLeft; ui.top = gui.offsetTop; saveUI(ui); } dragging = false; };

        $('#echo-rec-op').onclick = () => startRecording('op');
        $('#echo-rec-ed').onclick = () => startRecording('ed');

        $('#echo-replay-btn').onclick = () => {
            const v = video();
            if (v && pendingRecord) {
                v.currentTime = pendingRecord.startTime;
                v.play();
            }
        };
        
        $('#echo-save-btn').onclick = () => savePendingSignature();
        
        $('#echo-cancel-btn').onclick = () => {
            pendingRecord = null;
            hideConfirmationUI();
            setStatus('Cancelled recording.');
        };

        $('#echo-auto-toggle').onclick = () => {
            const key = getSeriesKey();
            if (!key || !lib[key]) { setStatus('❌ Record a signature first'); return; }
            lib[key].autoSkip = (lib[key].autoSkip === false) ? true : false;
            saveLib(lib);
            refreshInfo();
        };

        $('#echo-save-dur').onclick = () => {
            const key = getSeriesKey();
            if (!key || !lib[key]) { setStatus('❌ Record a signature first'); return; }
            const opVal = parseInt($('#echo-op-dur').value);
            const edVal = parseInt($('#echo-ed-dur').value);
            if (!isNaN(opVal)) lib[key].op_dur = opVal;
            if (!isNaN(edVal)) lib[key].ed_dur = edVal;
            saveLib(lib);
            setStatus('✅ Durations saved');
            refreshInfo();
        };

        $('#echo-threshold').oninput = e => {
            ui.threshold = parseFloat(e.target.value);
            $('#echo-thresh-val').textContent = Math.round(ui.threshold * 100) + '%';
            saveUI(ui);
        };

        $('#echo-opacity').oninput = e => {
            ui.opacity = parseFloat(e.target.value);
            gui.style.opacity = ui.opacity;
            $('#echo-opacity-val').textContent = Math.round(ui.opacity * 100) + '%';
            saveUI(ui);
        };

        $('#echo-clear').onclick = () => {
            const key = getSeriesKey();
            if (key && lib[key]) { delete lib[key]; saveLib(lib); setStatus('🗑️ Cleared'); refreshInfo(); }
        };

        $('#echo-export').onclick = () => {
            const blob = new Blob([JSON.stringify(lib, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'echoSkip_library.json';
            a.click();
        };

        $('#echo-import').onclick = () => {
            const inp = document.createElement('input'); inp.type = 'file';
            inp.onchange = e => {
                const reader = new FileReader();
                reader.onload = ev => {
                    try {
                        const imported = JSON.parse(ev.target.result);
                        for (const [k, v] of Object.entries(imported)) {
                            if (!lib[k]) lib[k] = v;
                            else {
                                if (v.op_sig && !lib[k].op_sig) { lib[k].op_sig = v.op_sig; lib[k].op_dur = v.op_dur; }
                                if (v.ed_sig && !lib[k].ed_sig) { lib[k].ed_sig = v.ed_sig; lib[k].ed_dur = v.ed_dur; }
                            }
                        }
                        saveLib(lib);
                        setStatus(`✅ Merged ${Object.keys(imported).length} entries`);
                        refreshInfo();
                    } catch (_) { setStatus('❌ Invalid file'); }
                };
                reader.readAsText(e.target.files[0]);
            };
            inp.click();
        };

        setTimeout(() => {
            refreshInfo();
            const key = getSeriesKey();
            if (key && lib[key]) {
                if (lib[key].op_dur) $('#echo-op-dur').value = lib[key].op_dur;
                if (lib[key].ed_dur) $('#echo-ed-dur').value = lib[key].ed_dur;
            }
        }, 1500);
    }

    /* ==================== VIDEO OBSERVER (runs everywhere) ==================== */
    let currentVideo = null;
    const obs = new MutationObserver(() => {
        const v = video();
        if (v && v !== currentVideo) {
            currentVideo = v;
            hasSkippedOP = false;
            hasSkippedED = false;

            v.addEventListener('play', () => {
                const key = getSeriesKey();
                if (key && lib[key] && (lib[key].op_sig || lib[key].ed_sig)) {
                    if (!isListening) startListening();
                    setStatus('👂 Listening…');
                }
            }, { once: true });

            v.addEventListener('ended', () => stopListening());
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });

})();
