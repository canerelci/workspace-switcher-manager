/**
 * Workspaces Switcher Manager
 * extension.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2022 - 2025
 * @license    GPL-3.0
 */
'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Settings from './settings.js';
import * as Util from './util.js';
import * as VerticalWorkspaces from './verticalWorkspaces.js';

import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import { WorkspaceThumbnail } from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

let opt;

const ANIMATION_TIME = 100;

const wsPopupMode = {
    ALL: 0,
    ACTIVE: 1,
    DEFAULT: 2,
};

/** Min tile size (px, before popupScale) so thumbnails can fill the card; paired with CSS min-height. */
const WSM_THUMB_TILE_MIN_PX = 252;

/** Bottom strip reserved for workspace labels when thumbnails are shown (boosted font sizes). */
const WSM_THUMB_LABEL_RESERVE_PX = 92;

/**
 * Max vertical padding (top/bottom of tile content) at popup-height-scale 100%; scaled by height factor (0 => none).
 */
const WSM_THUMB_CARD_VPAD_MAX_PX = 14;

/** Max gap between monitor frame and label stack at height-scale 100%; scaled same way. */
const WSM_THUMB_THUMB_LABEL_GAP_MAX_PX = 8;

/**
 * Reference workspace-tile width (px): `_childWidth / this ≈ 1` keeps legacy-ish label size; wider tiles bump `em` proportionally.
 */
const WSM_FONT_CARD_WIDTH_REF_PX = 196;

const POINTER_SELECT_PRESETS = [
    ['<Super>w'],
];

/** Pointer-select diagnostics → journal: `journalctl --user -f -g WSM-pointer` (no ripgrep needed) */
function _wsmPointerJournal(msg) {
    log(`[WSM-pointer] ${msg}`);
}

function _wsmPointerJournalVerbose(msg) {
    if (opt?.get('pointerWorkspaceSelectDebugOverlay'))
        _wsmPointerJournal(msg);
}

/** Writes to journal (`log`), stderr (`print`), and `$TMPDIR/wsm-extension.log`. */
function _wsmDiagLog(msg) {
    const line = `[WSM] ${msg}`;
    log(line);
    print(`${line}\n`);
    try {
        const path = GLib.build_filenamev([GLib.get_tmp_dir(), 'wsm-extension.log']);
        const file = Gio.File.new_for_path(path);
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        const stamp = GLib.DateTime.new_now_local().format_iso8601();
        const bytes = new GLib.Bytes(`${stamp} ${line}\n`);
        stream.write_bytes(bytes, null);
        stream.close(null);
    } catch (e) {
        log(`[WSM] diag file write failed: ${e.message}`);
    }
}

/** Logs when Content → Workspace thumbnails is enabled (journal: `journalctl -f | grep WSM-thumb`; try without `--user` if empty). */
function _wsmThumbJournal(msg) {
    if (opt?.get('popupWorkspaceThumbnails'))
        _wsmDiagLog(`thumb: ${msg}`);
}

/** Improve clone painting when embedding Shell WorkspaceThumbnail outside Overview (theme/compositor). */
function _wsmThumbnailPresentationHints(actor) {
    const OR = Clutter.OffscreenRedirect;
    try {
        if (OR?.NEVER !== undefined)
            actor.offscreen_redirect = OR.NEVER;
        else if (OR?.DISABLED !== undefined)
            actor.offscreen_redirect = OR.DISABLED;
    } catch (e) {
        /* ignore */
    }
}

/** Same ordering as Shell Overview `_onRestacked` (overview.js) for WorkspaceThumbnail.syncStacking(). */
function _wsmBuildWindowStackIndices() {
    const stack = global.get_window_actors();
    const stackIndices = {};
    for (let i = 0; i < stack.length; i++) {
        const mw = stack[i].get_meta_window();
        if (mw)
            stackIndices[mw.get_stable_sequence()] = i;
    }
    return stackIndices;
}

/** WS Box Height Scale as 0…1 (prefs allow 0): inner vertical padding + thumb↔label gap scale together. */
function _wsmThumbHeightScaleFactor() {
    return Math.max(0, opt.get('popupHeightScale') / 100);
}

/** [padTop, gapThumbToLabel, padBottom] in px; all zero when height scale is 0. */
function _wsmThumbCardVerticalInsets() {
    const hs = _wsmThumbHeightScaleFactor();
    const pad = Math.round(WSM_THUMB_CARD_VPAD_MAX_PX * hs);
    const gap = Math.round(WSM_THUMB_THUMB_LABEL_GAP_MAX_PX * hs);
    return [pad, gap, pad];
}

/**
 * Combines shrink-to-fit with allocated tile width (`WorkspaceSwitcherPopupList._childWidth`).
 */
function _wsmEffectiveFontFit(list) {
    const fit = list._fitToScreenScale;
    let cw = list._childWidth;
    if (!(cw > 0)) {
        const wa = _wsmWorkAreaForPopupSizing();
        const nWs = Math.max(1, global.workspace_manager.n_workspaces);
        const tiles = list._popupMode === wsPopupMode.ALL ? nWs : 1;
        const cwScale = opt.get('popupWidthScale') / 100;
        cw = ((wa.width - 80) / tiles) * cwScale;
        cw = Math.max(48, cw);
    }
    const wBoost = cw / WSM_FONT_CARD_WIDTH_REF_PX;
    const clamped = Math.min(2.05, Math.max(0.58, wBoost));
    return fit * clamped;
}

/**
 * WorkspaceThumbnail only draws windows on one monitor; pick the monitor with the most
 * taskbar-visible windows on this workspace (secondary monitor no longer yields empty tiles).
 */
function _wsmPickMonitorIndexForThumbnail(metaWorkspace, fallbackMonIdx) {
    const nMon = global.display.get_n_monitors();
    let bestMon = fallbackMonIdx;
    let bestScore = -1;
    for (let m = 0; m < nMon; m++) {
        let score = 0;
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || !win.located_on_workspace(metaWorkspace))
                continue;
            if (win.get_monitor() !== m)
                continue;
            if (win.skip_taskbar || !win.showing_on_its_workspace())
                continue;
            score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestMon = m;
        }
    }
    return bestMon;
}

/** Applied by pointer-hover timer; stylesheet :hover is unreliable under modal. */
const WSM_POINTER_HOVER_CLASS = 'wsm-pointer-hover';

function _wsmPointerSessionPersistsUntilClick() {
    return opt.get('pointerWorkspaceSelectPersistUntilClick');
}

/** Modal subtree is `popup._widget` (custom) or stock `popup`; Shell routes pointer/keys there after pushModal. */
function _wsmModalShellActor(popup) {
    return popup._widget ?? popup;
}

/** Mirror _setCustomStyle tile branch but with visible hover (inline beats stylesheet). */
function _wsmApplyPointerHoverTileStyles(popup, hoveredIdx) {
    if (!popup._list || popup._boxBgSize === undefined || popup._boxRadius === undefined)
        return;

    const inactiveHoverBg = opt.get('popupInactiveHoverBgColor');
    const inactiveHoverBd = opt.get('popupInactiveHoverBorderColor');
    const activeGlow = opt.get('popupActiveHoverGlowColor');
    const thumbTiles = opt.get('popupWorkspaceThumbnails');
    const borderChrome = thumbTiles ? 'border: none; border-width: 0px; outline: none;' : '';

    const children = popup._list.get_children();
    const activeWs = popup._activeWorkspaceIndex;
    const pm = popup._popupMode;

    for (let i = 0; i < children.length; i++) {
        const ch = children[i];
        const useActiveStyle = i === activeWs || pm;
        const isHover = hoveredIdx !== null && ch._wsIndex === hoveredIdx;

        const bs = popup._boxBgSize;
        const br = popup._boxRadius;

        if (useActiveStyle) {
            if (isHover) {
                ch.set_style(` background-size: ${bs}px;
                                        border-radius: ${br}px;
                                        color: ${popup._activeFgColor};
                                        background-color: ${popup._activeBgColor};
                                        border-color: ${popup._activeBgColor};
                                        filter: brightness(1.38) saturate(1.1);
                                        box-shadow: 0 0 14px ${activeGlow}, 0 0 32px ${activeGlow};
                                        ${borderChrome}`);
            } else {
                ch.set_style(` background-size: ${bs}px;
                                        border-radius: ${br}px;
                                        color: ${popup._activeFgColor};
                                        background-color: ${popup._activeBgColor};
                                        border-color: ${popup._activeBgColor};
                                        box-shadow: none;
                                        filter: none;
                                        ${borderChrome}`);
            }
        } else {
            let bg = popup._inactiveBgColor;
            let bd = popup._borderColor;
            if (isHover) {
                bg = inactiveHoverBg;
                bd = inactiveHoverBd;
            }
            ch.set_style(` background-size: ${bs}px;
                                        border-radius: ${br}px;
                                        color: ${popup._inactiveFgColor};
                                        background-color: ${bg};
                                        border-color: ${bd};
                                        ${borderChrome}`);
        }
    }
}

