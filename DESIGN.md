---
name: Upkeep
description: One window for the apps the package manager misses.
colors:
  ground: "oklch(0.19 0.022 165)"
  surface: "oklch(0.225 0.026 165)"
  raised: "oklch(0.26 0.03 165)"
  shell: "oklch(0.3 0.06 158)"
  shell-hi: "oklch(0.36 0.07 158)"
  shell-lo: "oklch(0.255 0.05 158)"
  line: "oklch(0.36 0.03 165)"
  line-soft: "oklch(0.28 0.026 165)"
  text: "oklch(0.955 0.012 110)"
  text-2: "oklch(0.8 0.02 150)"
  text-3: "oklch(0.69 0.025 155)"
  on-sun: "oklch(0.19 0.022 165)"
  sun: "oklch(0.87 0.16 96)"
  water: "oklch(0.76 0.11 232)"
  leaf: "oklch(0.8 0.17 148)"
  rust: "oklch(0.7 0.16 42)"
  fail: "oklch(0.7 0.19 25)"
  frost: "oklch(0.74 0.03 250)"
  bloom: "oklch(0.72 0.17 352)"
  dot: "oklch(0.6 0.02 160)"
typography:
  headline:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 640
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  tag-name:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 680
    lineHeight: 1.15
    letterSpacing: "0.035em"
  title:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 640
    lineHeight: 1.4
  body:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
  latin:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  label:
    fontFamily: "Archivo Variable, Archivo, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 560
    letterSpacing: "0.02em"
  data:
    fontFamily: "Martian Mono Variable, Martian Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "-0.01em"
    fontFeature: "tnum, zero"
rounded:
  sm: "4px"
  md: "6px"
  window: "8px"
  chip: "9px"
  sheet: "10px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
components:
  button-primary:
    backgroundColor: "{colors.sun}"
    textColor: "{colors.on-sun}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-disabled:
    backgroundColor: "{colors.shell-hi}"
    textColor: "{colors.text-2}"
  button-secondary:
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  button-quiet:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  tab:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  tab-selected:
    backgroundColor: "{colors.shell-hi}"
    textColor: "{colors.text}"
  segment-selected:
    backgroundColor: "{colors.shell-hi}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "26px"
  text-field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  filter-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  select:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "30px"
  chip:
    textColor: "{colors.text-2}"
    rounded: "{rounded.chip}"
    padding: "0 6px"
    height: "18px"
  ledger-row:
    backgroundColor: "{colors.surface}"
    typography: "{typography.tag-name}"
    height: "44px"
  ledger-row-fresh:
    textColor: "{colors.text-2}"
    height: "36px"
  header-bar:
    backgroundColor: "{colors.shell}"
    height: "56px"
  footer-bar:
    backgroundColor: "{colors.shell}"
    height: "64px"
---

# Design System: Upkeep

This file records the view as built. Every value below was read from the source named in its section. Where the code and the direction it was built to part ways, the code is recorded and the difference is noted in one line.

## Overview

**Creative North Star: "A nursery bench at night"**

Every app is a tagged plant on one bench. The window is a deep leaf-green shell around a green-black ground, with tag-white text. Each row carries a 4 px care band on its left edge, the coloured stripe of a nursery stake, and the band's colour and glyph together name the state. App names are set in condensed bold caps like the common name on a plant tag, the source repo sits beside them in italic like the Latin name, and versions are tabular mono.

The window is dense and calm. Pending rows carry the full apparatus (tick, versions, size, restore point, status) and fresh rows are one quieter, shorter line. During a run the working row keeps full colour and the rest of the run steps back. The one signature move is the stem: a working row's progress grows as a stem with four nodes, and a leaf opens at each node as its stage finishes.

The contract refuses two looks, and the code holds to both: the grey package table with green ticks, and the neon terminal.

**Key Characteristics:**

- Dark only, every neutral tinted toward leaf green (hue 158 to 165).
- State is a band colour, a glyph and a word, never colour alone.
- One primary button on screen at a time, in sun yellow.
- Flat surfaces separated by 1 px hairlines; shadows only on layers that float.
- One type family with a width axis for the tag caps, one mono for data.

## Colors

The palette is a night bench: tinted green-black grounds, a tag-white text ramp, and six care colours bright enough to read as stripes in the dark. Tokens live in `src/mainview/app.css`; the status-to-band map lives in `src/mainview/lib/state.ts`.

### Primary

- **Sun** (`sun`): the ready state and the one action that matters. Ready and queued bands, the ready status word, the checked tick, the queue place number, and the primary button fill. Text on it uses `on-sun`, which is the ground value.

### Care colours

- **Water** (`water`): working. The working band, stem fill, live caption, check progress bar, link text in release notes, the Add pane's busy line and the arc of Upkeep's own spinner. It is also the focus ring. Water words never stand alone without a bar or spinner beside them: Upkeep's own row at work says its sentence in `text` beside the spinner, since a lone water line reads as a link.
- **Leaf** (`leaf`): fresh and done. Fresh and done bands, completed stem nodes and leaves, the restore point tick, the "Updated to" result, the drop veil's dashed border, the all-fresh mark.
- **Rust** (`rust`): Needs a look. The problem band and status word. It is not the failure colour.
- **Fail** (`fail`): failed and rolled back. Its own red, apart from rust; `e2e/polish.spec.ts` asserts the two computed colours differ. Also the Remove confirm button. The close button's hover ground is a deeper red, `oklch(0.54 0.19 25)`, so its cross holds 4.5:1.
- **Frost** (`frost`): held. The held band, the strike colour on a skipped version, and the band on an add-pane suggestion card.
- **Bloom** (`bloom`): by hand. The manual band and status word.

