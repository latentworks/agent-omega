"use strict";
/* =====================================================================
   AGENT OMEGA — LAUNCH INTRO  v2  (ao-boot-3.js — rewritten per design digest)

   Sequence: secure-boot log (25 lines, auth scramble) → log fade →
   AGENT ONLINE → X-axis FLIP (ONLINE out / A/O hero in) → Ω globe
   fade-in → SETTLE (chrome + prompt + footer slide up around the hero,
   hero rises) → hand-off to the live home.

   HAND-OFF CONTRACT (Playwright harness + app must never break):
     window.AOBoot = { skip(), finish(), done:bool, __proof:{...} }
     · skip()/finish()  → fast-forward to unmount
     · on unmount       → AOBoot.done=true, overlay(.aob) removed from DOM,
                          window.focusActive() called
     · WS wiring        → wraps window.onWs to peek {type:'ready'}
     · test override    → window.__AOBOOT_TEST object (same as old boot)
   ===================================================================== */
(function () {
  if (window.AOBoot) return;
  if (document.getElementById('ao-boot-3-css')) return;

  /* ------------------------------------------------------------------ */
  /*  TIMING  (all ms; derived constants recalculated after test hook)   */
  /* ------------------------------------------------------------------ */
  var STEP          = 116;   // gap between boot lines
  var BOOT0         = 360;   // first line appears
  var NUM_LINES     = 25;
  var AUTH_I        = 15;    // index of the auth line
  var AUTH_LOCK_MS  = 700;   // total scramble→lock window for the auth line
  var LOG_FADE_OFF  = 320;   // after last line: start log fade
  var LOG_FADE_DUR  = 380;
  var ONLINE_OFF    = 340;   // after last line: AGENT ONLINE appears
  var ONLINE_FADE   = 220;   // ms for ONLINE opacity transition
  var FLIP_AFTER    = 820;   // after ONLINE_AT: start flip
  var FLIP_DUR      = 480;
  var GLOBE_AFTER   = 160;   // after FLIP0: start globe
  var GLOBE_FADE    = 700;
  var SETTLE_AFTER  = 360;   // after FLIP1: start settle
  var SETTLE_DUR    = 860;
  var POST_SETTLE   = 200;   // pause after settle before unmount fade
  var SKIP_FADE     = 250;   // fast fade on skip
  var DONE_FADE     = 460;   // normal cross-fade on complete (a touch gentler so the dissolve into the live UI reads as one continuous shot)
  var MAX_HOLD      = 14000; // hard cap

  function recalc() {
    /* these are referenced as function-scope vars; recalc writes back */
    window.__aobt = {
      LAST_T  : BOOT0 + (NUM_LINES - 1) * STEP,   // 3144
      AUTH_AT : BOOT0 + AUTH_I * STEP,             // 2100
      get ONLINE_AT() { return this.LAST_T + ONLINE_OFF; },   // 3484
      get FLIP0()     { return this.ONLINE_AT + FLIP_AFTER; }, // 4304
      get FLIP1()     { return this.FLIP0 + FLIP_DUR; },       // 4784
      get GLOBE_AT()  { return this.FLIP0 + GLOBE_AFTER; },    // 4464
      get SETTLE0()   { return this.FLIP1 + SETTLE_AFTER; },   // 5144
      get SETTLE1()   { return this.SETTLE0 + SETTLE_DUR; }    // 6004
    };
  }
  recalc();

  /* test-only override hook (harness may set window.__AOBOOT_TEST) */
  try {
    var OT = window.__AOBOOT_TEST;
    if (OT && typeof OT === 'object') {
      if (OT.STEP      != null) STEP      = OT.STEP;
      if (OT.BOOT0     != null) BOOT0     = OT.BOOT0;
      if (OT.MAX_HOLD  != null) MAX_HOLD  = OT.MAX_HOLD;
      if (OT.SETTLE_DUR!= null) SETTLE_DUR= OT.SETTLE_DUR;
      recalc();
    }
  } catch (_) {}

  var T = window.__aobt;  // shorthand

  /* ------------------------------------------------------------------ */
  /*  BOOT LINES  (25 total)                                             */
  /* ------------------------------------------------------------------ */
  /* type: 'header' | 'ok' | 'auth' | 'nominal' */
  var BOOT_LINES = [
    /* 0  */ ['AGENT-OMEGA  SECURE BOOT   v2.7.1',        'header' ],
    /* 1  */ ['detecting cpu features',               'ok'     ],
    /* 2  */ ['initializing kernel modules',          'ok'     ],
    /* 3  */ ['mounting /dev/agents',                 'ok'     ],
    /* 4  */ ['mounting /vault  luks-aes256',         'ok'     ],
    /* 5  */ ['spawning sandbox jail',                'ok'     ],
    /* 6  */ ['allocating vram arena',                'ok'     ],
    /* 7  */ ['discovering local models',             'ok'     ],
    /* 8  */ ['loading active model',                 'ok'     ],
    /* 9  */ ['warming kv-cache  8192 ctx',           'ok'     ],
    /* 10 */ ['starting llama-swap daemon',           'ok'     ],
    /* 11 */ ['binding local control socket',         'ok'     ],
    /* 12 */ ['resolving tool manifest',              'ok'     ],
    /* 13 */ ['negotiating tls-1.3',                  'ok'     ],
    /* 14 */ ['exchanging ed25519 keys',              'ok'     ],
    /* 15 */ ['verifying operator key',               'auth'   ],
    /* 16 */ ['opening secure channel',               'ok'     ],
    /* 17 */ ['establishing agent mesh',              'ok'     ],
    /* 18 */ ['sync agents registry  7 nodes',        'ok'     ],
    /* 19 */ ['mounting toolchain',                   'ok'     ],
    /* 20 */ ['indexing workspace  1284 files',       'ok'     ],
    /* 21 */ ['compiling ast cache',                  'ok'     ],
    /* 22 */ ['spinning up omega runtime',            'ok'     ],
    /* 23 */ ['arming watchdog',                      'ok'     ],
    /* 24 */ ['all systems nominal',                  'nominal']
  ];
  var AUTH_TOKEN = '7F3A-C19D-E40B-AA10';
  var HEX16 = '0123456789ABCDEF';

  /* ------------------------------------------------------------------ */
  /*  STATE                                                               */
  /* ------------------------------------------------------------------ */
  var root = null, termBox = null, onlineEl = null, heroEl = null;
  var settleChrome = null, settlePrompt = null, settleFooter = null;
  var globeCanvas = null, globePts = null, globeRaf = null, globeStart = 0;
  var mounted = false, finishing = false, readyArrived = false;
  var startT = 0;
  var timers = [], finishTimers = [];
  var skipKey = null, skipClick = null;
  // Skin-aware boot (UI-10): a user who chose the glassy Modern skin should NOT be shown the CRT
  // phosphor power-on log at every launch (then hard-flipped to the glassy UI). app.html's setSkin
  // persists the choice to localStorage 'ao.skin' before this script runs, so read it and, when
  // Modern, run a short brand-only intro with the terminal boot log suppressed.
  var MODERN = (function () { try { return localStorage.getItem('ao.skin') === 'modern'; } catch (_) { return false; } })();
  var TOKYO  = (function () { try { return localStorage.getItem('ao.skin') === 'tokyo';  } catch (_) { return false; } })();

  window.AOBoot = {
    skip:    function () { requestFinish('skip'); },
    finish:  function () { requestFinish('api');  },
    done:    false,
    __proof: { reason: '', mountedAt: 0, finishedAt: 0, unmountedAt: 0 }
  };

  /* ------------------------------------------------------------------ */
  /*  HELPERS                                                             */
  /* ------------------------------------------------------------------ */
  function now()   { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function ms()    { return now() - startT; }
  function at(delay, fn) { var id = setTimeout(fn, Math.max(0, delay)); timers.push(id); return id; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeOut3(t) { return 1 - Math.pow(1 - t, 3); }

  function padLine(text) {
    /* (text + ' ').padEnd(40, '.') */
    var s = text + ' ';
    while (s.length < 40) s += '.';
    return s;
  }

  function randomHexLike(token) {
    /* scramble: keep dashes, randomise hex chars */
    var s = '';
    for (var i = 0; i < token.length; i++) {
      s += (token[i] === '-') ? '-' : HEX16[Math.floor(Math.random() * 16)];
    }
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  CSS INJECTION                                                       */
  /* ------------------------------------------------------------------ */
  function injectCss() {
    var css = [
      /* ---- overlay root ---- */
      '.aob{position:fixed;inset:0;z-index:3000;overflow:hidden;',
        'background:radial-gradient(ellipse 140% 110% at 50% 40%,',
          '#0c1316 0%,#070a0c 55%,#040506 100%);',
        'font-family:"VT323","Segoe UI Symbol",monospace;',
        'cursor:default;user-select:none;}',
      '.aob *{box-sizing:border-box;}',

      /* ---- CRT scanlines ---- */
      '.aob-scan{position:absolute;inset:-4px;z-index:7;pointer-events:none;',
        'background-image:repeating-linear-gradient(0deg,',
          'rgba(0,0,0,.16) 0,rgba(0,0,0,.16) 1px,transparent 1px,transparent 2px);',
        'animation:aob-scanmove .6s steps(2) infinite;}',
      '@keyframes aob-scanmove{0%{transform:translateY(0)}100%{transform:translateY(2px)}}',

      /* ---- vignette ---- */
      '.aob-vign{position:absolute;inset:0;z-index:8;pointer-events:none;',
        'background:radial-gradient(125% 115% at 50% 50%,',
          'transparent 50%,rgba(0,0,0,.62) 100%);}',

      /* ---- terminal box (boot log) ---- */
      '.aob-term{position:absolute;top:34px;left:56px;right:56px;bottom:34px;',
        'z-index:3;font-size:16px;line-height:1.46;color:#6f7e74;',
        'white-space:pre;overflow:hidden;',
        'transition:opacity .38s ease;}',

      /* ---- caret ---- */
      '.aob-caret{display:inline-block;color:#5fbf7e;',
        'animation:aob-blink .8s steps(1) infinite;}',
      '@keyframes aob-blink{0%,100%{opacity:1}50%{opacity:0}}',

      /* ---- line colour helpers ---- */
      '.aob-hdr{color:#ffc774;}',   /* header amber */
      '.aob-ok{color:#5fbf7e;}',    /* OK green      */
      '.aob-nom{color:#9fb0a6;}',   /* nominal grey  */
      '.aob-gr{color:#5fbf7e;}',    /* granted green */

      /* ---- AGENT ONLINE ---- */
      '.aob-online{position:absolute;left:50%;top:50%;z-index:5;',
        'transform:translate(-50%,-50%);',
        'font-size:30px;letter-spacing:8px;text-align:center;white-space:nowrap;',
        'opacity:0;transition:opacity .22s ease;}',
      '.aob-online-dot{color:#5fbf7e;',
        'text-shadow:0 0 12px rgba(95,191,126,.75);}',
      '.aob-online-txt{color:#ffb454;}',

      /* ---- hero (A/O) ---- */
      '.aob-hero{position:absolute;left:50%;top:50%;z-index:5;',
        'transform:translate(-50%,-50%) perspective(900px) rotateX(90deg);',
        'text-align:center;opacity:0;pointer-events:none;}',
      '.aob-hero-row{display:flex;align-items:baseline;justify-content:center;',
        'font-size:104px;line-height:1;}',
      '.aob-hero-a{color:#e9f2eb;',
        'text-shadow:0 0 2px rgba(220,240,228,.7),0 0 24px rgba(150,210,180,.35);}',
      '.aob-hero-sl{color:#ffb454;',
        'text-shadow:0 0 2px var(--ac),0 0 28px rgba(255,180,84,.55);',
        'transform:translateY(-5px);display:inline-block;}',
      '.aob-hero-o{color:#e9f2eb;',
        'text-shadow:0 0 2px rgba(220,240,228,.7),0 0 24px rgba(150,210,180,.35);}',
      '.aob-hero-tag{font-size:21px;letter-spacing:7px;padding-left:7px;',
        'margin-top:8px;color:#ffb454;',
        'text-shadow:0 0 10px rgba(255,180,84,.42);}',

      /* ---- intro globe canvas ---- */
      '.aob-globe{position:absolute;inset:0;width:100%;height:100%;',
        'z-index:2;pointer-events:none;',
        'opacity:0;transition:opacity .7s ease;}',

      /* ---- settle: mock chrome ---- */
      '.aob-chrome{position:absolute;top:0;left:0;right:0;height:46px;z-index:6;',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:0 13px;background:#0b0e11;border-bottom:1px solid #181f23;',
        'color:#566359;font-size:16px;letter-spacing:.5px;',
        'opacity:0;pointer-events:none;}',

      /* ---- settle: mock prompt box ---- */
      '.aob-prompt{position:absolute;left:50%;z-index:6;',
        'width:680px;max-width:calc(100% - 48px);',
        'border:1px solid #45554d;background:rgba(8,12,10,.5);',
        'box-shadow:inset 0 0 18px rgba(0,0,0,.45);',
        'padding:20px 22px 16px;opacity:0;pointer-events:none;}',
      '.aob-plabel{position:absolute;top:-12px;left:18px;',
        'padding:0 8px;background:#080b0d;',
        'color:#ffb454;font-size:16px;letter-spacing:1px;}',
      '.aob-prow{font-size:23px;min-height:30px;display:flex;',
        'align-items:flex-start;color:#54655b;}',
      '.aob-pmark{color:#ffb454;margin-right:10px;}',

      /* ---- settle: mock footer ---- */
      '.aob-footer{position:absolute;bottom:12px;left:0;right:0;z-index:6;',
        'display:flex;justify-content:space-between;align-items:center;',
        'font-size:20px;color:#46544c;padding:0 44px;',
        'opacity:0;pointer-events:none;}',

      /* ---- reduced motion ---- */
      '@media (prefers-reduced-motion:reduce){',
        '.aob-scan,.aob-caret{animation:none !important;}}'
    ].join('');

    var s = document.createElement('style');
    s.id = 'ao-boot-3-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ */
  /*  DOM BUILD                                                           */
  /* ------------------------------------------------------------------ */
  function build() {
    root = document.createElement('div');
    root.className = 'aob';

    /* globe (z2, behind everything) */
    globeCanvas = document.createElement('canvas');
    globeCanvas.className = 'aob-globe';

    /* terminal box */
    termBox = document.createElement('div');
    termBox.className = 'aob-term';

    /* AGENT ONLINE */
    onlineEl = document.createElement('div');
    onlineEl.className = 'aob-online';
    var dot = document.createElement('span'); dot.className = 'aob-online-dot'; dot.textContent = '● ';
    var txt = document.createElement('span'); txt.className = 'aob-online-txt'; txt.textContent = 'AGENT  ONLINE';
    onlineEl.appendChild(dot); onlineEl.appendChild(txt);

    /* hero — A/O */
    heroEl = document.createElement('div');
    heroEl.className = 'aob-hero';
    var row = document.createElement('div'); row.className = 'aob-hero-row';
    var aEl = document.createElement('span'); aEl.className = 'aob-hero-a'; aEl.textContent = 'A';
    var sl = document.createElement('span');  sl.className = 'aob-hero-sl'; sl.textContent = '/';
    var oEl = document.createElement('span'); oEl.className = 'aob-hero-o'; oEl.textContent = 'O';
    row.appendChild(aEl); row.appendChild(sl); row.appendChild(oEl);
    var tag = document.createElement('div'); tag.className = 'aob-hero-tag'; tag.textContent = '/agent-omega';
    heroEl.appendChild(row); heroEl.appendChild(tag);

    /* settle chrome */
    settleChrome = document.createElement('div');
    settleChrome.className = 'aob-chrome';
    var chromL = document.createElement('div');
    chromL.style.cssText = 'display:flex;align-items:center;gap:9px;';
    var chromBar = document.createElement('span');
    chromBar.style.cssText = 'color:#3f4a44;font-size:18px;';
    chromBar.textContent = '▌';
    var chromBrand = document.createElement('span');
    chromBrand.style.cssText = 'color:#9fb0a6;letter-spacing:.5px;';
    chromBrand.textContent = 'agent-omega';
    // no fake git branch — the corrected live titlebar shows only the workspace, not a hardcoded '— main'
    chromL.appendChild(chromBar); chromL.appendChild(chromBrand);
    var chromR = document.createElement('div');
    chromR.style.cssText = 'display:flex;align-items:center;gap:15px;color:#3f4a44;font-size:15px;';
    chromR.innerHTML = '<span>—</span><span>▢</span><span style="color:#7a564a;">✕</span>';
    settleChrome.appendChild(chromL); settleChrome.appendChild(chromR);

    /* settle prompt box */
    settlePrompt = document.createElement('div');
    settlePrompt.className = 'aob-prompt';
    var plabel = document.createElement('span'); plabel.className = 'aob-plabel'; plabel.textContent = 'prompt';
    var prow   = document.createElement('div');  prow.className = 'aob-prow';
    var pmark  = document.createElement('span'); pmark.className = 'aob-pmark'; pmark.textContent = '>';
    var phint  = document.createElement('span'); phint.style.color = '#54655b'; phint.textContent = 'ask anything…';
    prow.appendChild(pmark); prow.appendChild(phint);
    settlePrompt.appendChild(plabel); settlePrompt.appendChild(prow);

    /* settle footer */
    settleFooter = document.createElement('div');
    settleFooter.className = 'aob-footer';
    // left slot mirrors the live home footer's workspace path, which is empty until a real workdir
    // arrives — no hardcoded '~/dev/agent-omega' placeholder
    var fL = document.createElement('span');
    var fR = document.createElement('span'); fR.textContent = 'agent-omega · v2.7.1';
    settleFooter.appendChild(fL); settleFooter.appendChild(fR);

    /* CRT overlays (highest z) */
    var scan = document.createElement('div'); scan.className = 'aob-scan';
    var vign = document.createElement('div'); vign.className = 'aob-vign';

    root.appendChild(globeCanvas);
    root.appendChild(termBox);
    root.appendChild(onlineEl);
    root.appendChild(heroEl);
    root.appendChild(settleChrome);
    root.appendChild(settlePrompt);
    root.appendChild(settleFooter);
    root.appendChild(scan);
    root.appendChild(vign);

    document.body.appendChild(root);
  }

  /* ------------------------------------------------------------------ */
  /*  BOOT LINE RENDERING                                                 */
  /* ------------------------------------------------------------------ */
  function appendToTerm(el) {
    /* remove caret if present, append el, re-append caret */
    var caret = termBox.querySelector('.aob-caret');
    if (caret) caret.parentNode.removeChild(caret);
    termBox.appendChild(el);
    /* re-add caret after the new line */
    if (!finishing) {
      var c = document.createElement('span');
      c.className = 'aob-caret';
      c.textContent = '█';
      termBox.appendChild(c);
    }
  }

  function addOkLine(text) {
    var span = document.createElement('span');
    /* label part */
    span.appendChild(document.createTextNode(padLine(text)));
    /* OK badge */
    var ok = document.createElement('span');
    ok.className = 'aob-ok';
    ok.textContent = ' OK';
    span.appendChild(ok);
    span.appendChild(document.createTextNode('\n'));
    appendToTerm(span);
  }

  function addHeaderLine(text) {
    var span = document.createElement('span');
    var h = document.createElement('span');
    h.className = 'aob-hdr';
    h.textContent = text;
    span.appendChild(h);
    span.appendChild(document.createTextNode('\n'));
    appendToTerm(span);
  }

  function addNominalLine(text) {
    var span = document.createElement('span');
    var n = document.createElement('span');
    n.className = 'aob-nom';
    n.textContent = text;
    span.appendChild(n);
    span.appendChild(document.createTextNode('\n'));
    /* remove caret entirely on last line */
    var caret = termBox.querySelector('.aob-caret');
    if (caret) caret.parentNode.removeChild(caret);
    termBox.appendChild(span);
  }

  function addAuthLine(text) {
    var span = document.createElement('span');
    span.appendChild(document.createTextNode(padLine(text)));
    /* dynamic value span */
    var valSpan = document.createElement('span');
    valSpan.textContent = randomHexLike(AUTH_TOKEN);
    span.appendChild(valSpan);
    span.appendChild(document.createTextNode('\n'));
    appendToTerm(span);
    /* kick off scramble → lock animation */
    startAuthAnim(valSpan);
  }

  function startAuthAnim(valSpan) {
    /* Phase 1: pure scramble for 300ms
       Phase 2: lock chars one by one over the remaining ~400ms
       Phase 3: append GRANTED */
    var token    = AUTH_TOKEN;
    var phase2Start = 300;                         // ms from auth-line add
    var lockMs   = AUTH_LOCK_MS - phase2Start;     // ~400ms for locking
    var perChar  = lockMs / token.length;          // ~21ms per char
    var t0       = performance.now();

    function tick() {
      if (finishing) return;
      var elapsed_ms = performance.now() - t0;

      if (elapsed_ms < phase2Start) {
        /* scramble */
        valSpan.textContent = randomHexLike(token);
        setTimeout(tick, 40);
        return;
      }

      /* lock phase */
      var locked = Math.min(Math.floor((elapsed_ms - phase2Start) / perChar), token.length);
      if (locked >= token.length) {
        /* fully locked → show GRANTED */
        valSpan.textContent = token + '   ';
        var g = document.createElement('span');
        g.className = 'aob-gr';
        g.textContent = 'GRANTED';
        if (valSpan.parentNode) valSpan.parentNode.insertBefore(g, valSpan.nextSibling);
        return;
      }
      /* build: locked prefix + scrambled suffix */
      var s = token.slice(0, locked);
      for (var i = locked; i < token.length; i++) {
        s += (token[i] === '-') ? '-' : HEX16[Math.floor(Math.random() * 16)];
      }
      valSpan.textContent = s;
      setTimeout(tick, 40);
    }

    setTimeout(tick, 0);
  }

  function addBootLine(idx) {
    if (finishing) return;
    var spec = BOOT_LINES[idx], text = spec[0], type = spec[1];
    if      (type === 'header')  addHeaderLine(text);
    else if (type === 'nominal') addNominalLine(text);
    else if (type === 'auth')    addAuthLine(text);
    else                         addOkLine(text);
  }

  /* ------------------------------------------------------------------ */
  /*  GLOBE  (adapted from omega-globe.js; smaller R, cy=0.45, base=0.26)*/
  /* ------------------------------------------------------------------ */
  function buildGlobePts() {
    var S = 220;
    var off = document.createElement('canvas');
    off.width = S; off.height = S;
    var ctx2 = off.getContext('2d');
    ctx2.fillStyle = '#fff';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.font = 'bold 190px Georgia,"Times New Roman",serif';
    ctx2.fillText('Ω', S / 2, S / 2 + 8);
    var d = ctx2.getImageData(0, 0, S, S).data;
    var flat = [], step = 3;
    for (var y = 0; y < S; y += step)
      for (var x = 0; x < S; x += step)
        if (d[(y * S + x) * 4 + 3] > 130)
          flat.push({ x: (x - S / 2) / (S / 2), y: (y - S / 2) / (S / 2) });
    var D = 0.1, COPIES = 3, out = [];
    for (var i = 0; i < flat.length; i++)
      for (var k = 0; k < COPIES; k++)
        out.push({ x: flat[i].x, y: flat[i].y, z: (Math.random() * 2 - 1) * D });
    return out;
  }

  function accentRgb() {
    // Boot is a deliberate retro CRT takeover in both skins: keep the globe fixed
    // amber to match the hardcoded boot text (retro -> modern reveal happens after).
    return '255,180,84';
  }

  function drawGlobe() {
    if (!globeCanvas || !root || !root.parentNode) { globeRaf = null; return; }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = globeCanvas.clientWidth, h = globeCanvas.clientHeight;
    if (w && h) {
      if (globeCanvas.width !== Math.round(w * dpr)) {
        globeCanvas.width  = Math.round(w * dpr);
        globeCanvas.height = Math.round(h * dpr);
      }
      var ctx = globeCanvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!globePts) globePts = buildGlobePts();

      var t   = (performance.now() - globeStart) / 1000;
      var app = clamp(t / (GLOBE_FADE / 1000), 0, 1);
      var R   = Math.min(w, h) * 0.34 * (0.72 + 0.28 * app);
      var cx  = w / 2, cy = h * 0.45;
      var spin = (1 - Math.exp(-t / 0.9)) * 2 + t * 0.5;
      var cs = Math.cos(spin), sn = Math.sin(spin);
      var TILT = 20 * Math.PI / 180, ct = Math.cos(TILT), st = Math.sin(TILT);
      var F = 3.0, base = 0.26;
      var rgb = accentRgb();
      var back = [], front = [];
      var pts = globePts;
      for (var i = 0; i < pts.length; i++) {
        var p  = pts[i];
        var lx = p.x, ly = -p.y, lz = p.z;
        var x1 = lx * cs + lz * sn, z1 = -lx * sn + lz * cs;
        var y2 = ly * ct - z1 * st, z2 = ly * st + z1 * ct;
        var persp = F / (F - z2);
        var px = cx + x1 * R * persp, py = cy - y2 * R * persp;
        var fr = (z2 + 1) / 2;
        var a  = base * app * (0.14 + 0.86 * fr * fr);
        var ds = 1.1 * persp;
        (z2 >= 0 ? front : back).push([px, py, a, ds]);
      }
      var j, dd;
      for (j = 0; j < back.length;  j++) { dd=back[j];  ctx.fillStyle='rgba('+rgb+','+dd[2]+')'; ctx.fillRect(dd[0],dd[1],dd[3],dd[3]); }
      for (j = 0; j < front.length; j++) { dd=front[j]; ctx.fillStyle='rgba('+rgb+','+dd[2]+')'; ctx.fillRect(dd[0],dd[1],dd[3],dd[3]); }
    }
    globeRaf = requestAnimationFrame(drawGlobe);
  }

  /* ------------------------------------------------------------------ */
  /*  FLIP  (X-axis: ONLINE flips out, hero flips in)                    */
  /* ------------------------------------------------------------------ */
  function runFlip() {
    var t0 = performance.now();
    function frame() {
      if (finishing) return;
      var fp = clamp((performance.now() - t0) / FLIP_DUR, 0, 1);

      /* ONLINE flips out: rotateX 0 → -90deg (first half of fp) */
      var onAngle  = -90 * Math.min(fp / 0.5, 1);
      var onOpacity = fp < 0.5 ? 1 : 0;
      onlineEl.style.transform = 'translate(-50%,-50%) perspective(900px) rotateX(' + onAngle + 'deg)';
      onlineEl.style.opacity   = '' + onOpacity;

      /* Hero flips in: rotateX 90 → 0 (second half of fp) */
      if (fp >= 0.5) {
        var heroAngle = 90 * (1 - (fp - 0.5) / 0.5);
        heroEl.style.opacity   = '1';
        heroEl.style.transform = 'translate(-50%,-50%) perspective(900px) rotateX(' + heroAngle + 'deg)';
      }

      if (fp < 1) { requestAnimationFrame(frame); return; }
      /* flip complete */
      onlineEl.style.opacity   = '0';
      heroEl.style.opacity     = '1';
      heroEl.style.transform   = 'translate(-50%,-50%)';
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ */
  /*  SETTLE  (chrome + prompt + footer slide up around the hero)        */
  /* ------------------------------------------------------------------ */
  function runSettle() {
    /* position the prompt box at ~55% of viewport height */
    settlePrompt.style.top = '55%';
    settlePrompt.style.transform = 'translateX(-50%) translateY(22px)';

    var t0 = performance.now();
    function frame() {
      if (finishing) return;
      var fp = clamp((performance.now() - t0) / SETTLE_DUR, 0, 1);
      var ep = easeOut3(fp);

      /* hero rises by settleP * 66px */
      heroEl.style.transform = 'translate(-50%,calc(-50% - ' + (ep * 66) + 'px))';

      /* chrome slides in from top */
      settleChrome.style.opacity   = '' + ep;
      settleChrome.style.transform = 'translateY(' + ((ep - 1) * 8) + 'px)';

      /* prompt fades up (starts 22px low) */
      settlePrompt.style.opacity   = '' + ep;
      settlePrompt.style.transform = 'translateX(-50%) translateY(' + ((1 - ep) * 22) + 'px)';

      /* footer fades up */
      settleFooter.style.opacity = '' + ep;

      if (fp < 1) { requestAnimationFrame(frame); return; }

      /* settle complete → begin unmount sequence */
      if (!finishing && mounted) {
        finishing = true;
        window.AOBoot.__proof.reason    = 'complete';
        window.AOBoot.__proof.finishedAt = now();
        teardownSkip();
        clearTimers();
        if (globeRaf) { cancelAnimationFrame(globeRaf); globeRaf = null; }
        finishTimers.push(setTimeout(function () { crossfadeAndUnmount(DONE_FADE); }, POST_SETTLE));
      }
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ */
  /*  SEQUENCE                                                            */
  /* ------------------------------------------------------------------ */
  /* Modern skin: a brief brand-only intro (Ω globe + AGENT ONLINE) on a clean dark backdrop
     instead of the CRT phosphor boot log, then hand off to the app's own glassy reveal (UI-10). */
  function playModern() {
    try { root.classList.add('aob-modern'); root.style.background = '#0b0d10'; } catch (_) {}
    if (termBox) termBox.style.display = 'none';   // suppress the phosphor boot log entirely
    window.AOBoot.__proof.modern = true;
    at(40, function () {
      if (finishing) return;
      if (onlineEl) onlineEl.style.opacity = '1';
      try { globeStart = performance.now(); globeCanvas.style.opacity = '1'; drawGlobe(); } catch (_) {}
    });
    at(760, function () { requestFinish('modern'); });
    at(MAX_HOLD, function () { requestFinish('timeout'); });
  }

  /* Tokyo Dream: a light daylight skin — no CRT phosphor boot, no dark flash.
     Wash the overlay to paper, suppress the terminal log + globe + ONLINE +
     hero cards, hold a calm beat, then hand off to the app's light home. */
  function playTokyo() {
    try { root.classList.add('aob-tokyo'); root.style.background = '#FAF6EE'; } catch (_) {}
    if (termBox) termBox.style.display = 'none';
    try { var sc = root.querySelector('.aob-scan'); if (sc) sc.style.display = 'none'; } catch (_) {}
    try { var vg = root.querySelector('.aob-vign'); if (vg) vg.style.display = 'none'; } catch (_) {}
    try { if (globeCanvas) globeCanvas.style.display = 'none'; } catch (_) {}
    try { if (onlineEl) onlineEl.style.display = 'none'; } catch (_) {}
    try { if (heroEl) heroEl.style.display = 'none'; } catch (_) {}
    window.AOBoot.__proof.tokyo = true;
    at(420, function () { requestFinish('tokyo'); });
    at(MAX_HOLD, function () { requestFinish('timeout'); });
  }

  function play() {
    startT = now();
    mounted = true;
    window.AOBoot.__proof.mountedAt = startT;
    if (TOKYO) { playTokyo(); return; }
    if (MODERN) { playModern(); return; }

    /* stream boot lines */
    for (var i = 0; i < NUM_LINES; i++) {
      (function (idx) {
        at(BOOT0 + idx * STEP, function () { addBootLine(idx); });
      })(i);
    }

    /* fade out terminal log */
    at(T.LAST_T + LOG_FADE_OFF, function () {
      if (finishing) return;
      /* remove caret immediately */
      var c = termBox.querySelector('.aob-caret');
      if (c) c.parentNode.removeChild(c);
      termBox.style.opacity = '0';
    });

    /* AGENT ONLINE fades in */
    at(T.ONLINE_AT, function () {
      if (finishing) return;
      onlineEl.style.opacity = '1';
    });

    /* X-axis FLIP */
    at(T.FLIP0, function () {
      if (finishing) return;
      runFlip();
    });

    /* Ω globe fades in */
    at(T.GLOBE_AT, function () {
      if (finishing) return;
      globeStart = performance.now();
      globeCanvas.style.opacity = '1';   /* CSS transition does the .7s fade */
      drawGlobe();
    });

    /* SETTLE */
    at(T.SETTLE0, function () {
      if (finishing) return;
      runSettle();
    });

    /* hard cap */
    at(MAX_HOLD, function () { requestFinish('timeout'); });
  }

  /* ------------------------------------------------------------------ */
  /*  FINISH / UNMOUNT                                                    */
  /* ------------------------------------------------------------------ */
  function requestFinish(reason) {
    if (finishing || !mounted) return;
    finishing = true;
    window.AOBoot.__proof.reason     = reason;
    window.AOBoot.__proof.finishedAt = now();
    clearTimers();
    teardownSkip();
    if (globeRaf) { cancelAnimationFrame(globeRaf); globeRaf = null; }
    crossfadeAndUnmount((reason === 'skip') ? SKIP_FADE : DONE_FADE);
  }

  // Seamless hand-off: cross-fade the live app IN (.win, 0->1) while the boot overlay fades OUT, so the
  // settled mock DISSOLVES into the real UI instead of the real screen popping through (the seam the user
  // noticed). The overlay bg is opaque, so starting .win at 0 can't flash black. Shared by BOTH the
  // natural settle-complete path AND requestFinish (skip / api / timeout / modern).
  function crossfadeAndUnmount(dur) {
    var appEl = document.querySelector('.win');
    if (appEl) {
      appEl.style.transition = 'none';                           // commit opacity:0 with NO transition first...
      appEl.style.opacity = '0';
      void appEl.offsetWidth;                                    // ...force a style resolve so 0 is the transition baseline...
      requestAnimationFrame(function () {                        // ...then next frame turn the transition on and fade to 1
        appEl.style.transition = 'opacity ' + (dur / 1000) + 's ease';
        appEl.style.opacity = '1';
      });
    }
    root.style.transition = 'opacity ' + (dur / 1000) + 's ease';
    root.style.opacity    = '0';
    finishTimers.push(setTimeout(unmount, dur + 40));
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    window.AOBoot.__proof.unmountedAt = now();
    window.AOBoot.done = true;
    finishTimers.forEach(clearTimeout); finishTimers = [];
    var appEl = document.querySelector('.win');   // clear the cross-fade inline styles so transition/opacity don't linger on the app root
    if (appEl) { appEl.style.transition = ''; appEl.style.opacity = ''; }
    try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (_) {}
    try { if (typeof window.focusActive === 'function') window.focusActive(); } catch (_) {}
  }

  /* ------------------------------------------------------------------ */
  /*  SKIP + WS WIRING                                                    */
  /* ------------------------------------------------------------------ */
  function setupSkip() {
    skipKey = function (e) {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      e.preventDefault(); e.stopImmediatePropagation();
      requestFinish('skip');
    };
    skipClick = function (e) {
      e.preventDefault(); e.stopPropagation();
      requestFinish('skip');
    };
    window.addEventListener('keydown', skipKey, true);
    if (root) root.addEventListener('mousedown', skipClick, true);
  }

  function teardownSkip() {
    try { window.removeEventListener('keydown', skipKey, true); } catch (_) {}
    try { if (root) root.removeEventListener('mousedown', skipClick, true); } catch (_) {}
    skipKey = skipClick = null;
  }

  function onReady() {
    if (readyArrived) return;
    readyArrived = true;
    /* ready has no timing effect in this intro — the sequence is fixed-length
       and self-completes. The hook is kept for API compatibility. */
  }

  function wireWs() {
    if (window.__aoBootWsWrapped) return true;
    if (typeof window.onWs !== 'function') return false;
    window.__aoBootWsWrapped = true;
    var orig = window.onWs;
    window.onWs = function (m) {
      try { if (m && m.type === 'ready') onReady(m); } catch (_) {}
      return orig.apply(this, arguments);
    };
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  BOOT                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    injectCss();
    build();
    setupSkip();
    if (!wireWs()) {
      /* onWs not yet defined — retry briefly (handles odd load orders) */
      var tries = 0;
      var iv = setInterval(function () {
        if (wireWs() || ++tries > 40) clearInterval(iv);
      }, 50);
    }
    play();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
