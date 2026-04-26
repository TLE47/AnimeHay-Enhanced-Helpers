# Animehay2Anilist (Auto-Tracker)

## Overview
**Animehay2Anilist** is a robust, iframe-busting, comprehensive user-script built for seamless watch time metrics tracking and automatic episode pushing between AnimeHay (and standard iframe hosts like Hydrax/SSPlay) and your AniList profile. 

Instead of manually updating AniList after every episode, let this script do the heavy lifting context-switching for you!

## Features
- **Dynamic Cross-Domain Video Tracking:** Embeds deeply into video playing iframes (`ahay.stream`, `playhydrax.com` etc.) and utilizes `postMessage` cross-domain messaging bridges to securely send watch metrics back to the main wrapper UI.
- **Resume Playback:** Memorizes your exact playback duration down to the second inside your local browser database. Automatically jumps you precisely back where you left off if you accidentally refresh the page or step away.
- **Strict AniList Mutation API:** Directly modifies your AniList `progress` stats natively using the GraphQL API via secure JWT token logic.
- **Surgical Metadata Parsing:** Precisely parses raw website `<title>` head data utilizing strict Regex extractions (`/Phim\s+(.+?)\s+Tập/i`) to capture the cleanest title string possible, then queries AniList with high-fidelity accuracy. 
- **Auto-Sync thresholds:** Features customizable user thresholds (e.g., automatically mark as watched when you hit 85% of the video duration—skipping the end credits).

## Interconnectivity
If you are simultaneously utilizing `animeHay_epTracker`, both scripts conveniently share the exact same `anilist_token` database key. Logging into one automatically authenticates the other!
