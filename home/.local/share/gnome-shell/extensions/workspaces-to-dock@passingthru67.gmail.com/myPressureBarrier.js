/* ========================================================================================================
 * myPressureBarrier.js
 * --------------------------------------------------------------------------------------------------------
 *  CREDITS:  Part of this code was copied from gnome-shell Layout.js
 * ========================================================================================================
 */


const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;

const myPressureBarrier = new Lang.Class({
    Name: 'workspacesToDock_myPressureBarrier',

    _init: function(threshold, speedLimit, timeout, actionMode) {
        this._threshold = threshold;
        this._speedLimit = speedLimit;
        this._timeout = timeout;
        this._actionMode = actionMode;
        this._barriers = [];
        this._eventFilter = null;

        this._isTriggered = false;
        this._reset();
    },

    addBarrier: function(barrier) {
        barrier._pressureHitId = barrier.connect('hit', Lang.bind(this, this._onBarrierHit));
        barrier._pressureLeftId = barrier.connect('left', Lang.bind(this, this._onBarrierLeft));

        this._barriers.push(barrier);
    },

    _disconnectBarrier: function(barrier) {
        barrier.disconnect(barrier._pressureHitId);
        barrier.disconnect(barrier._pressureLeftId);
    },

    removeBarrier: function(barrier) {
        this._disconnectBarrier(barrier);
        this._barriers.splice(this._barriers.indexOf(barrier), 1);
    },

    destroy: function() {
        this._barriers.forEach(Lang.bind(this, this._disconnectBarrier));
        this._barriers = [];
        if (this._keyPressEventId > 0)
            global.stage.disconnect(this._keyPressEventId);
    },

    setEventFilter: function(filter) {
        this._eventFilter = filter;
    },

    _reset: function() {
        this._barrierEvents = [];
        this._currentPressure = 0;
        this._lastTime = 0;
    },

    _isHorizontal: function(barrier) {
        return barrier.y1 == barrier.y2;
    },

    _getDistanceAcrossBarrier: function(barrier, event) {
        if (this._isHorizontal(barrier))
            return Math.abs(event.dy);
        else
            return Math.abs(event.dx);
    },

    _getDistanceAlongBarrier: function(barrier, event) {
        if (this._isHorizontal(barrier))
            return Math.abs(event.dx);
        else
            return Math.abs(event.dy);
    },

    _trimBarrierEvents: function() {
        // Events are guaranteed to be sorted in time order from
        // oldest to newest, so just look for the first old event,
        // and then chop events after that off.
        let i = 0;
        let threshold = this._lastTime - this._timeout;

        while (i < this._barrierEvents.length) {
            let [time, distance] = this._barrierEvents[i];
            if (time >= threshold)
                break;
            i++;
        }

        let firstNewEvent = i;

        for (i = 0; i < firstNewEvent; i++) {
            let [time, distance] = this._barrierEvents[i];
            this._currentPressure -= distance;
        }

        this._barrierEvents = this._barrierEvents.slice(firstNewEvent);
    },

    _onBarrierLeft: function(barrier, event) {
        barrier._isHit = false;
        if (this._barriers.every(function(b) { return !b._isHit; })) {
            this._reset();
            this._isTriggered = false;
        }
    },

    _trigger: function() {
        this._isTriggered = true;
        this.emit('trigger');
        this._reset();
    },

    _onBarrierHit: function(barrier, event) {
        barrier._isHit = true;

        // If we've triggered the barrier, wait until the pointer has the
        // left the barrier hitbox until we trigger it again.
        if (this._isTriggered)
            return;

        if (this._eventFilter && this._eventFilter(event))
            return;

        // Throw out all events not in the proper keybinding mode
        if (!(this._actionMode & Main.actionMode))
            return;

        let slide = this._getDistanceAlongBarrier(barrier, event);
        let distance = this._getDistanceAcrossBarrier(barrier, event);

        if (this._speedLimit && distance >= this._speedLimit) {
            this.emit('speed-exceeded');
            this._reset();
            return;
        }

        if (distance >= this._threshold) {
            this._trigger();
            return;
        }

        // Throw out events where the cursor is move more
        // along the axis of the barrier than moving with
        // the barrier.
        if (slide > distance)
            return;

        this._lastTime = event.time;

        this._trimBarrierEvents();
        distance = Math.min(15, distance);

        this._barrierEvents.push([event.time, distance]);
        this._currentPressure += distance;

        if (this._currentPressure >= this._threshold)
            this._trigger();
    }
});
Signals.addSignalMethods(myPressureBarrier.prototype);
