/* jshint esnext:true */
/*
 *
 *  GNOME Shell Extension for the great Taskwarrior application
 *  - Displays pending Tasks.
 *  - adding / modifieing tasks.
 *
 * Copyright (C) 2016
 *     Florijan Hamzic <florijanh@gmail.com>,
 *
 * This file is part of gnome-shell-extension-taskwhisperer.
 *
 * gnome-shell-extension-taskwhisperer is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * gnome-shell-extension-taskwhisperer is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gnome-shell-extension-taskwhisperer.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const Dialogs = Me.imports.dialogs;
const taskService = Me.imports.taskService;
const TaskService = taskService.TaskService;

const Config = imports.misc.config;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Shell = imports.gi.Shell;
const ShellEntry = imports.ui.shellEntry;
const St = imports.gi.St;
const Util = imports.misc.util;

const Gettext = imports.gettext.domain('gnome-shell-extension-taskwhisperer');
const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;

const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// Settings
const TASKWHISPERER_SETTINGS_SCHEMA = 'org.gnome.shell.extensions.taskwhisperer';
const TASKWHISPERER_DESKTOP_INTERFACE = 'org.gnome.desktop.interface';


const MenuPosition = {
    CENTER: 0,
    RIGHT : 1,
    LEFT  : 2
};


let _cachedData;
let _cacheExpirationTime;
let _cacheDurationInSeconds = 10;
let _refreshTaskDataTimeoutID = undefined;

let _isOpen = false;
let _lastTimeOpened;
let _hitScrollEvent = false;

let _currentSortID = taskService.SortOrder.DUE;
let _currentTaskType = taskService.TaskType.ACTIVE;
let _currentItems = [];
let _currentPage = 0;


const ScrollBox = new Lang.Class({
    Name   : 'ScrollBox',
    Extends: PopupMenu.PopupMenuBase,

    _init: function(menu, styleClass)
    {
        this.menu = menu;

        this.box = new St.BoxLayout({
            style_class: styleClass,
            vertical   : true
        });

        this.actor = new St.ScrollView({
            style_class      : 'scrollBox',
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.NEVER
        });

        this.actor.add_actor(this.box);
        //this.actor._delegate = this;
        //this.actor.clip_to_allocation = true;
        //this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));

        let scrollBar = this.actor.get_vscroll_bar();
        let appsScrollBoxAdj = scrollBar.get_adjustment();

        this.actor.connect('scroll-event', Lang.bind(this, function()
        {
            if(_hitScrollEvent)
            {
                return;
            }

            let currentPosition = appsScrollBoxAdj.value + this.actor.height;

            if((currentPosition + 400) >= appsScrollBoxAdj.upper)
            {
                this.loadNextItems();
            }
        }));

        this.reloadTaskData(true, Lang.bind(this, function()
        {
            this.loadNextItems();
        }));
    },

    addGridItem       : function(task)
    {
        let dueDateAbbreviation = task.DueDateAbbreviation;

        let description = (dueDateAbbreviation ? dueDateAbbreviation + "  " : "") + task.Description
        let gridMenu = new PopupMenu.PopupSubMenuMenuItem(description, true);
        gridMenu.actor.add_style_class_name("taskGrid");
        gridMenu.menu.box.add_style_class_name("taskGridInner");
        gridMenu.menu._needsScrollbar = function()
        {
            return false;
        };

        if(task.IsCompleted)
        {
            gridMenu.icon.icon_name = 'object-select-symbolic';
            gridMenu.icon.add_style_class_name("completed");
        }
        else if(!dueDateAbbreviation)
        {
            gridMenu.icon.icon_name = 'dialog-warning-symbolic';
            gridMenu.icon.add_style_class_name("warning");
        }
        else if(task.Priority == taskService.TaskPriority.LOW)
        {
            gridMenu.icon.icon_name = 'flag-symbolic';
            gridMenu.icon.add_style_class_name("minor");
        }
        else if(task.Priority == taskService.TaskPriority.MEDIUM)
        {
            gridMenu.icon.icon_name = 'flag-symbolic';
            gridMenu.icon.add_style_class_name("medium");
        }
        else if(task.Priority == taskService.TaskPriority.HIGH)
        {
            gridMenu.icon.icon_name = 'flag-symbolic';
            gridMenu.icon.add_style_class_name("urgent");
        }
        else
        {
            gridMenu.icon.icon_name = 'list-remove-symbolic';
            gridMenu.icon.add_style_class_name("hidden");
        }

        log(JSON.stringify(task, null, 4));

        if(task.IsCompleted)
        {
            this._appendDataRow(gridMenu, _("Identifier:"), task.ID + " (" + task.UUID + ")");

        }
        else
        {
            this._appendDataRow(gridMenu, _("Identifier:"), task.UUID);
        }

        this._appendDataRow(gridMenu, _("Description:"), task.Description);
        this._appendDataRow(gridMenu, _("Status:"), task.Status);

        if(task.Tags)
        {
            this._appendDataRow(gridMenu, _("Tags:"), task.TagsAsString);
        }

        if(task.Priority)
        {
            this._appendDataRow(gridMenu, _("Priority:"), task.Priority);
        }

        this._appendDataRow(gridMenu, _("Urgency:"), task.Urgency.toString());

        if(task.Due)
        {
            let dateFormat = Shell.util_translate_time_string(N_("%H:%M %A %d. %b. %Y"));
            let formattedText = task.DueDate.toLocaleFormat(dateFormat);
            this._appendDataRow(gridMenu, _("Due:"), formattedText);
        }

        let buttonBox = new St.BoxLayout({
            style_class: 'buttonBox'
        });

        let _buttonMenu = new PopupMenu.PopupBaseMenuItem({
            reactive   : false,
            style_class: 'button-container'
        });

        if(!task.IsCompleted)
        {
            let _markDoneButton = Convenience.createButton(_("Set Task Done"), "doneTask", "doneTask", Lang.bind(this, function()
            {
                this.emit('setDone', task);
            }));

            let _modifyButton = Convenience.createButton(_("Modify Task"), "modifyTask", "modifyTask", Lang.bind(this, function()
            {
                this.emit('modify', task);
            }));

            buttonBox.add(_markDoneButton, {expand: true, x_fill: true, x_align: St.Align.MIDDLE});
            buttonBox.add(_modifyButton, {expand: true, x_fill: true, x_align: St.Align.MIDDLE});
        }

        if(ExtensionUtils.versionCheck(['3.8'], Config.PACKAGE_VERSION))
        {
            _buttonMenu.add_actor(buttonBox);
        }
        else
        {
            _buttonMenu.actor.add_actor(buttonBox);
        }

        gridMenu.menu.addMenuItem(_buttonMenu);
        this.addMenuItem(gridMenu);

        _gridItems[task.ID] = gridMenu;
    },
    removeTaskFromGrid: function(taskID)
    {
        let gridMenuItem = _gridItems[task.ID];
        if(gridMenuItem)
        {
            gridMenuItem.destroy();
        }
    },

    _appendDataRow: function(gridMenu, title, value)
    {
        let rowMenuItem = new PopupMenu.PopupBaseMenuItem({
            reactive   : false,
            style_class: 'taskDataRowMenuItem'
        });

        let taskDataRow = new St.BoxLayout({
            style_class: 'taskDataRow'
        });

        let titleLabel = new St.Label({
            text       : title,
            style_class: 'rowTitle'
        });

        let valueLabel = new St.Label({
            text       : value,
            style_class: 'rowValue'
        });

        taskDataRow.add(titleLabel, {expand: true, x_fill: false, x_align: St.Align.START});
        taskDataRow.add(valueLabel, {expand: true, x_fill: false, x_align: St.Align.END});

        if(ExtensionUtils.versionCheck(['3.8'], Config.PACKAGE_VERSION))
        {
            rowMenuItem.add_actor(taskDataRow);
        }
        else
        {
            rowMenuItem.actor.add_actor(taskDataRow);
        }

        gridMenu.menu.addMenuItem(rowMenuItem);
    },

    _destroyItems: function()
    {
        let items = this.box.get_children();
        for(let i = 0; i < items.length; i++)
        {
            let boxItem = items[i];
            boxItem.destroy();
        }
    },

    loadNextItems: function(cleanItemBox)
    {
        _hitScrollEvent = true;

        if(cleanItemBox)
        {
            let scrollBar = this.actor.get_vscroll_bar();
            let appsScrollBoxAdj = scrollBar.get_adjustment();
            appsScrollBoxAdj.value = 0;
            scrollBar.set_adjustment(appsScrollBoxAdj);

            _currentPage = 0;
            _gridItems = {};
            this._destroyItems();
        }

        let showAmount = _currentPage * 25;

        let data = _currentItems.slice(showAmount, showAmount + 25);

        for(let i = 0; i < data.length; i++)
        {
            this.addGridItem(data[i]);
        }

        _currentPage++;
        _hitScrollEvent = false;
    },

    reloadTaskData: function(refreshCache, afterReloadCallback)
    {
        let now = new Date().getTime() / 1000;
        if(refreshCache || !_cacheExpirationTime || _cacheExpirationTime < now)
        {
            _cacheExpirationTime = now + _cacheDurationInSeconds;
            this.menu.service.loadTaskDataAsync(_currentTaskType, Lang.bind(this, function(data)
            {
                let sortFunction = this.menu._sortByDue;

                switch(_currentSortID)
                {
                    case taskService.SortOrder.DUE:
                        if(_currentTaskType == taskService.TaskType.COMPLETED)
                        {
                            sortFunction = this.menu._sortByModification;
                        }
                        else
                        {
                            sortFunction = this.menu._sortByDue;
                        }
                        break;
                    case taskService.SortOrder.URGENCY:
                        sortFunction = this.menu._sortByUrgency;
                        break;
                }

                data.sort(sortFunction);

                _currentItems = data;

                this.loadNextItems(true);

                this.menu._panelButtonLabel.text = ngettext("%d Task", "%d Tasks", data.length).format(data.length);

                if(afterReloadCallback)
                {
                    afterReloadCallback.call(this);
                }
            }));
        }
    }
});


const HeaderBar = new Lang.Class({
    Name   : 'HeaderBar',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(menu)
    {
        this.menu = menu;
        this.actor = new St.BoxLayout({
            style_class: "headerBar",
            vertical   : false
        });

        this.actor.add(this._createLeftBoxMenu(), {expand: true, x_fill: true, x_align: St.Align.START});
        this.actor.add(this._createMiddleBoxMenu(), {expand: true, x_fill: true, x_align: St.Align.MIDDLE});
        this.actor.add(this._createRightBoxMenu(), {expand: false, x_fill: true, x_align: St.Align.END});
    },

    _createLeftBoxMenu: function()
    {
        let leftBox = new St.BoxLayout({
            style_class: "leftBox"
        });

        leftBox.add(Convenience.createActionButton("list-add-symbolic", "hatt", null, Lang.bind(this.menu, function()
        {
            this._openTaskCreationDialog();
        })));

        leftBox.add(Convenience.createActionButton("view-refresh-symbolic", "hatt2", "last", Lang.bind(this.menu, function()
        {
            this.taskBox.reloadTaskData(true);
        })));

        return leftBox;
    },

    _createMiddleBoxMenu: function()
    {
        let middleBox = new St.BoxLayout({
            style_class: "middleBox"
        });

        let activeClass = taskService.TaskType.ACTIVE == _currentTaskType ? "active" : "";
        let activeButton = Convenience.createButton(_("Active"), "active", "activeButton " + activeClass, Lang.bind(this, this._toggleTaskType));
        activeButton.TypeID = taskService.TaskType.ACTIVE;

        activeClass = taskService.TaskType.COMPLETED == _currentTaskType ? "active" : "";
        let closedButton = Convenience.createButton(_("Completed"), "completed", "completedButton " + activeClass, Lang.bind(this, this._toggleTaskType));
        closedButton.TypeID = taskService.TaskType.COMPLETED;

        middleBox.add(activeButton);
        middleBox.add(closedButton);

        return middleBox;
    },

    _createRightBoxMenu: function()
    {
        let rightBox = new St.BoxLayout({style_class: "rightBox"});

        let activeClass = taskService.SortOrder.DUE == _currentSortID ? "active" : "";
        var addIcon = Convenience.createActionButton("appointment-symbolic", "hatt3", activeClass, Lang.bind(this, this._toggleSortIcon));
        addIcon.SortID = taskService.SortOrder.DUE;
        rightBox.add(addIcon, {expand: false, x_fill: false, x_align: St.Align.END});

        activeClass = taskService.SortOrder.URGENCY == _currentSortID ? "active" : "";
        var reloadIcon = Convenience.createActionButton("flag-symbolic", "hatt4", "last " + activeClass, Lang.bind(this, this._toggleSortIcon));
        reloadIcon.SortID = taskService.SortOrder.URGENCY;
        rightBox.add(reloadIcon, {expand: false, x_fill: false, x_align: St.Align.END});

        return rightBox;
    },

    _toggleSortIcon: function(button)
    {
        // skip because it is already active
        if(_currentSortID == button.SortID)
        {
            return;
        }

        // first remove active classes then highlight the clicked button
        let tabBox = button.get_parent();
        let tabBoxChildren = tabBox.get_children();

        for(let i = 0; i < tabBoxChildren.length; i++)
        {
            let tabButton = tabBoxChildren[i];
            tabButton.remove_style_class_name("active");
        }

        button.add_style_class_name("active");
        _currentSortID = button.SortID;

        // clear box and fetch new data
        this.menu.taskBox.reloadTaskData(true);
    },

    _toggleTaskType: function(button)
    {
        // skip because it is already active
        if(_currentTaskType == button.TypeID)
        {
            return;
        }

        // first remove active classes then highlight the clicked button
        let tabBox = button.get_parent();
        let tabBoxChildren = tabBox.get_children();

        for(let i = 0; i < tabBoxChildren.length; i++)
        {
            let tabButton = tabBoxChildren[i];
            tabButton.remove_style_class_name("active");
        }

        button.add_style_class_name("active");
        _currentTaskType = button.TypeID;

        // clear box and fetch new data
        this.menu.taskBox.reloadTaskData(true);
    }
});


const TaskWhispererMenuButton = new Lang.Class({
    Name: 'TaskWhispererMenuButton',

    Extends: PanelMenu.Button,

    get _position_in_panel()
    {
        //if(!this._settings)
        //{
        //    this.loadConfig();
        //}

        return MenuPosition.CENTER;
    },

    _init: function()
    {
        this.switchProvider();

        // Load settings
        // this.loadConfig();

        // Label
        this._panelButtonLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            text   : _('...')
        });

        // Panel menu item - the current class
        let menuAlignment = 0.25;

        if(Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
        {
            menuAlignment = 1.0 - menuAlignment;
        }

        this.parent(menuAlignment);

        // Putting the panel item together
        let topBox = new St.BoxLayout();
        topBox.add_actor(this._panelButtonLabel);
        this.actor.add_actor(topBox);

        let dummyBox = new St.BoxLayout();
        this.actor.reparent(dummyBox);
        dummyBox.remove_actor(this.actor);
        dummyBox.destroy();

        this.actor.add_style_class_name('task-whisperer');

        let children = null;
        switch(this._position_in_panel)
        {
            case MenuPosition.LEFT:
                children = Main.panel._leftBox.get_children();
                Main.panel._leftBox.insert_child_at_index(this.actor, children.length);
                break;
            case MenuPosition.CENTER:
                children = Main.panel._centerBox.get_children();
                Main.panel._centerBox.insert_child_at_index(this.actor, children.length);
                break;
            case MenuPosition.RIGHT:
                children = Main.panel._rightBox.get_children();
                Main.panel._rightBox.insert_child_at_index(this.actor, 0);
                break;
        }

        if(Main.panel._menus === undefined)
        {
            Main.panel.menuManager.addMenu(this.menu);
        }
        else
        {
            Main.panel._menus.addMenu(this.menu);
        }

        this.taskBox = new ScrollBox(this, "");
        this._renderPanelMenuHeaderBox();

        this.taskBox.connect("setDone", Lang.bind(this, function(that, task)
        {
            this.service.setTaskDone(task.ID, Lang.bind(this, function()
            {
                this.taskBox.reloadTaskData(true);
            }));
        }));

        this.taskBox.connect("modify", Lang.bind(this, this._openModificationDialog));

        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen)
        {
            _isOpen = isOpen;
            this.taskBox.reloadTaskData(true);
        }));

        let section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);

        section.actor.add_actor(this.taskBox.actor);

        this.setRefreshTaskDataTimeout();

        if(ExtensionUtils.versionCheck(['3.8'], Config.PACKAGE_VERSION))
        {
            this._needsColorUpdate = true;
            let context = St.ThemeContext.get_for_stage(global.stage);
            this._globalThemeChangedId = context.connect('changed', Lang.bind(this, function()
            {
                this._needsColorUpdate = true;
            }));
        }
    },

    _sortByDue: function(a, b)
    {
        let dueA = a.Due || "";
        let dueB = b.Due || "";

        dueA = dueA.replace("T", "").replace("Z", "");
        dueB = dueB.replace("T", "").replace("Z", "");

        return dueA - dueB;
    },

    _sortByModification: function(a, b)
    {
        let valueA = a.Modified || "";
        let valueB = b.Modified || "";

        valueA = valueA.replace("T", "").replace("Z", "");
        valueB = valueB.replace("T", "").replace("Z", "");

        return valueB - valueA;
    },

    _sortByUrgency: function(a, b)
    {
        let valueA = a.Urgency || "";
        let valueB = b.Urgency || "";

        return valueB - valueA;
    },

    _renderPanelMenuHeaderBox: function()
    {
        this.headerBar = new HeaderBar(this);
        let section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);

        section.actor.add_actor(this.headerBar.actor);
    },

    _openModificationDialog: function(that, task)
    {
        // FIXME: looks like a bug, if i remove actor.hide / show, i have to click twice on the dialog
        //        once to kill the (already hidden menu) twice to interact with the dialog.. dafuq?
        this.menu.actor.hide();
        this.actor.hide();
        this.actor.show();

        this._modifyTaskDialog = new Dialogs.ModifyTaskDialog(task);

        this._modifyTaskDialog.connect('modify',
            Lang.bind(this, function(dialog, modificationParameter)
            {
                this.service.modifyTask(task.ID, modificationParameter, Lang.bind(this, function(buffer, status)
                {
                    if(status != 0)
                    {
                        dialog._errorMessageLabel.text = _("Sorry, that didn\'t work. Please try again.") + "\r\n" + buffer;
                        dialog._errorMessageLabel.show();
                        return;
                    }

                    this.taskBox.reloadTaskData(true);
                    dialog.close();
                }));
            }));

        this._modifyTaskDialog.open(global.get_current_time());
    },

    _openTaskCreationDialog: function()
    {
        // FIXME: looks like a bug, if i remove actor.hide / show, i have to click twice on the dialog
        //        once to kill the (already hidden menu) twice to interact with the dialog.. dafuq?
        this.menu.actor.hide();
        this.actor.hide();
        this.actor.show();

        this._createTaskDialog = new Dialogs.CreateTaskDialog();

        this._createTaskDialog.connect('create',
            Lang.bind(this, function(dialog, parameterString)
            {
                this.service.createTask(parameterString, Lang.bind(this, function(buffer, status)
                {
                    if(status != 0)
                    {
                        dialog._errorMessageLabel.text = _("Sorry, that didn\'t work. Please try again.") + "\r\n" + buffer;
                        dialog._errorMessageLabel.show();
                        return;
                    }

                    this.taskBox.reloadTaskData(true);
                    dialog.close();
                }));
            }));

        this._createTaskDialog.open(global.get_current_time());
    },

    switchProvider: function()
    {
        // By now only direct export of taskwarrior is supported
        this.useTaskWarriorExport();
    },

    useTaskWarriorExport: function()
    {
        this.service = new TaskService();
    },

    setRefreshTaskDataTimeout: function()
    {
        if(this._refreshTaskDataTimeoutID)
        {
            Mainloop.source_remove(this._refreshTaskDataTimeoutID);
            this._refreshTaskDataTimeoutID = undefined;
        }

        this._refreshTaskDataTimeoutID = Mainloop.timeout_add_seconds(150, Lang.bind(this, function()
        {
            // Avoid intervention while user is doing something
            if(!_isOpen)
            {
                this.taskBox.reloadTaskData(true);
            }

            this.setRefreshTaskDataTimeout();
            return true;
        }));
    },

    stop: function()
    {
        _currentItems = [];
        _cacheExpirationTime = undefined;

        if(this._refreshTaskDataTimeoutID)
        {
            Mainloop.source_remove(this._refreshTaskDataTimeoutID);
            this._refreshTaskDataTimeoutID = undefined;
        }
    }
});

let taskWhispererMenu;

function init()
{
    Convenience.initTranslations('gnome-shell-extension-taskwhisperer');
}

function enable()
{
    taskWhispererMenu = new TaskWhispererMenuButton();
    Main.panel.addToStatusArea('taskWhispererMenu', taskWhispererMenu);
}

function disable()
{
    taskWhispererMenu.stop();
    taskWhispererMenu.destroy();
}
