// ==UserScript==
// @name         AnimeHay from AniList epTracker
// @version      3.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_epTracker.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_epTracker.user.js
// @description  Highlight next episode based on AniList progress
// @author       Gemini (refactored)
// @include      /.*animehay.*\/thong-tin-phim\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (!window.location.href.includes('thong-tin-phim')) return;

    // ─── Config ───────────────────────────────────────────────────────────────
    const COLOR = '#FFD700';
    const ANILIST_GQL = 'https://graphql.anilist.co';
    const SELECTORS = {
        epButton: '.aim-ep-btn',
        titleMain: '.aim-hero__title',
        titleAlt: '.aim-hero__alt-name',
        infoLink: '.wp-bc a[href*="/thong-tin-phim/"]',
    };

    // ─── Token setup ─────────────────────────────────────────────────────────
    let TOKEN = GM_getValue('anilist_token', '');
    if (!TOKEN) {
        const entered = prompt('AniList Tracker: Enter your AniList JWT Token (one-time setup):');
        if (entered?.trim()) {
            GM_setValue('anilist_token', entered.trim());
            TOKEN = entered.trim();
            alert('Token saved! Refreshing…');
            location.reload();
        }
        return; // don't proceed without a token
    }

    // ─── State ────────────────────────────────────────────────────────────────
    let progress = null; // null = not yet fetched, number = fetched
    let highlighted = false;
    let fetchStarted = false;
    let observer = null;

    // ─── Debug panel ─────────────────────────────────────────────────────────
    let isMinimized = GM_getValue('epTracker_minimized', false);

    const panel = document.createElement('div');
    panel.style.cssText = `
        position:fixed;bottom:20px;right:20px;width:300px;
        background:rgba(0,0,0,.88);color:#fff;border-radius:8px;
        font:13px monospace;box-shadow:0 4px 6px rgba(0,0,0,.3);
        z-index:999999;border:1px solid #444;overflow:hidden;`;

    const header = document.createElement('div');
    header.style.cssText = `
        background:#222;padding:5px 10px;display:flex;
        justify-content:space-between;align-items:center;
        border-bottom:1px solid #444;user-select:none;`;
    header.innerHTML = `
        <span style="color:${COLOR};font-weight:bold;font-size:11px;">EpTracker</span>
        <div style="display:flex;gap:8px;">
            <button id="ep-refresh" style="background:none;border:none;color:#3db4f2;cursor:pointer;font-size:14px;" title="Recheck">↻</button>
            <button id="ep-min"     style="background:none;border:none;color:#fff;cursor:pointer;font-size:14px;">${isMinimized ? '+' : '−'}</button>
        </div>`;

    const logs = document.createElement('div');
    logs.style.cssText = `padding:10px;max-height:180px;overflow-y:auto;`;
    if (isMinimized) logs.style.display = 'none';

    panel.appendChild(header);
    panel.appendChild(logs);

    function log(msg) {
        console.log('[EpTracker]', msg);
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.marginBottom = '3px';
        logs.appendChild(el);
        while (logs.children.length > 8) logs.removeChild(logs.firstChild);
        if (!panel.isConnected && document.body) document.body.appendChild(panel);
    }

    header.querySelector('#ep-min').onclick = function () {
        isMinimized = !isMinimized;
        logs.style.display = isMinimized ? 'none' : 'block';
        this.textContent = isMinimized ? '+' : '−';
        GM_setValue('epTracker_minimized', isMinimized);
    };

    header.querySelector('#ep-refresh').onclick = () => {
        progress = null;
        highlighted = false;
        fetchStarted = false;
        log('Forced recheck…');
        init();
    };

    // ─── Helpers ──────────────────────────────────────────────────────────────

    // Strip noise that confuses AniList search
    function cleanTitle(s) {
        return s
            .replace(/(movie|ova|tv|vietsub|lồng tiếng|thuyết minh|trọn bộ|tập\s*\d+)/gi, ' ')
            .replace(/[-–—]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Extract a de-duped list of candidate titles from the page
    async function gatherTitles() {
        const main = document.querySelector(SELECTORS.titleMain)?.innerText?.trim();
        if (!main) return [];

        const candidates = new Set([main]);

        // Try the alt-name element on this page
        const alt = document.querySelector(SELECTORS.titleAlt)?.innerText?.trim();
        if (alt) alt.split(',').map(t => t.trim()).filter(Boolean).forEach(t => candidates.add(t));

        // If no alt name found, fetch the info page
        if (candidates.size === 1) {
            const infoLink = document.querySelector(SELECTORS.infoLink)?.href;
            if (infoLink) {
                try {
                    const html = await fetch(infoLink).then(r => r.text());
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const remote = doc.querySelector(SELECTORS.titleAlt)?.innerText?.trim();
                    if (remote) remote.split(',').map(t => t.trim()).filter(Boolean).forEach(t => candidates.add(t));
                } catch {
                    log('Could not fetch info page for alt titles.');
                }
            }
        }

        return [...candidates];
    }

    // Fire ONE AniList query for a single title; returns progress number or null
    function queryAniList(title) {
        const clean = cleanTitle(title);
        const gql = `query($s:String){Page(page:1,perPage:1){media(search:$s,type:ANIME){mediaListEntry{progress}}}}`;
        return fetch(ANILIST_GQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ query: gql, variables: { s: clean } }),
        })
            .then(r => r.json())
            .then(data => {
                const entry = data?.data?.Page?.media?.[0]?.mediaListEntry;
                if (entry && entry.progress != null) return entry.progress;
                return null;
            })
            .catch(() => null);
    }

    // Highlight the button whose text exactly matches the episode number
    function tryHighlight() {
        if (progress === null || highlighted) return;
        const target = String(progress);
        const btn = [...document.querySelectorAll(SELECTORS.epButton)]
            .find(el => el.innerText.trim() === target);
        if (btn) {
            btn.style.cssText = `
                background:${COLOR}!important;color:#000!important;
                font-weight:bold!important;border:2px solid red!important;
                box-shadow:0 0 10px ${COLOR}!important;`;
            btn.dataset.highlighted = '1';
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            log(`✓ Highlighted episode ${target}`);
            highlighted = true;
            observer?.disconnect(); // no more DOM watching needed
        }
    }

    // Main fetch flow: search all titles IN PARALLEL, settle on first hit
    async function fetchProgress(titles) {
        log('Searching: ' + titles.map(cleanTitle).join(' | '));
        // Fire all requests simultaneously; take the first non-null result
        const result = await Promise.any(
            titles.map(t =>
                queryAniList(t).then(p => {
                    if (p == null) throw new Error('no result');
                    return p;
                })
            )
        ).catch(() => null); // all failed

        if (result != null) {
            progress = result;
            log(`AniList progress: ep ${progress}`);
            tryHighlight();
        } else {
            log('No AniList progress found for this title.');
        }
    }

    // ─── MutationObserver: watch for episode buttons ──────────────────────────
    function startObserver() {
        if (observer) return;
        observer = new MutationObserver(() => {
            if (progress !== null && !highlighted) tryHighlight();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ─── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        if (fetchStarted) return;

        // Wait for the title element (up to ~4 s)
        let titleEl = null;
        for (let i = 0; i < 20; i++) {
            titleEl = document.querySelector(SELECTORS.titleMain);
            if (titleEl?.innerText?.trim()) break;
            await new Promise(r => setTimeout(r, 200));
        }

        if (!titleEl?.innerText?.trim()) {
            log('Title element not found. Giving up.');
            return;
        }

        fetchStarted = true;
        startObserver();

        const titles = await gatherTitles();
        log('Titles found: ' + titles.length);
        await fetchProgress(titles);

        // If buttons weren't rendered yet, observer will catch them
        if (!highlighted) log('Waiting for episode buttons…');
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    if (!panel.isConnected && document.body) document.body.appendChild(panel);
    log('EpTracker v3.0 started.');
    init();

})();