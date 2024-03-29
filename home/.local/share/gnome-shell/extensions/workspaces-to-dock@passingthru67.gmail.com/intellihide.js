/* ========================================================================================================
 * intellihide.js - intellihide functions
 * --------------------------------------------------------------------------------------------------------
 *  CREDITS:  This code was copied from the dash-to-dock extension https://github.com/micheleg/dash-to-dock
 *  and modified to create a workspaces dock. Many thanks to michele_g for a great extension.
 * ========================================================================================================
 */


const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const Gdk = imports.gi.Gdk;
const St = imports.gi.St;

const Main = imports.ui.main;
const GrabHelper = imports.ui.grabHelper;
const Config = imports.misc.config;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const handledWindowTypes = [
    Meta.WindowType.NORMAL,
    // Meta.WindowType.DESKTOP,    // skip nautilus dekstop window
    // Meta.WindowType.DOCK,       // skip other docks
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN
];

const handledWindowTypes2 = [
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.TOOLTIP
];

const OverviewOption = {
    SHOW: 0,        // Dock is always visible
    HIDE: 1,        // Dock is always invisible. Visible on mouse hover
    PARTIAL: 2      // Dock partially hidden. Visible on mouse hover
};

let GSFunctions = {};


/*
 * A rough and ugly implementation of the intellihide behaviour.
 * Intellihide object: call show()/hide() function based on the overlap with the
 * the dock staticBox object;
 *
 * Dock object has to contain a Clutter.ActorBox object named staticBox and
 * emit a 'box-changed' signal when this changes.
 *
*/

