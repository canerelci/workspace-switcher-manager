---
name: workspace-switcher-manager
description: >-
  Maps the WSM (Workspace Switcher Manager) GNOME Shell extension codebase—modules,
  GSettings keys, prototype overrides, and vertical-workspace integration. Repository
  language policy: user-facing chat may be Turkish; all code, comments, docs, and
  committed project text stay English. Use when editing this repo, adding preferences,
  fixing workspace popup/switch behavior, or debugging conflicts with other extensions.
---

# Workspace Switcher Manager (WSM)

## Language policy

- **Conversation with the user** may use Turkish or English depending on context.
- **Everything in the repo** must stay **English**: source code, comments, `README`, schemas, commit messages, skill bodies stored under `.cursor/skills/`, UI strings that ship with the extension (follow existing gettext/`_()` patterns).

## What this project is

- **UUID:** `workspace-switcher-manager@G-dH.github.com`
- **Stack:** GNOME Shell extension — ES modules (`import`/`export`), GObject/Clutter/St, Shell UI imports from `resource:///org/gnome/shell/...`
- **Target shells:** See `metadata.json` → `shell-version` (e.g. 45–48)

## Source layout

| File | Role |
|------|------|
| `extension.js` | `Extension` subclass: enable/disable, `Meta.Workspace.get_neighbor` replacement, `WorkspaceSwitcherPopup` customization (custom + default variants), labels/thumbnails logic |
| `settings.js` | `Options` class: bridges JS option names ↔ GSettings keys; delayed apply; `get`/`set`/`getDefault`; profile save/load; optional backends via factories (`wm.preferences`, `mutter`) |
| `util.js` | `Overrides` extends `InjectionManager`: `addOverride`/`removeOverride`/`removeAll`; `after_*` hooks run after original method; `getEnabledExtensions(pattern)` for coexistence checks |
| `verticalWorkspaces.js` | When vertical layout is active: patches `WorkspaceLayout` + `WorkspacesView`; remaps Page Up/Down keybindings; Apps overview button toggles temporary horizontal layout |
| `prefs.js` | `ExtensionPreferences`: Adwaita preference pages via `optionsFactory.js` |
| `optionsFactory.js` | Widget builders / page composition for prefs |
| `stylesheet.css` | Shell stylesheet for popup classes |
| `schemas/*.gschema.xml` | Extension keys; compile to `schemas/gschemas.compiled` (Makefile) |

## Enable/disable contract (`extension.js`)

- **enable:** Saves original `get_neighbor`, reads default workspace orientation, may disable “reverse orientation” UI if `vertical-workspaces` extension is enabled (`Util.getEnabledExtensions('vertical-workspaces')`), constructs global `opt = new Settings.Options(this)`, `Overrides` instance, wires `_updatePopupMode`, `_reverseWsOrientation`, `_updateNeighbor`, connects `opt` `changed` → `_updateSettings`.
- **disable:** Clears prefs demo timer, destroys `Main.wm._workspaceSwitcherPopup` if present, restores default popup class override, restores `get_neighbor`, resets workspace layout patch, `removeAll()` overrides, `opt.destroy()`.

## Workspace switching logic

- Custom **`_getNeighbor`** applies when any of: wraparound, ignore-last-workspace, or reverse orientation is active — grid-aware LEFT/RIGHT/UP/DOWN with optional wrap.
- **`override_workspace_layout`** (`Meta.DisplayCorner.TOPLEFT`, rows/columns `-1` vs `1`) switches horizontal vs vertical workspace strip when “reverse orientation” is allowed.

## Popup modes (constants in `extension.js`)

- `wsPopupMode`: `ALL` (0), `ACTIVE` (1), `DEFAULT` (2).
- `_updatePopupMode`: DEFAULT → stock popup with `WorkspaceSwitcherPopupDefault` overrides; otherwise → fully custom `WorkspaceSwitcherPopupCustom` class substitution on `WorkspaceSwitcherPopup` prototype.

**Note:** Code references `wsPopupMode.DISABLE` in `display()`, but `DISABLE` is not defined on `wsPopupMode` — those comparisons are always false. Prefer fixing or removing that branch when touching popup visibility logic (`popup-visibility` / `_popupDisabled` already gates behavior).

