// ==UserScript==
// @name         AnimeHay Smart Video Skipper (Iframe & Full Site)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @updateURL    https://raw.githubusercontent.com/TLE47/animehay_epTracker_anilist/main/animehaySmartSkipper.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/animehay_epTracker_anilist/main/animehaySmartSkipper.user.js
// @description  Fuzzy search skipper that works across iframes (Hydrax) with shared DB
// @author       Gemini
// @include      /.*animehay.*/
// @include      /^https?:\/\/([^\/]+\.)?playhydrax\.[^\/]+\/.*/
// @include      /^https?:\/\/([^\/]+\.)?ahay\.stream\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    /* -------------------- ENVIRONMENT CHECK -------------------- */
    const isMainPage = window.self === window.top;

    // --- Core Selectors ---
    // Update these if the anime website layout/classes change in the future
    const SELECTORS = {
        videoInfoBounds: '.movies-list.ah-frame-bg, .info-movie, .watching-movie',
        highlightTargets: ['h1', '.name', '.title', '.aim-hero__title', '.info .name_more', 'a.color-yellow']
    };

    /* -------------------- DATA MANAGEMENT -------------------- */
    const cleanStr = (str) => {
        if (!str) return "";
        return str.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\w\s]/gi, '')
            .trim();
    };

    const loadDB = () => {
        try {
            const data = GM_getValue('skipDB', {});
            return (data && typeof data === 'object') ? data : {};
        } catch (e) { return {}; }
    };

    const store = {
        db: loadDB(),
        ui: GM_getValue('skipperUI', {
            minimized: false,
            left: null,
            top: null,
            enabled: true,
            highlight: true,
            opacity: 1
        }),
        saveDB() {
            for (let key in this.db) { this.db[key].rules.sort((a, b) => a.min - b.min); }
            GM_setValue('skipDB', this.db);
        },
        saveUI() { GM_setValue('skipperUI', this.ui); }
    };

    /* -------------------- CORE LOGIC -------------------- */
    const $ = (s, ctx = document) => ctx.querySelector(s);
    const video = () => $('video');
    const getMins = (sec) => Math.floor(sec / 60);

    // Cross-domain title storage
    let iframeReceivedTitle = "";

    function findMatchKey() {
        // If in iframe, use title sent from parent. If on main page, use document.title.
        const sourceTitle = isMainPage ? document.title : iframeReceivedTitle;
        if (!sourceTitle) return null;

        // Strip exactly like Animehay2Anilist: extract the string explicitly between "Phim " and " Tập"
        let extractedTitle = sourceTitle;
        const titleMatch = sourceTitle.match(/Phim\s+(.+?)\s+Tập/i);
        if (titleMatch) {
            extractedTitle = titleMatch[1];
        }

        // Apply generic streaming site word stripping as backup
        let pageTitle = cleanStr(extractedTitle);
        const genericWords = /\b(xem phim|phim|tap(?:\s+\d+)?|vietsub|thuyet minh|long tieng|tron bo|movie|ova|tv|animehay|anime)\b/g;
        pageTitle = pageTitle.replace(genericWords, ' ').replace(/\s+/g, ' ').trim();

        let bestMatch = null;

        for (const [cleanKey, data] of Object.entries(store.db)) {
            // Prevent insanely short/generic keys from matching
            if (cleanKey.length <= 2) continue;

            const safeKey = cleanKey.replace(genericWords, ' ').replace(/\s+/g, ' ').trim();
            if (safeKey.length <= 2) continue; // It was literally just a generic word

            if (pageTitle.includes(safeKey)) {
                // Keep the longest matching key (e.g., "One Piece Film Red" beats "One" or "Piece")
                if (!bestMatch || cleanKey.length > bestMatch.length) {
                    bestMatch = cleanKey;
                }
            }
        }
        
        return bestMatch;
    }

    /* -------------------- CROSS-DOMAIN BRIDGE -------------------- */
    if (isMainPage) {
        // Periodically "shout" the title to all iframes
        setInterval(() => {
            const iframes = document.querySelectorAll('iframe');
            iframes.forEach(frame => {
                frame.contentWindow.postMessage({ type: 'SK_TITLE_TRANSFER', title: document.title }, '*');
            });
        }, 2000);
    } else {
        // Listen for the title message inside the player iframe
        window.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'SK_TITLE_TRANSFER') {
                iframeReceivedTitle = e.data.title;
            }
        });
    }

    /* -------------------- UI & STYLES (Main Page Only) -------------------- */
    if (isMainPage) {
        const styleSheet = document.createElement('style');
        styleSheet.textContent = `
            #skipper { position: fixed; top: 20px; right: 20px; width: 260px; background: #1e1e1e; color: #eee; font-family: system-ui, sans-serif; border-radius: 10px; z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.5); border: 1px solid #333; transition: opacity 0.1s; overflow: hidden; }
            #sk-header { padding: 10px; background: #2a2a2a; cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; font-weight: bold; user-select: none; }
            #sk-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; box-sizing: border-box; }
            .row { display: flex; gap: 6px; width: 100%; box-sizing: border-box; }
            .row input { flex: 1; min-width: 0; }
            input, button { background: #2b2b2b; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; outline: none; box-sizing: border-box; }
            button { cursor: pointer; transition: filter 0.2s; white-space: nowrap; }
            button:hover { filter: brightness(1.3); }
            #sk-rules { max-height: 180px; overflow-y: auto; border-top: 1px solid #333; margin-top: 5px; display: block; scroll-behavior: smooth; }
            #sk-rules.hidden, #sk-body.hidden { display: none !important; }
            .rule-group { border-bottom: 1px solid #333; transition: all 0.3s; }
            .rule-group.active-match { background: #3d3d14; border-left: 4px solid #ffcc00; }
            .rule-item { padding: 8px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; }
            .del-btn { color: #ff5555; border: none; background: none; font-size: 14px; cursor: pointer; padding: 0 5px; }
            #sk-status { font-size: 11px; color: #aaa; text-align: center; margin-top: 5px; }
            .sk-picking-active { outline: 2px solid #ffcc00 !important; outline-offset: -2px; cursor: crosshair !important; }
            #sk-cancel-pick { display: none; background: #ff5555; border: none; font-weight: bold; padding: 0 12px; }
            .slider-container { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #333; padding: 10px 0 4px 0; width: 100%; }
            .slider-header { display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
            input[type=range]#sk-opacity { width: 100%; height: 6px; accent-color: #ffcc00; cursor: pointer; margin: 4px 0; background: #333; border: none; border-radius: 10px; padding: 0; }
            .sk-page-highlight { color: #ffcc00 !important; text-shadow: 0 0 10px rgba(255, 204, 0, 0.5) !important; border-bottom: 2px dashed #ffcc00; display: inline-block; }
        `;
        document.head.append(styleSheet);

        const gui = document.createElement('div');
        gui.id = 'skipper';
        gui.style.opacity = store.ui.opacity;
        gui.innerHTML = `
            <div id="sk-header"><span>⏩ Skipper</span><button id="sk-min" style="background:none; border:none; font-size:20px">−</button></div>
            <div id="sk-body">
                <div class="row">
                    <input id="sk-title" placeholder="Anime title...">
                    <button id="sk-pick" title="Select title from page">🔍</button>
                    <button id="sk-cancel-pick" title="Cancel">✕</button>
                </div>
                <div class="row"><input id="sk-minDur" type="number" placeholder="Min min"><input id="sk-maxDur" type="number" placeholder="Max min"></div>
                <div class="row"><input id="sk-skip" type="number" placeholder="Skip to (s)"><button id="sk-capture">🎯</button></div>
                <button id="sk-add" style="background: #2e7d32; border:none; font-weight: bold;">Add Rule</button>
                <div class="row"><button id="sk-check" style="flex:1">Check</button><button id="sk-show" style="flex:1">Rules</button></div>
                <div class="row"><button id="sk-import" style="flex:1; font-size:10px">Merge</button><button id="sk-export" style="flex:1; font-size:10px">Export</button></div>
                <div class="slider-container">
                    <div class="slider-header"><span>Transparency</span><span id="sk-opacity-val">${Math.round(store.ui.opacity * 100)}%</span></div>
                    <input type="range" id="sk-opacity" min="0.1" max="1" step="0.05" value="${store.ui.opacity}">
                </div>
                <div class="row" style="align-items:center; gap:10px; border-top:1px solid #333; padding-top:8px;">
                    <input type="checkbox" id="sk-enabled" ${store.ui.enabled ? 'checked' : ''}><label style="font-size: 11px;">Auto-Skip</label>
                    <input type="checkbox" id="sk-highlight" ${store.ui.highlight ? 'checked' : ''}><label style="font-size: 11px;">Highlight</label>
                </div>
                <div id="sk-rules" class="hidden"></div><div id="sk-status">Ready</div>
            </div>
        `;
        document.body.append(gui);

        /* -------------------- UI LOGIC -------------------- */
        const updateStatus = (msg) => $('#sk-status').textContent = msg;

        $('#sk-opacity').oninput = (e) => {
            const val = e.target.value;
            gui.style.opacity = val;
            $('#sk-opacity-val').textContent = `${Math.round(val * 100)}%`;
            store.ui.opacity = val;
            store.saveUI();
        };

        let dragging = false, offset = { x: 0, y: 0 };
        $('#sk-header').onmousedown = e => { if (e.target.tagName !== 'BUTTON') { dragging = true; offset = { x: e.clientX - gui.offsetLeft, y: e.clientY - gui.offsetTop }; } };
        window.onmousemove = e => { if (dragging) { gui.style.left = (e.clientX - offset.x) + 'px'; gui.style.top = (e.clientY - offset.y) + 'px'; gui.style.right = 'auto'; } };
        window.onmouseup = () => { if (dragging) { store.ui.left = gui.offsetLeft; store.ui.top = gui.offsetTop; store.saveUI(); } dragging = false; };

        $('#sk-min').onclick = () => { $('#sk-body').classList.toggle('hidden'); store.ui.minimized = $('#sk-body').classList.contains('hidden'); store.saveUI(); $('#sk-min').textContent = store.ui.minimized ? '+' : '−'; checkIntersection(); };
        $('#sk-enabled').onchange = (e) => { store.ui.enabled = e.target.checked; store.saveUI(); };
        $('#sk-highlight').onchange = (e) => { store.ui.highlight = e.target.checked; store.saveUI(); renderRules(); };

        $('#sk-add').onclick = () => {
            const rawTitle = $('#sk-title').value.trim(), cleanKey = cleanStr(rawTitle);
            const min = parseInt($('#sk-minDur').value), max = parseInt($('#sk-maxDur').value), skip = parseInt($('#sk-skip').value);
            if (!cleanKey || isNaN(min) || isNaN(max) || isNaN(skip)) return updateStatus('❌ Invalid');
            if (!store.db[cleanKey]) store.db[cleanKey] = { displayName: rawTitle, rules: [] };
            store.db[cleanKey].rules.push({ min, max, skip });
            store.saveDB(); updateStatus('✅ Added'); renderRules();
        };

        $('#sk-rules').onclick = (e) => {
            if (e.target.classList.contains('del-btn')) {
                const { key, idx } = e.target.dataset;
                store.db[key].rules.splice(idx, 1);
                if (!store.db[key].rules.length) delete store.db[key];
                store.saveDB(); renderRules();
            }
        };

        $('#sk-show').onclick = () => { $('#sk-rules').classList.toggle('hidden'); renderRules(); };
        $('#sk-check').onclick = () => { const key = findMatchKey(); updateStatus(key ? `🎯 Match: ${store.db[key].displayName}` : '❓ No match'); renderRules(); };

        // Export/Import
        $('#sk-export').onclick = () => { const blob = new Blob([JSON.stringify({ skipDB: store.db, uiState: store.ui }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = "skipper_final.json"; a.click(); };
        $('#sk-import').onclick = () => {
            const input = document.createElement('input'); input.type = 'file';
            input.onchange = (e) => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (!data.skipDB) throw "Err";
                        for (const [key, inc] of Object.entries(data.skipDB)) {
                            if (!store.db[key]) store.db[key] = inc;
                            else inc.rules.forEach(r => { if (!store.db[key].rules.some(old => old.min === r.min && old.skip === r.skip)) store.db[key].rules.push(r); });
                        }
                        store.saveDB(); location.reload();
                    } catch (err) { updateStatus('❌ Error'); }
                };
                reader.readAsText(e.target.files[0]);
            };
            input.click();
        };

        // UI Initialization
        if (store.ui.minimized) $('#sk-body').classList.add('hidden');
        if (store.ui.left !== null) { gui.style.left = store.ui.left + 'px'; gui.style.top = store.ui.top + 'px'; gui.style.right = 'auto'; }

        function checkIntersection() {
            if (!store.ui.minimized || dragging) {
                gui.style.opacity = store.ui.opacity;
                gui.style.pointerEvents = 'auto';
                return;
            }
            const wRect = gui.getBoundingClientRect();
            const targets = document.querySelectorAll(SELECTORS.videoInfoBounds);
            let overlap = false;
            for (const el of targets) {
                const tRect = el.getBoundingClientRect();
                if (!(wRect.right < tRect.left || wRect.left > tRect.right || wRect.bottom < tRect.top || wRect.top > tRect.bottom)) {
                    overlap = true;
                    break;
                }
            }
            if (overlap) {
                gui.style.opacity = '0';
                gui.style.pointerEvents = 'none';
            } else {
                gui.style.opacity = store.ui.opacity;
                gui.style.pointerEvents = 'auto';
            }
        }
        window.addEventListener('scroll', checkIntersection, { passive: true });
        window.addEventListener('resize', checkIntersection, { passive: true });

        function highlightOnPage() {
            document.querySelectorAll('.sk-page-highlight').forEach(el => el.classList.remove('sk-page-highlight'));
            if (!store.ui.highlight) return;
            const matchKey = findMatchKey();
            if (!matchKey) return;
            SELECTORS.highlightTargets.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    if (cleanStr(el.textContent).includes(matchKey.split(' ')[0])) el.classList.add('sk-page-highlight');
                });
            });
        }

        function renderRules() {
            const box = $('#sk-rules'); box.innerHTML = '';
            const currentMatchKey = findMatchKey();
            const keys = Object.keys(store.db).sort();
            if (!keys.length) return box.innerHTML = '<div style="padding:10px; font-size:11px; text-align:center;">No rules</div>';
            for (const cleanKey of keys) {
                const data = store.db[cleanKey];
                const isMatch = store.ui.highlight && (cleanKey === currentMatchKey);
                const section = document.createElement('div');
                section.className = `rule-group ${isMatch ? 'active-match' : ''}`;
                section.innerHTML = `<div style="padding:4px 8px; background:#333; font-size:10px; font-weight:bold;">${data.displayName} ${isMatch ? '⭐' : ''}</div>`;
                data.rules.forEach((r, idx) => {
                    const item = document.createElement('div');
                    item.className = 'rule-item';
                    item.innerHTML = `<span>${r.min}-${r.max}m ➔ ${r.skip}s</span><button class="del-btn" data-key="${cleanKey}" data-idx="${idx}">🗑️</button>`;
                    section.append(item);
                });
                box.append(section);
            }
            highlightOnPage();
        }

        /* -------------------- PICKER LOGIC -------------------- */
        let isPicking = false;
        const togglePicker = (active) => {
            isPicking = active;
            $('#sk-pick').style.display = active ? 'none' : 'block';
            $('#sk-cancel-pick').style.display = active ? 'block' : 'none';
            updateStatus(active ? 'Click title on page' : 'Ready');
            if (active) {
                document.addEventListener('mouseover', handleMouseOver);
                document.addEventListener('click', handlePickerClick, { capture: true });
            } else {
                document.removeEventListener('mouseover', handleMouseOver);
                document.removeEventListener('click', handlePickerClick, { capture: true });
                const prev = $('.sk-picking-active');
                if (prev) prev.classList.remove('sk-picking-active');
            }
        };

        const handleMouseOver = (e) => {
            if (!isPicking || e.target.closest('#skipper')) return;
            const prev = $('.sk-picking-active');
            if (prev) prev.classList.remove('sk-picking-active');
            e.target.classList.add('sk-picking-active');
        };

        const handlePickerClick = (e) => {
            if (!isPicking || e.target.closest('#skipper')) return;
            e.preventDefault(); e.stopPropagation();
            const clone = e.target.cloneNode(true);
            clone.querySelectorAll('.material-icons-round, .material-icons, i, span[class*="icon"]').forEach(el => el.remove());
            let cleanedText = clone.textContent.replace(/\s+/g, ' ').trim();
            if (!cleanedText) cleanedText = e.target.innerText;
            if (cleanedText) { $('#sk-title').value = cleanedText; updateStatus('✨ Captured'); }
            togglePicker(false);
        };

        $('#sk-pick').onclick = () => togglePicker(true);
        $('#sk-cancel-pick').onclick = () => togglePicker(false);
        $('#sk-capture').onclick = () => { const v = video(); if (v) $('#sk-skip').value = Math.floor(v.currentTime); };

        setInterval(highlightOnPage, 3000);
        renderRules();
    }

    /* -------------------- SKIP CHECKER (Runs everywhere) -------------------- */
    let isSkipped = false, currentVideo = null;

    const runSkipCheck = () => {
        if (isSkipped || !store.ui.enabled) return;
        const v = video();
        if (!v || !v.duration) return;

        const key = findMatchKey();
        if (key) {
            const match = store.db[key].rules.find(r => getMins(v.duration) >= r.min && getMins(v.duration) <= r.max);
            if (match && v.currentTime < match.skip) {
                v.currentTime = match.skip;
                isSkipped = true;
                if (isMainPage) $('#sk-status').textContent = `🚀 Skipped by ${key}`;
            }
        }
    };

    // Watch for video elements being added (especially inside iframes)
    const observer = new MutationObserver(() => {
        const v = video();
        if (v && v !== currentVideo) {
            currentVideo = v;
            isSkipped = false;
            v.addEventListener('timeupdate', runSkipCheck);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();