/** Hover highlight: pick under pointer finds tile (enter/hover often broken under modal). */
function _wsmPointerHoverVisualTick(popup) {
    if (Main.wm._workspaceSwitcherPopup !== popup || !popup._wsmPointerSelect || !popup._list)
        return GLib.SOURCE_REMOVE;

    const [px, py] = global.get_pointer();
    let actor = null;
    try {
        actor = _wsmPickActorAt(Clutter.PickMode.REACTIVE, px, py);
    } catch (e) {
        actor = null;
    }

    let idx = null;
    let a = actor;
    while (a) {
        if (a._wsIndex !== undefined) {
            idx = a._wsIndex;
            break;
        }
        a = a.get_parent();
    }

    const prev = popup._wsmHoverVisualIdx;
    if (idx !== prev && opt.get('pointerWorkspaceSelectDebugOverlay'))
        _wsmPointerDebugAppend(popup, `pick-hover ws=${idx === null ? 'none' : idx}`);

    popup._wsmHoverVisualIdx = idx;
    for (const ch of popup._list.get_children()) {
        if (ch._wsIndex === undefined)
            continue;
        if (idx !== null && ch._wsIndex === idx)
            ch.add_style_class_name(WSM_POINTER_HOVER_CLASS);
        else
            ch.remove_style_class_name(WSM_POINTER_HOVER_CLASS);
    }
    _wsmApplyPointerHoverTileStyles(popup, idx);
    return GLib.SOURCE_CONTINUE;
}

function _wsmDisconnectPointerSelectHandlers(popup) {
    if (popup._wsmHoverVisualTimerId) {
        GLib.source_remove(popup._wsmHoverVisualTimerId);
        popup._wsmHoverVisualTimerId = 0;
    }
    popup._wsmHoverVisualIdx = undefined;
    if (popup._list) {
        for (const ch of popup._list.get_children()) {
            if (ch._wsIndex !== undefined)
                ch.remove_style_class_name(WSM_POINTER_HOVER_CLASS);
        }
    }
    if (typeof popup._setCustomStyle === 'function')
        popup._setCustomStyle();

    if (!popup._wsmPointerBindings?.length)
        return;
    for (const h of popup._wsmPointerBindings)
        h.actor.disconnect(h.id);
    popup._wsmPointerBindings = [];
}

function _wsmAttachPointerSelectHandlers(popup) {
    _wsmDisconnectPointerSelectHandlers(popup);
    if (!popup._wsmPointerSelect || !popup._list)
        return;
    popup._wsmPointerBindings = [];
    let idx = 0;
    for (const child of popup._list.get_children()) {
        const captured = child;
        if (captured._wsIndex === undefined)
            captured._wsIndex = idx;
        idx++;
        captured.reactive = true;
        captured.track_hover = true;

        const id = captured.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const wsIdx = captured._wsIndex;
            if (wsIdx === undefined)
                return Clutter.EVENT_PROPAGATE;
            const ws = global.workspace_manager.get_workspace_by_index(wsIdx);
            if (ws)
                ws.activate(global.get_current_time());
            popup.destroy();
            return Clutter.EVENT_STOP;
        });
        popup._wsmPointerBindings.push({ actor: captured, id });
    }

    popup._wsmHoverVisualTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33,
        () => _wsmPointerHoverVisualTick(popup));
}

function _wsmMarkSubtreeNonReactive(actor) {
    if (!actor)
        return;
    actor.reactive = false;
    actor.track_hover = false;
    for (const c of actor.get_children())
        _wsmMarkSubtreeNonReactive(c);
}

function _wsmUnbindEsc(popup) {
    if (popup._wsmEscGrabIdleId) {
        GLib.source_remove(popup._wsmEscGrabIdleId);
        popup._wsmEscGrabIdleId = 0;
    }
    if (popup._wsmEscStageKeyId) {
        global.stage.disconnect(popup._wsmEscStageKeyId);
        popup._wsmEscStageKeyId = 0;
    }
    if (popup._wsmEscActorKeyId) {
        const escTarget = popup._widget ?? popup;
        if (escTarget)
            escTarget.disconnect(popup._wsmEscActorKeyId);
        popup._wsmEscActorKeyId = 0;
    }
}

