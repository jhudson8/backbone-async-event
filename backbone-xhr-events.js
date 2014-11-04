/*!
 * backbone-xhr-events v0.8.0
 * https://github.com/jhudson8/backbone-async-event
 *
 * Copyright (c) 2014 Joe Hudson<joehud_AT_gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
(function (main) {
  if (typeof define === 'function' && define.amd) {
    define(['backbone', 'underscore'], function (Backbone, _) {
      main(Backbone, _);
    });
  } else if (typeof exports !== 'undefined' && typeof require !== 'undefined') {
    module.exports = function (Backbone) {
      main(Backbone, require('underscore'));
    };
  } else {
    main(Backbone, _);
  }
})(function (Backbone, _) {

  // ANY OVERRIDES MUST BE DEFINED BEFORE LOADING OF THIS SCRIPT
  // Backbone.xhrCompleteEventName: event triggered on models when all XHR requests have been completed
  var xhrCompleteEventName = Backbone.xhrCompleteEventName = Backbone.xhrCompleteEventName || 'xhr:complete';
  // the model attribute which can be used to return an array of all current XHR request events
  var xhrLoadingAttribute = Backbone.xhrModelLoadingAttribute = Backbone.xhrModelLoadingAttribute || 'xhrActivity';
  // Backbone.xhrEventName: the event triggered on models and the global bus to signal an XHR request
  var xhrEventName = Backbone.xhrEventName = Backbone.xhrEventName || 'xhr';
  // Backbone.xhrGlobalAttribute: global event handler attribute name (on Backbone) used to subscribe to all model xhr events
  var xhrGlobalAttribute = Backbone.xhrGlobalAttribute = Backbone.xhrGlobalAttribute || 'xhrEvents';

  // initialize the global event bus
  var globalXhrBus = Backbone[xhrGlobalAttribute] = _.extend({}, Backbone.Events);
  var SUCCESS = 'success';
  var ERROR = 'error';

  var Context = function(method, model, options) {
    this.method = method;
    this.model = model;
    this.options = options;
  }
  Context.prototype.abort = function() {
    if (!this.aborted) {
      this.aborted = true;
      this.preventDefault = true;
      if (this.xhr) {
        this.xhr.abort();
      }
    }
  }
  _.extend(Context.prototype, Backbone.Events);

  // allow backbone to send xhr events on models
  var _sync = Backbone.sync;
  Backbone.sync = function (method, model, options) {

    options = options || {};
    // Ensure that we have a URL.
    if (!options.url) {
      options.url = _.result(model, 'url');
    }

    var context = initializeXHRLoading(method, model, model, options);
    if (context.preventDefault) {
      // it is assumed that either context.options.success or context.options.error will be called
      return;
    }
    var xhr = _sync.call(this, method, model, options);
    context.xhr = xhr;
    return xhr;
  };

  // provide helper flags to determine model fetched status
  globalXhrBus.on(xhrEventName + ':read', function (model, events) {
    events.on(SUCCESS, function () {
      model.hasBeenFetched = true;
      model.hadFetchError = false;
    });
    events.on(ERROR, function () {
      model.hadFetchError = true;
    });
  });


  // execute the callback directly if the model is fetch
  // initiate a fetch with this callback as the success option if not fetched
  // or plug into the current fetch if in progress
  Backbone.Model.prototype.whenFetched = Backbone.Collection.whenFetched = function(success, error) {
    var model = this;
    function successWrapper() {
      success(model);
    }
    if (this.hasBeenFetched) {
      return success(this);
    }
    // find current fetch call (if any)
    var _fetch = _.find(this[xhrLoadingAttribute], function(req) {
      return req.method === 'read';
    });
    if (_fetch) {
      _fetch.on('success', successWrapper);
      if (error) {
        _fetch.on('error', error);
      }
    } else {
      this.fetch({ success: successWrapper, error: error });
    }
  }

  // forward all or some XHR events from the source object to the dest object
  Backbone.forwardXhrEvents = function (source, dest, typeOrCallback) {
    var handler = handleForwardedEvents(!_.isFunction(typeOrCallback) && typeOrCallback);
    if (_.isFunction(typeOrCallback)) {
      // forward the events *only* while the function is executing wile keeping "this" as the context
      try {
        source.on(xhrEventName, handler, dest);
        typeOrCallback.call(this);
      } finally {
        source.off(xhrEventName, handler, dest);
      }
    } else {
      var eventName = typeOrCallback ? (xhrEventName + ':') + typeOrCallback : xhrEventName;
      source.on(eventName, handler, dest);
    }
  }

  Backbone.stopXhrForwarding = function (source, dest, type) {
    var handler = handleForwardedEvents(type),
      eventName = type ? (xhrEventName + ':') + type : xhrEventName;
    source.off(xhrEventName, handler, dest);
  }

  var _eventForwarders = {};

  function handleForwardedEvents(type) {
    type = type || '_all';
    var func = _eventForwarders[type];
    if (!func) {
      // cache it so we can unbind when we need to
      func = function (eventName, events) {
        if (type !== '_all') {
          // if the event is already scoped, the event type will not be provided as the first parameter
          options = events;
          events = eventName;
          eventName = type;
        }
        // these events will be called because we are using the same options object as the source call
        initializeXHRLoading(events.method, this, events.model, events.options);
      }
      _eventForwarders[type] = func;
    }
    return func;
  }

  // set up the XHR eventing behavior
  // "model" is to trigger events on and "sourceModel" is the model to provide to the success/error callbacks
  // these are the same unless there is event forwarding in which case the "sourceModel" is the model that actually
  // triggered the events and "model" is just forwarding those events
  function initializeXHRLoading(method, model, sourceModel, options) {
    var loads = model[xhrLoadingAttribute] = model[xhrLoadingAttribute] || [],
      eventName = options && options.event || method,
      context = new Context(method, sourceModel, options);

    var scopedEventName = xhrEventName + ':' + eventName;
    model.trigger(xhrEventName, eventName, context);
    model.trigger(scopedEventName, context);
    if (model === sourceModel) {
      // don't call global events if this is XHR forwarding
      globalXhrBus.trigger(xhrEventName, eventName, model, context);
      globalXhrBus.trigger(scopedEventName, model, context);
    }

    // allow for 1 last override
    var _beforeSend = options.beforeSend;
    options.beforeSend = function(xhr, settings) {
      context.xhr = xhr;
      context.settings = settings;

      if (_beforeSend) {
        var rtn = _beforeSend.call(this, xhr, settings);
        if (rtn === false) {
          return rtn;
        }
      }
      context.trigger('before-send', xhr, settings, context);
      if (context.preventDefault) {
        return false;
      }
      loads.push(context);
    };


    function onComplete(type) {
      var _type = options[type];
      // success: (data, status, xhr);  error: (xhr, type, error)
      options[type] = function (p1, p2, p3) {
        if (type === SUCCESS && !context.preventDefault) {
          // trigger the "data" event which allows manipulation of the response before any other events or callbacks are fired
          context.trigger('after-send', p1, p2, p3, context);
          p1 = context.data || p1;
          // if context.preventDefault is true, it is assumed that the option success or callback will be manually called
          if (context.preventDefault) {
            return;
          }
        }

        // options callback
        var _args = arguments;
        if (_type) {
          _type.call(this, p1, p2, p3);
        }

        // remove the load entry
        var index = loads.indexOf(context);
        if (index >= 0) {
          loads.splice(index, 1);
        }

        // if there are no more cuncurrent XHRs, model[xhrLoadingAttribute] should always be undefind
        if (loads.length === 0) {
          model[xhrLoadingAttribute] = undefined;
          model.trigger(xhrCompleteEventName, context);
        }

        // trigger the success/error event
        var args = (type === SUCCESS) ? [type, context] : [type, p1, p2, p3, context];
        context.trigger.apply(context, args);

        // trigger the complete event
        args.splice(0, 0, 'complete');
        context.trigger.apply(context, args);
      };
    }
    onComplete(SUCCESS);
    onComplete(ERROR);

    return context;
  }

});
