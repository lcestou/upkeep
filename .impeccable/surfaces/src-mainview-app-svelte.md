---
version: 1
slug: "src-mainview-app-svelte"
primary_target: "src/mainview/App.svelte"
related_targets: []
---

# Updates window

Scope: the whole app window (Updates, History, Settings views) and the tray menu. Mode: Operate.

Audience and job: the owner at his desk after login, dark Mint-Y desktop, two monitors at 2x. He wants to see what is pending, tick, press Install once, and leave.

Task: review the pending list, install the ticked ones with no further prompts, watch each row's progress, read the outcome, retry what failed, undo a bad update.

Content: about 32 apps with a name, a source repo, a kind, an installed version, a latest version, a size, a restore point, a state.

Constraints: standard web controls only, keyboard operable, state never by colour alone, reduced motion respected, no network fonts.

## Direction contract

THESIS: A nursery bench at night. Every app is a tagged plant on one bench, and its row shows how fresh it is. Refused: the grey package table with green ticks, and the neon terminal.

OWN-WORLD: Deep leaf-green shell on a green-black ground with tag-white text. Each row carries a care band on its left edge, the coloured stripe of a nursery stake, and the band's colour and glyph name the state: sun yellow for ready, water blue for working, leaf green for fresh, rust for failed, frost grey for held, magenta for by hand. App name in bold condensed caps like a common name on a plant tag, source repo in italic beside it like the Latin name. Versions in tabular mono.

STORY: He sees a count and a list, understands which apps are stale and what each will become, believes nothing will be lost because every row shows its restore point, presses Install once, and watches stems grow.

FIRST VIEWPORT: 980 by 720. A header strip 56 px tall across the top with the state sentence at left ("7 updates ready") and the Updates, History, Settings tabs plus Check again at right. Below it the list fills the window in four groups, Ready to install first, rows 44 px tall. A footer bar 64 px tall holds the selection count at left and the one primary button, "Install 7 updates", at right. The signature move lives in the row's right third.

SIGNATURE: The stem. A working row's progress is a horizontal stem with four nodes, Download, Back up, Install, Verify. The download span fills by bytes, and a leaf unfurls at each node as its stage finishes. Raises: stage widths come from that app's last measured run (labanotation, length is duration). Hairlines and bands snap to whole device pixels (Emigre bitmap). A failed, skipped or rolled-back version stays in the row struck through and history is append-only (ticket wallet, nothing disappears, it cancels). Ready rows get the full apparatus while fresh rows are one quiet line (lexicon, rank by apparatus). During a run the working row holds full colour and the others drop back (transit diagram, the chosen line burns brightest). The latest version is set light while pending and thickens to bold once verified (variable specimen, an axis carries state).

FORM: Nursery plant tags and seed packets, candidate 7 of 7 on the ordered list (split-flap board, record label catalogue, parcel label, service booklet, press check, arcade score table, nursery tags). seed:83d0d37a74ebc31e

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Unresolved: the product name. A light theme is tokenised but only dark is verified in this build.