function _wsmBindEscToClose(popup) {
    if (!popup._wsmPointerSelect)
        return;
    _wsmUnbindEsc(popup);

    const escHandler = (actor, event) => {
        if (Main.wm._workspaceSwitcherPopup !== popup)
            return Clutter.EVENT_PROPAGATE;
        let sym;
        try {
            sym = event.get_key_symbol();
        } catch (e) {
            return Clutter.EVENT_PROPAGATE;
        }
        if (sym !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        popup.destroy();
        return Clutter.EVENT_STOP;
    };

    popup._wsmEscStageKeyId = global.stage.connect('key-press-event', escHandler);

    const escTarget = popup._widget ?? popup;
    if (escTarget)
        popup._wsmEscActorKeyId = escTarget.connect('key-press-event', escHandler);

    if (!popup._wsmEscCleanupRegistered) {
        popup._wsmEscCleanupRegistered = true;
        popup.connect('destroy', () => {
            _wsmUnbindEsc(popup);
        });
    }
}

/** Grab keyboard/pointer so the overlay receives events (Esc, clicks outside tiles). */
function _wsmPushPointerModal(popup) {
    if (!popup._wsmPointerSelect)
        return;
    const actor = popup._widget ?? popup;
    if (!actor)
        return;
    _wsmPopPointerModal(popup);
    try {
        const params = {
            timestamp: global.get_current_time(),
            actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        };
        const result = Main.pushModal(actor, params);
        popup._wsmModalGrab = result;
        popup._wsmModalActor = actor;
    } catch (e) {
        console.warn('WSM: pushModal failed', e?.message ?? e);
    }
}

function _wsmPopPointerModal(popup) {
    const grab = popup._wsmModalGrab;
    const actor = popup._wsmModalActor ?? popup._widget ?? popup;
    popup._wsmModalGrab = undefined;
    popup._wsmModalActor = null;
    if (grab === undefined || grab === null || grab === false)
        return;
    try {
        if (grab === true)
            Main.popModal(actor);
        else
            Main.popModal(grab);
    } catch (e) {
        try {
            Main.popModal(actor);
        } catch (e2) {
            /* ignore */
        }
    }
}

const WSM_POINTER_DEBUG_MAX_LINES = 36;

function _wsmDescribeActorChain(actor) {
    if (!actor)
        return '(null)';
    const parts = [];
    let a = actor;
    for (let i = 0; i < 12 && a; i++) {
        let typeName = 'Actor';
        try {
            typeName = GObject.type_name_from_instance(a);
        } catch (e) {
            /* ignore */
        }
        let sc = '';
        try {
            sc = a.get_style_class_name?.() ?? '';
        } catch (e) {
            /* ignore */
        }
        const nm = a.name || '';
        const shortSc = sc ? sc.split(/\s+/).slice(0, 5).join('.') : '';
        parts.push(`${typeName}${nm ? `[${nm}]` : ''}${shortSc ? ` #${shortSc}` : ''}`);
        a = a.get_parent();
    }
    return parts.join(' <- ');
}

function _wsmPickActorAt(pickMode, x, y) {
    const st = global.stage;
    try {
        if (st.get_actor_at_pos)
            return st.get_actor_at_pos(pickMode, x, y);
        if (st.get_actor_at_point)
            return st.get_actor_at_point(pickMode, x, y);
    } catch (e) {
        return null;
    }
    return null;
}

function _wsmPointerDebugAppend(popup, line) {
    if (!popup._wsmPointerSelect || !opt.get('pointerWorkspaceSelectDebugOverlay'))
        return;
    if (!popup._wsmDebugLines)
        popup._wsmDebugLines = [];
    const t = GLib.DateTime.new_now_local().format('%H:%M:%S');
    popup._wsmDebugLines.push(`${t} ${line}`);
    if (popup._wsmDebugLines.length > WSM_POINTER_DEBUG_MAX_LINES)
        popup._wsmDebugLines.splice(0, popup._wsmDebugLines.length - WSM_POINTER_DEBUG_MAX_LINES);
}

function _wsmDestroyPointerDebugOverlay(popup) {
    if (popup._wsmDebugTickId) {
        GLib.source_remove(popup._wsmDebugTickId);
        popup._wsmDebugTickId = 0;
    }
    if (popup._wsmDebugAllocId) {
        const ref = popup._wsmDebugAllocTarget;
        if (ref)
            ref.disconnect(popup._wsmDebugAllocId);
        popup._wsmDebugAllocId = 0;
        popup._wsmDebugAllocTarget = null;
    }
    if (popup._wsmDebugCopyKeyId) {
        const ka = popup._wsmDebugCopyKeyActor ?? _wsmModalShellActor(popup);
        if (ka)
            ka.disconnect(popup._wsmDebugCopyKeyId);
        popup._wsmDebugCopyKeyId = 0;
        popup._wsmDebugCopyKeyActor = null;
    }
    if (popup._wsmDebugOuter) {
        popup._wsmDebugOuter.destroy();
        popup._wsmDebugOuter = null;
    }
    popup._wsmDebugLabel = null;
    popup._wsmDebugLines = null;
    popup._wsmDebugExportText = '';
}

function _wsmPointerDebugCopyToClipboard(popup) {
    const t = popup._wsmDebugExportText ?? '';
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, t);
}

function _wsmPointerDebugRaiseOverlay(popup) {
    const o = popup._wsmDebugOuter;
    if (o && typeof o.raise_top === 'function')
        o.raise_top();
}

function _wsmPositionPointerDebugOverlay(popup) {
    if (!popup._wsmDebugOuter)
        return;
    const ref = popup._container ?? popup._list ?? popup;
    if (!ref)
        return;
    const [cx, cy] = ref.get_position();
    const [cw] = ref.get_size();
    const margin = 8;
    const dbg = popup._wsmDebugOuter;
    const dw = dbg.width > 1 ? dbg.width : 380;
    dbg.set_position(Math.round(cx + cw - dw - margin), Math.round(cy + margin));
}

function _wsmPointerDebugTick(popup) {
    if (Main.wm._workspaceSwitcherPopup !== popup || !popup._wsmDebugLabel)
        return GLib.SOURCE_REMOVE;

    const [px, py] = global.get_pointer();
    let pickReactive = '(n/a)';
    let pickAll = '(n/a)';
    try {
        const ar = _wsmPickActorAt(Clutter.PickMode.REACTIVE, px, py);
        pickReactive = _wsmDescribeActorChain(ar);
    } catch (e) {
        pickReactive = String(e?.message ?? e);
    }
    try {
        const aa = _wsmPickActorAt(Clutter.PickMode.ALL, px, py);
        pickAll = _wsmDescribeActorChain(aa);
    } catch (e) {
        pickAll = String(e?.message ?? e);
    }

    let hoverBits = '';
    if (popup._list) {
        const bits = [];
        for (const ch of popup._list.get_children()) {
            if (ch._wsIndex === undefined)
                continue;
            bits.push(`ws${ch._wsIndex}:h=${ch.hover ? 1 : 0}`);
        }
        hoverBits = bits.join(' ');
    }

    const lines = popup._wsmDebugLines ?? [];
    const header = [
        `WSM pointer-select debug`,
        `pointer: (${px}, ${py})`,
        `pick REACTIVE: ${pickReactive}`,
        `pick ALL: ${pickAll}`,
        `modal grab: ${popup._wsmModalGrab ? 'yes' : 'no'}`,
        `tile.hover: ${hoverBits || '(no list)'}`,
        `pick-hover idx: ${popup._wsmHoverVisualIdx === undefined ? '(n/a)' : popup._wsmHoverVisualIdx === null ? 'none' : popup._wsmHoverVisualIdx}`,
        '--- log ---',
        ...lines,
    ];
    popup._wsmDebugExportText = header.join('\n');
    popup._wsmDebugLabel.clutter_text.set_text(header.join('\n'));
    _wsmPositionPointerDebugOverlay(popup);
    _wsmPointerDebugRaiseOverlay(popup);
    return GLib.SOURCE_CONTINUE;
}

function _wsmAttachPointerDebugOverlay(popup) {
    _wsmDestroyPointerDebugOverlay(popup);
    if (!popup._wsmPointerSelect || !opt.get('pointerWorkspaceSelectDebugOverlay'))
        return;

    popup._wsmDebugLines = [];

    const outer = new St.BoxLayout({
        vertical: true,
        style_class: 'wsm-pointer-debug-panel',
        reactive: true,
    });
    outer.set_width(380);

    const label = new St.Label({
        style_class: 'wsm-pointer-debug-label',
        text: 'WSM debug…',
    });
    label.clutter_text.line_wrap = true;
    label.set_width(380);

    const btn = new St.Button({
        label: 'Copy debug (Ctrl+Shift+C)',
        style_class: 'button',
        reactive: true,
        track_hover: true,
        can_focus: true,
    });
    btn.connect('button-press-event', (actor, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        _wsmPointerDebugCopyToClipboard(popup);
        return Clutter.EVENT_STOP;
    });

    outer.add_child(label);
    outer.add_child(btn);

    const shellActor = _wsmModalShellActor(popup);
    shellActor.add_child(outer);
    popup._wsmDebugOuter = outer;
    popup._wsmDebugLabel = label;

    _wsmPointerDebugRaiseOverlay(popup);

    popup._wsmDebugCopyKeyActor = shellActor;
    popup._wsmDebugCopyKeyId = shellActor.connect('key-press-event', (actor, event) => {
        if (Main.wm._workspaceSwitcherPopup !== popup)
            return Clutter.EVENT_PROPAGATE;
        const need = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK;
        if ((event.get_state() & need) !== need)
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        if (sym !== Clutter.KEY_c && sym !== Clutter.KEY_C)
            return Clutter.EVENT_PROPAGATE;
        _wsmPointerDebugCopyToClipboard(popup);
        return Clutter.EVENT_STOP;
    });

    const ref = popup._container ?? popup._list ?? popup;
    if (ref) {
        popup._wsmDebugAllocTarget = ref;
        popup._wsmDebugAllocId = ref.connect('notify::allocation', () => {
            _wsmPositionPointerDebugOverlay(popup);
        });
    }

    popup._wsmDebugTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => _wsmPointerDebugTick(popup));

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (Main.wm._workspaceSwitcherPopup === popup)
            _wsmPointerDebugTick(popup);
        return GLib.SOURCE_REMOVE;
    });

    _wsmPointerDebugAppend(popup, 'debug overlay created');
}


/** Work area used to clamp workspace-switcher list size (matches monitor preference: primary vs current). */
function _wsmWorkAreaForPopupSizing() {
    const monIdx = opt.get('monitor') === 0
        ? Main.layoutManager.primaryIndex
        : global.display.get_current_monitor();
    return Main.layoutManager.getWorkAreaForMonitor(monIdx);
}


export default class WSM extends Extension {
    enable() {
        this._original_getNeighbor = Meta.Workspace.prototype.get_neighbor;
        this._defaultOrientationVertical = global.workspace_manager.layout_rows === -1;

        // if VW extension enabled, disable this option in WSM
        this._wsOrientationEnabled = !Util.getEnabledExtensions('vertical-workspaces').length;

        opt = new Settings.Options(this);

        this._overrides = new Util.Overrides();

        this._updatePopupMode();

        this._reverseWsOrientation(opt.get('reverseWsOrientation'));
        this._updateNeighbor();

        opt.connect('changed', this._updateSettings.bind(this));

        this._syncPointerPresetToAccelerator();
        this._updatePointerSelectKeybinding();

        _wsmDiagLog(`enabled uuid=${this.metadata.uuid} popupMode=${opt.get('popupMode')} popupVisibility=${opt.get('popupVisibility')} thumbs=${opt.get('popupWorkspaceThumbnails')}`);

        console.debug(`${this.metadata.name}: enabled`);
    }

    disable() {
        Main.wm.removeKeybinding('pointer-workspace-select-accelerator');

        if (this._prefsDemoTimeoutId) {
            GLib.source_remove(this._prefsDemoTimeoutId);
            this._prefsDemoTimeoutId = 0;
        }

        if  (Main.wm._workspaceSwitcherPopup) {
            Main.wm._workspaceSwitcherPopup.destroy();
            Main.wm._workspaceSwitcherPopup = null;
        }

        this._setDefaultWsPopup();
        Meta.Workspace.prototype.get_neighbor = this._original_getNeighbor;

        this._reverseWsOrientation(false);

        this._overrides.removeAll();
        this._overrides = null;

        if (opt) {
            opt.destroy();
            opt = null;
        }

        console.debug(`${this.metadata.name}: disabled`);
    }

