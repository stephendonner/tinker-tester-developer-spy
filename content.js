/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global browser, cloneInto, Config */

// This content script is called before any other page scripts, so we
// can modify the page script environment and set up the ability to
// create and modify hooks before other page scripts run.

function pageScript(Config, Messages) {
  const { UUID } = Config;

  const gSetTimeout = setTimeout;
  const gClearTimeout = clearTimeout;
  const gDateNow = Date.now;

  const Log = (function() {
    const origConsole = console;
    return function log() {
      origConsole.log.apply(origConsole, arguments);
    };
  }());

  const LogTrace = (function() {
    const origConsole = console;
    let tracing = false;
    return function logTrace() {
      if (tracing) {
        return;
      }
      tracing = true;
      origConsole.log.apply(origConsole, arguments);
      origConsole.trace();
      tracing = false;
    };
  }());

  function getActionFor(code) {
    if (code === "start debugger") {
      // eslint-disable-next-line no-debugger
      return () => { debugger; };
    } else if (code === "log stack trace") {
      return undefined;
    } else if (code === "ignore") {
      return (obj, args) => {
        LogTrace(Messages.LogIgnoringCall, obj, args);
        return null;
      };
    } else if (code === "nothing") {
      return function() {};
    }
    return new Function(code + "//" + Config.AllowEvalsToken);
  }

  class PropertyHook {
    constructor(path, options) {
      this.path = typeof path === "string" ? path.split(".") : path;
      this.revertPoint = undefined;
      if (options) {
        this.setOptions(options);
      }
    }

    setOptions(opts) {
      this.onGetter = opts.onGetter || ((o, rv) => rv);
      this.onSetter = opts.onSetter || ((o, nv) => nv);
      this.onCalled = opts.onCalled || ((o, a) => { return o.apply(this, a); });
      if (opts.enabled) {
        this.enable();
      } else {
        this.disable();
      }
    }

    enable() {
      if (this.enabled) {
        return;
      }
      this.enabled = true;
      let obj = window;
      let index = 0;
      const count = this.path.length;
      this.revertPoint = undefined;
      while (index < count - 1) {
        let name = this.path[index++];
        if (obj[name]) {
          obj = obj[name];
        } else {
          // if the property doesn't (yet) exist, then
          // add in a mock-object so we can track any
          // accesses for it early, but listen in case
          // it is later changed to a different value
          // and disable our current mock, then re-
          // enable the rule again.
          while (index++ < count) {
            obj = this.mockMissingProperty(obj, name);
            name = this.path[index];
          }
        }
      }
      this.overrideProperty(obj, this.path[this.path.length - 1]);
    }

    disable() {
      if (!this.revertPoint) {
        return;
      }
      const [obj, name, oldprop] = this.revertPoint;
      this.revertPoint = undefined;
      if (oldprop) {
        Object.defineProperty(obj, name, oldprop);
      } else {
        delete obj[name];
      }
      this.enabled = false;
    }

    findProperty(obj, name) {
      let proto = obj;
      do {
        const prop = Object.getOwnPropertyDescriptor(proto, name);
        if (prop) {
          return prop;
        }
        proto = Object.getPrototypeOf(proto);
      } while (proto);
      return undefined;
    }

    mockMissingProperty(obj, name) {
      const oldprop = this.findProperty(obj, name);
      Object.defineProperty(obj, name, {
        configurable: true, // So reloading the addon doesn't throw an error.
        get: () => {
          const v = oldprop.get.call(obj);
          if (v) {
            Object.defineProperty(obj, name, oldprop);
            if (!this.revertPoint) {
              this.revertPoint = [obj, name, oldprop];
            }
            this.enable();
          }
          return v;
        },
        set: v => {
          oldprop.set.call(obj, v);
          Object.defineProperty(obj, name, oldprop);
          if (!this.revertPoint) {
            this.revertPoint = [obj, name, oldprop];
          }
          this.enable();
        },
      });
      return Object.getOwnPropertyDescriptor(obj, name);
    }

    wrapValue(value) {
      if (typeof value === "function") {
        const me = this;
        return function() {
          let retval = me.onCalled(value, arguments, this);
          if (retval === undefined) {
            if (new.target) {
              retval = new (Function.prototype.bind.apply(value, arguments));
            } else {
              retval = value.apply(this, arguments);
            }
          }
          return retval;
        };
      }
      return value;
    }

    overrideProperty(obj, name) {
      const oldprop = this.findProperty(obj, name);
      if (!this.revertPoint) {
        this.revertPoint = [obj, name, oldprop];
      }
      const newprop = {
        configurable: true, // So reloading the addon doesn't throw an error.
        enumerable: oldprop && oldprop.enumerable || false,
      };
      if (oldprop && (oldprop.get || oldprop.set)) {
        const me = this;
        newprop.get = function() {
          return me.onGetter(this, oldprop.get.call(this));
        };
        newprop.set = function(newValue) {
          newValue = me.onSetter(this, newValue, oldprop.get.call(this));
          oldprop.set.call(this, newValue);
        };
      } else { // value, not get/set (or no such property)
        const me = this;
        newprop.get = function() {
          const curValue = oldprop && oldprop.value &&
                           me.wrapValue(oldprop.value);
          return me.onGetter(this, curValue);
        };
        if (!oldprop || oldprop.writable) {
          newprop.set = function(val) {
            const newValue = me.onSetter(this, me.wrapValue(val));
            if (oldprop) {
              oldprop.value = newValue;
            }
          };
        }
      }
      Object.defineProperty(obj, name, newprop);
    }
  }

  class DisableHook extends PropertyHook {
    enable() {
      if (this.revertPoint) {
        return; // already disabling the property
      }

      let parentObj = window;
      let index = 0;
      const count = this.path.length;
      while (index < count - 1) {
        const name = this.path[index++];
        if (parentObj[name]) {
          parentObj = parentObj[name];
        } else {
          // if the property doesn't exist, do nothing.
          return;
        }
      }

      const revertName = this.path[index];
      const revertProp = this.findProperty(parentObj, revertName);
      this.revertPoint = [parentObj, revertName, revertProp];
      // Try deleting outright first.
      delete parentObj[revertName];
      // If the value is still in the prototype, then just
      // obscure ourselves as an undefined value.
      if (revertName in parentObj) {
        Object.defineProperty(parentObj, revertName, {
          configurable: true,
          enumerable: false,
          value: undefined,
        });
      }
    }
  }

  const matchRegex = (function() {
    const RE = /^\/(.*)\/([gimuy]*)$/;
    return function getRegex(str) {
      const isRE = str.match(RE);
      if (isRE) {
        try {
          const RE = new RegExp(isRE[1], isRE[2]);
          return {
            match: str => str.match(RE),
            replace: (str, rep) => str.replace(RE, rep),
          };
        } catch (_) { }
      }
      return undefined;
    };
  })();

  function getCommaSeparatedList(str) {
    const vals = str || "";
    if (vals) {
      return vals.split(",").map(v => v.trim());
    }
    return [];
  }

  function matchCommaSeparatedList(str) {
    const vals = getCommaSeparatedList(str);
    return {
      match: str => vals.includes(str),
      replace: (str, rep) => rep,
    };
  }

  function matchString(str) {
    return {
      match: str2 => str === str2,
      replace: (str, rep) => rep,
    };
  }

  class TTDSHook {
    constructor(name, oldTTDS) {
      this.name = name;
    }

    check() {
      return Config[this.name];
    }

    update(opts) {
      if (!("enabled" in opts)) {
        opts.enabled = true;
      }
      const changes = {};
      changes[this.name] = opts;
      channel.port1.postMessage(changes);
      return "OK";
    }

    // Will be called once by the constructor
    activate() {
    }

    // Will be called when this TTDS instance dies
    deactivate() {
    }
  }

  class ElementCreatedHook extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.audioConstructorHook = new PropertyHook("window.Audio", {
        onCalled: (fn, args) => {
          this._onCreated("audio");
        },
      });
      this.createElementHook = new PropertyHook("document.createElement", {
        onCalled: (fn, args) => {
          const name = args[0].toLowerCase();
          this._onCreated(name);
        },
      });
      this.createElementNSHook = new PropertyHook("document.createElementNS", {
        onCalled: (fn, args) => {
          const name = args[0].toLowerCase();
          this._onCreated(name);
        },
      });
      this.importNodeHook = new PropertyHook("document.importNode", {
        onCalled: (fn, args, thisObj) => {
          const name = args[0].nodeName.toLowerCase();
          this._onCreated(name);
        },
      });
      this.cloneNodeHook = new PropertyHook("Element.prototype.cloneNode", {
        onCalled: (fn, args, thisObj) => {
          const name = thisObj.nodeName.toLowerCase();
          this._onCreated(name);
        },
      });
      this.innerHTMLHook = new PropertyHook("Element.prototype.innerHTML", {
        onSetter: (obj, html) => {
          this._onHTML(html);
          return html;
        },
      });
      this.outerHTMLHook = new PropertyHook("Element.prototype.outerHTML", {
        onSetter: (obj, html) => {
          this._onHTML(html);
          return html;
        },
      });
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if (opts.onCreated) {
        this.onCreated = getActionFor(opts.onCreated) || function(elem) {
          LogTrace(Messages.LogElementCreated, elem);
        };
      }

      if (opts.names) {
        this.names = [];
        this.regexes = {};
        getCommaSeparatedList(opts.names).map(_name => {
          const name = _name.trim().toLowerCase();
          this.regexes[name] = new RegExp("<" + name, "i");
          this.names.push(name);
          return name;
        });
      } else {
        delete this.names;
      }

      if ("enabled" in opts) {
        if (opts.enabled) {
          this.enable();
        } else {
          this.disable();
        }
      }
    }

    enable() {
      this.enabled = true;

      this.audioConstructorHook.enable();
      this.createElementHook.enable();
      this.createElementNSHook.enable();
      this.importNodeHook.enable();
      this.cloneNodeHook.enable();
      this.innerHTMLHook.enable();
      this.outerHTMLHook.enable();
    }

    disable() {
      this.enabled = false;

      this.audioConstructorHook.disable();
      this.createElementHook.disable();
      this.createElementNSHook.disable();
      this.importNodeHook.disable();
      this.cloneNodeHook.disable();
      this.innerHTMLHook.disable();
      this.outerHTMLHook.disable();
    }

    _onCreated(name) {
      if (this.enabled && this.onCreated &&
          (!this.names || this.names.includes(name))) {
        this.onCreated(name);
      }
    }

    _onHTML(html) {
      if (this.enabled && this.onCreated && this.names) {
        for (const name of this.names) {
          if (this.regexes[name].test(html)) {
            this.onCreated(name);
          }
        }
      }
    }
  }

  class ElementDetectionHook extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if ("addedNodes" in mutation) {
            for (const node of mutation.addedNodes) {
              if (node.matches && node.matches(this.selector)) {
                this._currentlyMatchingNodes.add(node);
                this.onDetected(node);
              }
            }
          }
          if ("removedNodes" in mutation) {
            for (const node of mutation.removedNodes) {
              if (node.matches && this._currentlyMatchingNodes.has(node)) {
                this._currentlyMatchingNodes.delete(node);
                this.onLost(node, mutation.attributeName, mutation.oldValue);
              }
            }
          }
          if (mutation.type === "attributes") {
            const node = mutation.target;
            if (node.matches) {
              const currentlyMatches = this._currentlyMatchingNodes.has(node);
              if (node.matches(this.selector)) {
                if (!currentlyMatches) {
                  this._currentlyMatchingNodes.add(node);
                  this.onDetected(node, mutation.attributeName, mutation.oldValue);
                }
              } else if (currentlyMatches) {
                this._currentlyMatchingNodes.delete(node);
                this.onLost(node, mutation.attributeName, mutation.oldValue);
              }
            }
          }
        }
      });
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if ("enabled" in opts && !opts.enabled) {
        this.disable();
      }
      const shouldEnable = "enabled" in opts && opts.enabled;
      if ("selector" in opts) {
        this.selector = opts.selector;
        if (shouldEnable) {
          this._findCurrentlyMatchingNodes();
        }
      }
      if ("onDetected" in opts) {
        if (opts.onDetected) {
          this.onDetected = getActionFor(opts.onDetected) || function(elem) {
            LogTrace(Messages.LogElementDetected, elem);
          };
        } else {
          delete this.onDetected;
        }
      }
      if ("onLost" in opts) {
        if (opts.onLost) {
          this.onLost = getActionFor(opts.onLost) || function(elem, changed, oldValue) {
            LogTrace(Messages.LogElementLost, elem, changed, oldValue);
          };
        } else {
          delete this.onLost;
        }
      }
      if (shouldEnable) {
        this.enable();
      }
    }

    _findCurrentlyMatchingNodes() {
      const matches = this._currentlyMatchingNodes = new WeakSet();
      document.querySelectorAll(this.selector).forEach(node => {
        matches.add(node);
      });
    }

    enable() {
      this._findCurrentlyMatchingNodes();
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeOldValue: true,
        childList: true,
        subtree: true,
      });
    }

    disable() {
      this.observer.disconnect();
      this._currentlyMatchingNodes = new WeakSet();
    }
  }

  const EventListenerHook = (function() {
    class Rule {
      setOptions(opts) {
        if ("enabled" in opts) {
          this.enabled = !!opts.enabled;
        }
        if ("types" in opts) {
          this.types = matchRegex(opts.types) ||
                       matchCommaSeparatedList(opts.types);
        }
        if ("selector" in opts) {
          this.selector = opts.selector;
        }
        this.onAdded = (opts.onAdded === "ignore" &&
          ((type, elem, fn) => {
            if (this._matches(type, elem)) {
              LogTrace(type, Messages.LogIgnoringListenerAddedOn, elem, fn);
              return false;
            }
            return undefined;
          })) || getActionFor(opts.onAdded) || function(type, elem, fn) {
          LogTrace(type, Messages.LogListenerAddedOn, elem, fn);
        };
        this.onRemoved = (opts.onRemoved === "ignore" &&
          ((type, elem, fn) => {
            if (this._matches(type, elem)) {
              LogTrace(type, Messages.LogIgnoringListenerRemovedFrom, elem, fn);
              return false;
            }
            return undefined;
          })) || getActionFor(opts.onRemoved) || function(type, elem, fn) {
          LogTrace(type, Messages.LogListenerRemovedFrom, elem, fn);
        };
        this.onEvent = (opts.onEvent === "ignore" &&
          ((event, handler) => {
            if (this._matches(event.type, event.target)) {
              Log(event.type, Messages.LogIgnoringEvent, event.target, event, handler);
              return false;
            }
            return undefined;
          })) || getActionFor(opts.onEvent) || function(event, handler) {
            Log(event.type, Messages.LogEventFiredOn, event.target, event, handler);
          };
      }

      enable() {
        this.enabled = true;
      }

      disable() {
        this.enabled = false;
      }

      _matches(type, elem) {
         return (!this.types || this.types.match(type)) &&
                (!this.selector ||
                  (this.selector === "document" && elem instanceof Document) ||
                  (this.selector === "window" && elem instanceof Window) ||
                  (elem.matches && elem.matches(this.selector)));
      }

      _onAdded(elem, type, fn) {
        if (this.enabled && this._matches(type, elem)) {
          return this.onAdded(type, elem, fn);
        }
        return undefined;
      }

      _onRemoved(elem, type, fn) {
        if (this.enabled && this._matches(type, elem)) {
          return this.onRemoved(type, elem, fn);
        }
        return undefined;
      }

      _onEvent(event, handler) {
        if (this.enabled && this._matches(event.type, event.target)) {
          return this.onEvent(event, handler);
        }
        return undefined;
      }
    }

    return class EventListenerHook extends TTDSHook {
      constructor(name, oldTTDS) {
        super(name, oldTTDS);

        this.targetInstance = this;
        this.enabled = false;
        this.rules = [new Rule()];

        if (oldTTDS && oldTTDS[name]) {
          const oldInstance = oldTTDS[name];

          // Inherhit handler proxies
          this.handlerProxies = oldInstance.handlerProxies;

          // Make those proxies call us instead
          const originalInstance = oldInstance.originalInstance || oldInstance;
          this.originalInstance = originalInstance;
          originalInstance.targetInstance = this;
        } else {
          this.handlerProxies = new WeakMap();
        }
      }

      activate() {
        if (this.oldAEL) {
          return;
        }

        this.oldAEL = EventTarget.prototype.addEventListener;
        this.oldREL = EventTarget.prototype.removeEventListener;

        const me = this;
        EventTarget.prototype.addEventListener = function(type, handler, opts) {
          return me.onAddListener(this, type, handler, opts);
        };
        EventTarget.prototype.removeEventListener = function(type, handler, opts) {
          return me.onRemoveListener(this, type, handler, opts);
        };
      }

      deactivate() {
        if (!this.oldAEL) {
          return;
        }

        this.disable();

        EventTarget.prototype.addEventListener = this.oldAEL;
        EventTarget.prototype.removeEventListener = this.oldREL;

        this.oldAEL = undefined;
        this.oldREL = undefined;
      }

      enable() {
        for (const rule of this.rules) {
          rule.enable();
        }
      }

      disable() {
        for (const rule of this.rules) {
          rule.disable();
        }
      }

      onAddListener(elem, type, handler, options) {
        for (const rule of this.rules) {
          if (rule._onAdded(elem, type, handler, options) === false) {
            return undefined;
          }
        }
        if (!handler) { // no handler, so this call will fizzle anyway
          return undefined;
        }
        const proxy = this.handlerProxies.get(handler) || (event => {
          return this.targetInstance.onEvent(event, handler);
        });
        const returnValue = this.oldAEL.call(elem, type, proxy, options);
        this.handlerProxies.set(handler, proxy);
        return returnValue;
      }

      onRemoveListener(elem, type, handler, options) {
        if (handler && this.handlerProxies.has(handler)) {
          for (const rule of this.rules) {
            if (rule._onRemoved(elem, type, handler) === false) {
              return;
            }
          }
          const proxy = this.handlerProxies.get(handler);
          this.oldREL.call(elem, type, proxy, options);
        } else {
          this.oldREL.apply(elem, arguments);
        }
      }

      onEvent(event, originalHandler) {
        let stopEvent = false;
        for (const rule of this.rules) {
          if (rule._onEvent(event, originalHandler) === false) {
            stopEvent = true;
          }
        }
        if (!stopEvent) {
          if (originalHandler.handleEvent) {
            return originalHandler.handleEvent(event);
          }
          return originalHandler.apply(this, arguments);
        }
        return undefined;
      }

      setOptions(opts) {
        this.rules[0].setOptions(opts);
        this.enabled = this.rules[0].enabled;
      }
    };
  }());

  class StyleListenerHook extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.relatedElementForPropsObj = new WeakMap();

      this.styleHook = new PropertyHook(
        "HTMLElement.prototype.style",
        {
          onGetter: (element, css2Properties) => {
            this.relatedElementForPropsObj.set(css2Properties, element);
            return css2Properties;
          }
        }
      );

      this.propertyNameHooks = {};
    }

    activate() {
      this.styleHook.enable();
      for (const hook of Object.values(this.propertyNameHooks)) {
        hook.enable();
      }
    }

    deactivate() {
      this.disable();
      this.styleHook.disable();
      for (const hook of Object.values(this.propertyNameHooks)) {
        hook.disable();
      }
    }

    registerStylePropertyListener(listener, prop) {
      if (this.propertyNameHooks[prop]) {
        return;
      }

      this.propertyNameHooks[prop] = new PropertyHook(
        `CSS2Properties.prototype.${prop}`,
        {
          enabled: true,
          onGetter: (obj, value) => {
            if (this.relatedElementForPropsObj.has(obj)) {
              const element = this.relatedElementForPropsObj.get(obj);
              value = this._onGet(prop, element, value);
            }
            return value;
          },
          onSetter: (obj, newValue) => {
            if (this.relatedElementForPropsObj.has(obj)) {
              const element = this.relatedElementForPropsObj.get(obj);
              newValue = this._onSet(prop, element, newValue);
            }
            return newValue;
          },
        }
      );
    }

    setOptions(opts) {
      if ("enabled" in opts) {
        this.enabled = !!opts.enabled;
      }

      this.onGet = getActionFor(opts.onGet) || function(prop, elem, value) {
        LogTrace(elem, `.style.${prop}`, Messages.LogGetterAccessed, value);
        return value;
      };
      this.onSet = getActionFor(opts.onSet) || function(prop, elem, value) {
        LogTrace(elem, `.style.${prop}`, Messages.LogSetterCalled, value);
        return value;
      };
      if (opts.properties) {
        this.properties = getCommaSeparatedList(opts.properties);
      }
      if (opts.selector) {
        this.selector = opts.selector;
      }
      if (opts.onlyValues) {
        this.onlyValues = matchRegex(opts.onlyValues) ||
                          matchCommaSeparatedList(opts.onlyValues);
      }
      for (const prop of this.properties) {
        this.registerStylePropertyListener(this, prop);
      }
    }

    enable() {
      this.enabled = true;
    }

    disable() {
      this.enabled = false;
    }

    _matches(prop, elem, value) {
      return (!this.properties || this.properties.includes(prop)) &&
             (!this.selector || elem.matches(this.selector)) &&
             (!this.onlyValues || this.onlyValues.match(value));
    }

    _onGet(prop, elem, returnValue) {
      if (this.enabled && this.onGet && this._matches(prop, elem, returnValue)) {
        returnValue = this.onGet(prop, elem, returnValue);
      }
      return returnValue;
    }

    _onSet(prop, elem, newValue) {
      if (this.enabled && this.onSet && this._matches(prop, elem, newValue)) {
        newValue = this.onSet(prop, elem, newValue);
      }
      return newValue;
    }
  }

  class XHRandFetchObserver extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.fetchHook = new PropertyHook(
        "window.fetch",
        {
          onCalled: (obj, args) => {
            const method = ((args[1] || {}).method || "get").toLowerCase();
            const url = new URL(args[0] || "", location).href.toLowerCase();
            if (this.onSend &&
                (!this.onlyMethods || this.onlyMethods.match(method)) &&
                (!this.onlyURLs || this.onlyURLs.match(url))) {
              this.onSend("fetch", args);
            }
          },
        }
      );

      const openedXHRArgs = new WeakMap();

      // Save the method and URL on the XHR objects when opened (for the send hook's use)
      this.openXHRHook = new PropertyHook(
        "XMLHttpRequest.prototype.open",
        {
          onCalled: (obj, args) => {
            openedXHRArgs.set(this, args);
          },
        }
      );

      this.sendXHRHook = new PropertyHook(
        "XMLHttpRequest.prototype.send",
        {
          onCalled: (obj, args) => {
            const openArgs = openedXHRArgs.get(this);
            const method = (openArgs[0] || "get").toLowerCase();
            const url = new URL(openArgs[1] || "", location).href.toLowerCase();
            if (this.onSend &&
                (!this.onlyMethods || this.onlyMethods.match(method)) &&
                (!this.onlyURLs || this.onlyURLs.match(url))) {
              this.onSend("XHR sent", openArgs);
            }
          },
        }
      );
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if ("enabled" in opts) {
        if (opts.enabled) {
          this.enable();
        } else {
          this.disable();
        }
      }

      if (opts.onSend) {
        this.onSend = getActionFor(opts.onSend) || LogTrace;
      }

      if (opts.onlyMethods) {
        this.onlyMethods = matchRegex(opts.onlyMethods) ||
                           matchCommaSeparatedList(opts.onlyMethods);
      }

      if (opts.onlyURLs) {
        this.onlyURLs = matchRegex(opts.onlyURLs) || matchString(opts.onlyURLs);
      }
    }

    enable() {
      this.fetchHook.enable();
      this.openXHRHook.enable();
      this.sendXHRHook.enable();
    }

    disable() {
      this.fetchHook.disable();
      this.openXHRHook.disable();
      this.sendXHRHook.disable();
    }
  }

  class GeolocationHook extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.watchers = {};
      this.nextWatcherId = 1;
    }

    deactivate() {
      this.disable();
    }

    getCoords() {
      return Object.assign(this.geolocation, {timestamp: gDateNow.call()});
    }

    updateWatcher(callback) {
      gSetTimeout.call(window, () => callback(this.getCoords()), 1);
    }

    setOptions(opts) {
      if (opts.enabled) {
        this.enable();
      } else {
        this.disable();
      }

      if (opts.accuracy || opts.altitude || opts.altitudeAccuracy ||
          opts.heading || opts.latitude || opts.longitude || opts.speed) {
        this.geolocation = {
          coords: {
            accuracy: parseFloat(opts.accuracy) || 1000,
            altitude: parseFloat(opts.altitude) || 0,
            altitudeAccuracy: parseFloat(opts.altitudeAccuracy) || 0,
            heading: parseFloat(opts.heading) || NaN,
            latitude: parseFloat(opts.latitude) || 0,
            longitude: parseFloat(opts.longitude) || 0,
            speed: parseFloat(opts.speed) || NaN,
          }
        };

        for (const callback of Object.values(this.watchers)) {
          this.updateWatcher(callback);
        }
      }
    }

    enable() {
      if (!this.override) {
        this.override = new PropertyHook("navigator.geolocation", {
          onGetter: (obj, value) => {
            if (this.geolocation) {
              return {
                getCurrentPosition: success => {
                  success(this.getCoords());
                },
                clearWatch: id => {
                  delete this.watchers[id];
                },
                watchPosition: success => {
                  this.watchers[this.nextWatcherId] = success;
                  this.updateWatcher(success);
                  return this.nextWatcherId++;
                },
              };
            }
            return value;
          }
        });
      }
      this.override.enable();
    }

    disable() {
      if (this.override) {
        this.override.disable();
      }
    }
  }

  class LanguagesHook extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.languageHook = new PropertyHook("navigator.language", {
        onGetter: (obj, value) => {
          return this.language || value;
        }
      });
      this.languagesHook = new PropertyHook("navigator.languages", {
        onGetter: (obj, value) => {
          return this.languages || value;
        }
      });
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if (opts.languages) {
        this.language = undefined;
        this.languages = undefined;

        const acceptHeaderValue = opts.languages.trim();
        if (acceptHeaderValue) {
          this.languages = acceptHeaderValue.split(",").map(lang => {
            return lang.split(";")[0].trim();
          });
          this.language = this.languages[0];
        }
      }

      if (opts.enabled) {
        this.enable();
      } else {
        this.disable();
      }
    }

    enable() {
      this.languageHook.enable();
      this.languagesHook.enable();
    }

    disable() {
      this.languageHook.disable();
      this.languagesHook.disable();
    }
  }

  class SimpleOverrides extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.overrides = [];
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if (opts.overrides) {
        this.disable();

        this.overrides = [];
        const overrides = (opts.overrides || {}).script || {};
        for (const [override, newValue] of Object.entries(overrides)) {
          this.overrides.push(new PropertyHook(override, {
            onGetter: (obj, value) => {
              return newValue;
            }
          }));
        }
      }

      if ("enabled" in opts) {
        if (opts.enabled) {
          this.enable();
        } else {
          this.disable();
        }
      }
    }

    enable() {
      for (const override of this.overrides) {
        override.enable();
      }
    }

    disable() {
      for (const override of this.overrides) {
        override.disable();
      }
    }
  }

  class SimpleHookList extends TTDSHook {
    constructor(name, oldTTDS) {
      super(name, oldTTDS);

      this.hooks = [];
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      this.disable();

      this.hooks = [];
      for (const [hook, action] of Object.entries(opts.properties || {})) {
        if (action === "hide") {
          this.hooks.push(new DisableHook(hook));
        } else {
          const hookAction = getActionFor(action);
          this.hooks.push(new PropertyHook(hook, {
            onGetter: hookAction || function(obj, value) {
              LogTrace(hook, Messages.LogGetterAccessed, value);
              return value;
            },
            onSetter: hookAction || function(obj, newValue) {
              LogTrace(hook, Messages.LogSetterCalled, newValue);
              return newValue;
            }
          }));
        }
      }
      for (const [hook, action] of Object.entries(opts.methods || {})) {
        if (action === "hide") {
          this.hooks.push(new DisableHook(hook));
        } else {
          const onCalled = getActionFor(action) || function(obj, args, thisObj) {
            LogTrace(hook, thisObj, Messages.LogCalledWithArgs, args);
          };
          this.hooks.push(new PropertyHook(hook, {
            onGetter: (obj, fn) => {
              // If the method didn't originally exist, just return our hook
              return fn || onCalled;
            },
            onCalled,
          }));
        }
      }

      if (opts.enabled) {
        this.enable();
      }
    }

    enable() {
      for (const hook of this.hooks) {
        hook.enable();
      }
    }

    disable() {
      for (const hook of this.hooks) {
        hook.disable();
      }
    }
  }

  const DisableDebugger = (function() {
    const origFn = window.Function;
    const origEval = window.eval;
    const debuggerMatch = /debugger/g;
    const debuggerReplacement = "true /*debugger*/";

    function fnHandler(...args) {
      const o = args[args.length - 1];
      if (typeof o === "string" && o.includes("debugger")) {
        args[args.length - 1] = o.replace(debuggerMatch, debuggerReplacement);
      }
      return origFn.apply(args);
    }

    function evalHandler(o) {
      if (typeof o === "string" && o.includes("debugger")) {
        o = o.replace(debuggerMatch, debuggerReplacement);
      }
      return origEval(o);
    }

    return class DisableDebugger extends TTDSHook {
      deactivate() {
        this.disable();
      }

      setOptions(opts) {
        if ("enabled" in opts) {
          if (opts.enabled) {
            this.enable();
          } else {
            this.disable();
          }
        }
      }

      enable() {
        origFn.constructor = fnHandler;
        origFn.prototype.constructor = fnHandler;
        window.Function = fnHandler;
        window.eval = evalHandler;
      }

      disable() {
        origFn.constructor = origFn;
        origFn.prototype.constructor = origFn;
        window.Function = origFn;
        window.eval = origEval;
      }
    };
  }());

  class FunctionBind extends TTDSHook {
    activate() {
      this.enabled = false;
      const me = this;

      Function.prototype.bind = function(oThis) {
        if (typeof this !== "function") {
          // closest thing possible to the ECMAScript 5
          // internal IsCallable function
          throw new TypeError(Messages.InvalidFunctionBind);
        }

        const aArgs   = Array.prototype.slice.call(arguments, 1);
        const fToBind = this;
        const fNOP    = function() {};
        const fBound  = function() {
          if (me.enabled) {
            LogTrace(Messages.LogBoundFunctionCalled, fToBind.toString());
          }
          return fToBind.apply(this instanceof fNOP
                 ? this
                 : oThis,
                 aArgs.concat(Array.prototype.slice.call(arguments)));
        };

        if (this.prototype) {
          // Function.prototype doesn't have a prototype property
          fNOP.prototype = this.prototype;
        }
        fBound.prototype = new fNOP();

        fBound._boundFunction = fToBind;
        fBound._boundArguments = aArgs;

        return fBound;
      };
    }

    deactivate() {
      this.disable();
    }

    setOptions(opts) {
      if ("enabled" in opts) {
        this.enabled = !!opts.enabled;
      }
    }

    enable() {
      this.enabled = true;
    }

    disable() {
      this.enabled = false;
    }
  }

  class IgnoredBackgroundScriptHook extends TTDSHook {
    setOptions() {}
    enable() {}
    disable() {}
  }


  // We return a message port back to the outer content script, so we can
  // securely with it without polluting the window's namespace.
  const channel = new MessageChannel();

  // If there is an old instance of TTDS we're replacing, then first
  // deactivate it so it reverts its various hooks.
  const oldInstance = window[UUID];
  if (oldInstance) {
    oldInstance.deactivate();
  }

  // Expose an API object which requires a secret key that is logged to the
  // console, to help ease configuration when using the remote devtools.
  const Tinker = {
    activate: () => {
      for (const hook of Object.values(Tinker)) {
        if (hook.activate) {
          hook.activate();
        }
      }
    },

    deactivate: () => {
      for (const hook of Object.values(Tinker)) {
        if (hook.deactivate) {
          hook.deactivate();
        }
      }
    },

    // If TTDS is restarted, then its AllowEvalsToken will change.
    // We presume it was restarted because it's being upgraded,
    // and disallow reconnecting to this instance.
    reconnect: config => {
      if (Config.AllowEvalsToken !== config.AllowEvalsToken) {
        Config.AllowEvalsToken = config.AllowEvalsToken;
        return undefined;
      }
      Tinker.replaceConfig(config);
      return channel.port2;
    },

    getConfig: () => {
      return Config;
    },

    replaceConfig: config => {
      Config = config;
      for (const [name, options] of Object.entries(config || {})) {
        if (Tinker[name]) {
          Tinker[name].setOptions(options);
        }
      }
    },
  };

  function addHook(name, cls) {
    Tinker[name] = new cls(name, oldInstance);
    Tinker[name].activate();
  }

  addHook("ObserveXHRandFetch", XHRandFetchObserver);
  addHook("ElementCreation", ElementCreatedHook);
  addHook("ElementDetection", ElementDetectionHook);
  addHook("StyleProperties", StyleListenerHook);
  addHook("UserAgentOverrides", SimpleOverrides);
  addHook("DisableDebugger", DisableDebugger);
  addHook("FunctionBind", FunctionBind);
  addHook("Geolocation", GeolocationHook);
  addHook("OverrideLanguages", LanguagesHook);
  addHook("DetectUAChecks", SimpleHookList);
  addHook("EventListener", EventListenerHook);
  addHook("EventFeatures", SimpleHookList);
  addHook("Scrolling", SimpleHookList);
  addHook("DocumentWrite", SimpleHookList);
  addHook("InputsAndLinks", SimpleHookList);
  addHook("MediaElements", SimpleHookList);
  addHook("Scheduling", SimpleHookList);
  addHook("ShadowDOM", SimpleHookList);
  addHook("CORSBypass", IgnoredBackgroundScriptHook);
  addHook("OverrideRequestHeaders", IgnoredBackgroundScriptHook);
  addHook("OverrideNetworkRequests", IgnoredBackgroundScriptHook);

  if (oldInstance) {
    // Grab the configuration of known hooks, and send it to the
    // background script so all TTDS UI is updated to match it.
    const oldConfig = oldInstance.getConfig();
    const newConfig = {};
    for (const [name, hook] of Object.entries(Tinker)) {
      if (hook.update && oldConfig[name]) {
        newConfig[name] = oldConfig[name];
      }
    }
    if (Object.keys(newConfig).length) {
      Tinker.replaceConfig(newConfig);
      channel.port1.postMessage(newConfig);
    }
  } else {
    console.info(Messages.apiAnnounceKey.replace("KEY", UUID));
    Tinker.replaceConfig(Config);
  }

  Object.defineProperty(window, UUID, {
    configurable: true,
    enumerable: false,
    value: Tinker,
  });

  // If we hear no heartbeat from our content-script for 5
  // seconds, presume that the addon is toast (the script should
  // reconnect by then if upgrading or restarting).
  const addonIsStillAlive = (function() {
    let canary = -1;
    return function() {
      gClearTimeout.call(window, canary);
      canary = gSetTimeout(() => {
        if (window[UUID] === Tinker) {
          delete window[UUID];
        }
        Tinker.deactivate();
      }, 5000);
    };
  }());

  channel.port1.onmessage = event => {
    const message = event.data;
    if (message === "addonIsStillAlive") {
      addonIsStillAlive();
    } else {
      Tinker.replaceConfig(JSON.parse(message));
    }
  };
  return channel.port2;
}

