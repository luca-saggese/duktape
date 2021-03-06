/*
 *  Minimal ES2015+ Promise polyfill
 *
 *  Limitations:
 *
 *    - Caller must manually call Promise.runQueue() to process pending jobs.
 *    - No Promise subclassing or non-subclass foreign Promises yet.
 *    - Promise.all() and Promise.race() assume a plain array, not iterator.
 *    - Doesn't handle errors from core operations, e.g. out-of-memory or
 *      internal error when queueing/running jobs.  These are implementation
 *      defined for the most part.
 *    - See XXX in source for more.
 *
 *  This polyfill was originally used to gain a better understanding of the
 *  ES2015 specification algorithms, before implementing Promises natively.
 *  As such this polyfill may not be production quality.
 *
 *  See also: https://github.com/stefanpenner/es6-promise#readme
 */

(function () {
    if (typeof Promise !== 'undefined') { return; }

    // Job queue to simulate ES2015 job queues, linked list, 'next' reference.
    // While ES2015 doesn't guarantee the relative order of jobs in different
    // job queues, within a certain queue strict FIFO is required.  See ES5.1
    // https://www.ecma-international.org/ecma-262/6.0/#sec-jobs-and-job-queues:
    // "The PendingJob records from a single Job Queue are always initiated in
    // FIFO order. This specification does not define the order in which
    // multiple Job Queues are serviced."
    var queueHead = null, queueTail = null;
    function enqueueJob(job) {
        compact(job);
        if (queueHead) {
            queueTail.next = job;
            compact(queueTail);
            queueTail = job;
        } else {
            queueHead = job;
            queueTail = job;
        }
    }
    function dequeueJob() {
        var ret = queueHead;
        if (ret) {
            queueHead = ret.next;
            if (!queueHead) {
                queueTail = null;
            }
        }
        return ret;
    }

    // Helper to define/modify properties more compactly.
    function def(obj, key, val, attrs) {
        if (attrs === void 0) { attrs = 'wc'; }
        Object.defineProperty(obj, key, {
            value: val,
            writable: attrs.indexOf('w') >= 0,
            enumerable: attrs.indexOf('e') >= 0,
            configurable: attrs.indexOf('c') >= 0
        });
    }

    // Helper for Duktape specific object compaction.
    var compact = (typeof Duktape === 'object' && Duktape.compact) ||
                  function (v) { return v; };

    // Promise detection (plain or subclassed Promise), in spec has
    // [[PromiseState]] internal slot which isn't affected by Proxy
    // behaviors etc.
    var symMarker = Symbol('promise');
    function isPromise(p) {
        return p !== null && typeof p === 'object' && symMarker in p;
    }
    function requirePromise(p) {
        if (!isPromise(p)) { throw new TypeError('Promise required'); }
    }

    // Raw fulfill/reject operations, assume resolution processing done.
    function doFulfill(p, val) {
        if (p.state !== void 0) { return; }  // should not happen
        p.state = true; p.value = val;
        var reactions = p.fulfillReactions;
        delete p.fulfillReactions; delete p.rejectReactions; compact(p);
        reactions.forEach(function (r) {
            enqueueJob({
                handler: r.handler,
                resolve: r.resolve,
                reject: r.reject,
                value: val
            });  // only value is new
        });
    }
    function doReject(p, val) {
        if (p.state !== void 0) { return; }  // should not happen
        p.state = false; p.value = val;
        var reactions = p.rejectReactions;
        delete p.fulfillReactions; delete p.rejectReactions; compact(p);
        reactions.forEach(function (r) {
            enqueueJob({
                handler: r.handler,
                resolve: r.resolve,
                reject: r.reject,
                value: val
            });  // only value is new
        });
    }

    // Create a new resolve/reject pair for a Promise.  Multiple pairs are
    // needed in thenable handling, with all but the most recent pair being
    // neutralized ('alreadyResolved').  Because Promises are resolved only
    // via this resolution process, it shouldn't be possible for the Promise
    // to be settled but check it anyway: it may be useful for e.g. the C API
    // to forcibly resolve/fulfill/reject a Promise regardless of extant
    // resolve/reject functions.
    function createResolutionFunctions(p) {
        // In ES2015 the resolve/reject functions have a shared 'state' object
        // with a [[AlreadyResolved]] slot.  Here we use an in-scope variable.
        var alreadyResolved = false;
        var reject = function (err) {
            if (alreadyResolved) { return; }
            alreadyResolved = true;  // neutralize resolve/reject
            if (p.state !== void 0) { return; }
            doReject(p, err);
        };
        var resolve = function (val) {
            if (alreadyResolved) { return; }
            alreadyResolved = true;  // neutralize resolve/reject
            if (p.state !== void 0) { return; }
            if (val === p) {
                return doReject(p, new TypeError('self resolution'));
            }
            try {
                var then = (val !== null && typeof val === 'object' &&
                            val.then);
                if (typeof then === 'function') {
                    var t = createResolutionFunctions(p);
                    return enqueueJob({
                        thenable: val,
                        then: then,
                        resolve: t.resolve,
                        reject: t.reject
                    });
                    // old resolve/reject is neutralized, only new pair is live
                }
                return doFulfill(p, val);
            } catch (e) {
                return doReject(p, e);
            }
        };
        return { resolve: resolve, reject: reject };
    }

    // Job queue simulation.
    function runQueueEntry() {
        var job = dequeueJob();
        if (!job) { return false; }
        if (job.then && job.resolve && job.reject) {
            try {
                void job.then.call(job.thenable, job.resolve, job.reject);
            } catch (e) {
                job.reject(e);
            }
        } else if (job.handler && job.resolve && job.reject) {
            try {
                if (job.handler === 'Identity') {
                    res = job.value;
                } else if (job.handler === 'Thrower') {
                    throw job.value;
                } else {
                    res = job.handler.call(void 0, job.value);
                }
                job.resolve(res);
            } catch (e) {
                job.reject(e);
            }
        } else {
            throw new Error('internal error');  // unknown job
        }
        return true;
    }

    // %Promise% constructor.
    var cons = function Promise(executor) {
        if (!new.target) {
            throw new TypeError('Promise must be called as a constructor');
        }
        if (typeof executor !== 'function') {
            throw new TypeError('executor must be callable');
        }
        var _this = this;
        this[symMarker] = true;
        def(this, 'state', void 0);   // undefined (pending), true/false
        def(this, 'value', void 0);
        def(this, 'fulfillReactions', []);
        def(this, 'rejectReactions', []);
        compact(this);
        var t = createResolutionFunctions(this);
        try {
            void executor(t.resolve, t.reject);
        } catch (e) {
            t.reject(e);
        }
    };
    var proto = cons.prototype;
    def(cons, 'prototype', proto, '');

    // %Promise%.resolve().
    // XXX: direct handling
    function resolve(val) {
        if (isPromise(val) && val.constructor === this) { return val; }
        return new Promise(function (resolve, reject) { resolve(val); });
    }

    // %Promise%.reject()
    // XXX: direct handling
    function reject(val) {
        return new Promise(function (resolve, reject) { reject(val); });
    }

    // %Promise%.all().
    function all(list) {
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        var values = [];
        var index = 0;
        var remaining = 1;  // remaining intentionally 1, not 0
        list.forEach(function (x) {  // XXX: no iterator support
            var t = Promise.resolve(x);
            var f = function promiseAllElement(val) {
                var F = promiseAllElement;
                if (F.alreadyCalled) { return; }
                F.alreadyCalled = true;
                values[F.index] = val;
                if (--remaining === 0) {
                    resolveFn.call(void 0, values);
                }
            };
            // In ES2015 the functions would reference a shared state object
            // explicitly.  Here the conceptual state is in scope.
            f.index = index++;
            remaining++;
            t.then(f, rejectFn);
        });
        if (--remaining === 0) {
            resolveFn.call(void 0, values);
        }
        return p;
    }

    // %Promise%.race().
    function race(list) {
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        list.forEach(function (x) {  // XXX: no iterator support
            var t = Promise.resolve(x);
            t.then(resolveFn, rejectFn);
        });
        return p;
    }

    // %PromisePrototype%.then(), also used for .catch().
    function then(onFulfilled, onRejected) {
        // No subclassing support here now, no NewPromiseCapability() handling.
        requirePromise(this);
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        if (typeof onFulfilled !== 'function') { onFulfilled = 'Identity' }
        if (typeof onRejected !== 'function') { onRejected = 'Thrower' }
        if (this.state === void 0) {  // pending
            this.fulfillReactions.push({
                handler: onFulfilled,
                resolve: resolveFn,
                reject: rejectFn
            });
            this.rejectReactions.push({
                handler: onRejected,
                resolve: resolveFn,
                reject: rejectFn
            });
        } else if (this.state) {  // fulfilled
            enqueueJob({
                handler: onFulfilled,
                resolve: resolveFn,
                reject: rejectFn,
                value: this.value
            });
        } else {  // rejected
            enqueueJob({
                handler: onRejected,
                resolve: resolveFn,
                reject: rejectFn,
                value: this.value
            });
        }
        return p;
    }

    // %PromisePrototype%.catch.
    var _catch = function (onRejected) {
        return this.then.call(this, void 0, onRejected);
    };
    def(_catch, 'name', 'catch', 'c');

    // %Promise%.try(), https://github.com/tc39/proposal-promise-try,
    // simple polyfill-style implementation.
    var _try = function (func) {
        // XXX: check 'this' for callability, or Promise / subclass.
        return new this(function (resolve, reject) { resolve(func()); });
    };
    def(_try, 'name', 'try', 'c');

    // Define visible objects and properties.
    (function () {
        def(this, 'Promise', cons);
        def(cons, 'resolve', resolve);
        def(cons, 'reject', reject);
        def(cons, 'all', all);
        def(cons, 'race', race);
        def(cons, 'try', _try);
        def(proto, 'then', then);
        def(proto, 'catch', _catch);
        def(proto, Symbol.toStringTag, 'Promise', 'c');

        // Custom API to drive the "job queue".
        def(cons, 'runQueue', function _runQueueUntilEmpty() {
            while (runQueueEntry()) {}
        });

        compact(this); compact(cons); compact(proto);
    }());
}());