    _setCustomWsPopup() {
        this._setDefaultWsPopup();
        this._overrides.addOverride('WorkspaceSwitcherPopup', WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype, WorkspaceSwitcherPopupCustom);
    }

    _setDefaultWsPopup() {
        this._overrides.removeOverride('WorkspaceSwitcherPopup');
    }

    // ------------------------------------------------------------------------------
    _updateSettings(settings, key) {
        switch (key) {
        case 'pointer-workspace-select-enabled':
        case 'pointer-workspace-select-accelerator':
        case 'pointer-workspace-select-hotkey-preset':
            this._syncPointerPresetToAccelerator();
            this._updatePointerSelectKeybinding();
            return;
        case 'popup-mode':
            this._updatePopupMode();
            break;
        case 'default-colors':
            return;
        case 'ws-wraparound':
        case 'ws-ignore-last':
            this._updateNeighbor();
            return;
        case 'reverse-ws-orientation':
        case 'vertical-overview':
            this._reverseWsOrientation(opt.get('reverseWsOrientation'), true);
            this._updateNeighbor();
            return;
        }

        // avoid multiple pop-ups when more than one settings keys were changed at once
        if (this._prefsDemoTimeoutId)
            GLib.source_remove(this._prefsDemoTimeoutId);

        this._prefsDemoTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, this._showPopupForPrefs.bind(this));
    }

    _updatePopupMode() {
        const popupMode = opt.get('popupMode');
        if (popupMode === wsPopupMode.DEFAULT) {
            this._setDefaultWsPopup();
            // set modified default so we can set its position and timing
            this._overrides.addOverride('WorkspaceSwitcherPopup', WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype, WorkspaceSwitcherPopupDefault);
        } else {
            this._setCustomWsPopup();
        }
    }

    _updateNeighbor() {
        if (opt.get('wsSwitchWrap') || opt.get('wsSwitchIgnoreLast') || opt.get('reverseWsOrientation'))
            Meta.Workspace.prototype.get_neighbor = this._getNeighbor;
        else
            Meta.Workspace.prototype.get_neighbor = this._original_getNeighbor;
    }

    _reverseWsOrientation(reverse = false) {
        // this option is in conflict with Vertical Workspaces extension that includes the same patch
        if (!this._wsOrientationEnabled)
            return;

        // reverse === false means reset
        const orientationVertical = reverse ? !this._defaultOrientationVertical : this._defaultOrientationVertical;

        if (orientationVertical) {
            global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, 1);
            if (VerticalWorkspaces)
                VerticalWorkspaces.patch(this._overrides);
        } else { // horizontal
            global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, 1, -1);
            if (VerticalWorkspaces)
                VerticalWorkspaces.reset(this._overrides);
        }
    }

    _showPopupForPrefs() {
        // if user is currently customizing the popup, show the popup on the screen
        const wsIndex = global.workspace_manager.get_active_workspace_index();
        if (Main.wm._workspaceSwitcherPopup !== null) {
            Main.wm._workspaceSwitcherPopup.destroy();
            Main.wm._workspaceSwitcherPopup = null;
        }

        Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
        Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
            Main.wm._workspaceSwitcherPopup = null;
        });

        Main.wm._workspaceSwitcherPopup.display(wsIndex);

        this._prefsDemoTimeoutId = 0;
        return GLib.SOURCE_REMOVE;
    }

    _getNeighbor(direction) {
        const activeIndex = this.index();
        const ignoreLast = opt.get('wsSwitchIgnoreLast');
        const wraparound = opt.get('wsSwitchWrap');
        const nWorkspaces = global.workspace_manager.n_workspaces - (ignoreLast ? 1 : 0);
        const lastIndex = nWorkspaces - 1;
        const rows = global.workspace_manager.layout_rows > -1 ? global.workspace_manager.layout_rows : nWorkspaces;
        const columns = global.workspace_manager.layout_columns > -1 ? global.workspace_manager.layout_columns : nWorkspaces;

        let index = activeIndex;
        let neighborExists;

        if (direction === Meta.MotionDirection.LEFT) {
            index -= 1;
            const currentRow = Math.floor(activeIndex / columns);
            const indexRow = Math.floor(index / columns);
            neighborExists = index > -1 && indexRow === currentRow;
            if (wraparound && !neighborExists) {
                index = currentRow * columns + columns - 1;
                const maxIndexOnLastRow = lastIndex % columns;
                index = index < lastIndex ? index : currentRow * columns + maxIndexOnLastRow;
            }
        } else if (direction === Meta.MotionDirection.RIGHT) {
            index += 1;
            const currentRow = Math.floor(activeIndex / columns);
            const indexRow = Math.floor(index / columns);
            neighborExists = index <= lastIndex && indexRow === currentRow;
            if (wraparound && !neighborExists)
                index = currentRow * columns;
        } else if (direction === Meta.MotionDirection.UP) {
            index -= columns;
            neighborExists = index > -1;
            if (wraparound && !neighborExists) {
                index = rows * columns + index;
                index = index < nWorkspaces ? index : index - columns;
            }
        } else if (direction === Meta.MotionDirection.DOWN) {
            index += columns;
            neighborExists = index <= lastIndex;
            if (wraparound && !neighborExists)
                index %= columns;
        }

        return global.workspace_manager.get_workspace_by_index(neighborExists || wraparound ? index : activeIndex);
    }

    _syncPointerPresetToAccelerator() {
        const p = opt.get('pointerWorkspaceSelectHotkeyPreset');
        const accel = POINTER_SELECT_PRESETS[p] ?? POINTER_SELECT_PRESETS[0];
        opt.set('pointerWorkspaceSelectAccelerator', accel);
    }

    _updatePointerSelectKeybinding() {
        Main.wm.removeKeybinding('pointer-workspace-select-accelerator');
        const enabled = opt.get('pointerWorkspaceSelectEnabled');
        const accels = this.getSettings().get_strv('pointer-workspace-select-accelerator');
        _wsmDiagLog(`pointer keybinding enabled=${enabled} accelerator=${accels.join(', ')}`);
        if (!enabled)
            return;
        Main.wm.addKeybinding(
            'pointer-workspace-select-accelerator',
            this.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onPointerSelectActivate()
        );
        _wsmDiagLog('pointer keybinding addKeybinding registered');
    }

    _onPointerSelectActivate() {
        try {
            _wsmPointerJournalVerbose('shortcut invoked');
            if (!opt.get('pointerWorkspaceSelectEnabled')) {
                _wsmPointerJournal('shortcut ignored: pointer-workspace-select-enabled is false');
                return;
            }
            const wsIndex = global.workspace_manager.get_active_workspace_index();
            _wsmPointerJournalVerbose(`active workspace index=${wsIndex}`);
            if (Main.wm._workspaceSwitcherPopup) {
                Main.wm._workspaceSwitcherPopup.destroy();
                Main.wm._workspaceSwitcherPopup = null;
                _wsmPointerJournalVerbose('destroyed existing workspace switcher popup');
            }
            globalThis._wsmPointerSelectOpening = true;
            try {
                Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
                    Main.wm._workspaceSwitcherPopup = null;
                });
                Main.wm._workspaceSwitcherPopup.display(wsIndex);
                _wsmPointerJournalVerbose('popup display() finished');
            } finally {
                globalThis._wsmPointerSelectOpening = false;
            }
        } catch (e) {
            globalThis._wsmPointerSelectOpening = false;
            _wsmPointerJournal(`ERROR in pointer-select: ${e?.message ?? e}`);
            if (e?.stack)
                _wsmPointerJournal(e.stack);
        }
    }
}

// -------------------------------------------------------------------------------------

function _getWindowApp(metaWindow) {
    let tracker = Shell.WindowTracker.get_default();
    return tracker.get_window_app(metaWindow);
}

