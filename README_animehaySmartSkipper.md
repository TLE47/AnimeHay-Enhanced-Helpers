# AnimeHay Smart Video Skipper

![AnimeHay Smart Video Skipper](https://placehold.co/800x400/222222/ff5555?text=AnimeHay+Smart+Video+Skipper)

## Overview
**AnimeHay Smart Video Skipper** is a heavy-duty, rules-based fuzzy matching skipping suite. It is designed to allow you to configure global "Skip DB" timings (for anime openings/endings) and perfectly execute them across all complex nested HTML5 video iframes found on AnimeHay.

## Features
- **Shared Remote Database:** Keeps a persistent `skipDB` database containing skip rules tied mathematically to specific strings and durations, letting you permanently skip 2-minute openings for shows that have them.
- **Fuzzy Iframe Targeting:** Intelligently pings wrapper titles into isolated player iframes using `SK_TITLE_TRANSFER` protocols, bypassing cross-origin restrictions so the isolated video tag constantly knows what anime it's currently streaming.
- **Complete Rules GUI:** Incorporates a persistent, draggable UI window overlay for adding exactly where to skip (min/max timeline ranges), checking active hits, verifying overlap targets, and modifying your stored configurations on the fly based on specific current durations.
- **Fallback Regex Cleanup:** Actively shreds AnimeHay's generic naming structures (`"Vietsub"`, `"Trọn bộ"`, `"Lồng tiếng"`, etc.) natively, guaranteeing the generic keywords won't accidentally trigger a rule meant for exclusively one show. 
- **Fade Transparency Interaction:** Implements the same reactive viewport overlap intersection tracking logic found across the suite to keep the skipper tool completely out of your face when scrolling the webpage.

## Maintenance
Just like the other tools in the suite, Smart Video Skipper houses a globally scoped `SELECTORS` JSON object right at the top of the file. You can easily override class targets without scrolling through the 400+ lines of codebase rules!
