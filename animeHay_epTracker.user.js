// ==UserScript==
// @name         AnimeHay from AniList epTracker
// @version      2.6
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_epTracker.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_epTracker.user.js
// @description  Highlight next episode based on AniList
// @author       Gemini
// @include      /.*animehay.*\/thong-tin-phim\/.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      graphql.anilist.co
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    if (!window.location.href.includes('thong-tin-phim')) return;

    let TOKEN = GM_getValue("anilist_token", "");

    if (!TOKEN) {
        const userToken = prompt("AniList Tracker: Please enter your AniList JWT Token (one-time setup):");
        if (userToken) {
            GM_setValue("anilist_token", userToken.trim());
            TOKEN = userToken.trim();
            alert("Token saved! Refreshing page...");
            location.reload();
            return;
        } else {
            console.error("No token provided. EpTracker will not function.");
            return;
        }
    }
    const COLOR = '#FFD700'; // Gold

    // --- Core Selectors ---
    // Update these if the anime website layout/classes change in the future
    const SELECTORS = {
        videoInfoBounds: '.movies-list.ah-frame-bg, .info-movie, .watching-movie',
        epButton: '.aim-ep-btn',
        titleMain: '.aim-hero__title',
        titleAlt: '.aim-hero__alt-name'
    };

    let progressFetched = null;
    let pendingRequest = false;
    let searchAttempted = false;
    let hasHighlighted = false;

    // --- GUI setup ---
    const debugContainer = document.createElement('div');
    debugContainer.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(0,0,0,0.85);
        color: #fff;
        padding: 0;
        border-radius: 8px;
        font-family: monospace;
        font-size: 13px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        z-index: 999999;
        width: 300px;
        border: 1px solid #444;
        overflow: hidden;
        transition: opacity 0.2s;
    `;

    // Header for controls
    const header = document.createElement('div');
    header.style.cssText = `
        background: #222; padding: 5px 10px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #444; user-select: none;
    `;
    header.innerHTML = `
        <span style="color:#FFD700; font-weight:bold; font-size:11px;">EpTracker Debug</span>
        <div style="display:flex; gap:8px;">
            <button id="ep-refresh-btn" style="background:none; border:none; color:#3db4f2; cursor:pointer; font-size:14px; padding:0;" title="Force Recheck">↻</button>
            <button id="ep-min-btn" style="background:none; border:none; color:#fff; cursor:pointer; font-size:14px; padding:0;" title="Minimize">−</button>
        </div>
    `;

    const logsBody = document.createElement('div');
    logsBody.style.cssText = `padding: 10px; transition: max-height 0.3s ease; max-height: 200px; overflow-y: auto;`;

    debugContainer.appendChild(header);
    debugContainer.appendChild(logsBody);

    let isAttached = false;
    let isMinimized = GM_getValue("epTracker_minimized", false);

    // Apply initial saved state
    if (isMinimized) {
        logsBody.style.display = 'none';
        header.querySelector('#ep-min-btn').innerText = '+';
    }

    header.querySelector('#ep-min-btn').onclick = () => {
        isMinimized = !isMinimized;
        logsBody.style.display = isMinimized ? 'none' : 'block';
        header.querySelector('#ep-min-btn').innerText = isMinimized ? '+' : '−';
        GM_setValue("epTracker_minimized", isMinimized);
        checkIntersection();
    };

    header.querySelector('#ep-refresh-btn').onclick = () => {
        progressFetched = null;
        pendingRequest = false;
        searchAttempted = false;
        hasHighlighted = false;
        window.complainedAboutNum = false;
        checkCount = 0;
        logDebug("Forced Recheck Initialized.");
        runLoop(); // Trigger immediately
    };

    function checkIntersection() {
        if (!isMinimized) {
            debugContainer.style.opacity = '1';
            debugContainer.style.pointerEvents = 'auto';
            return;
        }
        const wRect = debugContainer.getBoundingClientRect();
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
            debugContainer.style.opacity = '0';
            debugContainer.style.pointerEvents = 'none';
        } else {
            debugContainer.style.opacity = '1';
            debugContainer.style.pointerEvents = 'auto';
        }
    }
    window.addEventListener('scroll', checkIntersection, { passive: true });
    window.addEventListener('resize', checkIntersection, { passive: true });

    function logDebug(msg) {
        console.log("[EpTracker Debug]", msg);
        const line = document.createElement('div');
        line.innerText = msg;
        line.style.marginBottom = '4px';
        logsBody.appendChild(line);
        // keep only last 6 messages
        while (logsBody.children.length > 6) {
            logsBody.removeChild(logsBody.firstChild);
        }

        // Lazily attach the debug container
        if (!isAttached && document.body) {
            document.body.appendChild(debugContainer);
            isAttached = true;
        }
    }

    // Clean title for a higher API match rate
    function cleanTitle(str) {
        return str.replace(/(movie|ova|tv|vietsub|lồng tiếng|thuyết minh|trọn bộ|tập \d+|-)/gi, ' ').replace(/\s+/g, ' ').trim();
    }

    function fetchAniListMatch(titlesQueue) {
        if (titlesQueue.length === 0) {
            logDebug("Exhausted all title matches. No anime found.");
            pendingRequest = false;
            return;
        }
        const titleToSearch = titlesQueue.shift();
        const clean = cleanTitle(titleToSearch);
        logDebug("Searching AniList: " + clean);

        const query = `query($s:String){Page(page:1,perPage:1){media(search:$s,type:ANIME){mediaListEntry{progress}}}}`;

        fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + TOKEN
            },
            body: JSON.stringify({ query: query, variables: { s: clean } })
        })
            .then(response => response.json())
            .then(data => {
                try {
                    const media = data?.data?.Page?.media;
                    if (media && media.length > 0) {
                        const progress = media[0]?.mediaListEntry?.progress;
                        if (progress !== undefined && progress !== null) {
                            progressFetched = progress;
                            logDebug("Found user progress: Eps " + progress);
                        } else {
                            logDebug("Matched on AniList, but no watch progress found. Trying alt names...");
                            setTimeout(() => fetchAniListMatch(titlesQueue), 500);
                        }
                    } else {
                        logDebug("No match for this title. Trying alt names...");
                        setTimeout(() => fetchAniListMatch(titlesQueue), 500);
                    }
                } catch (e) {
                    logDebug("Error reading AniList data.");
                    setTimeout(() => fetchAniListMatch(titlesQueue), 500);
                }
            })
            .catch(error => {
                logDebug("Fetch request failed (Network/CORS).");
                setTimeout(() => fetchAniListMatch(titlesQueue), 500);
            });
    }

    function checkAnilistProgress(titles) {
        if (pendingRequest) return;
        pendingRequest = true;
        fetchAniListMatch([...titles]); // queue the array
    }

    function highlightSpecificMatch(numStr) {
        let localFound = false;
        document.querySelectorAll(SELECTORS.epButton).forEach(el => {
            if (el.innerText.trim() === numStr) {
                localFound = true;
                if (!el.dataset.highlighted) {
                    el.dataset.highlighted = 'true';
                    el.style.cssText = `background:${COLOR} !important; color:black !important; font-weight:bold !important; border:2px solid red !important; box-shadow: 0px 0px 10px ${COLOR} !important;`;
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    logDebug("Highlighted episode: " + numStr);
                }
            }
        });
        return localFound;
    }

    function highlightEpisodes() {
        if (progressFetched === null || hasHighlighted) return;

        const currEp = progressFetched.toString();

        if (highlightSpecificMatch(currEp)) {
            hasHighlighted = true;
        } else {
            if (searchAttempted && !window.complainedAboutNum) {
                window.complainedAboutNum = true;
                logDebug(`Watched Ep ${currEp} was not found on the page.`);
            }
        }
    }

    let checkCount = 0;
    const MAX_CHECKS = 5;

    function runLoop() {
        if (!isAttached && document.body) {
            document.body.appendChild(debugContainer);
            isAttached = true;
        }

        // Find title
        if (!pendingRequest && !searchAttempted) {
            const titleEl = document.querySelector(SELECTORS.titleMain);
            if (titleEl && titleEl.innerText) {
                searchAttempted = true;

                let titlesToSearch = [titleEl.innerText];

                // Also grab alternate names if available (async fetch if on watch page)
                (async () => {
                    let altNameText = "";
                    const altNameEl = document.querySelector(SELECTORS.titleAlt);
                    if (altNameEl && altNameEl.innerText) {
                        altNameText = altNameEl.innerText;
                    } else {
                        const infoLink = document.querySelector('.wp-bc a[href*="/thong-tin-phim/"]');
                        if (infoLink && infoLink.href) {
                            try {
                                const response = await fetch(infoLink.href);
                                const html = await response.text();
                                const parser = new DOMParser();
                                const doc = parser.parseFromString(html, "text/html");
                                const remoteAltNameEl = doc.querySelector(SELECTORS.titleAlt);
                                if (remoteAltNameEl && remoteAltNameEl.innerText) {
                                    altNameText = remoteAltNameEl.innerText;
                                }
                            } catch (e) {
                                logDebug("Failed to fetch info page for alt names.");
                            }
                        }
                    }

                    if (altNameText) {
                        const altNames = altNameText.split(',').map(n => n.trim()).filter(n => n.length > 0);
                        titlesToSearch.push(...altNames);
                    }

                    logDebug("Detected Titles: " + titlesToSearch.join(' | '));
                    checkAnilistProgress(titlesToSearch);
                })();
            } else {
                checkCount++;
                logDebug(`Waiting for title element (${SELECTORS.titleMain})... (${checkCount}/${MAX_CHECKS})`);
                if (checkCount >= MAX_CHECKS) {
                    searchAttempted = true; // Stop spamming checks and give up
                    logDebug("Title not found after 5 checks. Giving up.");
                }
            }
        }

        // Highlight active if fetched
        if (progressFetched !== null && !hasHighlighted) {
            highlightEpisodes();
        }
    }

    logDebug("EpTracker Started.");
    setInterval(runLoop, 2000);

})();
 