### Neutral

- **Ground** (`ground`): the page, sticky column header, inputs and selects, inline code.
- **Surface** (`surface`): ledger rows, the inspector pane, Settings sheets, History rows.
- **Raised** (`raised`): a hovered or open row, the add-pane suggestion card, the refusal toast.
- **Shell** (`shell`), with `shell-hi` and `shell-lo`: the header and footer bars. `shell-lo` is the tab track, `shell-hi` the selected tab and segment and the disabled primary button.
- **Line** (`line`) and **Line soft** (`line-soft`): `line` for control borders, the checking band and the stem rail; `line-soft` for row hairlines and dividers.
- **Text** (`text`), **Text 2** (`text-2`), **Text 3** (`text-3`): primary copy, secondary copy, and captions, column heads, Latin names.
- **Dot** (`dot`): only the checking glyph, because the `line` band is too faint to draw a glyph in.

A few literal values sit outside the tokens: the 1 px rule under the header and over the footer is `oklch(0.12 0.03 160)`, the log drawer ground is `oklch(0.165 0.02 165)`, and the reason sentence under a problem row is `oklch(0.84 0.08 48)` (failed: `oklch(0.84 0.09 25)`, also History's failure detail). The System group's warning notes use the problem tint.

### Named Rules

**The Three Signals Rule.** A state is always a band colour, a glyph and a word. A new row state adds an entry to `CARE` in `lib/state.ts` (band token and glyph), a word in `statusText` in `lib/copy.ts`, and a status-text colour in `AppRow.svelte`.

**The Dim Step Rule.** A row that steps back during a run drops to 0.72 opacity and lifts its faint colours a tone (`text-3` takes `text-2`; rust, bloom and frost brighten) so text still holds 4.5:1 once dimmed. Any new dimmed state does the same.

## Typography

**Interface font:** Archivo Variable (fallback Archivo, system-ui, sans-serif), loaded from `@fontsource-variable/archivo` with its width axis, roman and italic.
**Data font:** Martian Mono Variable (fallback Martian Mono, ui-monospace, monospace), from `@fontsource-variable/martian-mono`.

No network fonts: both ship in the bundle (`src/mainview/main.ts`). Body text gets `word-spacing: 0.08em` because Archivo's word space is tight at interface sizes, and controls inherit the page's font, word space and tracking. Sizes are tokens `--fs-11` to `--fs-19` in `app.css`.

### Hierarchy

- **Headline** (640, 19 px, 1.2, width 92%, tabular figures): the state sentence in the header ("7 updates ready"), the pane and Add pane titles, the drop veil line.
- **Tag name** (680, 14 px, 1.15, width 74%, uppercase, tracking 0.035em, word space 0.14em): app names in rows. The pane title uses the same class at 19 px. The footer run bar uses the tag caps at 12 px, weight 640; the Add pane's scan results set file names in them too. Fresh and system rows set the name at 560 in `text-2`.
- **Title** (640, 13 px): group headings in the ledger, Settings group names, History run headings, Log drawer title. Pane sub-headings ("Restore points", "What changed", "Log") are 12 px at 620 in `text-2`.
- **Body** (400, 13 px, 1.4): default text, status words (540), buttons (560), tabs (560). Settings row labels are 14 px. Release notes use 1.5 line height and a 68ch measure.
- **Latin** (italic 400, 12 px, `text-3`): the source repo beside the name.
- **Label** (560, 11 px, tracking 0.02em, `text-3`): column heads, chips, counts.
- **Data** (Martian Mono, 12 px, width 87.5%, tabular and slashed zero, tracking -0.01em): versions, sizes, restore points, by-hand commands, the queue place, log lines (11 px).

### Named Rules

**The Weight Carries State Rule.** The latest version is set at `wght` 380 while pending and moves to 720, in leaf, once verified (400 ms, `--ease-out`). A failed or rolled-back version stays in the row, struck through in `fail`; a skipped one is struck in `frost`.

## Layout

Sources: `App.svelte`, `HeaderBar.svelte`, `FooterBar.svelte`, `AppList.svelte`, `app.css`, `src/bun/window-size.ts`.

The window opens at 980 by 720 and is designed down to 760 by 520, its minimum. The shell is a three-row grid: header 56 px, the view, footer 64 px. Header and footer content is capped at 1280 px and centred; the bar colours span the window. Spacing is a 4 px step, `--s1` to `--s6`.

The header holds, left to right: the window buttons when Upkeep draws its own frame, the 20 px mark, the state sentence with its one-line note ("Checked 2 minutes ago · 3 more by hand"), then the Updates, History, Settings tabs and Check again. Padding is 20 px left and 16 px right, and the content clears the window buttons by 16 px (a 118 px clearance from the window edge). The sentence sits on the tabs' centre within 1 px in every state, idle, checking, running and summary (`e2e/round3.spec.ts`); a zero-width lead-in keeps the note line's baseline when no note shows, so the title never hops.

The sentence gives way first; the tabs and Check again keep their size. Only the sentence's own text takes an ellipsis, and during a run only the app's name in it may be cut: "Installing " and ", 1 of 4" stay whole, and the full sentence is its title. Notes sit 6 px apart and never shrink: each fits whole or wraps out of sight, and the note line's whole text is its title. Below 860 px the by-hand count leaves first and Check again drops its word, keeping its icon and its accessible name. At 760 px the check time stays whole on the title's line.

The footer holds the selection ("4 selected · 112 MB" with Select all and Select none) or, during a run, the run bar at left, and Show log plus the run controls at right, 24 px apart.

### The ledger

The list is a size container named `list`, so the columns follow the list's own width, not the window's. The ledger is capped at 1280 px and centred. Column gap is 10 px, right padding 16 px. One definition in `.ledger-cols` drives rows, the row button and the column heads, so they cannot disagree:

| List width     | Columns after the 32 px tick column                                                        |
| -------------- | ------------------------------------------------------------------------------------------ |
| 1100 px and up | mark 20, name up to 360, kind 92, version 168, size 64, restore 96, status 248 to the rest |
| 900 to 1099    | the same, with status fixed at 212                                                         |
| 640 to 899     | mark 20, name the rest, version 168, restore 96, status 212 (kind and size hidden)         |
| under 640      | mark 20, name the rest, version 150, status 168 (restore hidden too)                       |

The sticky column header is 34 px on the ground, with the filter field spanning mark to kind and Add app at the end of the status column. Group headings are 44 px (40 px for the first), 20 px from the left. Groups appear in this order when they have members: the current run, Ready to install, By hand, Needs a look, Held back, Checking, Restart to finish, Fresh (`GROUP_ORDER` in `lib/model.svelte.ts`), then System when its setting is on. Fresh and System start folded; the fold lasts for the session, and an active filter opens both. The column header and the title bar set `user-select: none`, so a double-click there selects nothing.

### The inspector

Opening a row or Add app docks a pane at the right at `max(380px, 42%)` of the bench, on `surface`, with a `line-soft` rule on its left. Pane padding is 20 px sides and 24 px bottom, sections 20 px apart, and its contents indent 24 px to sit under the name past the glyph. Below 900 px the pane is a full-width sheet over the list with Back to list first in its header, the list behind it is `inert`, and focus moves into the sheet.

Other views: History centres at 820 px, Settings at 560 px. The log drawer spans the window above the footer at 45% of the height left after header and footer.

Contract difference: the contract names five groups; the code adds the run group, Restart to finish, Checking and System.

## Elevation & Depth

Sources: `app.css`, `App.svelte`, `HeaderBar.svelte`, `AppList.svelte`, `LogDrawer.svelte`. The window is flat. Depth comes from tonal steps (ground, surface, raised, shell) and 1 px hairlines drawn as inset box-shadows so a row's height centres its text exactly. Shadows appear only on layers that float over others.

### Shadow Vocabulary

- **Pop** (`--shadow-pop: 0 10px 28px -6px oklch(0.08 0.02 165 / 0.7), 0 2px 6px oklch(0.08 0.02 165 / 0.5)`): the inspector as a sheet under 900 px, the log drawer, the refusal toast.
- **Selected tab** (`0 1px 2px oklch(0.1 0.03 160 / 0.5)`): the selected tab only.
- **Primary lip** (`0 1px 0 oklch(1 0 0 / 0.25) inset`): the top edge of the primary button.
- **Scroll shade**: a 16 px gradient from `oklch(0.08 0.02 165 / 0.6)` at a pane edge that has more content behind it. A row cut by the list's bottom edge is covered by a fade into solid ground, so the last visible row is whole or absent.

### Named Rules

**The Float Only Rule.** Nothing at rest casts a shadow. A new surface that sits in the flow takes a tone and a hairline; only a layer that covers another takes `--shadow-pop`.

## Shapes

Sources: `app.css`, `App.svelte`, the component styles. Corners are small and practical. Controls and fields take 6 px (`--radius`), checkboxes, inline code and focus rings on rows 4 px, chips are a 9 px pill on an 18 px height, the tab and segment tracks 8 px with 6 px pills inside, add-pane cards 8 px, Settings sheets 10 px, the drop veil 12 px. Window buttons are 28 px circles.

The window itself rounds to 8 px (`--window-radius`) to match Linux Mint's Mint-Y theme. Rounding needs a see-through window, and the desktop draws no shadow under a see-through window, so a rounded Upkeep window has no shadow; Settings says so ("A rounded window has no shadow from the desktop."). The shell is clipped with `clip-path` as well as the radius so fixed layers stay inside the corners. With its own frame and not maximised, the page draws a 1 px `line` edge inside the window. Square corners and maximised windows have no radius and keep the desktop's shadow.

Bands are 4 px solid stripes on the row's left edge. Status glyphs are 16 px line drawings, 1.6 px stroke, round caps.

## Components

### Buttons

Defined once in `app.css` as `.btn` and its modifiers. All are inline-flex with an 8 px icon gap, 560 weight, and transition background, border and opacity over 100 ms ease-out. Disabled is 0.5 opacity and a not-allowed cursor.

- **Primary** (`.btn.primary`): 36 px, 16 px padding, sun fill and border, `on-sun` text at 680. Hover `oklch(0.91 0.15 96)`, active `oklch(0.82 0.15 96)`. Disabled turns `shell-hi` with `text-2` at full opacity, so its label still reads. Its focus ring is `text`, not water. Only one shows at a time: in Add mode the footer's Install steps down to secondary.
- **Secondary** (`.btn`): 32 px, 12 px padding, transparent with a `line` border. Hover adds a 7% tag-white wash and a `text-3` border; active 12%.
- **Small** (`.btn.small`): 26 px, 8 px padding, 12 px text. The default for pane and Settings actions.
- **Quiet** (`.btn.quiet`): no border, `text-2`, turning `text` on hover. Show log and Add app in the column header.
- **Danger**: a small button with `fail` border and text, used only for the Remove confirm.

### Tabs and segmented controls

Sources: `HeaderBar.svelte`, `SettingsView.svelte`. Header tabs sit in a `shell-lo` track with 3 px padding and 2 px gaps; each tab is 28 px high, 12 px padding, `text-2`, and the selected one is `shell-hi` with `text` and the selected-tab shadow. Arrow keys, Home and End move between them, and only the selected tab is a Tab stop. Settings segmented controls use the same shape on a `ground` track with a `line-soft` border, at 26 px and 12 px text. Each is a real radio group (`role="radiogroup"` with `role="radio"` buttons): one Tab stop on the checked option, the arrow keys move and select, Home and End go to the ends.

### Checkbox

Sources: `app.css`, `AppRow.svelte`. A real `input type="checkbox"` drawn in the palette: 16 px box, 1.5 px `text-3` border, 4 px radius; hover border `text`; checked fills sun with a dark tick; transitions 120 ms. In rows it sits inside a 28 px label so the hit area is 28 by 28. The header tick goes indeterminate when some shown rows are ticked.

### Fields and selects

Sources: `AddPane.svelte`, `AppList.svelte`, `SettingsView.svelte`, `SuggestionCard.svelte`.

- **Text field** (Add pane): 32 px, 12 px padding, `line` border, 6 px radius, on `ground`, mono at 12 px; placeholder `text-3`; read-only at 0.7 opacity. An error is a 12 px `fail` line with `role="alert"`; while it shows the field is `aria-invalid` and the error joins its `aria-describedby` ahead of the hint. An empty Find clears the last error. A failed apps.toml write says why, says nothing changed, and offers Open apps.toml.
- **Filter field** (column header): 26 px, 8 px padding, on `surface`, up to 260 px wide, focus ring offset 0.
- **Select** (Settings): 30 px, at least 64 px wide, on `ground`, mono 12 px. Selects in suggestion cards are 28 px on `surface` with a 4 px radius.
- **Language picker** (`LanguagePicker.svelte`): the Select's button, with a 5 px filled caret, opening a list the page draws (a listbox, not the desktop's menu: GTK sets a native menu so the chosen item sits over the box, and eleven entries ran off the window). The list is fixed to the window under the button, or over it when the window ends first, at least 180 px wide, 30 px rows, 8 showing and the rest scrolling, `ground` with a `line` border and a soft shadow. The row under the pointer or keyboard is `shell-hi`; the chosen one is `text` at weight 600. Each language is written in itself and carries its own `lang`.