const WorkspaceSwitcherPopupCustom = {
    _init() {
        Clutter.Actor.prototype._init.bind(this)();
        this._widget = new St.Widget({
            // offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
            x: 0,
            y: 0,
            width: global.screen_width,
            height: global.screen_height,
            style_class: 'workspace-switcher-group',
        });
        /* Pointer-select: full-area hit target + modal grab; labels stay reactive when marking non-reactive would pass clicks through. */
        if (globalThis._wsmPointerSelectOpening === true)
            this._widget.reactive = true;

        Main.uiGroup.add_child(this._widget);

        this._timeoutId = 0;

        this._wsmPointerSelect = globalThis._wsmPointerSelectOpening === true;
        this._popupMode = opt.get('popupMode');
        this._popupDisabled = !opt.get('popupVisibility');
        // if popup disabled don't allocate more resources (unless pointer-select session forces UI)
        if (this._popupDisabled && !this._wsmPointerSelect)
            return;

        this._container = new St.BoxLayout({
            style_class: 'workspace-switcher-container',
        });
        this._widget.add_child(this._container);

        this._orientation = global.workspace_manager.layout_rows === -1
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
        this._list = new WorkspaceSwitcherPopupList();
        this._list._popupMode = this._popupMode;
        this._container.add_child(this._list);

        this._monitorOption = opt.get('monitor');
        this._workspacesOnPrimaryOnly = opt.get('workspacesOnPrimaryOnly');

        this._horizontalPosition = opt.get('popupHorizontal') / 100;
        this._verticalPosition = opt.get('popupVertical') / 100;
        this._modifiersCancelTimeout = opt.get('modifiersHidePopup');
        this._displayTimeout = opt.get('popupTimeout');
        this._fadeOutTime = opt.get('fadeOutTime');

        this._popScale = opt.get('popupScale') / 100;
        this._paddingScale = opt.get('popupPaddingScale') / 100;
        this._spacingScale = opt.get('popupSpacingScale') / 100;
        this._radiusScale = opt.get('popupRadiusScale') / 100;
        this._list._popScale = this._popScale;

        this._indexScale = opt.get('indexScale') / 100;
        this._fontScale = opt.get('fontScale') / 100;
        this._textBold = opt.get('textBold');
        this._textShadow = opt.get('textShadow');
        this._wrapAppNames = opt.get('wrapAppNames');

        this._popupOpacity = opt.get('popupOpacity');
        this._bgColor = opt.get('popupBgColor');
        this._borderColor = opt.get('popupBorderColor');
        this._activeFgColor = opt.get('popupActiveFgColor');
        this._activeBgColor = opt.get('popupActiveBgColor');
        this._inactiveFgColor = opt.get('popupInactiveFgColor');
        this._inactiveBgColor = opt.get('popupInactiveBgColor');
        this._borderColor = opt.get('popupBorderColor');

        this._activeShowWsIndex = opt.get('activeShowWsIndex');
        this._activeShowWsName = opt.get('activeShowWsName');
        this._activeShowAppName = opt.get('activeShowAppName');
        this._activeShowWinTitle = opt.get('activeShowWinTitle');
        this._inactiveShowWsIndex = opt.get('inactiveShowWsIndex');
        this._inactiveShowWsName  = opt.get('inactiveShowWsName');
        this._inactiveShowAppName = opt.get('inactiveShowAppName');
        this._inactiveShowWinTitle = opt.get('inactiveShowWinTitle');

        this._widget.hide();

        let workspaceManager = global.workspace_manager;
        this._workspaceManagerSignals = [];
        this._workspaceManagerSignals.push(workspaceManager.connect('workspace-added',
            this._redisplay.bind(this)));
        this._workspaceManagerSignals.push(workspaceManager.connect('workspace-removed',
            this._redisplay.bind(this)));

        this.connect('destroy', this._onDestroy.bind(this));

        this._list.set_style('margin: 0;');
        this._redisplay();

        if (opt.get('reversePopupOrientation'))
            this._list.vertical = !this._list.vertical;

        if (Meta.disable_unredirect_for_display)
            Meta.disable_unredirect_for_display(global.display);
        else // new in GS 48
            global.compositor.disable_unredirect();
    },

    _show() {
        this._container.ease({
            opacity: 255,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._widget.show();
    },

    display(activeWorkspaceIndex = null) {
        if (!this._container)
            return;

        this._activeWorkspaceIndex = activeWorkspaceIndex;

        if (this._wsmPointerSelect && this._list)
            this._list._popupMode = wsPopupMode.ALL;

        this._setCustomStyle();
        this._setSpacing();
        this._redisplay();
        this._resetTimeout();

        this.opacity = Math.floor(this._popupOpacity / 100 * 255);

        this._show();
        // this._setCustomStyle();
        // first style adjustments have to be made to calculate popup size
        this._setPopupPosition();

        if (this._list._fitToScreenScale < 1)
            this._addLabels();

        if (this._wsmPointerSelect)
            _wsmAttachPointerSelectHandlers(this);

        if (this._wsmPointerSelect)
            _wsmBindEscToClose(this);

        if (this._wsmPointerSelect)
            _wsmPushPointerModal(this);

        if (this._wsmPointerSelect)
            _wsmAttachPointerDebugOverlay(this);
    },

    _redisplay() {
        let workspaceManager = global.workspace_manager;

        this._list.destroy_all_children();

        if (opt.get('popupWorkspaceThumbnails'))
            this._list.add_style_class_name('wsm-popup-workspace-thumbnails');
        else
            this._list.remove_style_class_name('wsm-popup-workspace-thumbnails');

        for (let i = 0; i < workspaceManager.n_workspaces; i++) {
            let indicator = null;

            const showAllIndicators = this._wsmPointerSelect || this._popupMode === wsPopupMode.ALL;

            if (i === this._activeWorkspaceIndex)
                indicator = new St.Bin({ style_class: 'ws-switcher-active' });
            // TODO single ws indicator needs to be handled in the container class, disabled for now
            else if (showAllIndicators)
                indicator = new St.Bin({ style_class: 'ws-switcher-box' });

            if (indicator) {
                // we need to know wsIndex of active box in single ws mode
                indicator._wsIndex = i;
                indicator.reactive = true;
                indicator.track_hover = true;
                this._list.add_child(indicator);
            }
        }
        this._setCustomStyle();
        this._addLabels();

        if (this._wsmPointerSelect)
            _wsmAttachPointerSelectHandlers(this);
    },

    _resetTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._wsmPointerSelect && _wsmPointerSessionPersistsUntilClick())
            return;
        if (this._displayTimeout)
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._displayTimeout, this._onTimeout.bind(this));
    },

    _onTimeout() {
        if (this._wsmPointerSelect && _wsmPointerSessionPersistsUntilClick()) {
            this._timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        // if user holds any modifier key, don't hide the popup and wait until they release the keys
        if (this._modifiersCancelTimeout) {
            const mods = global.get_pointer()[2];
            if (mods & 77)
                return GLib.SOURCE_CONTINUE;
        }

        this._container.ease({
            opacity: 0.0,
            duration: this._fadeOutTime,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.destroy(),
        });

        this._timeoutId = 0;
        return GLib.SOURCE_REMOVE;
    },

    _onDestroy() {
        _wsmDestroyPointerDebugOverlay(this);
        _wsmPopPointerModal(this);
        _wsmDisconnectPointerSelectHandlers(this);
        _wsmUnbindEsc(this);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._wsmThumbDeferTickId) {
            GLib.source_remove(this._wsmThumbDeferTickId);
            this._wsmThumbDeferTickId = 0;
        }

        let workspaceManager = global.workspace_manager;
        for (let i = 0; i < this._workspaceManagerSignals.length; i++)
            workspaceManager.disconnect(this._workspaceManagerSignals[i]);

        this._workspaceManagerSignals = [];
        this._wsNamesSettings = null;
        this._widget.destroy();
        this._widget = null;

        if (Meta.enable_unredirect_for_display)
            Meta.enable_unredirect_for_display(global.display);
        else // new in GS 48
            global.compositor.enable_unredirect();
    },

    _setCustomStyle() {
        if (this._contRadius === undefined) {
            const contRadius = this._container.get_theme_node().get_length('border-radius');
            // this._contRadius = Math.min(Math.max(Math.floor(contRadius * this._popScale), 3), contRadius);
            this._contRadius = Math.max(Math.floor(contRadius * this._radiusScale), 3);
            let contPadding = this._widget.get_theme_node().get_length('padding') || 10;
            contPadding = Math.max(contPadding * this._popScale, 2);
            this._contPadding = Math.floor(contPadding * this._paddingScale);
            this._container.set_style(`padding: ${this._contPadding}px;
                                           border-radius: ${this._contRadius}px;
                                           background-color: ${this._bgColor};
                                           border-color: ${this._borderColor};`
            );
        }

        const children = this._list.get_children();
        const thumbTiles = opt.get('popupWorkspaceThumbnails');
        for (let i = 0; i < children.length; i++) {
            if (this._boxRadius === undefined) {
                const theme = children[i].get_theme_node();
                const boxRadius = theme.get_length('border-radius');
                this._boxRadius = Math.max(Math.floor(boxRadius * this._radiusScale), 3);
                this._boxHeight = Math.floor(theme.get_height() * this._popScale);
                this._boxBgSize = Math.floor(theme.get_length('background-size') * this._popScale);
            }
            const borderChrome = thumbTiles
                ? 'border: none; border-width: 0px; outline: none;'
                : '';
            if (i === this._activeWorkspaceIndex || this._popupMode) { // 0 all ws 1 single ws 2,3 will never get to here
                children[i].set_style(` background-size: ${this._boxBgSize}px;
                                        border-radius: ${this._boxRadius}px;
                                        color: ${this._activeFgColor};
                                        background-color: ${this._activeBgColor};
                                        border-color: ${this._activeBgColor};
                                        box-shadow: none;
                                        ${borderChrome}`
                );
            } else {
                children[i].set_style(` background-size: ${this._boxBgSize}px;
                                        border-radius: ${this._boxRadius}px;
                                        color: ${this._inactiveFgColor};
                                        background-color: ${this._inactiveBgColor};
                                        border-color: ${this._borderColor};
                                        ${borderChrome}`
                );
            }
        }
    },

    _addLabels() {
        const children = this._list.get_children();
        const thumbsEnabled = opt.get('popupWorkspaceThumbnails');
        const list = this._list;
        /* Until WorkspaceSwitcherPopupList has allocated tile sizes, thumbnails would be ~28px tall and bins (~52px CSS) clip them away */
        const layoutReady = list._childWidth > 0 && list._childHeight > 0;

        _wsmDiagLog(`_addLabels thumbsEnabled=${thumbsEnabled} layoutReady=${layoutReady} tiles=${children.length} ` +
            `fit=${list._fitToScreenScale} childW=${list._childWidth} childH=${list._childHeight} boxH=${this._boxHeight}`);

        if (thumbsEnabled && !layoutReady) {
            for (let i = 0; i < children.length; i++) {
                const labelBox = this._getCustomLabel(children[i]._wsIndex);
                if (labelBox) {
                    children[i].set_child(labelBox);
                    _wsmMarkSubtreeNonReactive(labelBox);
                }
            }
            if (!this._wsmThumbDeferTickId) {
                this._wsmThumbDeferTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
                    this._wsmThumbDeferTickId = 0;
                    if (Main.wm._workspaceSwitcherPopup === this && opt.get('popupWorkspaceThumbnails'))
                        this._addLabels();
                    return GLib.SOURCE_REMOVE;
                });
                GLib.Source.set_name_by_id(this._wsmThumbDeferTickId, '[WSM] thumbnails wait for tile allocation');
            }
            return;
        }

        for (let i = 0; i < children.length; i++) {
            const wsIdx = children[i]._wsIndex;
            const labelBox = this._getCustomLabel(wsIdx);

            if (!thumbsEnabled) {
                if (labelBox) {
                    children[i].set_child(labelBox);
                    /* Labels stay non-reactive so picking hits the St.Bin tile (CSS :hover on
                       .ws-switcher-*). Reactive children would steal hover with no matching styles.
                       Pointer-select relies on modal + reactive fullscreen widget to absorb clicks
                       outside tiles, not on reactive labels. */
                    _wsmMarkSubtreeNonReactive(labelBox);
                }
                continue;
            }

            const [thumbW, thumbH] = this._getThumbnailClipDimensions(wsIdx);
            const thumbClip = this._createWorkspaceThumbnailClip(wsIdx, thumbW, thumbH);

            if (!thumbClip && !labelBox)
                continue;

            const root = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.START,
            });
            const [padTop, gapLbl, padBot] = _wsmThumbCardVerticalInsets();
            root.margin_top = padTop;
            root.margin_bottom = padBot;
            if (thumbClip)
                root.add_child(thumbClip);
            if (labelBox) {
                if (thumbClip)
                    labelBox.margin_top = gapLbl;
                root.add_child(labelBox);
            }

            children[i].set_child(root);
            _wsmMarkSubtreeNonReactive(root);
        }
    },

    _getThumbnailClipDimensions(wsIndex) {
        const ws = global.workspace_manager.get_workspace_by_index(wsIndex);
        const fallbackMon = this._monitorOption === 0
            ? Main.layoutManager.primaryIndex
            : global.display.get_current_monitor();
        const monIdx = ws ? _wsmPickMonitorIndexForThumbnail(ws, fallbackMon) : fallbackMon;
        const wa = Main.layoutManager.getWorkAreaForMonitor(monIdx);

        const list = this._list;
        let tileW = list._childWidth;
        let tileH = list._childHeight;

        if (!tileW || !tileH) {
            const geoAspect = wa.width / wa.height * (opt.get('popupWidthScale') / 100);
            const bh = this._boxHeight || Math.round(80 * this._popScale);
            tileH = bh;
            tileW = Math.round(bh * geoAspect);
        }

        /* Full tile width; height matches work-area aspect (same for every workspace on this monitor). */
        const innerW = Math.max(32, Math.floor(tileW));
        const thumbH = Math.round(innerW * wa.height / wa.width);

        return [innerW, thumbH];
    },

    _createWorkspaceThumbnailClip(wsIndex, thumbW, thumbH) {
        const ws = global.workspace_manager.get_workspace_by_index(wsIndex);
        if (!ws)
            return null;

        const fallbackMon = this._monitorOption === 0
            ? Main.layoutManager.primaryIndex
            : global.display.get_current_monitor();
        const monIdx = _wsmPickMonitorIndexForThumbnail(ws, fallbackMon);

        const thumbnail = new WorkspaceThumbnail(ws, monIdx);
        _wsmThumbnailPresentationHints(thumbnail);

        const wa = Main.layoutManager.getWorkAreaForMonitor(monIdx);
        const scale = Math.min(thumbW / wa.width, thumbH / wa.height);

        /* Same as overview ThumbnailsBox: scale the internal viewport, not the root actor. */
        thumbnail.setScale(scale, scale);

        const dispW = Math.round(wa.width * scale);
        const dispH = Math.round(wa.height * scale);
        const ox = Math.floor((thumbW - dispW) / 2);
        const oy = Math.floor((thumbH - dispH) / 2);

        thumbnail.opacity = 255;
        thumbnail.show();

        try {
            thumbnail.syncStacking(_wsmBuildWindowStackIndices());
        } catch (e) {
            log(`[WSM-thumb] syncStacking: ${e?.message ?? e}`);
        }

        const nClones = thumbnail._windows?.length ?? 0;
        _wsmThumbJournal(`ws=${wsIndex} mon=${monIdx} wa=${wa.width}x${wa.height} thumb=${thumbW}x${thumbH} scale=${scale.toFixed(4)} clones=${nClones}`);

        const clip = new WorkspaceSwitcherManagerThumbnailClip();
        _wsmThumbnailPresentationHints(clip);

        const inner = new Clutter.ActorBox();
        inner.x1 = ox;
        inner.y1 = oy;
        inner.x2 = ox + dispW;
        inner.y2 = oy + dispH;
        clip.setThumbnailInnerBox(inner);

        clip.set_size(thumbW, thumbH);
        clip.add_child(thumbnail);
        clip.show();

        const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!thumbnail.get_stage())
                return GLib.SOURCE_REMOVE;
            try {
                thumbnail.syncStacking(_wsmBuildWindowStackIndices());
            } catch (e) {
                log(`[WSM-thumb] idle syncStacking: ${e?.message ?? e}`);
            }
            clip.queue_relayout();
            thumbnail.queue_redraw();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(idleId, '[WSM] thumbnail idle refresh');

        return clip;
    },

    _setSpacing() {
        let spacing;
        if (!this._list._listSpacing) {
            spacing = Math.floor(10 * this._popScale);
            this._list._listSpacing = Math.floor(spacing * this._spacingScale);
        }
    },

    _setPopupPosition() {
        let workArea;
        if (this._monitorOption === 0)
            workArea = global.display.get_monitor_geometry(Main.layoutManager.primaryIndex);
        else
            workArea = global.display.get_monitor_geometry(global.display.get_current_monitor());


        let [, natHeight] = this._container.get_preferred_height(global.screen_width);
        let [, natWidth] = this._container.get_preferred_width(natHeight);
        let h = this._horizontalPosition;
        let v = this._verticalPosition;
        this._widget.x = workArea.x + Math.floor((workArea.width - natWidth) * h);
        this._widget.y = workArea.y + Math.floor((workArea.height - natHeight) * v);
    },

    _getWsNamesSettings() {
        if (!this._wsNamesSettings) {
            this._wsNamesSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.wm.preferences',
            });
        }
        return this._wsNamesSettings;
    },

    _getCustomLabel(wsIndex) {
        let labelBox = null;
        let textLabel = null;
        let indexLabel = null;
        let titleLabel = null;
        let text = '';
        const textShadowStyle = 'text-shadow: +1px -1px 4px rgb(200, 200, 200);';

        const wsIndexIsActiveWS = wsIndex === this._activeWorkspaceIndex;

        const showIndex = wsIndexIsActiveWS ? this._activeShowWsIndex  : this._inactiveShowWsIndex;
        const showName  = wsIndexIsActiveWS ? this._activeShowWsName   : this._inactiveShowWsName;
        const showApp   = wsIndexIsActiveWS ? this._activeShowAppName  : this._inactiveShowAppName;
        const showTitle = wsIndexIsActiveWS ? this._activeShowWinTitle : this._inactiveShowWinTitle;

        if (!(showIndex || showName || showApp || showTitle))
            return null;

        const thumbLabels = opt.get('popupWorkspaceThumbnails');
        const labelFsBoost = thumbLabels ? 1.48 : 1;
        const labelFit = _wsmEffectiveFontFit(this._list);
        const padScale = opt.get('popupLabelPaddingScale') / 100;
        const hPadEm = 0.5 * padScale;

        if (showIndex) {
            const text = `${wsIndex + 1}`;
            const fontSize = this._popScale * this._indexScale * labelFit * labelFsBoost;
            indexLabel = new St.Label({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `text-align: center;
                        font-size: ${fontSize}em;
                        ${this._textBold ? 'font-weight: bold;' : ''}
                        ${this._textShadow ? textShadowStyle : ''}
                        padding: 2px;
                        padding-left: ${hPadEm}em;
                        padding-right: ${hPadEm}em`,
                text,
            });
        }

        if (showName) {
            const name = this._getWsName(wsIndex);
            if (name) {
                if (text)
                    text += '\n';

                text += name;
            }
        }

        if (showApp) {
            const appName = this._getWsAppName(wsIndex);
            if (appName) {
                if (text)
                    text += '\n';

                text += appName;
            }
        }

        if (showTitle) {
            const winTitle = this._getWinTitle(wsIndex);
            const fontSize = this._popScale * this._fontScale * 0.8 * labelFit * labelFsBoost;
            if (winTitle && !text.split('\n').includes(winTitle)) {
                titleLabel = new St.Label({
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `text-align: center;
                            font-size: ${fontSize}em;
                            ${this._textBold ? 'font-weight: bold;' : ''}
                            ${this._textShadow ? textShadowStyle : ''}
                            padding-top: 0.3em;
                            padding-left: ${hPadEm}em;
                            padding-right: ${hPadEm}em`,
                    text: winTitle,
                });
            }
        }

        let fontSize = this._popScale * this._fontScale * labelFit * labelFsBoost;
        // if text is ordered but not delivered (no app name, no ws name) but ws index will be shown,
        // add an empty line to avoid index jumping during switching (at least when app name wrapping is disabled)
        if (this._popupMode === wsPopupMode.ACTIVE && (showName || showApp || showTitle) && showIndex && !text)
            text = ' ';

        if (text) {
            textLabel = new St.Label({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `text-align: center;
                        font-size: ${fontSize}em;
                        ${this._textBold ? 'font-weight: bold;' : ''}
                        ${this._textShadow ? textShadowStyle : ''}
                        padding-top: 0.3em;
                        padding-left: ${hPadEm}em;
                        padding-right: ${hPadEm}em`,
                text,
            });
        }

        if (indexLabel || textLabel || titleLabel) {
            labelBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                vertical: true,
            });
        }
        if (indexLabel)
            labelBox.add_child(indexLabel);

        if (textLabel)
            labelBox.add_child(textLabel);


        if (titleLabel)
            labelBox.add_child(titleLabel);


        return labelBox;
    },

    _getWsName(wsIndex) {
        if (!this._wsNames) {
            const settings = this._getWsNamesSettings();
            this._wsNames = settings.get_strv('workspace-names');
        }

        if (this._wsNames.length > wsIndex)
            return this._wsNames[wsIndex];

        return null;
    },

    _getWindows(workspace, modals = false) {
        // We ignore skip-taskbar windows in switchers, but if they are attached
        // to their parent, their position in the MRU list may be more appropriate
        // than the parent; so start with the complete list ...
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL,
            workspace);
        // ... map windows to their parent where appropriate, or leave it if the user wants to list modal windows too...
        return windows.map(w => {
            return w.is_attached_dialog() && !modals ? w.get_transient_for() : w;
        // ... and filter out skip-taskbar windows and duplicates
        // ... (if modal windows (attached_dialogs) haven't been removed in map function, leave them in the list)
        }).filter((w, i, a) => (!w.skip_taskbar && a.indexOf(w) === i) || w.is_attached_dialog());
    },

    _getCurrentWsWin(wsIndex) {
        const ws = global.workspace_manager.get_workspace_by_index(wsIndex);
        let wins = this._getWindows(null);

        wins = wins.filter(w => w.get_workspace() === ws);

        if (this._workspacesOnPrimaryOnly) {
            const monitor = Main.layoutManager.primaryIndex;
            wins = wins.filter(w => w.get_monitor() === monitor);
        }

        if (wins.length > 0)
            return wins[0];
        else
            return null;
    },

    _getWsAppName(wsIndex) {
        const win = this._getCurrentWsWin(wsIndex);

        let appName = null;
        if (win) {
            appName = _getWindowApp(win).get_name();
            // wrap app names
            if (this._wrapAppNames)
                appName = appName.replace(' ', '\n');
        }

        return appName;
    },


    _getWinTitle(wsIndex) {
        const win = this._getCurrentWsWin(wsIndex);
        let title = null;
        if (win)
            title = win.get_title();


        return title;
    },
};// );

