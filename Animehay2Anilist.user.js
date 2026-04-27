// ==UserScript==
// @name         AnimeHay to AniList Auto-Tracker
// @version      6.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/Animehay2Anilist.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/Animehay2Anilist.user.js
// @description  Auto-tracks watched episodes to AniList with library management
// @author       Gemini (refactored)
// @include      /.*animehay.*/
// @include      /^https?:\/\/([^\/]+\.)?playhydrax\.[^\/]+\/.*/
// @include      /^https?:\/\/([^\/]+\.)?ssplay\.[^\/]+\/.*/
// @include      /^https?:\/\/([^\/]+\.)?ahay\.[^\/]+\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @connect      graphql.anilist.co
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── Token setup ──────────────────────────────────────────────────────────
    let ACCESS_TOKEN = GM_getValue('anilist_token', '');
    if (!ACCESS_TOKEN) {
        const t = prompt('AniList Auto-Tracker: Enter your AniList JWT Token (one-time setup):');
        if (t?.trim()) {
            GM_setValue('anilist_token', t.trim());
            ACCESS_TOKEN = t.trim();
            alert('Token saved! Refreshing…');
            location.reload();
        }
        return;
    }

    // ─── Constants ────────────────────────────────────────────────────────────
    const SELECTORS = {
        videoInfoBounds: '.movies-list.ah-frame-bg, .info-movie, .watching-movie',
        titleAlt: '.aim-hero__alt-name',
        titleMainLink: 'a.color-yellow[href*="thong-tin-phim"]',
        epCurrent: '.wp-ep.current, .current.wp-ep, .wp-ep .current',
        epBoxClassic: '.bg-black.color-gray.fs-17',
        epBoxBackup: 'div.color-gray.bg-black.border-l-t',
        infoLink: '.wp-bc a[href*="/thong-tin-phim/"]',
    };

    const isMainPage = window.self === window.top;

    // ─── Utils ────────────────────────────────────────────────────────────────
    // Memoised so getShowId() isn't re-run every interval tick
    const showId = (() => {
        const path = window.location.pathname;
        const match = path.match(/\/thong-tin-phim\/([^/.]+)/)
            || path.match(/\/xem-phim\/([^/.]+)/);
        return match ? match[1].split('-tap-')[0] : path.split('/').pop();
    })();

    function getEpisodeId() {
        const m = window.location.pathname.match(/\/xem-phim\/([^/.]+)/);
        return m ? m[1] : null;
    }

    function cleanTitle(str) {
        if (!str) return '';
        return str
            .replace(/tập\s*\d+|tap\s*\d+/gi, '')
            .replace(/(movie|ova|tv|vietsub|lồng tiếng|thuyết minh|trọn bộ)/gi, '')
            .replace(/[-/.[\]():]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Levenshtein-based similarity  (0–1)
    function similarity(a, b) {
        a = a.toLowerCase(); b = b.toLowerCase();
        const la = a.length, lb = b.length;
        if (la === 0 && lb === 0) return 1;
        const longer = la >= lb ? la : lb;
        // DP with two rows
        let prev = Array.from({ length: lb + 1 }, (_, i) => i);
        for (let i = 1; i <= la; i++) {
            const cur = [i];
            for (let j = 1; j <= lb; j++) {
                cur[j] = a[i - 1] === b[j - 1]
                    ? prev[j - 1]
                    : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
            }
            prev = cur;
        }
        return (longer - prev[lb]) / longer;
    }

    // ─── Library (stored as JSON object keyed by title) ───────────────────────
    function getLib() { try { return GM_getValue('title_library_v2', {}); } catch { return {}; } }
    function saveLib(lib) { GM_setValue('title_library_v2', lib); }
    function addToLib(title) {
        if (!title) return;
        const lib = getLib();
        if (!lib[title]) { lib[title] = Date.now(); saveLib(lib); refreshMemoryList(); }
    }
    function removeFromLib(title) {
        const lib = getLib(); delete lib[title]; saveLib(lib); refreshMemoryList();
    }

    // ─── AniList API ──────────────────────────────────────────────────────────
    function gqlRequest(query, variables) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://graphql.anilist.co',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}` },
                data: JSON.stringify({ query, variables }),
                onload(res) {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.errors?.[0]?.message?.includes('Invalid token')) setStatus('🔑 Token Expired', 'orange');
                        resolve(data);
                    } catch { resolve({}); }
                },
                onerror() { resolve({}); },
            });
        });
    }

    // Search AniList for a title string; returns array of {id, romaji, english}
    async function searchAniList(term) {
        const res = await gqlRequest(
            `query($s:String){Page(page:1,perPage:10){media(search:$s,type:ANIME){id title{romaji english}}}}`,
            { s: term }
        );
        return (res?.data?.Page?.media || []).map(m => ({
            id: m.id,
            romaji: m.title.romaji || '',
            english: m.title.english || '',
        }));
    }

    // Score every candidate against the query title
    function bestMatch(candidates, query) {
        let best = null, bestScore = 0;
        for (const c of candidates) {
            const s = Math.max(similarity(query, c.romaji), similarity(query, c.english));
            if (s > bestScore) { bestScore = s; best = c; }
        }
        return best ? { anime: best, score: bestScore } : null;
    }

    // Try up to three progressively-shorter word prefixes in parallel, take best hit
    async function findBestMatch(titles) {
        const queries = new Set();
        for (const t of titles) {
            const words = t.split(/\s+/);
            // Full title, 4-word prefix, 2-word prefix
            [words.join(' '), words.slice(0, 4).join(' '), words.slice(0, 2).join(' ')]
                .filter(q => q.length > 2)
                .forEach(q => queries.add(q));
        }

        const results = await Promise.all([...queries].map(q => searchAniList(q)));
        const allCandidates = [...new Map(
            results.flat().map(c => [c.id, c])
        ).values()];

        let best = null, bestScore = 0;
        for (const title of titles) {
            const m = bestMatch(allCandidates, title);
            if (m && m.score > bestScore) { best = m; bestScore = m.score; }
        }
        return best;
    }

    // Write progress to AniList — preserves COMPLETED status
    async function saveProgress(mediaId, epNum, titleForLib) {
        // Check current list entry first to avoid overwriting COMPLETED
        const checkRes = await gqlRequest(
            `query($id:Int){Media(id:$id){mediaListEntry{status progress}}}`,
            { id: mediaId }
        );
        const entry = checkRes?.data?.Media?.mediaListEntry;
        const status = entry?.status === 'COMPLETED' ? 'COMPLETED' : 'CURRENT';

        const res = await gqlRequest(
            `mutation($m:Int,$p:Int,$s:MediaListStatus){SaveMediaListEntry(mediaId:$m,progress:$p,status:$s){id progress}}`,
            { m: mediaId, p: epNum, s: status }
        );
        if (res?.data?.SaveMediaListEntry) {
            setStatus(`✅ Synced Ep ${epNum}`, '#00ff00');
            addToLib(titleForLib);
            confirmBox.style.display = 'none';
        } else {
            setStatus('❌ Sync failed', 'red');
        }
    }

    // ─── Sync entry point ─────────────────────────────────────────────────────
    let syncLock = false; // prevent overlapping async syncs

    async function syncProgress(force = false) {
        if (syncLock) return;
        syncLock = true;
        try {
            await _syncProgress(force);
        } finally {
            syncLock = false;
        }
    }

    async function _syncProgress(force) {
        const manual = manualInput?.value.trim();

        // Gather all candidate titles
        const titles = new Set();
        if (manual) {
            titles.add(manual);
        } else {
            const mapped = mappedDisplay?.textContent;
            if (mapped && mapped !== '-') titles.add(mapped);

            // Alt names from page or fetched info page
            let altText = document.querySelector(SELECTORS.titleAlt)?.innerText || '';
            if (!altText) {
                const infoHref = document.querySelector(SELECTORS.infoLink)?.href;
                if (infoHref) {
                    setStatus('Fetching alt names…', '#3db4f2');
                    try {
                        const html = await fetch(infoHref).then(r => r.text());
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        altText = doc.querySelector(SELECTORS.titleAlt)?.innerText || '';
                    } catch { }
                }
            }
            altText.split(',').map(n => cleanTitle(n)).filter(n => n.length > 2).forEach(n => titles.add(n));
        }

        if (!titles.size) { setStatus('No title found', 'red'); return; }

        setStatus('Searching…', '#3db4f2');
        const result = await findBestMatch([...titles]);

        if (!result || result.score < 0.35) { setStatus('❌ No match', 'red'); return; }

        const epNum = parseInt(epDisplay?.textContent) || 1;
        const matchPct = Math.round(result.score * 100);
        const threshold = GM_getValue('sync_threshold', 85);
        const primaryTitle = manual || [...titles][0];

        if (matchPct >= threshold || force) {
            await saveProgress(result.anime.id, epNum, primaryTitle);
        } else {
            setStatus('Confirm match?', 'orange');
            confirmTitle.innerHTML = `Found: <b style="color:#3db4f2">${result.anime.romaji}</b><br>Score: ${matchPct}%`;
            confirmBox.style.display = 'block';
            btnAccept.onclick = () => saveProgress(result.anime.id, epNum, primaryTitle);
            btnCancel.onclick = () => { confirmBox.style.display = 'none'; setStatus('Cancelled', '#ff4444'); };
        }
    }

    // ─── Video tracking (iframe) ──────────────────────────────────────────────
    if (!isMainPage) {
        let resumed = false;
        const epId = getEpisodeId();

        const startTracking = (video) => {
            // Resume saved position once
            if (!resumed) {
                resumed = true;
                const saved = epId ? GM_getValue('time_' + epId, 0) : 0;
                if (saved > 10 && video.duration > 0 && saved < video.duration - 10) {
                    video.currentTime = saved;
                }
            }

            // Send metrics to parent on timeupdate (event-driven, not interval)
            video.addEventListener('timeupdate', () => {
                if (!video.duration) return;
                window.parent.postMessage({
                    type: 'AH_VIDEO_METRICS',
                    currentTime: video.currentTime,
                    duration: video.duration,
                    epId,
                }, '*');
            });
        };

        const tryVideo = () => {
            const v = document.querySelector('video');
            if (!v) return;
            if (v.readyState >= 1) { startTracking(v); }
            else { v.addEventListener('loadedmetadata', () => startTracking(v), { once: true }); }
        };

        // Watch for video appearing
        const vObs = new MutationObserver(() => { const v = document.querySelector('video'); if (v) { vObs.disconnect(); tryVideo(); } });
        vObs.observe(document.body, { childList: true, subtree: true });
        tryVideo();
        return; // iframe context exits here
    }

    // ─── Main page: receive metrics & drive auto-sync ─────────────────────────
    let lastEpId = null;
    let hasSyncedThisEp = false;

    window.addEventListener('message', e => {
        const d = e.data;
        if (d?.type !== 'AH_VIDEO_METRICS') return;

        const pct = (d.currentTime / d.duration) * 100;
        if (progressBar) progressBar.style.width = pct + '%';
        if (d.epId) GM_setValue('time_' + d.epId, d.currentTime);

        // Reset sync flag when episode changes
        if (d.epId !== lastEpId) { lastEpId = d.epId; hasSyncedThisEp = false; }

        const threshold = GM_getValue('sync_threshold', 85);
        if (pct >= threshold && !hasSyncedThisEp) {
            hasSyncedThisEp = true;
            syncProgress();
        }
    });

    // ─── UI update loop (main page only) ──────────────────────────────────────
    // Only updates display strings — no API calls here
    let lastRawTitle = '';
    setInterval(() => {
        // Extract title
        let raw = '';
        const titleMatch = document.title.match(/Phim\s+(.+?)\s+Tập/i);
        if (titleMatch) raw = cleanTitle(titleMatch[1]);
        else {
            const link = document.querySelector(SELECTORS.titleMainLink);
            if (link) raw = cleanTitle(link.innerText);
        }

        if (raw && raw !== lastRawTitle) {
            lastRawTitle = raw;
            if (rawDisplay) rawDisplay.textContent = raw;
            const saved = GM_getValue(showId, '');
            if (mappedDisplay && !manualInput?.value.trim()) {
                mappedDisplay.textContent = saved || raw;
            }
        }

        // Episode number
        const epBox = document.querySelector(SELECTORS.epCurrent)
            || document.querySelector(SELECTORS.epBoxClassic)
            || document.querySelector(SELECTORS.epBoxBackup);
        if (epBox && epDisplay) epDisplay.textContent = epBox.innerText.replace(/\D/g, '');
    }, 1000);

    // ─── GUI ──────────────────────────────────────────────────────────────────
    const savedPos = GM_getValue('widget_pos', {});
    const savedOpacity = GM_getValue('widget_opacity', 0.95);
    const savedThreshold = GM_getValue('sync_threshold', 85);
    const savedMinimized = GM_getValue('widget_minimized', false);

    const style = document.createElement('style');
    style.textContent = `
        #ah2al { position:fixed; top:10px; right:10px; width:340px; background:#0a0a0a; color:#00ff00;
                 border-radius:8px; font-family:monospace; font-size:12px; z-index:100000;
                 border:2px solid #3db4f2; box-shadow:0 4px 15px rgba(0,0,0,.8);
                 overflow:hidden; display:flex; flex-direction:column; opacity:${savedOpacity}; }
        #ah2al * { box-sizing:border-box; }
        #ah2al button { cursor:pointer; }
        #ah2al-body input[type=text] { width:100%; background:#000; color:#fff;
            border:1px solid #444; padding:5px; font-size:11px; }
        .mem-item { display:flex; justify-content:space-between; margin-bottom:4px;
            padding:3px 5px; background:#111; border:1px solid #222;
            align-items:center; border-radius:3px; }
        .mem-item span { font-size:9px; overflow:hidden; text-overflow:ellipsis;
            white-space:nowrap; flex:1; color:#eee; margin-right:5px; }
    `;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = 'ah2al';
    container.innerHTML = `
        <div id="ah2al-header" style="background:#1a1a1a;padding:8px 12px;cursor:move;
            display:flex;justify-content:space-between;align-items:center;
            border-bottom:1px solid #333;user-select:none;">
            <span style="color:#3db4f2;font-weight:bold;">AniList Tracker</span>
            <div style="display:flex;gap:8px;">
                <span id="ah2al-min" style="cursor:pointer;color:#ffcc00;">${savedMinimized ? '+' : '_'}</span>
                <span id="ah2al-close" style="cursor:pointer;color:#ff4444;">✕</span>
            </div>
        </div>
        <div id="ah2al-body" style="padding:12px;display:${savedMinimized ? 'none' : 'block'};">
            <div style="margin-bottom:8px;line-height:1.4;">
                <div style="color:#aaa;font-size:10px;display:flex;justify-content:space-between;align-items:center;">
                    <span>Detected: <span id="ah2al-raw" style="color:#eee">-</span></span>
                    <button id="ah2al-copy" style="background:#444;color:#fff;border:none;border-radius:3px;padding:2px 5px;font-size:9px;">COPY</button>
                </div>
                <div style="color:#3db4f2;font-size:11px;margin-top:4px;">
                    Mapped: <span id="ah2al-mapped" style="color:#fff;font-weight:bold;">-</span>
                </div>
            </div>

            <div id="ah2al-confirm" style="display:none;margin-bottom:10px;padding:10px;
                background:#1a1a00;border:1px solid #ffcc00;border-radius:4px;">
                <div style="color:#ffcc00;font-weight:bold;font-size:10px;margin-bottom:5px;">LOW MATCH — CONFIRM?</div>
                <div id="ah2al-confirm-title" style="color:#fff;font-size:11px;margin-bottom:8px;line-height:1.3;">-</div>
                <div style="display:flex;gap:5px;">
                    <button id="ah2al-accept" style="flex:1;background:#00aa00;color:#fff;border:none;padding:5px;border-radius:3px;font-weight:bold;">ACCEPT</button>
                    <button id="ah2al-cancel" style="flex:1;background:#aa0000;color:#fff;border:none;padding:5px;border-radius:3px;font-weight:bold;">CANCEL</button>
                </div>
            </div>

            <div style="display:flex;justify-content:space-between;margin:8px 0;
                background:#222;padding:5px;border-radius:3px;">
                <span>Ep: <span id="ah2al-ep" style="color:#fff;">-</span></span>
                <span id="ah2al-status" style="color:#ffcc00;">Ready</span>
            </div>

            <details style="margin-top:10px;background:#1a1a1a;border-radius:4px;border:1px solid #333;">
                <summary style="padding:5px;cursor:pointer;color:#3db4f2;">Manage Titles & Library</summary>
                <div style="padding:8px;border-top:1px solid #333;">
                    <input type="text" id="ah2al-manual" placeholder="Paste corrected title…">
                    <div id="ah2al-memlist" style="max-height:150px;overflow-y:auto;margin-top:8px;"></div>
                </div>
            </details>

            <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#aaa;font-size:10px;">Opacity: <span id="ah2al-op-val">${Math.round(savedOpacity * 100)}%</span></span>
                    <input type="range" id="ah2al-opacity" min="0.1" max="1" step="0.05" value="${savedOpacity}"
                        style="width:170px;height:4px;cursor:pointer;accent-color:#3db4f2;">
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#aaa;font-size:10px;">Auto-Sync @ <span id="ah2al-th-val">${savedThreshold}</span>%</span>
                    <input type="range" id="ah2al-threshold" min="10" max="99" step="1" value="${savedThreshold}"
                        style="width:170px;height:4px;cursor:pointer;accent-color:#ffcc00;">
                </div>
            </div>

            <button id="ah2al-sync" style="margin-top:10px;width:100%;background:#3db4f2;
                border:none;color:#fff;border-radius:4px;padding:10px;font-weight:bold;">
                SYNC NOW
            </button>
        </div>
        <div id="ah2al-prog-wrap" style="height:3px;background:rgba(255,255,255,.1);
            display:${savedMinimized ? 'none' : 'block'};">
            <div id="ah2al-prog" style="height:100%;width:0%;background:#3db4f2;transition:width .5s;"></div>
        </div>
    `;
    document.body.appendChild(container);

    // Restore saved position
    if (savedPos.left) {
        container.style.left = savedPos.left;
        container.style.top = savedPos.top;
        container.style.right = 'auto';
    }

    // ─── Scoped element refs ───────────────────────────────────────────────────
    const rawDisplay = container.querySelector('#ah2al-raw');
    const mappedDisplay = container.querySelector('#ah2al-mapped');
    const epDisplay = container.querySelector('#ah2al-ep');
    const statusEl = container.querySelector('#ah2al-status');
    const progressBar = container.querySelector('#ah2al-prog');
    const confirmBox = container.querySelector('#ah2al-confirm');
    const confirmTitle = container.querySelector('#ah2al-confirm-title');
    const btnAccept = container.querySelector('#ah2al-accept');
    const btnCancel = container.querySelector('#ah2al-cancel');
    const manualInput = container.querySelector('#ah2al-manual');
    const memList = container.querySelector('#ah2al-memlist');
    const body = container.querySelector('#ah2al-body');
    const progWrap = container.querySelector('#ah2al-prog-wrap');

    function setStatus(text, color = '#ffcc00') {
        statusEl.textContent = text;
        statusEl.style.color = color;
    }

    // ─── Panel controls ────────────────────────────────────────────────────────
    container.querySelector('#ah2al-min').addEventListener('click', function () {
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        progWrap.style.display = hidden ? 'block' : 'none';
        this.textContent = hidden ? '_' : '+';
        GM_setValue('widget_minimized', !hidden);
    });

    container.querySelector('#ah2al-close').addEventListener('click', () => container.remove());
    container.querySelector('#ah2al-sync').addEventListener('click', () => syncProgress(true));

    container.querySelector('#ah2al-copy').addEventListener('click', function () {
        GM_setClipboard(rawDisplay.textContent);
        this.textContent = 'OK';
        setTimeout(() => this.textContent = 'COPY', 1000);
    });

    container.querySelector('#ah2al-opacity').addEventListener('input', function () {
        const v = parseFloat(this.value);
        container.style.opacity = v;
        container.querySelector('#ah2al-op-val').textContent = Math.round(v * 100) + '%';
        GM_setValue('widget_opacity', v);
    });

    container.querySelector('#ah2al-threshold').addEventListener('input', function () {
        const v = parseInt(this.value);
        container.querySelector('#ah2al-th-val').textContent = v;
        GM_setValue('sync_threshold', v);
    });

    // ─── Drag (uses addEventListener — no global handler clobber) ─────────────
    let dragging = false, dragOff = [0, 0];
    container.querySelector('#ah2al-header').addEventListener('mousedown', e => {
        if (e.target.tagName === 'SPAN' && e.target.id !== 'ah2al-header') return;
        dragging = true;
        dragOff = [container.offsetLeft - e.clientX, container.offsetTop - e.clientY];
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        container.style.left = (e.clientX + dragOff[0]) + 'px';
        container.style.top = (e.clientY + dragOff[1]) + 'px';
        container.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        GM_setValue('widget_pos', { top: container.style.top, left: container.style.left });
    });

    // ─── Overlap fade (minimized only) ────────────────────────────────────────
    function checkOverlap() {
        const minimized = body.style.display === 'none';
        const userOpacity = GM_getValue('widget_opacity', 0.95);
        if (!minimized) { container.style.opacity = userOpacity; container.style.pointerEvents = 'auto'; return; }
        const wr = container.getBoundingClientRect();
        const overlap = [...document.querySelectorAll(SELECTORS.videoInfoBounds)].some(el => {
            const r = el.getBoundingClientRect();
            return !(wr.right < r.left || wr.left > r.right || wr.bottom < r.top || wr.top > r.bottom);
        });
        container.style.opacity = overlap ? '0' : userOpacity;
        container.style.pointerEvents = overlap ? 'none' : 'auto';
    }
    window.addEventListener('scroll', checkOverlap, { passive: true });
    window.addEventListener('resize', checkOverlap, { passive: true });

    // ─── Library UI ───────────────────────────────────────────────────────────
    function refreshMemoryList() {
        memList.innerHTML = '';
        const lib = getLib();
        const entries = Object.keys(lib);
        if (!entries.length) {
            memList.innerHTML = '<div style="color:#666;font-size:9px;text-align:center;padding:10px;">Library empty</div>';
            return;
        }
        // Sort by most recently added
        entries.sort((a, b) => (lib[b] || 0) - (lib[a] || 0));
        entries.forEach(title => {
            const item = document.createElement('div');
            item.className = 'mem-item';
            item.innerHTML = `
                <span title="${title}">${title}</span>
                <div style="display:flex;gap:3px;">
                    <button class="ml" style="background:#3db4f2;border:none;color:#fff;font-size:8px;padding:2px 5px;border-radius:2px;font-weight:bold;">LOAD</button>
                    <button class="md" style="background:#aa0000;border:none;color:#fff;font-size:8px;padding:2px 5px;border-radius:2px;font-weight:bold;">DEL</button>
                </div>`;
            item.querySelector('.ml').addEventListener('click', () => {
                manualInput.value = title;
                GM_setValue(showId, title);
                syncProgress(true);
            });
            item.querySelector('.md').addEventListener('click', () => {
                if (confirm(`Remove "${title}" from library?`)) removeFromLib(title);
            });
            memList.appendChild(item);
        });
    }

    refreshMemoryList();

})();