## Overrides pattern (`util.js`)

- Plain keys replace prototype methods.
- Keys prefixed with `after__` (double underscore after `after_`) wrap: run original, then patch function.
- Restoration uses stored originals per override name.

## Adding or changing a setting

1. Add key in `schemas/org.gnome.shell.extensions.workspace-switcher-manager.gschema.xml` (type, default, description).
2. Run `make` or `glib-compile-schemas schemas` so `gschemas.compiled` updates.
3. Add entry in `settings.js` → `this.options` (JS name → `[type, gsettings-key, optionalSettingsFactory]`).
4. Wire UI in `optionsFactory.js` / list builders in `prefs.js` as needed.
5. Handle `changed` in `extension.js` → `_updateSettings` if runtime behavior must react without full reload.

## External GSettings (not only extension schema)

- `org.gnome.desktop.wm.preferences`: `workspace-names`, `num-workspaces` (and similar) via optional getters in `Options`.
- `org.gnome.mutter`: `dynamic-workspaces`, `workspaces-only-on-primary`.
- `org.gnome.desktop.wm.keybindings`: modified by `verticalWorkspaces._switchPageShortcuts()` for Page Up/Down routing.

## Development workflow

- **Validate (no Shell load):** `make check` — compiles schemas and builds the zip; does not run inside GNOME Shell.
- **Build zip only:** `make` / `make build`.
- **Symlink workflow (no reinstall loop):** `make dev-link` — links this repo into `~/.local/share/gnome-shell/extensions/<uuid>/`; edit files, restart Shell. Requires that path not already be a real directory (`make uninstall` first if needed). `make dev-unlink` removes the symlink.
- **One-shot install:** `make install` — zip + extract to extensions dir.
- **Clean:** `make clean` — removes zip, compiled schema, `locale/` outputs.
- **Shell restart:** After install, restart GNOME Shell (X11: Alt+F2 `r`; Wayland: re-login). Enable via Extensions app or `gnome-extensions enable workspace-switcher-manager@G-dH.github.com`.
- **Runtime diagnostics:** Extension `_wsmDiagLog()` writes to **journal** (`log`), **stderr** (`print`), and **`$TMPDIR/wsm-extension.log`** (usually `/tmp/wsm-extension.log`). If `journalctl` shows nothing from the extension, `tail -f /tmp/wsm-extension.log` while toggling the extension or opening the workspace switcher.
- **Editor:** VS Code/Cursor tasks in `.vscode/tasks.json` wrap `make check` and `make install`.
- **CI:** `.github/workflows/ci.yml` runs `make check` on push and pull requests.
- **Zip size:** Makefile fails if zip &gt; 5 MB (EGO limit).
- **Translations:** `make pot` / `po/` → `locale/` MO files included in zip when present.

See **Development** in `README.md` for the command table.

## Extension coexistence

- If **Vertical Workspaces** is enabled, WSM skips reversing workspace orientation (`_wsOrientationEnabled === false`) to avoid duplicate patches.

## UI / UX conventions

- Preference changes debounced then may trigger `_showPopupForPrefs` (100 ms timer) so the workspace popup previews customization.

### Pointer workspace select (Super+W-style overlay)

- **Modal grab:** `Main.pushModal` on the fullscreen overlay actor (`_widget` for custom popup, `this` for default variant) so pointer and keyboard focus Shell modal routing; pair with `Main.popModal` on destroy (`extension.js` helpers `_wsmPushPointerModal` / `_wsmPopPointerModal`). Supports both grab-returning and legacy boolean `pushModal` return values.
- **Reactive fullscreen widget:** The fullscreen `St.Widget` must be `reactive = true` so transparent regions absorb clicks instead of passing them to focused windows.
- **Labels:** Keep workspace tile **labels non-reactive** (`_wsmMarkSubtreeNonReactive`) so pointer picks resolve to the **`St.Bin`** (`ws-switcher-box` / `ws-switcher-active`), which is what `stylesheet.css` `:hover` rules target; reactive labels would receive hover instead (no styles). **Do not** rely on “reactive labels” for clicks — use **`Main.pushModal`** on the overlay plus **`_widget.reactive = true`** so misses outside tiles are absorbed by Shell modal routing instead of leaking to focused windows.
- **Hover (pointer-select):** Pick finds tile + `wsm-pointer-hover` class; **visual** hover updates **`set_style` inline** — `_setCustomStyle()` sets base colors inline (stylesheet overridden). **`_wsmApplyPointerHoverTileStyles`** uses GSettings **`popup-inactive-hover-bg-color`**, **`popup-inactive-hover-border-color`**, **`popup-active-hover-glow-color`** (prefs → Colors → Pointer hover). **`_wsmDisconnectPointerSelectHandlers`** calls **`_setCustomStyle()`** to restore.
- **Debug overlay:** Must be a **child of the modal actor** (`popup._widget` or stock `popup`), not `Main.uiGroup`, or clicks and keys never reach it after `pushModal`. Copy shortcut on **`key-press-event`** on that same actor. Logs include `pick-hover idx` from the hover ticker.