### Settings rows

Each sheet is a 560 px card on `surface` with a `line-soft` border and 10 px radius. A row is at least 52 px, 16 px padding, label at 14 px left and control right, hairline between rows. A row whose control is a segmented group stacks, with 12 px vertical padding and a 12 px `text-3` help line under it. App list stacks the same way: Open apps.toml, Export and Import side by side, and a help line that after an Export or Import says what it did. Sheets come in this order: general, Window, Extras (Show system updates, then Install system updates from Upkeep while the first is on; Show Cleanup, then Include developer caches while it is on; each with its help line), About. A new Settings control is a row in a sheet: label left, control right, help text under only when the choice needs explaining.

### Ledger row

The signature component, `AppRow.svelte`. A grid on the ledger columns, 44 px high on `surface`, a `line-soft` hairline under it, `raised` on hover and when open. The open row also shows a small `text` triangle at its right edge pointing at the pane. Left to right:

1. The 4 px band in the state's colour.
2. The tick column: a checkbox on ready rows, the queue place number in sun on queued rows, empty otherwise.
3. One button covering every cell after the tick, so the whole row opens the pane.
4. Mark: the state glyph, 16 px.
5. Name: the tag name, then chips (In use, Root, Auto), then the repo in italic, on one 18 px line. When space runs out the repo goes first, then each chip shrinks to its glyph, then the name ellipsises. Nothing wraps.
6. Kind, version pair, size, restore point, status. The restore point is a leaf tick and the version; an app that can keep one but has none yet reads "none yet" in 12 px `text-3`; a kind that cannot keep one stays blank (the pane says why).

