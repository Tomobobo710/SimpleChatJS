// Profiler - an F9-toggleable overlay that shows where SimpleChat spends its time.
//
// A lightweight, always-on instrumentation sink exposed as `window.Profiler`. The
// tagged calls are ~microseconds each, so it's safe to leave them in hot paths.
// The F9 overlay renders:
//   • LAST BUILD - the most recent full history load, split into fetch (network) /
//     process (turn grouping + RTO parse) / render (DOM) phases, plus a per-block-type
//     cost table (every block we rendered during that build, biggest first).
//   • SESSION    - cumulative session totals (sum / count / avg / max).
//   • LIVE       - FPS, frame-time average/max, session frame count.
//
// Metrics accumulate two ways:
//   - ALWAYS: Profiler.timing()/count() add to the SESSION view.
//   - DURING A BUILD: anything between beginBuild()/endBuild() is snapshotted into
//     "LAST BUILD" (in addition to session totals). loadChatHistory wraps its whole
//     body, so everything that happens inside — including renderBlock()'s per-type
//     timing while building the DOM — is attributed to that build.

(function () {
    'use strict';

    var OVERLAY_ID = 'scjs-profiler-overlay';
    var timeNow = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

    // Console diagnostics for this overlay. Every lifecycle step logs here so we can
    // tell, from the DevTools console, whether the script loaded / init ran / F9 fired
    // / the panel is on-screen — no guessing.
    function dbg() {
        if (window.console && window.console.log) {
            try {
                console.log.apply(console, ['[Profiler]'].concat(Array.prototype.slice.call(arguments)));
            } catch (e) { /* console may be unavailable */ }
        }
    }

    // ---------- state ----------
    var phases = {};          // name -> { count, sum, min, max }   (session, always)
    var counters = {};        // name -> number                      (session, always)
    var build = null;         // active build while begin/end are pending
    var builds = [];          // small ring of completed builds
    var lastBuild = null;
    var buildStart = 0;
    var sessionStart = timeNow();
    var sessionFrames = 0;

    // frame tracking
    var frameMin = Infinity;
    var frameMax = 0;
    var frameSum = 0;
    var frameCount = 0;
    var fpsWindowStart = timeNow();
    var fpsFrames = 0;
    var fps = 0;
    var lastFrameTs = null;

    // overlay
    var overlay = null;
    var overlayShown = false;
    var rafId = null;
    var refreshTimer = null;

    // ---------- measurement primitives ----------
    function tstart() { return timeNow(); }
    function tend(t) { return timeNow() - t; }

    function getPhase(name) {
        if (!phases[name]) phases[name] = { count: 0, sum: 0, min: Infinity, max: 0 };
        return phases[name];
    }

    // Record a discrete timing for a phase (always session; also current build).
    function timing(name, ms) {
        if (!(ms >= 0)) ms = 0;
        var p = getPhase(name);
        p.count++;
        p.sum += ms;
        if (ms < p.min) p.min = ms;
        if (ms > p.max) p.max = ms;
        if (build) {
            if (!build.phases[name]) build.phases[name] = { count: 0, sum: 0 };
            build.phases[name].count++;
            build.phases[name].sum += ms;
        }
    }

    // Record a count (events, message/turn/node totals).
    function count(name, n) {
        n = (n === undefined) ? 1 : n;
        counters[name] = (counters[name] || 0) + n;
        if (build) build.counters[name] = (build.counters[name] || 0) + n;
    }

    // Run fn() while timing it, attributing wall time to `name`. Returns fn()'s value.
    function pt(name, fn) {
        var t = tstart();
        try { return fn(); }
        finally { timing(name, tend(t)); }
    }

    // ---------- build lifecycle ----------
    function beginBuild() {
        buildStart = timeNow();
        build = { startMs: buildStart, totalMs: 0, phases: {}, counters: {}, meta: {} };
    }

    function endBuild(meta) {
        if (!build) return null;
        build.totalMs = tend(buildStart);
        if (meta) build.meta = meta;
        lastBuild = build;
        builds.push(build);
        if (builds.length > 50) builds.shift();
        build = null;
        return lastBuild;
    }

    // Grand total of the most recent build = the outer wall time (begin→end). Phases
    // are intentionally *inclusive* subsets of that wall time (e.g. block rendering is
    // inside render.turn.dom, inside hist.render), so summing them would inflate the
    // total — always report the real elapsed wall time and show each phase as a % of it.
    function buildTotal(b) {
        return b ? b.totalMs : 0;
    }

    // ---------- FPS ticker ----------
    function tick() {
        sessionFrames++;
        frameCount++;
        var t = timeNow();
        if (lastFrameTs != null) {
            var dt = t - lastFrameTs;
            if (dt > 0 && dt < 500) {   // ignore hiccup frames (tab swaps, heavy pauses)
                frameSum += dt;
                if (dt < frameMin) frameMin = dt;
                if (dt > frameMax) frameMax = dt;
            }
        }
        lastFrameTs = t;
        fpsFrames++;
        if (t - fpsWindowStart >= 1000) {
            fps = (fpsFrames * 1000) / (t - fpsWindowStart);
            fpsWindowStart = t;
            fpsFrames = 0;
        }
        rafId = requestAnimationFrame(tick);
    }

    // ---------- formatting helpers ----------
    function fmtMs(ms) {
        if (!(ms >= 0)) ms = 0;
        if (ms < 100) return ms.toFixed(ms < 10 ? 2 : 1) + 'ms';
        if (ms < 1000) return Math.round(ms) + 'ms';
        return (ms / 1000).toFixed(2) + 's';
    }
    function fmtInt(n) {
        return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    function fmtElapsed(ms) {
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        s = s % 60;
        return m + 'm' + (s < 10 ? '0' : '') + s + 's';
    }

    // ---------- overlay DOM ----------
    function buildOverlay() {
        if (overlay) return overlay;

        // CRITICAL: the <style> must live in <head>, NOT inside the overlay element.
        // render() repaints the panel with `overlay.innerHTML = ...` every refresh,
        // which would destroy a child <style> — collapsing the panel to an unstyled,
        // non-fixed blob. In <head> it survives all repaints.
        if (!document.getElementById(OVERLAY_ID + '-css')) {
            var css = document.createElement('style');
            css.id = OVERLAY_ID + '-css';
            css.textContent = [
                '#' + OVERLAY_ID + '{position:fixed;top:12px;right:12px;width:360px;max-width:92vw;max-height:calc(100vh - 24px);overflow:auto;z-index:99999;background:rgba(16,16,18,.94);color:#d7d7dc;border:1px solid #444;border-radius:8px;font:11px/1.4 "Cascadia Mono","Consolas",monospace;padding:8px 12px 10px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto;backdrop-filter:blur(4px);}',
                '#' + OVERLAY_ID + ' *{box-sizing:border-box;}',
                '#' + OVERLAY_ID + ' .sc-prof-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #3a3a3f;padding-bottom:6px;margin-bottom:8px;cursor:move;user-select:none;touch-action:none;}',
                '#' + OVERLAY_ID + ' .sc-prof-title{font-weight:700;color:#fff;letter-spacing:.5px;font-size:12px;}',
                '#' + OVERLAY_ID + ' .sc-prof-f9{color:#777;font-weight:400;font-size:9px;letter-spacing:1px;margin-left:4px;}',
                '#' + OVERLAY_ID + ' .sc-prof-close{cursor:pointer;color:#888;font-size:14px;line-height:1;padding:0 2px;}',
                '#' + OVERLAY_ID + ' .sc-prof-close:hover{color:#fff;}',
                '#' + OVERLAY_ID + ' .sc-prof-section{margin-bottom:10px;}',
                '#' + OVERLAY_ID + ' .sc-prof-section-title{font-weight:700;color:#9ad1ff;font-size:11px;letter-spacing:.4px;margin-bottom:4px;}',
                '#' + OVERLAY_ID + ' .sc-prof-elapsed{color:#888;font-weight:400;float:right;}',
                '#' + OVERLAY_ID + ' .sc-prof-row{display:flex;justify-content:space-between;gap:8px;padding:1px 0;}',
                '#' + OVERLAY_ID + ' .sc-prof-dim{opacity:.75;}',
                '#' + OVERLAY_ID + ' .sc-prof-label{color:#aab;}',
                '#' + OVERLAY_ID + ' .sc-prof-val{color:#eef;text-align:right;}',
                '#' + OVERLAY_ID + ' table.sc-prof-table{width:100%;border-collapse:collapse;margin-top:2px;}',
                '#' + OVERLAY_ID + ' .sc-prof-table td,.sc-prof-table th{padding:1px 4px;white-space:nowrap;}',
                '#' + OVERLAY_ID + ' .sc-prof-table th{color:#889;font-weight:400;text-align:right;border-bottom:1px solid #333;font-size:10px;}',
                '#' + OVERLAY_ID + ' .sc-prof-table th.sc-prof-name{text-align:left;}',
                '#' + OVERLAY_ID + ' .sc-prof-name{color:#c8d2ff;max-width:190px;overflow:hidden;text-overflow:ellipsis;}',
                '#' + OVERLAY_ID + ' .sc-prof-now{text-align:right;color:#eef;}',
                '#' + OVERLAY_ID + ' .sc-prof-bar{width:38%;}',
                '#' + OVERLAY_ID + ' .sc-prof-bar span{display:block;height:8px;background:linear-gradient(90deg,#4c9aff,#9ad1ff);border-radius:2px;min-width:2px;}',
                '#' + OVERLAY_ID + ' .sc-prof-pct{color:#9ad1ff;text-align:right;width:38px;}',
                '#' + OVERLAY_ID + ' tr.sc-prof-top .sc-prof-name{color:#fff;font-weight:700;}',
                '#' + OVERLAY_ID + ' .sc-prof-note{color:#9a9;font-style:italic;padding:4px 0;}',
                '#' + OVERLAY_ID + ' .sc-prof-live{border-top:1px solid #3a3a3f;padding-top:6px;}',
                '@media (prefers-reduced-motion: reduce){#' + OVERLAY_ID + ' .sc-prof-bar span{transition:none;}}'
            ].join('\n');
            var head = document.head || document.documentElement;
            head.appendChild(css);
        }

        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'sc-profiler';
        overlay.style.display = 'none';
        var host = document.body || document.documentElement;
        if (!host) {
            dbg('ERROR: no document.body/documentElement yet to attach the overlay to');
            return overlay;
        }
        host.appendChild(overlay);
        dbg('overlay element created:', OVERLAY_ID);
        return overlay;
    }

    function rowHtml(label, value, dim) {
        return '<div class="sc-prof-row' + (dim ? ' sc-prof-dim' : '') + '">'
            + '<span class="sc-prof-label">' + label + '</span>'
            + '<span class="sc-prof-val">' + (value === undefined ? '' : value) + '</span></div>';
    }

    // Build-phase table: biggest-first, with a relative impact bar and % of build.
    function buildPhaseRows(b) {
        var total = buildTotal(b) || 1;
        var rows = [];
        for (var name in b.phases) {
            var s = b.phases[name].sum;
            if (!(s > 0)) continue;
            rows.push({ name: name, sum: s, pct: Math.round((s / total) * 100) });
        }
        rows.sort(function (a, x) { return x.sum - a.sum; });
        var max = rows.length ? rows[0].sum : 0;
        return rows.map(function (r) {
            var w = max > 0 ? Math.max(2, Math.round((r.sum / max) * 100)) : 0;
            return '<tr' + (r === rows[0] ? ' class="sc-prof-top"' : '') + '>'
                + '<td class="sc-prof-name" title="' + r.name + '">' + r.name + '</td>'
                + '<td class="sc-prof-bar"><span style="width:' + w + '%"></span></td>'
                + '<td class="sc-prof-pct">' + r.pct + '%</td>'
                + '<td class="sc-prof-now">' + fmtMs(r.sum) + '</td></tr>';
        }).join('');
    }

    // Session table: most expensive first, limited to `limit` rows.
    function sessionRows(limit) {
        var entries = [];
        for (var name in phases) {
            if (!phases[name].count) continue;
            entries.push({
                name: name,
                sum: phases[name].sum,
                count: phases[name].count,
                avg: phases[name].sum / phases[name].count,
                max: phases[name].max
            });
        }
        entries.sort(function (a, x) { return x.sum - a.sum; });
        if (limit && entries.length > limit) entries = entries.slice(0, limit);
        return entries.map(function (e) {
            return '<tr><td class="sc-prof-name" title="' + e.name + '">' + e.name + '</td>'
                + '<td class="sc-prof-now">' + fmtMs(e.sum) + '</td>'
                + '<td class="sc-prof-now">' + fmtInt(e.count) + '</td>'
                + '<td class="sc-prof-now">' + fmtMs(e.avg) + '</td>'
                + '<td class="sc-prof-now">' + fmtMs(e.max) + '</td></tr>';
        }).join('');
    }

    function render() {
        if (!overlay || !overlayShown) return;

        var nodes = 0;
        try { nodes = document.querySelectorAll('#messages *').length; } catch (e) { nodes = 0; }

        var html = '';
        html += '<div class="sc-prof-head">'
            + '<span class="sc-prof-title">SimpleChat Profiler <span class="sc-prof-f9">(F9)</span></span>'
            + '<span class="sc-prof-close" title="Hide (F9)">\u00d7</span></div>';

        // ---- last build ----
        var b = lastBuild;
        html += '<div class="sc-prof-section"><div class="sc-prof-section-title">LAST BUILD';
        if (b) {
            var m = b.meta || {};
            html += ' <span class="sc-prof-elapsed">' + fmtMs(buildTotal(b)) + ' total</span></div>';
            html += rowHtml('turns', fmtInt(m.turns || 0), true);
            html += rowHtml('messages', fmtInt(m.messages || 0), true);
            html += rowHtml('DOM nodes', fmtInt(m.nodes || nodes || 0), true);
            if (m.chatId) html += rowHtml('chat', String(m.chatId).slice(0, 20), true);
            var hasPhases = false;
            for (var k in b.phases) { if (b.phases[k].sum > 0) { hasPhases = true; break; } }
            if (hasPhases) {
                html += '<table class="sc-prof-table"><thead><tr>'
                    + '<th class="sc-prof-name">phase</th><th>impact</th><th>%</th><th>time</th>'
                    + '</tr></thead><tbody>' + buildPhaseRows(b) + '</tbody></table>';
            } else {
                html += '<div class="sc-prof-note">No phased work in this build.</div>';
            }
        } else {
            html += '</div>';
            html += '<div class="sc-prof-note">No history load yet — open/switch a chat to populate.</div>';
        }
        html += '</div>';

        // ---- session ----
        var sr = sessionRows(14);
        html += '<div class="sc-prof-section"><div class="sc-prof-section-title">SESSION'
            + ' <span class="sc-prof-elapsed">' + fmtElapsed(timeNow() - sessionStart) + '</span></div>';
        if (sr) {
            html += '<table class="sc-prof-table"><thead><tr>'
                + '<th class="sc-prof-name">phase</th><th>sum</th><th>n</th><th>avg</th><th>max</th>'
                + '</tr></thead><tbody>' + sr + '</tbody></table>';
        } else {
            html += '<div class="sc-prof-note">No session timings recorded yet.</div>';
        }
        html += '</div>';

        // ---- live / frame ----
        var frameAvg = frameCount > 0 ? frameSum / frameCount : 0;
        var frameTxt = fps + ' fps' + (frameAvg ? ' · ' + fmtMs(frameAvg) + ' avg' : '')
            + (frameMax > 0 ? ' · max ' + fmtMs(frameMax) : '');
        var zoom = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio) || 1;
        html += '<div class="sc-prof-section sc-prof-live">'
            + rowHtml('effective zoom', zoom.toFixed(2) + '\u00d7')
            + rowHtml('frame', frameTxt)
            + rowHtml('frames (session)', fmtInt(sessionFrames))
            + rowHtml('rendered blocks', fmtInt(counters['render.blocks'] || 0))
            + '</div>';

        overlay.innerHTML = html;
    }

    // ---------- show / hide / toggle ----------
    function show() {
        buildOverlay();
        overlay.style.display = 'block';
        overlayShown = true;
        // Clamp into the visible area — with the app's zoom factor a stale left/top
        // (e.g. after a window resize or zoom change while hidden) could sit off-screen.
        try {
            var rect = overlay.getBoundingClientRect();
            var vw = window.innerWidth, vh = window.innerHeight;
            var moved = rect.right > vw - 4 || rect.left < 4 || rect.bottom > vh - 4 || rect.top < 4;
            if (moved) {
                overlay.style.left = '';
                overlay.style.top = '';
                overlay.style.right = '12px';
                overlay.style.bottom = '';
                rect = overlay.getBoundingClientRect();
            }
            dbg('SHOW rect={x:' + Math.round(rect.left) + ',y:' + Math.round(rect.top)
                + ',w:' + Math.round(rect.width) + ',h:' + Math.round(rect.height)
                + '} viewport=' + Math.round(vw) + 'x' + Math.round(vh)
                + ' dpr=' + window.devicePixelRatio
                + ' display=' + overlay.style.display
                + ' visibility=' + getComputedStyle(overlay).visibility
                + ' onScreen=' + (rect.left >= 0 && rect.top >= 0 && rect.right <= vw && rect.bottom <= vh));
        } catch (err) {
            dbg('SHOW (rect check failed):', err && err.message);
        }
        if (typeof requestAnimationFrame === 'function' && !rafId) {
            lastFrameTs = null;
            rafId = requestAnimationFrame(tick);
        }
        refreshTimer = setInterval(render, 500);
        render();
    }
    function hide() {
        overlayShown = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        if (overlay) overlay.style.display = 'none';
        dbg('HID');
    }
function toggle() { overlayShown ? hide() : show(); }

    // ---------- init ----------
    function init() {
        buildOverlay();
        // Bind the toggle several redundant ways so nothing can swallow it: F9 on both
        // window and document (capture phase — fires even if a handler stopped propagation
        // on window), and Ctrl+Shift+P as a fallback for machines where F9 needs an Fn
        // key or Windows/Media grabs it. Each binding is idempotent (our first one wins).
        var toggleHandler = function (e) {
            var key = (e.key || '').toLowerCase();
            var isF9 = key === 'f9';
            var isFallback = e.ctrlKey && e.shiftKey && (key === 'p' || key === 'P');
            if (!isF9 && !isFallback) return;
            e.preventDefault();
            e.stopPropagation();
            dbg('toggle key received: key=' + (e.key || '') + ' ctrl=' + e.ctrlKey + ' shift=' + e.shiftKey);
            toggle();
        };
        window.addEventListener('keydown', toggleHandler);
        document.addEventListener('keydown', toggleHandler, true);
        dbg('initialized; bindings installed (F9 / Ctrl+Shift+P)');

        // One delegated close handler; the button itself is recreated each refresh.
        overlay.addEventListener('click', function (e) {
            if (e.target && e.target.classList && e.target.classList.contains('sc-prof-close')) {
                hide();
            }
        });

        // Drag the overlay by its header. The element is position:fixed and the whole
        // page is zoomed (webFrame.setZoomFactor in the preload), but getBoundingClientRect
        // and clientX/Y are both in CSS pixels, so a plain offset math works at any zoom.
        var drag = null;
        overlay.addEventListener('pointerdown', function (e) {
            if (!e.target.closest || !e.target.closest('.sc-prof-head')) return;
            if (e.button !== 0) return;
            var rect = overlay.getBoundingClientRect();
            drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, ptr: e.pointerId };
            try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* older blink */ }
            e.preventDefault();
        });
        overlay.addEventListener('pointermove', function (e) {
            if (!drag || e.pointerId !== drag.ptr) return;
            overlay.style.left = (e.clientX - drag.dx) + 'px';
            overlay.style.top = (e.clientY - drag.dy) + 'px';
            overlay.style.right = 'auto';
            overlay.style.bottom = 'auto';
        });
        var endDrag = function (e) { if (drag && e.pointerId === drag.ptr) drag = null; };
        overlay.addEventListener('pointerup', endDrag);
        overlay.addEventListener('pointercancel', endDrag);
    }
    // ---------- export ----------
    window.Profiler = {
        tstart: tstart,
        tend: tend,
        pt: pt,
        time: timing,
        timing: timing,
        count: count,
        beginBuild: beginBuild,
        endBuild: endBuild,
        buildTotal: buildTotal,
        toggle: toggle,
        show: show,
        hide: hide,
        get lastBuild() { return lastBuild; },
        get building() { return !!build; },
        _stats: function () { return { phases: phases, counters: counters, lastBuild: lastBuild }; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        dbg('script loaded (readyState=loading) — waiting for DOMContentLoaded');
    } else {
        dbg('script loaded (readyState=' + document.readyState + ') — initializing now');
        init();
    }
})();