const Intellihide = new Lang.Class({
    Name: 'workspacesToDock.intellihide',

    _init: function(dock) {
        this._gsCurrentVersion = Config.PACKAGE_VERSION.split('.');
        this._settings = Convenience.getSettings('org.gnome.shell.extensions.workspaces-to-dock');
        this._signalHandler = new Convenience.globalSignalHandler();

        // Dock object
        this._dock = dock;

        // temporarily disable intellihide until initialized (prevents connected signals from trying to update dock visibility)
        this._disableIntellihide = true;

        // Override Gnome Shell functions
        this._overrideGnomeShellFunctions();

        // Load settings
        this._bindSettingsChanges();

        this._tracker = Shell.WindowTracker.get_default();
        this._topWindow = null;
        this._focusedWin = null;

        // initial intellihide status is null
        this.status = null;

        // Keep track of the current overview mode (I mean if it is on/off)
        this._inOverview = false;

        // Flag set when overview mode is toggled by window drag event
        this._toggledOverviewOnDrag = false;

        // Main id of the timeout controlling timeout for updateDockVisibility function
        // when windows are dragged around (move and resize)
        this._windowChangedTimeout = 0;

        // Quick show timeout
        this._switchWorkspaceQuickShow = this._settings.get_boolean('quick-show-on-workspace-change');
        this._quickShowTimeoutId = 0;

        // Connect global signals
        this._signalHandler.push(
            // call updateVisibility when dock actor changes
            [
                this._dock,
                'box-changed',
                Lang.bind(this, this._onDockSettingsChanged)
            ],
            // Add timeout when window grab-operation begins and remove it when it ends.
            // These signals only exist starting from Gnome-Shell 3.4
            [
                global.display,
                'grab-op-begin',
                Lang.bind(this, this._grabOpBegin)
            ],
            [
                global.display,
                'grab-op-end',
                Lang.bind(this, this._grabOpEnd)
            ],
            // direct maximize/unmazimize are not included in grab-operations
            [
                global.window_manager,
                'unminimize',
                Lang.bind(this, this._onWindowUnminimized)
            ],
            [
                global.window_manager,
                'minimize',
                Lang.bind(this, this._onWindowMinimized)
            ],
            [
                global.window_manager,
                'size-change',
                Lang.bind(this, this._onWindowSizeChange)
            ],
            // Probably this is also included in restacked?
            [
                global.window_manager,
                'switch-workspace',
                Lang.bind(this, this._switchWorkspace)
            ],
            // trigggered for instance when a window is closed.
            [
                global.screen,
                'restacked',
                Lang.bind(this, this._onScreenRestacked)
            ],
            // when windows are alwasy on top, the focus window can change
            // without the windows being restacked. Thus monitor window focus change.
            [
                this._tracker,
                'notify::focus-app',
                Lang.bind(this, this._onFocusAppChanged)
            ],
            // Set visibility in overview mode
            [
                Main.overview,
                'showing',
                Lang.bind(this, this._overviewEnter)
            ],
            [
                Main.overview,
                'hiding',
                Lang.bind(this,this._overviewExit)
            ],
            // window-drag-events emitted from workspaces thumbnail window dragging action
            [
                Main.overview,
                'window-drag-begin',
                Lang.bind(this,this._onWindowDragBegin)
            ],
            [
                Main.overview,
                'window-drag-cancelled',
                Lang.bind(this,this._onWindowDragCancelled)
            ],
            [
                Main.overview,
                'window-drag-end',
                Lang.bind(this,this._onWindowDragEnd)
            ],
            // item-drag-events emitted from app display icon dragging action
            [
                Main.overview,
                'item-drag-begin',
                Lang.bind(this,this._onItemDragBegin)
            ],
            [
                Main.overview,
                'item-drag-cancelled',
                Lang.bind(this,this._onItemDragCancelled)
            ],
            [
                Main.overview,
                'item-drag-end',
                Lang.bind(this,this._onItemDragEnd)
            ],
            // update when monitor changes, for instance in multimonitor when monitors are attached
            [
                Main.layoutManager,
                'monitors-changed',
                Lang.bind(this, this._onMonitorsChanged)
            ],
            [
                Main.panel.menuManager._grabHelper,
                'focus-grabbed',
                Lang.bind(this, this._onPanelFocusGrabbed)
            ],
            [
                Main.panel.menuManager._grabHelper,
                'focus-ungrabbed',
                Lang.bind(this, this._onPanelFocusUngrabbed)
            ],
            [
                Main.overview.viewSelector,
                'page-changed',
                Lang.bind(this, this._overviewPageChanged)
            ]
        );

        // if background manager valid, Connect grabHelper signals
        let primaryIndex = Main.layoutManager.primaryIndex;
        if (Main.layoutManager._bgManagers[primaryIndex]) {
            this._signalHandler.pushWithLabel(
                'bgManagerSignals',
                [
                    Main.layoutManager._bgManagers[primaryIndex].backgroundActor._backgroundManager._grabHelper,
                    'focus-grabbed',
                    Lang.bind(this, this._onPanelFocusGrabbed)
                ],
                [
                    Main.layoutManager._bgManagers[primaryIndex].backgroundActor._backgroundManager._grabHelper,
                    'focus-ungrabbed',
                    Lang.bind(this, this._onPanelFocusUngrabbed)
                ]
            );
        }

        // Start main loop and bind initialize function
        Mainloop.idle_add(Lang.bind(this, this._initialize));
    },

    _initialize: function() {
        // enable intellihide now
        this._disableIntellihide = false;

        // updte dock visibility
        this._updateDockVisibility();
    },

    destroy: function() {
        // Disconnect global signals
        this._signalHandler.disconnect();

        // Disconnect GSettings signals
        this._settings.run_dispose();

        if (this._windowChangedTimeout > 0)
            Mainloop.source_remove(this._windowChangedTimeout); // Just to be sure

        this._restoreGnomeShellFunctions();
    },

    // Called during init to override/extend gnome shell functions
    _overrideGnomeShellFunctions: function() {
        // Extend the GrabHelper grab function to emit a signal when focus is grabbed
        GSFunctions['GrabHelper_grab'] = GrabHelper.GrabHelper.prototype.grab;
        GrabHelper.GrabHelper.prototype.grab = function(params) {
            let ret = GSFunctions['GrabHelper_grab'].call(this, params);
            if (ret)
                this.emit('focus-grabbed');
            return ret;
        };
        // Extend the GrabHelper ungrab function to emit a signal when focus is ungrabbed
        GSFunctions['GrabHelper_ungrab'] = GrabHelper.GrabHelper.prototype.ungrab;
        GrabHelper.GrabHelper.prototype.ungrab = function(params) {
            let ret = GSFunctions['GrabHelper_ungrab'].call(this, params);
            this.emit('focus-ungrabbed');
            return ret;
        };
        Signals.addSignalMethods(GrabHelper.GrabHelper.prototype);
    },

    // main function called during destroy to restore gnome shell functions
    _restoreGnomeShellFunctions: function() {
        // Restore normal GrabHelper grab function
        GrabHelper.GrabHelper.prototype.grab = GSFunctions['GrabHelper_grab'];
        // Restore normal GrabHelper ungrab function
        GrabHelper.GrabHelper.prototype.ungrab = GSFunctions['GrabHelper_ungrab'];
    },

    // handler to bind settings when preferences changed
    _bindSettingsChanges: function() {
        this._settings.connect('changed::intellihide', Lang.bind(this, function() {
            this._updateDockVisibility();
        }));

        this._settings.connect('changed::intellihide-option', Lang.bind(this, function(){
            this._updateDockVisibility();
        }));

        this._settings.connect('changed::dock-fixed', Lang.bind(this, function() {
            if (this._settings.get_boolean('dock-fixed')) {
                this.status = true; // Since the dock is now shown
            } else {
                // Wait that windows rearrange after struts change
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._updateDockVisibility();
                    return false;
                }));
            }
        }));

        this._settings.connect('changed::quick-show-on-workspace-change', Lang.bind(this, function(){
            this._switchWorkspaceQuickShow = this._settings.get_boolean('quick-show-on-workspace-change');
            this._updateDockVisibility();
        }));

    },

    // handler for when dock size-position is changed
    _onDockSettingsChanged: function() {
        this._updateDockVisibility();
    },

    // handler for when window is unminimized
    _onWindowUnminimized: function() {
        this._updateDockVisibility();
    },

    // handler for when window is minimized
    _onWindowMinimized: function() {
        this._updateDockVisibility();
    },

    // handler for when window is resized
    _onWindowSizeChange: function() {
        this._updateDockVisibility();
    },

    // handler for when screen is restacked
    _onScreenRestacked: function() {
        this._updateDockVisibility();
    },

    // handler for when app focus changed
    _onFocusAppChanged: function() {
        this._updateDockVisibility();
    },

    // handler for when monitor changes
    _onMonitorsChanged: function() {
        // disconnect bgManager signals
        this._signalHandler.disconnectWithLabel('bgManagerSignals');

        // if background manager valid, Connect grabHelper signals
        let primaryIndex = Main.layoutManager.primaryIndex;

        if (!Main.layoutManager._bgManagers[primaryIndex] ||
            !Main.layoutManager._bgManagers[primaryIndex].backgroundActor)
                return;

        this._signalHandler.pushWithLabel(
            'bgManagerSignals',
            [
                Main.layoutManager._bgManagers[primaryIndex].backgroundActor._backgroundManager._grabHelper,
                'focus-grabbed',
                Lang.bind(this, this._onPanelFocusGrabbed)
            ],
            [
                Main.layoutManager._bgManagers[primaryIndex].backgroundActor._backgroundManager._grabHelper,
                'focus-ungrabbed',
                Lang.bind(this, this._onPanelFocusUngrabbed)
            ]
        );

        this._updateDockVisibility();
    },

    // handler for when thumbnail windows dragging started
    _onWindowDragBegin: function() {
        Main.overview.show();
        this._toggledOverviewOnDrag = true;
        this._show();
    },

    // handler for when thumbnail windows dragging cancelled
    _onWindowDragCancelled: function() {
        if (this._toggledOverviewOnDrag) {
            this._toggledOverviewOnDrag = false;
        }
    },

    // handler for when thumbnail windows dragging ended
    _onWindowDragEnd: function() {
    },

    // handler for when app icon dragging started
    _onItemDragBegin: function() {
        Main.overview.show();
        this._toggledOverviewOnDrag = true;
        this._show();
    },

    // handler for when app icon dragging cancelled
    _onItemDragCancelled: function() {
        if (this._toggledOverviewOnDrag) {
            this._toggledOverviewOnDrag = false;

            // Should we hide the dock?
            // GS38+ remains in same overview mode, therefore we need to detect mode to determine if we should hide dock.
            if (this._inOverview) {
                if (Main.overview.viewSelector._activePage != Main.overview.viewSelector._workspacesPage)
                    this._hide();
            }
        }
    },

    // handler for when app icon dragging ended
    _onItemDragEnd: function() {
        if (this._toggledOverviewOnDrag) {
            this._toggledOverviewOnDrag = false;

            // Should we hide the dock?
            // GS38+ remains in same overview mode, therefore we need to detect mode to determine if we should hide dock.
            if (this._inOverview) {
                if (Main.overview.viewSelector._activePage != Main.overview.viewSelector._workspacesPage)
                    this._hide();
            }
        }
    },

    // handler for when overview mode exited
    _overviewExit: function() {
        this._inOverview = false;
        this._updateDockVisibility();
    },

    // handler for when overview mode entered
    _overviewEnter: function() {
        this._inOverview = true;
        let overviewAction = this._settings.get_enum('overview-action');
        if (overviewAction == OverviewOption.SHOW) {
            if (Main.overview.viewSelector._activePage == Main.overview.viewSelector._workspacesPage) {
                this._show();
            } else {
                this._hide();
            }
        } else if (overviewAction == OverviewOption.HIDE) {
            this._hide();
        } else if (overviewAction == OverviewOption.PARTIAL) {
            this._hide();
        }
    },

    // handler for when Gnome Shell 3.6+ overview page is changed (GS36+)
    // for example, when Applications button is clicked the workspaces dock is hidden
    // or when search is started the workspaces dock is hidden
    _overviewPageChanged: function(source, page) {
        let newPage;
        if (page)
            newPage = page;
        else
            newPage = Main.overview.viewSelector._activePage;

        if (this._inOverview) {
            if (newPage == Main.overview.viewSelector._workspacesPage) {
                let overviewAction = this._settings.get_enum('overview-action');
                if (overviewAction == OverviewOption.SHOW) {
                    this._show();
                } else if (overviewAction == OverviewOption.HIDE) {
                    this._hide();
                } else if (overviewAction == OverviewOption.PARTIAL) {
                    this._hide();
                }
            } else {
                this._hide();
            }
        }
    },

    // handler for when panel focus is grabbed (GS 38+)
    _onPanelFocusGrabbed: function(source, event) {
        if (this._settings.get_boolean('ignore-top-panel')) return;
        let idx = source._grabStack.length - 1;
        let focusedActor = source._grabStack[idx].actor;
        let [rx, ry] = focusedActor.get_transformed_position();
        let [rw, rh] = focusedActor.get_size();
        let [dx, dy] = this._dock.actor.get_position();
        let [dcx, dcy] = this._dock._container.get_transformed_position();
        let [dw, dh] = this._dock.actor.get_size();
        let [dcw, dch] = this._dock._container.get_size();

        if (this._dock._isHorizontal) {
            dx = dcx;
            dw = dcw;
        } else {
            dy = dcy;
            dh = dch;
        }

        let test;
        if (this._dock._position == St.Side.LEFT || this._dock._position == St.Side.TOP) {
            test = (rx < dx + dw) && (rx + rw > dx) && (ry < dy + dh) && (ry + rh > dy);
        } else if (this._dock._position == St.Side.RIGHT) {
            test = (rx < dx) && (rx + rw > dx - dw) && (ry < dy + dh) && (ry + rh > dy);
        } else if (this._dock._position == St.Side.BOTTOM) {
            test = (rx < dx + dw) && (rx + rw > dx) && (ry + rh > dy - dh) && (ry < dy);
        }

        if (test) {
            this._disableIntellihide = true;
            this._hide();
        }
    },

    // handler for when panel focus is ungrabbed (GS 38+)
    _onPanelFocusUngrabbed: function(source, event) {
        if (this._settings.get_boolean('ignore-top-panel')) return;
        this._disableIntellihide = false;
        if (this._inOverview) {
            if (Main.overview.viewSelector._activePage == Main.overview.viewSelector._workspacesPage)
                this._show();
        } else {
            this._updateDockVisibility();
        }
    },

    // handler for when window move begins
    _grabOpBegin: function() {
        if (this._settings.get_boolean('intellihide')) {
            let INTERVAL = 100; // A good compromise between reactivity and efficiency; to be tuned.

            if (this._windowChangedTimeout > 0)
                Mainloop.source_remove(this._windowChangedTimeout); // Just to be sure

            this._windowChangedTimeout = Mainloop.timeout_add(INTERVAL,
                Lang.bind(this, function() {
                    this._updateDockVisibility();
                    return true; // to make the loop continue
                })
            );
        }
    },

    // handler for when window move ends
    _grabOpEnd: function() {
        if (this._settings.get_boolean('intellihide')) {
            if (this._windowChangedTimeout > 0)
                Mainloop.source_remove(this._windowChangedTimeout);

            this._windowChangedTimeout = 0
            this._updateDockVisibility();
        }
    },

    // handler for when workspace is switched
    _switchWorkspace: function(shellwm, from, to, direction) {

        // Reset quick show timeout
        this._switchedWorkspace = true;
        if (this._quickShowTimeoutId > 0)
            Mainloop.source_remove(this._quickShowTimeoutId);

        this._quickShowTimeoutId = 0;

        this._updateDockVisibility();
    },

    // intellihide function to show dock
    _show: function() {
        if (this._settings.get_boolean('dock-fixed')) {
            this._dock.fadeInDock(0, 0);
        } else {
            this._dock.disableAutoHide();
        }
        this.status = true;
    },

    // intellihide function to hide dock
    _hide: function(metaOverlap) {
        this.status = false;
        if (this._settings.get_boolean('dock-fixed')) {
            if (metaOverlap) {
                // meta popup overlap initiated this hide
                this._dock.fadeOutDock(0, 0, true);
            } else {
                // toppanel or messagetray or overview change initiated this hide
                this._dock.fadeOutDock(0, 0, false);
            }
        } else {
            this._dock.enableAutoHide();
        }
    },

    // Reset quick show timeout
    _quickShowExit: function() {
        this._switchedWorkspace = false;
        if (this._quickShowTimeoutId > 0)
            Mainloop.source_remove(this._quickShowTimeoutId);

        this._quickShowTimeoutId = 0;
        this._updateDockVisibility();
    },

    // intellihide function to determine if dock overlaps a window
    _updateDockVisibility: function() {
        if (this._disableIntellihide)
            return;

        // Return if we are in overview mode
        if (this._inOverview) {
            return;
        }

        //else in normal mode:
        else {
            if (this._settings.get_boolean('intellihide') || this._settings.get_boolean('dock-fixed')) {
                let overlaps = false;
                let windows = global.get_window_actors();

                if (windows.length > 0) {

                    // SANITY CHECK
                    //global.log("===============================================================");
                    //for (let i = windows.length-1; i >= 0; i--) {
                        //let win = windows[i].get_meta_window();
                        //let wclass = win.get_wm_class();
                        //let wtype = win.get_window_type();
                        //let wfocus = win.has_focus();
                        //let wapp = this._tracker.get_window_app(win);
                        //let msg = wclass + " [" + wtype + "] focused? " + wfocus + " wintype? " + wtype + " app? " + wapp;
                        //global.log(msg);
                    //}
                    //global.log("---------------------------------------------------------------");

                    // This is the default window on top of all others
                    this._topWindow = windows[windows.length-1].get_meta_window();

                    // Find focused window (not always top window)
                    for (let i = windows.length-1; i >= 0; i--) {
                        let win = windows[i].get_meta_window();
                        if (win.has_focus()) {
                            this._focusedWin = win;
                            break;
                        }
                    }

                    // If there isn't a focused app, use that of the window on top
                    //this._focusApp = this._tracker.focus_app || this._tracker.get_window_app(this._topWindow);

                    windows = windows.filter(this._intellihideFilterInteresting, this);

                    for (let i = 0; i < windows.length; i++) {
                        let win = windows[i].get_meta_window();
                        if (win) {
                            let rect = win.get_frame_rect();
                            let [dx, dy] = this._dock.actor.get_position();
                            let [dcx, dcy] = this._dock._container.get_transformed_position();
                            let [dw, dh] = this._dock.actor.get_size();
                            let [dcw, dch] = this._dock._container.get_size();

                            // SANITY CHECK
                            // global.log("dx="+dx+" dy="+dy+" || dcx="+Math.round(dcx)+" dcy="+dcy);
                            // global.log("dw="+dw+" dh="+dh+" || dcw="+dcw+" dch="+dch);

                            if (this._dock._isHorizontal) {
                                dx = dcx;
                                dw = dcw;
                            } else {
                                dy = dcy;
                                dh = dch;
                            }

                            let test;
                            if (this._dock._position == St.Side.LEFT || this._dock._position == St.Side.TOP) {
                                test = (rect.x < dx + dw) && (rect.x + rect.width > dx) && (rect.y < dy + dh) && (rect.y + rect.height > dy);
                            } else if (this._dock._position == St.Side.RIGHT) {
                                test = (rect.x < dx) && (rect.x + rect.width > dx - dw) && (rect.y < dy + dh) && (rect.y + rect.height > dy);
                            } else if (this._dock._position == St.Side.BOTTOM) {
                                test = (rect.x < dx + dw) && (rect.x + rect.width > dx) && (rect.y + rect.height > dy - dh) && (rect.y < dy);
                            }
                            if (test) {
                                overlaps = true;
                                break;
                            }
                        }
                    }
                }

                if (this._switchWorkspaceQuickShow && this._switchedWorkspace && this._quickShowTimeoutId == 0) {
                    this._show();
                    let timeout = this._settings.get_double('quick-show-timeout');
                    this._quickShowTimeoutId = Mainloop.timeout_add(timeout, Lang.bind(this, this._quickShowExit));
                } else {
                    if (this._quickShowTimeoutId == 0) {
                        if (overlaps) {
                            this._hide(true);
                        } else {
                            this._show();
                        }
                    }
                }
            } else {
                if (this._switchWorkspaceQuickShow && this._switchedWorkspace && this._quickShowTimeoutId == 0) {
                    this._show();
                    let timeout = this._settings.get_double('quick-show-timeout');
                    this._quickShowTimeoutId = Mainloop.timeout_add(timeout, Lang.bind(this, this._quickShowExit));
                } else {
                    if (this._quickShowTimeoutId == 0)
                        this._hide();
                }
            }
        }

    },

    // Filter interesting windows to be considered for intellihide.
    // Consider all windows visible on the current workspace.
    _intellihideFilterInteresting: function(wa, edge) {
        let currentWorkspace = global.screen.get_active_workspace_index();
        let meta_win = wa.get_meta_window();
        if (!meta_win) { //TODO michele: why? What does it mean?
            return false;
        }

        if (!this._handledWindowType(meta_win))
            return false;

        let wksp = meta_win.get_workspace();
        if (!wksp)
            return false;

        let wksp_index = wksp.index();

        // check intellihide-option for windows of focused app
        if (this._settings.get_int('intellihide-option') == 1) {

            // TEST1: ignore if meta_win is a popup window
            if (meta_win.get_window_type() != Meta.WindowType.POPUP_MENU) {
                // TEST2: ignore if meta_win is not same class as the focused window (not same app)
                if (this._focusedWin.get_wm_class() != meta_win.get_wm_class())
                    return false;
            }
        }

        // check intellihide-option for top-level windows of  focused app
        if (this._settings.get_int('intellihide-option') == 2) {

            // TEST1: ignore if meta_win is a popup window
            if (meta_win.get_window_type() != Meta.WindowType.POPUP_MENU) {

                // TEST2: ignore if meta_win is not same class as the focused window (not same app)
                if (this._focusedWin.get_wm_class() != meta_win.get_wm_class())
                    return false;

                // same app .. but is it top-level window?
                // TEST3: ignore if meta_win is not the focused window and both are normal windows
                if (this._focusedWin.get_window_type() == Meta.WindowType.NORMAL) {
                    if (meta_win.get_window_type() == Meta.WindowType.NORMAL) {
                        if (this._focusedWin != meta_win)
                            return false;
                    }
                }

                // TEST4: ignore if meta_win is tooltip but mouse pointer is not over focused window
                if (meta_win.get_window_type() == Meta.WindowType.TOOLTIP) {
                    let pointer = Gdk.Display.get_default().get_device_manager().get_client_pointer();
                    let [scr,x,y] = pointer.get_position();
                    let rect = this._focusedWin.get_frame_rect();
                    let overlap = ((x > rect.x) && (x < rect.x+rect.width) && (y > rect.y) && (y < rect.y+rect.height));
                    if (!overlap)
                        return false;
                }
            }
        }

        if (wksp_index == currentWorkspace && meta_win.showing_on_its_workspace()) {
            return true;
        } else {
            return false;
        }
    },

    // Filter windows by type
    // inspired by Opacify@gnome-shell.localdomain.pl
    _handledWindowType: function(metaWindow, grptype) {
        var wtype = metaWindow.get_window_type();

        if (grptype == null || grptype == 1) {
            if (!this._settings.get_boolean('dock-fixed')) {
                // Test primary window types .. only if dock is not fixed
                for (var i = 0; i < handledWindowTypes.length; i++) {
                    var hwtype = handledWindowTypes[i];
                    if (hwtype == wtype) {
                        return true;
                    }
                }
            }
        }

        if (grptype == null || grptype == 2) {
            // Test secondary window types .. even if dock is fixed
            for (var i = 0; i < handledWindowTypes2.length; i++) {
                var hwtype = handledWindowTypes2[i];
                if (hwtype == wtype) {
                    return true;
                }
            }
        }

        return false;
    }
});