Every row has the same set of cells in every state. A row with a reason sentence is 56 px and sets the reason under the name, inside the name column; Kind and Version stay in place and visible. The reason clamps to two lines. A ready row carries a reason when its last try failed (`lastTryFailed`: "Last try failed." and then the reason). A row being checked again keeps its last versions and its tick, disabled, until the answer arrives. Failed and rolled-back rows keep 44 px and one line. Fresh rows are 36 px on a transparent ground, band at 0.3 opacity, glyph and name in quieter tones, no size and no status word unless a restart is due. Rows outside the run during a run use the Dim Step Rule; queued and done rows in the run step back to band 0.4 and `text-3` captions.

| State       | Band          | Glyph                                                              | Status cell                                                                        |
| ----------- | ------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| checking    | `line`        | pulsing dot in `dot`                                               | "Checking", 440 weight, `text-3`; versions show a breathing skeleton               |
| ready       | `sun`         | the mark (pixel sprout below 1.5 dppx)                             | "Ready" in sun                                                                     |
| queued      | `sun`         | hourglass                                                          | "Queued" in sun, place number in the tick column                                   |
| working     | `water`       | three rising dashes, as the tray's working picture, never the leaf | the stem with "Downloading 12.1 of 30 MB", "Backing up", "Installing", "Verifying" |
| done        | `leaf`        | leaf                                                               | the full stem, "Updated to 10.5.2" or "Restart Zen Browser to finish"              |
| fresh       | `leaf` at 0.3 | leaf in `text-3`                                                   | empty, or "Restart Zen Browser to finish"                                          |
| manual      | `bloom`       | hand                                                               | the command to run, in mono, fitted to the cell                                    |
| held        | `frost`       | pause                                                              | "Held" or "Skipping 1.24.1b"                                                       |
| problem     | `rust`        | warning triangle                                                   | "Needs a look" in rust, reason sentence under the name                             |
| failed      | `fail`        | cross                                                              | "Failed" in fail, version struck in fail                                           |
| rolled_back | `fail`        | cross                                                              | "Rolled back to 3.29.9" in fail                                                    |