(function(Config) {
  const Messages = {
    apiAnnounceKey: browser.i18n.getMessage("apiAnnounceKey"),
    LogIgnoringCall: browser.i18n.getMessage("logIgnoringCall"),
    LogIgnoringEvent: browser.i18n.getMessage("logIgnoringEvent"),
    LogElementCreated: browser.i18n.getMessage("logElementCreated"),
    LogElementDetected: browser.i18n.getMessage("logElementDetected"),
    LogElementLost: browser.i18n.getMessage("logElementLost"),
    LogListenerAddedOn: browser.i18n.getMessage("logListenerAddedOn"),
    LogListenerRemovedFrom: browser.i18n.getMessage("logListenerRemovedFrom"),
    LogIgnoringListenerAddedOn: browser.i18n.getMessage("logIgnoringListenerAddedOn"),
    LogIgnoringListenerRemovedFrom: browser.i18n.getMessage("logIgnoringListenerRemovedFrom"),
    LogEventFiredOn: browser.i18n.getMessage("logEventFiredOn"),
    LogGetterAccessed: browser.i18n.getMessage("logGetterAccessed"),
    LogSetterCalled: browser.i18n.getMessage("logSetterCalled"),
    LogCalledWithArgs: browser.i18n.getMessage("logCalledWithArgs"),
    LogInvalidFunctionBind: browser.i18n.getMessage("logInvalidFunctionBind"),
    LogBoundFunctionCalled: browser.i18n.getMessage("logBoundFunctionCalled"),
  };

  const { UUID } = Config;
  const existingTTDS = window.wrappedJSObject[UUID];
  const port = existingTTDS && existingTTDS.reconnect(cloneInto(Config, existingTTDS)) ||
               window.eval(`(${pageScript}(${JSON.stringify(Config)},
                                           ${JSON.stringify(Messages)}));`);

  port.onmessage = msg => {
    const tabConfigChanges = msg.data;
    if (tabConfigChanges && Object.keys(tabConfigChanges).length) {
      browser.runtime.sendMessage({tabConfigChanges});
    }
  };

  // delegate any changes to the inner window's script using a message port
  browser.runtime.onMessage.addListener(
    message => {
      port.postMessage(JSON.stringify(message));
    }
  );

  setInterval(() => {
    port.postMessage("addonIsStillAlive");
  }, 1000);
})(Config);