/**
 * Shell Overview scales WorkspaceThumbnail via setScale() then thumbnail.allocate() from the
 * parent vfunc_allocate. Clutter.Clone textures need a real allocation; root set_scale() without
 * that pass keeps tiles grey despite nonzero clone counts in logs.
 */
const WorkspaceSwitcherManagerThumbnailClip = GObject.registerClass({
    GTypeName: 'WorkspaceSwitcherManagerThumbnailClip',
}, class WorkspaceSwitcherManagerThumbnailClip extends St.Widget {
    _init() {
        super._init({
            clip_to_allocation: true,
            style_class: 'wsm-workspace-thumbnail-clip',
        });
        this._innerBox = null;
    }

    setThumbnailInnerBox(actorBox) {
        this._innerBox = actorBox;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.get_first_child();
        if (!child || !this._innerBox)
            return;
        const themeNode = this.get_theme_node();
        const content = themeNode.get_content_box(box);
        const ib = this._innerBox;
        const cb = new Clutter.ActorBox();
        cb.x1 = content.x1 + ib.x1;
        cb.y1 = content.y1 + ib.y1;
        cb.x2 = content.x1 + ib.x2;
        cb.y2 = content.y1 + ib.y2;
        child.allocate(cb);
    }
});

const WorkspaceSwitcherPopupList = GObject.registerClass(
class WorkspaceSwitcherPopupList extends St.Widget {
    _init() {
        super._init({
            style_class: 'workspace-switcher-custom',
            // this parameter causes error: g_value_get_enum: assertion 'G_VALUE_HOLDS_ENUM (value)' failed
            // not in the original popup class, which has exactly the same super._init() call
            /* offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,*/
        });
        this._itemSpacing = 0;
        this._childHeight = 0;
        this._childWidth = 0;
        this._fitToScreenScale = 1;
        let orientation = global.workspace_manager.layout_rows === -1;
        if (opt.get('reversePopupOrientation'))
            orientation = !orientation;
        this._orientation = orientation
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;

        this.connect('style-changed', () => {
            this._itemSpacing = this._listSpacing;
            if (!this._itemSpacing)
                this._itemSpacing = this.get_theme_node().get_length('spacing');
        });
    }

    _getPreferredSizeForOrientation(_forSize) {
        let workArea = _wsmWorkAreaForPopupSizing();
        let themeNode = this.get_theme_node();

        let availSize;
        if (this._orientation === Clutter.Orientation.HORIZONTAL)
            availSize = workArea.width - themeNode.get_horizontal_padding();
        else
            availSize = workArea.height - themeNode.get_vertical_padding();

        const cw = opt.get('popupWidthScale') / 100;

        let size = 0;
        for (let child of this.get_children()) {
            let [, childNaturalHeight] = child.get_preferred_height(-1);
            let height = childNaturalHeight * workArea.width / workArea.height * this._popScale;

            if (this._orientation === Clutter.Orientation.HORIZONTAL) // width scale option application
                size += height * workArea.width / workArea.height * cw;
            else
                size += height;
        }

        let workspaceManager = global.workspace_manager;
        let spacing = this._itemSpacing * (this._popupMode !== wsPopupMode.ALL ? 0 : workspaceManager.n_workspaces - 1);
        size += spacing;

        // note info about downsizing the popup to calculate proper content size
        this._fitToScreenScale = size > availSize ? availSize / size : 1;

        size = Math.min(size, availSize);

        if (this._orientation === Clutter.Orientation.HORIZONTAL) {
            this._childWidth = (size - spacing) / (this._popupMode !== wsPopupMode.ALL ? 1 : workspaceManager.n_workspaces);
            return themeNode.adjust_preferred_width(size, size);
        } else {
            this._childHeight = (size - spacing) / (this._popupMode !== wsPopupMode.ALL ? 1 : workspaceManager.n_workspaces);
            return themeNode.adjust_preferred_height(size, size);
        }
    }

    _getSizeForOppositeOrientation() {
        let workArea = _wsmWorkAreaForPopupSizing();
        const thumbs = this.has_style_class_name('wsm-popup-workspace-thumbnails');
        const minSide = Math.round(WSM_THUMB_TILE_MIN_PX * (this._popScale ?? 1));
        const cw = opt.get('popupWidthScale') / 100;
        const ch = Math.max(0.18, opt.get('popupHeightScale') / 100);

        if (this._orientation === Clutter.Orientation.HORIZONTAL) {
            let h;
            if (thumbs) {
                const waMon = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                const [padTop, gap, padBot] = _wsmThumbCardVerticalInsets();
                const thumbH = this._childWidth * waMon.height / waMon.width;
                const contentMin = padTop + thumbH + gap + WSM_THUMB_LABEL_RESERVE_PX + padBot;
                const baseAspect = Math.round(this._childWidth * workArea.height / workArea.width / cw);
                h = Math.max(baseAspect, Math.ceil(contentMin), minSide);
            } else {
                h = Math.round(this._childWidth * workArea.height / workArea.width / cw / ch);
            }
            this._childHeight = h;
            return [this._childHeight, this._childHeight];
        } else {
            let w = Math.round(this._childHeight * workArea.width / workArea.height * cw / ch);
            if (thumbs) {
                const waMon = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                const [padTop, gap, padBot] = _wsmThumbCardVerticalInsets();
                const thumbH = w * waMon.height / waMon.width;
                const needH = padTop + thumbH + gap + WSM_THUMB_LABEL_RESERVE_PX + padBot;
                if (needH > this._childHeight) {
                    const inner = this._childHeight - padTop - gap - WSM_THUMB_LABEL_RESERVE_PX - padBot;
                    const wMax = inner * waMon.width / waMon.height;
                    w = Math.min(w, Math.floor(wMax));
                }
                w = Math.max(w, minSide);
            }
            this._childWidth = w;
            return [this._childWidth, this._childWidth];
        }
    }

    vfunc_get_preferred_height(forWidth) {
        if (this._orientation === Clutter.Orientation.HORIZONTAL)
            return this._getSizeForOppositeOrientation();
        else
            return this._getPreferredSizeForOrientation(forWidth);
    }

    vfunc_get_preferred_width(forHeight) {
        if (this._orientation === Clutter.Orientation.HORIZONTAL)
            return this._getPreferredSizeForOrientation(forHeight);
        else
            return this._getSizeForOppositeOrientation();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        let themeNode = this.get_theme_node();
        box = themeNode.get_content_box(box);

        let childBox = new Clutter.ActorBox();

        let rtl = this.text_direction === Clutter.TextDirection.RTL;
        let x = rtl ? box.x2 - this._childWidth : box.x1;
        let y = box.y1;
        for (let child of this.get_children()) {
            childBox.x1 = Math.round(x);
            childBox.x2 = Math.round(x + this._childWidth);
            childBox.y1 = Math.round(y);
            childBox.y2 = Math.round(y + this._childHeight);

            if (this._orientation === Clutter.Orientation.HORIZONTAL) {
                if (rtl)
                    x -= this._childWidth + this._itemSpacing;
                else
                    x += this._childWidth + this._itemSpacing;
            } else {
                y += this._childHeight + this._itemSpacing;
            }
            child.allocate(childBox);
        }
    }
});

