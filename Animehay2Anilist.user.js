    // ==UserScript==
    // @name         AnimeHay to AniList Auto-Tracker (Ultimate Gold Merged)
    // @namespace    http://tampermonkey.net/
    // @version      5.0
    // @updateURL    https://raw.githubusercontent.com/TLE47/animehay_epTracker_anilist/main/Animehay2Anilist.user.js
    // @downloadURL  https://raw.githubusercontent.com/TLE47/animehay_epTracker_anilist/main/Animehay2Anilist.user.js
    // @description  Support for Hydrax & SSPlay + Library Management
    // @author       Gemini
    // @include      /.*animehay.*/
    // @include      /^https?:\/\/([^\/]+\.)?playhydrax\.[^\/]+\/.*/
    // @include      /^https?:\/\/([^\/]+\.)?ssplay\.[^\/]+\/.*/
    // @include      /^https?:\/\/([^\/]+\.)?ahay\.[^\/]+\/.*/
    // @exclude      *://github.com/*
    // @exclude      *://*.github.com/*
    // @grant        GM_xmlhttpRequest
    // @grant        GM_setValue
    // @grant        GM_getValue
    // @grant        GM_listValues
    // @grant        GM_deleteValue
    // @grant        GM_setClipboard
    // @run-at       document-idle
    // ==/UserScript==

    (function() {
        'use strict';

        let ACCESS_TOKEN = GM_getValue("anilist_token", "");

        if (!ACCESS_TOKEN) {
            const userToken = prompt("AniList Auto-Tracker: Please enter your AniList JWT Token (one-time setup):");
            if (userToken) {
                GM_setValue("anilist_token", userToken.trim());
                ACCESS_TOKEN = userToken.trim();
                alert("Token saved! Refreshing page...");
                location.reload();
                return;
            } else {
                console.error("No token provided. Auto-Tracker will not function.");
                return;
            }
        }

        // --- Core Selectors ---
        // Update these if the anime website layout/classes change in the future
        const SELECTORS = {
            videoInfoBounds: '.movies-list.ah-frame-bg, .info-movie, .watching-movie',
            titleAlt: '.aim-hero__alt-name',
            titleMainLink: 'a.color-yellow[href*="thong-tin-phim"]',
            epCurrent: '.wp-ep.current, .current.wp-ep, .wp-ep .current',
            epBoxClassic: '.bg-black.color-gray.fs-17',
            epBoxBackup: 'div.color-gray.bg-black.border-l-t'
        };

        /* -------------------- CROSS-DOMAIN BRIDGE -------------------- */
        let skipperReceivedTitle = "";
        window.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'SK_TITLE_TRANSFER') {
                skipperReceivedTitle = e.data.title;
            }
        });

        // --- UTILS ---
        function getShowId() {
            const path = window.location.pathname;
            const match = path.match(/\/thong-tin-phim\/([^/.]+)/) || path.match(/\/xem-phim\/([^/.]+)/);
            return match ? match[1].split('-tap-')[0] : path.split('/').pop();
        }
        function getEpisodeId() {
            const match = window.location.pathname.match(/\/xem-phim\/([^/.]+)/);
            return match ? match[1] : null;
        }
        function getLibrary() { return GM_getValue("title_library", []); }

        function addToLibrary(title) {
            if (!title) return;
            let library = getLibrary();
            if (!library.includes(title)) {
                library.push(title);
                GM_setValue("title_library", library);
                refreshMemoryList();
            }
        }

        function removeFromLibrary(title) {
            let library = getLibrary().filter(t => t !== title);
            GM_setValue("title_library", library);
            refreshMemoryList();
        }

        function getSimilarity(s1, s2) {
            let longer = s1.toLowerCase(), shorter = s2.toLowerCase();
            if (s1.length < s2.length) { longer = s2; shorter = s1; }
            const longerLength = longer.length;
            if (longerLength === 0) return 1.0;
            return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
        }

        function editDistance(s1, s2) {
            let costs = [];
            for (let i = 0; i <= s1.length; i++) {
                let lastValue = i;
                for (let j = 0; j <= s2.length; j++) {
                    if (i == 0) costs[j] = j;
                    else if (j > 0) {
                        let newValue = costs[j - 1];
                        if (s1.charAt(i - 1) != s2.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                        costs[j - 1] = lastValue;
                        lastValue = newValue;
                    }
                }
                if (i > 0) costs[s2.length] = lastValue;
            }
            return costs[s2.length];
        }

        function cleanTitleString(str) {
            if (!str) return "";
            let cleanedBase = str
                .replace(/(movie|ova|tv|vietsub|lồng tiếng|thuyết minh|trọn bộ|tập \d+)/gi, '')
                .replace(/[-/.[\]():]/g, ' ')
                .replace(/\s+/g, ' ').trim();
            const words = cleanedBase.split(' ');
            const alwaysLowercase = new Set(['wa', 'ga', 'ni', 'o', 'wo', 'ya', 'kara', 'e', 'no', 'de', 'mo', 'made', 'the', 'in', 'of', 'and', 'is', 'on', 'for', 'with', 'to', 'at', 'by', 'an', 'a']);
            return words.map((word, index) => {
                const lower = word.toLowerCase();
                if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
                if (alwaysLowercase.has(lower)) return lower;
                return lower.charAt(0).toUpperCase() + lower.slice(1);
            }).join(' ');
        }

        // --- GUI SETUP ---
        console.log("[AnimeHay2AniList] Script started running. Window href:", window.location.href);

        const isMainPage = window.self === window.top;
        console.log("[AnimeHay2AniList] isMainPage:", isMainPage);
        let container, manualInput, mappedDisplay, rawDisplay, statusEl, memoryList, opacitySlider, thresholdSlider;

        if (isMainPage) {
            console.log("[AnimeHay2AniList] Initializing GUI...");
            container = document.createElement('div');
            const savedPos = GM_getValue("widget_pos", {top: "10px", right: "10px"});
            console.log("[AnimeHay2AniList] Loaded saved position:", savedPos);
            const isMinimized = GM_getValue("widget_is_minimized", false);
            const savedOpacity = GM_getValue("widget_opacity", 0.95);
            const savedThreshold = GM_getValue("sync_threshold", 85);

            const styleSheet = document.createElement('style');
            styleSheet.textContent = `
                #ah2al-container { position: fixed; top: 10px; right: 10px; background: #0a0a0a; color: #00ff00; border-radius: 8px; font-family: monospace; font-size: 12px; z-index: 100000; border: 2px solid #3db4f2; width: 340px; box-shadow: 0 4px 15px rgba(0,0,0,0.8); overflow: hidden; display: flex; flex-direction: column; opacity: ${savedOpacity}; }
                #ah2al-container * { box-sizing: border-box; }
            `;
            document.head.append(styleSheet);
            container.id = 'ah2al-container';

            container.innerHTML = `
            <div id="widget-header" style="background: #1a1a1a; padding: 8px 12px; cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; user-select: none;">
                <span style="color:#3db4f2; font-weight:bold;">AniList Tracker</span>
                <div style="display: flex; gap: 8px;"><span id="widget-min" style="cursor: pointer; color: #ffcc00;">_</span><span id="widget-close" style="cursor: pointer; color: #ff4444;">X</span></div>
            </div>
            <div id="widget-body" style="padding: 12px; display: ${isMinimized ? 'none' : 'block'};">
                <div style="margin-bottom:8px; line-height:1.4;">
                    <div style="color:#aaa; font-size:10px; display:flex; justify-content:space-between; align-items:center;">
                        <span>Detected: <span id="db-raw-title" style="color:#eee">-</span></span>
                        <button id="copy-title-btn" style="background:#444; color:white; border:none; border-radius:3px; padding:2px 5px; cursor:pointer; font-size:9px;">COPY</button>
                    </div>
                    <div style="color:#3db4f2; font-size:11px; margin-top:4px;">Mapped: <span id="db-mapped-display" style="color:white; font-weight:bold">-</span></div>
                </div>
                <div id="confirm-box" style="display:none; margin-bottom:10px; padding:10px; background:#1a1a00; border:1px solid #ffcc00; border-radius:4px;">
                    <div style="color:#ffcc00; font-weight:bold; font-size:10px; margin-bottom:5px;">LOW MATCH CONFIRMATION:</div>
                    <div id="confirm-title" style="color:white; font-size:11px; margin-bottom:8px; line-height:1.2;">-</div>
                    <div style="display:flex; gap:5px;">
                        <button id="btn-accept" style="flex:1; background:#00aa00; color:white; border:none; padding:5px; border-radius:3px; cursor:pointer; font-weight:bold;">ACCEPT</button>
                        <button id="btn-cancel" style="flex:1; background:#aa0000; color:white; border:none; padding:5px; border-radius:3px; cursor:pointer; font-weight:bold;">CANCEL</button>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; margin: 8px 0; background:#222; padding:5px; border-radius:3px;">
                    <span>Ep: <span id="db-ep" style="color:white">-</span></span>
                    <span id="db-status" style="color:#ffcc00;">Ready</span>
                </div>
                <details id="manual-dropdown" style="margin-top:10px; background:#1a1a1a; border-radius:4px; border:1px solid #333;">
                    <summary style="padding:5px; cursor:pointer; color:#3db4f2;">Manage Titles & Library</summary>
                    <div style="padding:8px; border-top:1px solid #333;">
                        <input type="text" id="manual-title" style="width:100%; background:#000; color:white; border:1px solid #444; padding:5px; font-size:11px; box-sizing:border-box;" placeholder="Paste corrected title...">
                        <div id="memory-list" style="max-height:150px; overflow-y:auto; margin-top:8px;"></div>
                    </div>
                </details>
                <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-size:10px;">Opacity: <span id="opacity-val">${Math.round(savedOpacity * 100)}%</span></span>
                        <input type="range" id="opacity-slider" min="0.1" max="1.0" step="0.05" value="${savedOpacity}" style="width:170px; height:4px; cursor:pointer; accent-color:#3db4f2;">
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-size:10px;">Auto-Sync @ <span id="sync-val">${savedThreshold}</span>%</span>
                        <input type="range" id="threshold-slider" min="10" max="99" step="1" value="${savedThreshold}" style="width:170px; height:4px; cursor:pointer; accent-color:#ffcc00;">
                    </div>
                </div>
                <button id="sync-now-btn" style="margin-top:10px; width:100%; cursor:pointer; background:#3db4f2; border:none; color:white; border-radius:4px; padding:10px; font-weight:bold;">SYNC NOW</button>
            </div>
            <div id="progress-wrapper" style="height: 3px; background: rgba(255,255,255,0.1); width: 100%; display: ${isMinimized ? 'none' : 'block'};">
                <div id="db-progress-bar" style="height: 100%; width: 0%; background: #3db4f2; transition: width 0.5s;"></div>
            </div>
            `;
            document.body.appendChild(container);
            if (savedPos && savedPos.left && typeof savedPos.left === 'string' && savedPos.left !== 'auto') {
                container.style.left = savedPos.left;
                container.style.top = savedPos.top;
                container.style.right = 'auto';
            }
            console.log("[AnimeHay2AniList] GUI appended to body!");

            manualInput = container.querySelector('#manual-title');
            mappedDisplay = container.querySelector('#db-mapped-display');
            rawDisplay = container.querySelector('#db-raw-title');
            statusEl = container.querySelector('#db-status');
            memoryList = container.querySelector('#memory-list');
            opacitySlider = container.querySelector('#opacity-slider');
            thresholdSlider = container.querySelector('#threshold-slider');

            // Drag Logic
            let isDragging = false, dragOffset = [0,0];
            container.querySelector('#widget-header').onmousedown = (e) => {
                isDragging = true;
                dragOffset = [container.offsetLeft - e.clientX, container.offsetTop - e.clientY];
            };
            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    container.style.left = (e.clientX + dragOffset[0]) + 'px';
                    container.style.top = (e.clientY + dragOffset[1]) + 'px';
                    container.style.right = 'auto';
                }
            });
            document.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    GM_setValue("widget_pos", {top: container.style.top, left: container.style.left});
                }
            });

            container.querySelector('#widget-min').onclick = () => {
                const body = container.querySelector('#widget-body'), prog = container.querySelector('#progress-wrapper');
                const isHidden = body.style.display === "none";
                body.style.display = isHidden ? "block" : "none";
                prog.style.display = isHidden ? "block" : "none";
                GM_setValue("widget_is_minimized", !isHidden);
                checkIntersection();
            };

            container.querySelector('#widget-close').onclick = () => container.remove();
            container.querySelector('#sync-now-btn').onclick = () => syncProgress(true);
            container.querySelector('#copy-title-btn').onclick = () => {
                GM_setClipboard(rawDisplay.innerText);
                const b = container.querySelector('#copy-title-btn');
                b.innerText="OK";
                setTimeout(() => b.innerText="COPY", 1000);
            };
            
            if (opacitySlider) {
                opacitySlider.oninput = (e) => {
                    const val = parseFloat(e.target.value);
                    container.style.opacity = val;
                    container.querySelector('#opacity-val').innerText = Math.round(val * 100) + "%";
                    GM_setValue("widget_opacity", val);
                };
            }
            if (thresholdSlider) {
                thresholdSlider.oninput = (e) => {
                    const val = parseInt(e.target.value);
                    container.querySelector('#sync-val').innerText = val;
                    GM_setValue("sync_threshold", val);
                }
            }

            function checkIntersection() {
                const isMinimized = GM_getValue("widget_is_minimized", false);
                const userOpacity = GM_getValue("widget_opacity", 0.95);
                if (!isMinimized || isDragging) {
                    container.style.opacity = userOpacity;
                    container.style.pointerEvents = 'auto';
                    return;
                }
                const wRect = container.getBoundingClientRect();
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
                    container.style.opacity = '0';
                    container.style.pointerEvents = 'none';
                } else {
                    container.style.opacity = userOpacity;
                    container.style.pointerEvents = 'auto';
                }
            }
            window.addEventListener('scroll', checkIntersection, {passive: true});
            window.addEventListener('resize', checkIntersection, {passive: true});
        }

        const setStatus = (text, color = "#ffcc00") => {
            if(statusEl) {
                statusEl.innerText = text;
                statusEl.style.color = color;
            }
        };

        async function anilistRequest(query, variables) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: "POST", url: "https://graphql.anilist.co",
                    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ACCESS_TOKEN },
                    data: JSON.stringify({ query, variables }),
                    onload: (res) => {
                        const response = JSON.parse(res.responseText || "{}");
                        if (response.errors && response.errors[0].message.includes("Invalid token")) setStatus("🔑 Token Expired", "orange");
                        resolve(response);
                    },
                    onerror: () => resolve({})
                });
            });
        }

        async function runIterativeSearch(fullTitle, words, startCount) {
            let currentWordCount = startCount;
            let lastBatch = [];
            let bestSeenOverall = { anime: null, score: 0, firstHook: words.slice(0, startCount).join(' '), debugList: [] };

            while (currentWordCount <= Math.min(words.length, 7)) {
                const hook = words.slice(0, currentWordCount).join(' ');
                const res = await anilistRequest(`query($s:String){ Page(page:1, perPage:10){ media(search:$s, type:ANIME){ id title{romaji english} } } }`, { s: hook });
                const candidates = res?.data?.Page?.media || [];
                if (candidates.length === 0) {
                    if (currentWordCount === startCount) break;
                    currentWordCount++;
                    continue;
                }

                let batchResults = candidates.map(m => {
                    const sRomaji = getSimilarity(fullTitle, m.title.romaji || "");
                    const sEnglish = getSimilarity(fullTitle, m.title.english || "");
                    return { anime: m, score: Math.max(sRomaji, sEnglish) };
                }).sort((a, b) => b.score - a.score);

                lastBatch = batchResults;
                let top = batchResults[0];
                if (top.score > bestSeenOverall.score) bestSeenOverall = { anime: top.anime, score: top.score, debugList: batchResults, firstHook: hook };
                if (top.score > 0.85) return { ...top, firstHook: hook, debugList: batchResults };
                currentWordCount++;
            }
            return { ...bestSeenOverall, debugList: lastBatch };
        }

        async function executeSync(mediaId, epNum, titleForLib) {
            const updateRes = await anilistRequest(`mutation($m:Int,$p:Int){ SaveMediaListEntry(mediaId:$m,progress:$p,status:CURRENT){id} }`, { m: mediaId, p: epNum });
            if (updateRes?.data) {
                setStatus(`✅ Synced Ep ${epNum}`, "#00ff00");
                addToLibrary(titleForLib);
                document.getElementById('confirm-box').style.display="none";
            }
        }

        async function syncProgress(force = false) {
            let titlesToSearch = [];
            let primaryTitle = "";

            if (manualInput && manualInput.value.trim()) {
                titlesToSearch.push(manualInput.value.trim());
                primaryTitle = manualInput.value.trim();
            } else if (mappedDisplay && mappedDisplay.innerText && mappedDisplay.innerText !== "-" && mappedDisplay.innerText !== "None") {
                titlesToSearch.push(mappedDisplay.innerText);
                primaryTitle = mappedDisplay.innerText;
                
                // Add alt names from the document or fetch from info page if on watch page
                if (isMainPage) {
                    let altNameText = "";
                    const altNameEl = document.querySelector(SELECTORS.titleAlt);
                    
                    if (altNameEl && altNameEl.innerText) {
                        altNameText = altNameEl.innerText;
                    } else {
                        setStatus("Fetching Alt Names...", "#3db4f2");
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
                                console.error("[AnimeHay2AL] Failed to fetch info page for alt names", e);
                            }
                        }
                    }

                    if (altNameText) {
                        const altNames = altNameText.split(',').map(n => n.trim()).filter(n => n.length > 0);
                        altNames.forEach(n => {
                            const c = cleanTitleString(n);
                            if (!titlesToSearch.includes(c)) titlesToSearch.push(c);
                        });
                    }
                }
            }

            if (titlesToSearch.length === 0) return;
            
            setStatus("Searching...", "#3db4f2");
            
            let bestResult = null;
            let matchedOriginalTitle = primaryTitle;

            for (let i = 0; i < titlesToSearch.length; i++) {
                const searchTitle = titlesToSearch[i];
                if (titlesToSearch.length > 1) setStatus(`Trying Alt Name ${i+1}...`, "#ffcc00");
                
                const words = searchTitle.split(/\s+/);
                let result = await runIterativeSearch(searchTitle, words, 2);
                
                if (result && result.anime && result.score > 0.35) {
                    bestResult = result;
                    matchedOriginalTitle = searchTitle;
                    break; // Good match found!
                }
            }

            if (bestResult && bestResult.anime && bestResult.score > 0.35) {
                const epNum = parseInt(document.getElementById('db-ep').innerText) || 1;
                const matchPercent = Math.round(bestResult.score * 100);

                if (matchPercent >= 93 || force) {
                    await executeSync(bestResult.anime.id, epNum, matchedOriginalTitle);
                } else {
                    setStatus("Confirm Match?", "orange");
                    const cBox = document.getElementById('confirm-box');
                    const cTitle = document.getElementById('confirm-title');
                    cTitle.innerHTML = `Found: <b style="color:#3db4f2">${bestResult.anime.title.romaji}</b><br>Score: ${matchPercent}%`;
                    cBox.style.display = "block";

                    document.getElementById('btn-accept').onclick = () => executeSync(bestResult.anime.id, epNum, matchedOriginalTitle);
                    document.getElementById('btn-cancel').onclick = () => {
                        cBox.style.display = "none";
                        setStatus("Sync Cancelled", "#ff4444");
                    };
                }
            } else {
                setStatus("❌ No High Match", "red");
            }
        }

        function refreshMemoryList() {
            if (!memoryList) return;
            memoryList.innerHTML = '';
            const lib = getLibrary();
            if (lib.length === 0) {
                memoryList.innerHTML = '<div style="color:#666; font-size:9px; text-align:center; padding:10px;">Library Empty</div>';
                return;
            }
            lib.forEach(title => {
                const item = document.createElement('div');
                item.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:4px; padding:3px 5px; background:#111; border:1px solid #222; align-items:center; border-radius:3px;';
                item.innerHTML = `
                <span style="font-size:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; color:#eee; margin-right:5px;">${title}</span>
                <div style="display:flex; gap:3px;">
                    <button class="mem-load" style="background:#3db4f2; border:none; color:white; cursor:pointer; font-size:8px; padding:2px 5px; border-radius:2px; font-weight:bold;">LOAD</button>
                    <button class="mem-del" style="background:#aa0000; border:none; color:white; cursor:pointer; font-size:8px; padding:2px 5px; border-radius:2px; font-weight:bold;">DEL</button>
                </div>`;

                item.querySelector('.mem-load').onclick = () => {
                    manualInput.value = title;
                    GM_setValue(getShowId(), title);
                    syncProgress(true);
                };
                item.querySelector('.mem-del').onclick = () => {
                    if (confirm(`Remove "${title}" from library?`)) {
                        removeFromLibrary(title);
                    }
                };
                memoryList.appendChild(item);
            });
        }

        /* -------------------- VIDEO DETECTION & BRIDGE -------------------- */
        function findVideoElement() {
            return document.querySelector('video');
        }

        if (isMainPage) {
            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'VIDEO_METRICS') {
                    const { currentTime, duration, epId } = e.data;
                    const prog = (currentTime / duration) * 100;
                    const progBar = document.getElementById('db-progress-bar');
                    if (progBar) progBar.style.width = prog + "%";
                    if (epId) GM_setValue("time_" + epId, currentTime);

                    if (prog > GM_getValue("sync_threshold", 85) && !window.hasSyncedThisEp) {
                        window.hasSyncedThisEp = true;
                        syncProgress();
                    }
                }
            });
        }

        setInterval(() => {
            const video = findVideoElement();
            const currentEpId = getEpisodeId();

            // Iframe Logic (Sending metrics to AnimeHay)
            if (!isMainPage && video && video.duration > 0) {
                // Resume video logic inside iframe - ONLY do it if we somehow get a valid Ep ID
                if (!video.dataset.resumed) {
                    if (currentEpId) {
                        const savedTime = GM_getValue("time_" + currentEpId, 0);
                        if (savedTime > 0 && savedTime < video.duration - 10) {
                            video.currentTime = savedTime;
                        }
                    } else {
                        // In case we're stuck in the "time_null" bug, see if parent told us what title we are
                        if (skipperReceivedTitle) {
                             const savedTime = GM_getValue("time_" + skipperReceivedTitle, 0);
                             if (savedTime > 0 && savedTime < video.duration - 10) {
                                video.currentTime = savedTime;
                             }
                        }
                    }
                    video.dataset.resumed = "true";
                }
                
                // Track progress against the title we got from parent for correct saving
                const syncKey = currentEpId || skipperReceivedTitle;
                window.parent.postMessage({ type: 'VIDEO_METRICS', currentTime: video.currentTime, duration: video.duration, epId: syncKey }, '*');
            }

            // Main Page UI Logic
            if (isMainPage) {
                const titleLink = document.querySelector(SELECTORS.titleMainLink);
                const epBox = document.querySelector(SELECTORS.epCurrent) || document.querySelector(SELECTORS.epBoxClassic) || document.querySelector(SELECTORS.epBoxBackup);
                
                let extractedTitle = "";
                const titleMatch = document.title.match(/Phim\s+(.+?)\s+Tập/i);
                if (titleMatch) {
                    extractedTitle = titleMatch[1];
                } else if (titleLink) {
                    extractedTitle = titleLink.innerText;
                }

                if (extractedTitle) {
                    const cleanSite = cleanTitleString(extractedTitle);
                    if (rawDisplay) rawDisplay.innerText = cleanSite;
                    if (mappedDisplay) mappedDisplay.innerText = manualInput.value.trim() || GM_getValue(getShowId(), "") || cleanSite;
                }
                
                const epDisplay = document.getElementById('db-ep');
                if (epBox && epDisplay) epDisplay.innerText = epBox.innerText.replace(/\D/g, '');
            }
        }, 1000);

        refreshMemoryList();
    })();