The version pair is a three-track grid (installed, 20 px arrow, latest) so every row shares one axis. With nothing installed the installed slot stays empty and the cell reads "→ 15.2.0"; screen readers hear "Not installed. 15.2.0 is the latest." instead. Otherwise they hear "to" between the two.

### System row

`SystemGroup.svelte`, `SystemRow.svelte`, the `SYS` strings in `lib/copy.ts`, `e2e/system.spec.ts`. A group last in the list, shown only while Settings, Extras, "Show system updates" is on, and read-only unless the second switch beneath it, "Install system updates from Upkeep" (off by default, shown only while the first is on), is on too. It lists the system's own pending updates: the packages Update Manager (else apt, dnf, pacman or zypper) would install, Flatpak apps and runtimes, Snaps, and Cinnamon's applets, desklets, extensions and themes.

The group heading is the folding heading Fresh uses (chevron, "System", the count in mono), then "From Update Manager, checked 2 minutes ago" ("From Update Manager, checking" during a check; the names are every source with rows, joined as the language joins a list, such as "From apt, Snap and Cinnamon", and Cinnamon is not named beside Update Manager, which shows spices itself) in 12 px `text-3`, then a quiet small "Open Update Manager" at the right. Folded with a problem, the heading carries a rust warning glyph whose label is the warning. Open, the body says one of: "Checking system updates" with the checking dot, "No system updates.", a rust-glyph note in the problem tint for a missing tool (the command's name, then "is not installed, so this part of the list is empty.") or an unreadable list ("Could not read Update Manager's list."), and the NVIDIA GL line when Flatpak's GL runtime is missing.

A system row sits on the ledger's columns but is a plain `div`: no button, no pane, no tick or tab stop unless installing is on (below), and nothing in it the keyboard walks or Select all ticks. It is at least 36 px with a hairline, no band and no ground of its own, the leaf glyph in `text-3`, and the name in tag caps at 560 in `text-2`, with the In use chip when the app is running. The Kind column says Security, Package, Kernel, Driver, Flatpak app, Flatpak runtime, Snap, or Cinnamon applet, desklet, extension or theme in 12 px `text-2`; Security is set in `text` at 600, weight not colour. The version cell runs from the Version column to the row's end, across the empty Size, Restore point and Status cells: the old version right-aligned in the first half of the version column, the arrow on the version column's arrow line, then the new version at `wght` 380. Only the old version may be cut; the new one never is, at 980 or 760 (`e2e/round3.spec.ts`). When the build changes and the version does not, the cell reads the version, then "new build" in `text-3`. A kernel or driver row adds "Needs a restart after it installs." 16 px after the new version, or under it when both do not fit. The whole change is the cell's title and its accessible name.

With installing on, a row Upkeep can install (Update Manager's packages, plain apt's, Flatpak, Snap and Cinnamon rows; never a kernel or driver row, never a kernel or NVIDIA package by name, and never a package row from dnf, pacman or zypper) gets the app rows' tick box in the tick column, unticked until the person ticks it; it is the row's only tab stop. A spice row says "Installs with every Cinnamon applet that has an update." (or desklet, extension, theme) where the restart note goes, and a package row from a list Upkeep does not install says "Install it with dnf." (or pacman, zypper). The header gains a small "Install 2 system updates" button after Open Update Manager ("Install system updates", disabled, with none ticked). It never runs anything: it opens a confirm block under the heading, in the Restart all pattern (1 px `line` border, `radius`, 13 px `text`): "Upkeep runs these commands, in this order:", the commands as typed in mono 12 px, one per line, "The commands that start with sudo need administrator rights and run as root." when any does, then "Install now" and "Not now", focus on Not now. During the install each ticked row shows "Waiting" or "Installing" (with the checking dot in `sun`) where its note goes, and the ticks lock. A refusal is a rust-glyph note in the problem tint with the engine's sentence. A finished install shows a results block of the same shape: "Installed 2 of 3.", then one line per row (the name at 560, "Installed" in `text-2` or "Failed" in `fail`, and the reason), and a "Done" button that clears it; installed rows have left the list by then.

System rows never enter the header sentence, the footer's Install count or selection, or the tray icon's count; the tray menu lists them on their own line ("System updates: 12").

### Cleanup tab

`CleanupView.svelte`, the `CLEAN` strings in `lib/copy.ts`, `e2e/cleanup.spec.ts`. A header tab between History and Settings, present only while Settings, Extras, "Show Cleanup" is on; turning it off while the tab shows moves to Settings. The view uses the Settings column: 560 px wide, centred, on `ground`. At the top, the intro sentence at 14 px, under it "Measured 2 minutes ago" (or the checking dot and "Measuring") in 12 px `text-3`, and a small "Measure again" button at the right. The first look at the tab measures; items land one by one as each is measured.

Items sit in up to three Settings-style sheets under 13 px headings: "Safe to clear", "Your call", "Shown only". An item is a block with 12 by 16 px padding and a hairline: the tick box (none on a shown item), the name at 14 px, the "Needs administrator" chip when it runs as root, a chip for what deleting means ("Comes back on its own", "Downloads again", "Cannot be undone"), and the size in mono at the right. Under it the one-sentence what in 12 px `text-2`, then a facts line for kernels, Timeshift and hand-made copies, then, for items with more than one part (leftovers, restore points, NVIDIA runtimes), one 28 px row per part with its own tick, the path or name in mono 12 px, ellipsised, and its size. A leftover newer than its live file starts unticked with its note in the problem tint. The item tick is checked when every part is, indeterminate when some are.

Under the sheets a sticky footer on `ground` holds the one primary button, "Review 2.4 GB", disabled with "Tick something to clean." beside it when nothing is ticked. Review never deletes: it opens a block above the sheets in the confirm pattern (1 px `line` border, `radius`, 13 px `text`): "Delete these?" at 14 px, one line per ticked item with its size, "2.4 GB in all." at 600, "Cannot be undone: …" when any item is final, "Upkeep runs these commands:" with each command in mono 12 px when any part runs one, the type field ("Type remove to also remove packages", 32 px mono) only when packages are ticked, then the danger button that names the total ("Delete 2.4 GB", disabled until the word is typed) and "Back", which takes focus. While the block is open or a cleanup runs, the sheets are inert. During the run each item says "Waiting", "Cleaning" or "Cleaned" under its text; after it, a results block of the same shape: "Freed 43 MB.", one line per item (name at 560, the state in `text-2` or `fail`, the size, the reason), and "Done". A refusal is a rust-glyph note with the engine's sentence. History lists each cleaned item by its name with "43 MB freed" where versions go and "Cleaned" as its result.

### The stem

`Stem.svelte`. One span per stage of the app's kind (Download, Back up, Install, Verify), each span's flex-grow set to that stage's weight. Weights come from the app's last successful update, each floored at 8 and summing to 100, or from the kind's default (`src/engine/store.ts`): AppImage and binaries 60/10/20/10; .deb 50/40/10 and source 10/80/10 with no Back up; self-updating and updater-script apps 85/15 for Install and Verify. No span is drawn narrower than 28 px, so the leaves stay countable.

Each span is a 2 px `line` rail with a `water` fill, then an 8 px node with a 1.5 px border. A finished span fills to the end in leaf, its node fills leaf, and a 9 px leaf grows from the node (scale and rotate, 280 ms `--ease-out`). The active node has a water border. Download fills by bytes; a stage with no percent shows a 40% sweep moving across the rail (1.1 s, stopped at 75% under reduced motion). The caption under the stem is 12 px, water at 560 while live, leaf when done. A live stem is a `progressbar` with its value and the caption as its value text.

The footer run bar repeats the run in miniature: one stop per queued app, each with its glyph, the name in tag caps at 12 px, and a 4 px rail filled in the state's colour.

### Pane

`RowDetail.svelte`. Header: glyph, the name in tag caps at 19 px, the close button (a cross when docked, Back to list under 900 px). Under it the repo, kind and In use chip; the version pair at 14 px with the status word in the state's colour; the stem when working; the reason sentence. Retry sits in the header when the app failed. Then blocks in this order: the by-hand command with Copy, or Run now for an app that checks itself; Restore points; actions (Skip or Stop skipping, Hold updates or Release hold, Install automatically, Open release page); Remove from Upkeep; What changed; facts (96 px term column); Log (last 40 lines). A disabled action during a run says why in its title ("Wait for the run to finish."). Remove asks in place with Remove and Keep; Keep takes focus and Escape keeps. Claude Code's plugins row's restore line reads "Claude Code keeps no older plugin to go back to." A new pane block is a grid with an 8 px gap and a 12 px `text-2` heading.

### Identity in the interface

Sources: `lib/brand.ts`, `components/Mark.svelte`, `components/Glyph.svelte`, `assets/brand/`.

- The mark (`mark-mono.svg`, a sprouting stem in one path) draws in `text` at 20 px in the header beside the state sentence and at 32 px in leaf on the all-fresh screen.
- The ready glyph is the mark itself, drawn as a vector and matched in height and weight to the hand glyph of By hand. Below 1.5 dppx it switches, by a `resolution` media query in `Glyph.svelte`, to the pixel sprout (`ui-sprout.svg`, fitted by hand on a 16 px grid), because a vector that small turns to mush on a 1x screen.
- The leaf (`ui-leaf.svg`, the mark's own leaf, upright) is the fresh and done glyph.
- About in Settings shows the horizontal dark lockup at 40 px tall: the mark on its sun tile (`#f4d340`, mark `#0a1711`) beside the UPKEEP wordmark in `#f0f1e8`. Under the version and the tagline sit three small buttons with the external-link glyph: What's new, Report a bug and Upkeep on GitHub.
- App icons: a sun tile with the dark drawing. 16, 22, 24 and 32 px use the hand-placed pixel sprout; 48 and 64 px a refitted mark on the 256 grid; 256 and 512 px the mark on a 224 px tile with a 48 px radius and a 1 px `#debb32` edge.
- Tray: the shipping pictures are the light drawings at 44 px (`tray-light-44`, rendered by `scripts/tray-icons.ts`), shown at 22 on a 2x panel. States are idle, working, failed, a count badge with a knocked-out digit from 1 to 9, and 9+. The plant sits left of centre to leave the badge its corner; idle has no badge, so its plant is centred. The dark drawings at 44 px (`tray-dark-44`) ship too, as `<state>-dark.png`, for a light Plasma panel (`src/bun/panel.ts`); every other desktop gets the light set. The 22 px masters are kept in `assets/brand` but not shipped.

### Focus and keyboard

Sources: `App.svelte`, `AppList.svelte`, `HeaderBar.svelte`, `e2e/keyboard.spec.ts`, `e2e/a11y.spec.ts`.

- Focus ring: 2 px solid `water`, 2 px offset. Row buttons draw it inset (offset -2 px) with a 4 px radius; the primary button's ring is `text`.
- First focus lands on the first row. Install is at most six Tab presses away.
- The list is one Tab stop (the open row, else the last focused, else the first). Up and Down move, Home and End jump, Space ticks, Enter or Right opens, Left closes, `a` opens Add app, Ctrl+A selects all. PageUp and PageDown on a row move focus by as many 44 px rows as fit under the 34 px column header (and the open pane follows); elsewhere in the list they scroll 90% of a page.
- `/` or Ctrl+F focuses the filter; in it, Down goes to the first row, Enter opens the first match, Escape clears it and goes no further.
- Escape closes the log, then the pane, and returns focus to the row (or to Add app).
- After Add, focus goes to the new app's row (the first added row after a scan); under 900 px the sheet keeps it, since the list is inert. After Remove, focus goes to the next row, or the one before when the removed row was last, or the filter when no row is left.
- System rows and Settings' segmented groups follow their own rules above: a system row has no stop except its tick box while installing is on, and a segmented group has one stop.
- Tab past the last control wraps to the first; inert regions and hidden controls are skipped. Ctrl+W closes the window when Upkeep draws its frame.
- When buttons swap (Install for Stop, Stop for Done) or a pressed button disables itself, focus moves to its partner, never to the page. No positive tabindex anywhere.

### Motion

Sources: `app.css`, `lib/motion.ts`, component styles. One custom easing, `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, for the leaf and the version weight; everything else uses `ease-out` or `linear`.

- 100 ms: button and window-button hover. 120 ms: checkbox, tabs. 150 ms: chevrons, scroll shades. 160 ms linear: stem fill; 160 ms fade: the state sentence. 200 ms: pane fly-in (32 px from the right), check bar, run bar fill. 240 ms: row dimming, restore point fade, footer slot swap; footer buttons fly 8 px. 280 ms: the leaf. 320 ms: rows reordering between groups (flip). 400 ms: the version weight.
- Loops: the checking dot pulses between 1 and 0.85 opacity over 1.2 s, the version skeleton breathes over 1.4 s, the sweep runs 1.1 s, the spinner 800 ms (a `text` arc in the Add pane's busy buttons, a `water` arc on Upkeep's own row while it downloads, tests or restarts).
- Reduced motion: CSS cuts every animation and transition to 0.001 ms and one iteration, and `ms()` returns 0 for every Svelte transition. The sweep parks at 75% and the spinner stops. `e2e/motion.spec.ts` checks every state is still reached.

### Window frame

Sources: `HeaderBar.svelte`, `WindowButtons.svelte`, `src/bun/index.ts`, `src/bun/chrome.ts`, `e2e/frame.spec.ts`. By default Upkeep draws its own title bar inside the 56 px header (`titleBarStyle: "hiddenInset"`, the resize edges kept). The header is a drag region and every control in it is not; double-clicking empty header space maximises. Window buttons are 28 px circles, 6 px apart, 12 px from the window edge, in the desktop's order and on its side (left or right, or set in Settings). They are `text-2`, `shell-hi` on hover, and close turns `oklch(0.54 0.19 25)` with a `text` cross, measured at 4.5:1 or better in `e2e/round3.spec.ts`. On the left, a 1 px by 24 px divider separates them from the mark, which keeps at least 20 px clear. Settings can hand the frame back to the desktop, which removes the buttons, the drag region and the edge.

### Voice

Every string is in `src/mainview/lib/copy.ts`, and each has a `data-testid` the specs assert on.

- Name the app, the version and the step: "Installing Zen Browser, 2 of 4", "Updated to 10.5.2", "Rolled back to 3.29.9", "Downloading 12.1 of 30 MB".
- Counts are plain sentences: "7 updates ready", "3 updated, 1 failed", "All 32 apps are up to date.", "Everything is fresh".
- Buttons are verbs with their object: "Install 7 updates", "Retry 1 failed", "Stop after this one", "Restore 1.24b", "Remove from Upkeep".
- Explain a refusal or a missing thing in one sentence: "Tick an update to install.", "It updates itself, and its table has no restore command.", "Remove fd from the list? The app itself stays installed.", "Could not write apps.toml:" with the reason, then "Nothing was changed."
- History names what a run was: a retry's sentence starts with "Retry: " ("Retry: 1 updated"), an app installed fresh reads "Installed 15.2.0" instead of a pair, and during a run "A run is in progress." heads the page with past runs listed under it.
- Sentence case, no exclamation marks, no hand-typed three-dot ellipsis (`e2e/polish.spec.ts` checks the whole window). A long label is truncated by the browser's ellipsis or fitted, never cut by hand.

### Accessibility, as measured

- `scripts/drive.mjs` (run against the dev build, not part of `bun run validate`) measures the contrast of every visible text node and glyph, blended through opacity onto the real background: text needs 4.5:1, or 3:1 at 24 px and up or 18.66 px bold; glyphs need 3:1.
- The figures written in `app.css`: each care colour is at least 4.6:1 on the shell and 5.9:1 on the ground; `text-3` is tuned to hold 4.5:1 on the shell; `fail` is 6.3:1 on the ground and 5.8:1 on surface; the checking dot still measures 3:1 on its row at its 0.85 pulse floor.
- `e2e/round2.spec.ts` pins the pulse keyframe at 0.85 and a failed row's height at 44 px. `e2e/round3.spec.ts` blends the dot at its low point over the row's real background and requires 3:1, and requires 4.5:1 for the close button's hover cross.
- Targets: the row tick 28 by 28, window buttons 28, tabs 28 high, close and back 28, buttons 26 to 36.
- `e2e/small.spec.ts`: at 760 by 520 no horizontal scroll and no clipped button label in any state. `e2e/a11y.spec.ts`: every control has a name, every SVG is hidden or labelled, no duplicate ids, tab order follows reading order.
- Live regions: the state sentence and selection count are polite; the run announces once per stage, not per percent.

Code differences from the contract:

- Contract: rows are 44 px. Code: 44 px pending, 56 px with a reason, 36 px fresh.
- Contract: rust for failed. Code: failed has its own red, `fail`, and rust is Needs a look.
- Contract: a light theme is tokenised. Code: dark only, no light tokens.

## Do's and Don'ts

### Do:

- **Do** give every new state a band token, a glyph and a word, through `CARE` in `lib/state.ts` and `statusText` in `lib/copy.ts`.
- **Do** take ledger columns from `.ledger-cols` in `app.css` and name each cell's grid column, so a hidden cell never moves another.
- **Do** keep row heights fixed per state (44, 56 with a reason, 36 fresh) and give every row the same set of cells in every state.
- **Do** keep anything outside Upkeep's own apps, such as system rows, out of the header, footer and tray counts.
- **Do** route every Svelte transition duration through `ms()` and put any new loop under the reduced-motion rule.
- **Do** keep one primary button on screen; step others down to secondary.
- **Do** put every new string in `copy.ts` with a `data-testid`, and change the spec with the string.

### Don't:

- **Don't** add a light theme or read the system scheme: the system webview can report light on a dark desktop, so the scheme is fixed to dark (`e2e/scheme.spec.ts`).
- **Don't** use CSS subgrid for the ledger: WebKitGTK 2.52 does not re-resolve a subgrid's tracks when a row's content changes. Pass the shared track variables instead.
- **Don't** carry status by colour alone, and don't use rust for failure.
- **Don't** add scroll snap to the list: it pulled a row the keyboard had just brought into view back under the edge.
- **Don't** put a shadow on a surface at rest, or on the window when its corners are rounded.
- **Don't** load fonts from the network or swap in system controls' own fonts; controls inherit the page's type.
- **Don't** type a three-dot ellipsis or cut a label by hand.