const WorkspaceSwitcherPopupDefault = {
    after__init() {
        this._wsmPointerSelect = globalThis._wsmPointerSelectOpening === true;
        this._popupDisabled = !opt.get('popupVisibility');
        // if popup disabled don't allocate more resources (unless pointer-select session forces UI)
        if (this._popupDisabled && !this._wsmPointerSelect)
            return;

        this.remove_constraint(this.get_constraints()[0]);
        this._monitorOption = opt.get('monitor');
        this._workspacesOnPrimaryOnly = opt.get('workspacesOnPrimaryOnly');

        this._horizontalPosition = opt.get('popupHorizontal') / 100;
        this._verticalPosition = opt.get('popupVertical') / 100;
        this._modifiersCancelTimeout = opt.get('modifiersHidePopup');
        this._fadeOutTime = opt.get('fadeOutTime');
        this._displayTimeout = opt.get('popupTimeout');
        this._list.set_style('margin: 0;');
        this._redisplay();

        const vertical = global.workspace_manager.layout_rows === -1;
        this._list.vertical = vertical;
        if (opt.get('reversePopupOrientation'))
            this._list.vertical =  !this._list.vertical;

        if (this._list.vertical)
            this._list.add_style_class_name('ws-switcher-vertical');

        this.connect('destroy', () => {
            _wsmDestroyPointerDebugOverlay(this);
            _wsmPopPointerModal(this);
        });
    },

    after__redisplay() {
        if (this._list) {
            for (const child of this._list.get_children()) {
                child.reactive = true;
                child.track_hover = true;
            }
        }
        if (this._wsmPointerSelect && this._list)
            _wsmAttachPointerSelectHandlers(this);
    },

    _setPopupPosition() {
        let workArea;
        if (this._monitorOption === 0)
            workArea = global.display.get_monitor_geometry(Main.layoutManager.primaryIndex);
        else
            workArea = global.display.get_monitor_geometry(global.display.get_current_monitor());


        let [, natHeight] = this.get_preferred_height(global.screen_width);
        let [, natWidth] = this.get_preferred_width(natHeight);
        let h = this._horizontalPosition;
        let v = this._verticalPosition;
        this.x = workArea.x + Math.floor((workArea.width - natWidth) * h);
        this.y = workArea.y + Math.floor((workArea.height - natHeight) * v);
    },

    display(activeWorkspaceIndex) {
        if (this._popupDisabled && !this._wsmPointerSelect) {
            // in this case the popup object will stay in Main.wm._workspaceSwitcherPopup
            // and wil not be recreated each time as there is no content to update
            return;
        }

        this._activeWorkspaceIndex = activeWorkspaceIndex;

        if (this._wsmPointerSelect && this._list)
            this._list._popupMode = wsPopupMode.ALL;

        this._redisplay();
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (!(this._wsmPointerSelect && _wsmPointerSessionPersistsUntilClick())) {
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._displayTimeout, this._onTimeout.bind(this));
            GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._onTimeout');
        }

        const duration = this.visible ? 0 : 100;
        this.show();
        this.opacity = 0;
        this.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._setPopupPosition();

        if (this._wsmPointerSelect) {
            this.reactive = true;
            _wsmBindEscToClose(this);
            _wsmPushPointerModal(this);
            _wsmAttachPointerDebugOverlay(this);
        }
    },

    _onTimeout() {
        if (this._wsmPointerSelect && _wsmPointerSessionPersistsUntilClick()) {
            this._timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        // if user holds any modifier key, don't hide the popup and wait until they release the keys
        if (this._modifiersCancelTimeout) {
            const mods = global.get_pointer()[2];
            if (mods & 77)
                return GLib.SOURCE_CONTINUE;
        }

        this.ease({
            opacity: 0,
            duration: this._fadeOutTime,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.destroy(),
        });

        this._timeoutId = 0;
        return GLib.SOURCE_REMOVE;
    },

    _resetTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._wsmPointerSelect && _wsmPointerSessionPersistsUntilClick())
            return;
        if (this._displayTimeout)
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._displayTimeout, this._onTimeout.bind(this));
    },
};