### Workspace thumbnails (custom popup)

- **`WorkspaceThumbnail(metaWorkspace, monitorIndex)`** (Shell `workspaceThumbnail.js`): second argument is **monitor index** (`primaryIndex` vs current monitor per WSM monitor pref), **not** workspace index. Passing workspace index breaks `_isMyWindow()` (`meta_window.get_monitor() === monitorIndex`), so thumbnails stay empty.
- **Work area vs monitor geometry:** `setPorthole()` uses **`Main.layoutManager.getWorkAreaForMonitor(monitorIndex)`**. Scale and center the scaled actor using **work-area width/height**, not full **`get_monitor_geometry`**, or tiles can mis-center and clip to blank.
- **Stacking:** Call **`thumbnail.syncStacking(stackIndices)`** with the same map Shell builds in **`overview.js`** (`get_window_actors()` order → `stable_sequence` → index). Overview wires `windows-restacked`; standalone thumbnails should sync once after construction.
- **Multi-monitor:** Thumbnails only show windows on **one** monitor per tile; prefer the monitor with the **most** overview-eligible windows on that workspace (`!skip_taskbar`, `showing_on_its_workspace()`), or secondary-only workspaces look empty if primary is always chosen.
- **setScale + allocate (critical):** Overview uses **`thumbnail.setScale(h, v)`** (scales internal `_viewport`) and **`thumbnail.allocate(box)`** from **`ThumbnailsBox.vfunc_allocate`**. Do **not** rely on root **`set_scale()`** alone: without a layout pass, **`Clutter.Clone`** can stay blank while logs still show **`clones=N`**. Embed thumbnails in **`WorkspaceSwitcherManagerThumbnailClip`** (`extension.js`) so **`child.allocate()`** runs inside **`vfunc_allocate`**.
- **Uniform thumbnail frames:** **`_getThumbnailClipDimensions`** uses **`_wsmThumbnailFrameWorkArea()`** (same as **`_wsmWorkAreaForPopupSizing()`** — monitor pref primary vs current). Do **not** use per-workspace **`getWorkAreaForMonitor(_wsmPickMonitorIndexForThumbnail(...))`** for **width×height** — that caused different tile heights when secondary monitors differed. **`WorkspaceThumbnail(ws, monIdx)`** still uses the picker **`monIdx`** for window clones; **`scale` + inner box center** letterboxes inside the shared frame.
- **Popup sizing:** **`popup-height-scale`** with thumbnails: **inner** top/bottom padding + thumb→label gap (`_wsmThumbCardVerticalInsets()`, scales from **0**). Without thumbnails, height scale still divides the aspect-derived tile size (`ch`). **`popup-label-padding-scale`** scales horizontal **`em`** padding on labels (default **55** ≈ tighter than legacy **100**). Label **`font-size`** uses **`_wsmEffectiveFontFit()`**: **`_fitToScreenScale`** × (**allocated tile width** / **`WSM_FONT_CARD_WIDTH_REF_PX`**, clamped), with a coarse guess until **`_childWidth`** exists.
- **`St.BoxLayout`:** Some Shell/St versions reject **`spacing:`** in the GObject constructor (`No property spacing on StBoxLayout`); use **`margin_top`** on the second child or set spacing after construction if the property exists.

When unsure, grep for the GSettings key string (e.g. `popup-mode`) and follow from schema → `settings.js` → `extension.js` / `prefs.js`.
