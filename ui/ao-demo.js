/* ao-demo.js — offline scripted-session playback.
   The app only shows the conversation UI when a model/sidecar is connected;
   in a no-backend preview it sits on the home screen. This plays a realistic
   scripted turn (user → thinking → tool → diff → streamed reply) so the
   conversation surfaces can be seen without a backend.

   Trigger:  /demo   (slash command)  ·  window.aoDemo()  ·  window.aoDemo.stop()
   Skin-agnostic — uses the same DOM the engine drives, so it renders in
   CRT / Modern / Tokyo alike. Purely a preview aid; a real `ready` + reply
   from the sidecar overwrites it. */
(function () {
  var timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers.length = 0; }
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

  var SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

  function play() {
    var home = document.getElementById('home');
    var chat = document.getElementById('chat');
    var log = document.getElementById('log');
    if (!chat || !log) return 'demo: chat DOM not found';
    clearTimers();

    // reveal the conversation view
    if (home) home.classList.add('hidden');
    chat.classList.remove('hidden');
    log.innerHTML = '';

    function add(html) {
      var d = document.createElement('div');
      d.innerHTML = String(html).trim();
      var el = d.firstElementChild;
      log.appendChild(el);
      return el;
    }
    function scroll() {
      var c = document.getElementById('convo');
      if (c) c.scrollTop = c.scrollHeight;
    }

    // 1 — user prompt
    add('<div class="urow"><span class="ac">&gt;</span><span class="utext">add a /skin command that cycles crt \u2192 modern \u2192 tokyo</span></div>');
    scroll();

    // 2 — thinking (animated)
    var think;
    at(500, function () {
      think = add('<div class="think"><span class="pk"><span class="spin"></span></span>&nbsp;thinking</div>');
      scroll();
    });

    // 3 — thought settles + tool starts (spinner)
    var tool, si = 0, spinTimer;
    at(2600, function () {
      if (think) think.outerHTML =
        '<div class="think think-done collapsed"><div class="pk"><span class="thchev">\u25b8</span>&nbsp;thought for 2s</div>' +
        '<div class="body">the setSkin fn already takes an id; I\'ll add a slash handler that reads the active skin, advances to the next in order, and persists it.</div></div>';
      tool = add('<div class="toolwrap"><div class="toolline"><span class="tglyph tgl">\u280b</span><span class="tname">Edit</span>&nbsp;<span class="tsub">command-discovery.js</span></div></div>');
      var g = tool.querySelector('.tgl');
      spinTimer = setInterval(function () { g.textContent = SPIN[si = (si + 1) % SPIN.length]; }, 90);
      timers.push({ __interval: spinTimer });
      scroll();
    });

    // 4 — tool done + diff
    at(4200, function () {
      clearInterval(spinTimer);
      var g = tool && tool.querySelector('.tgl'); if (g) g.textContent = '\u25a3';
      if (tool) tool.querySelector('.toolline').insertAdjacentHTML('beforeend', '<span class="ttime">1.2s</span>');
      add(
        '<div class="diff">' +
        '<div class="dk-row dk-row-ctx"><span class="dk-num">61</span><span class="dk-sign dk-sign-ctx"> </span><span class="dk-code"><span class="tk-keyword">const</span> order = [<span class="tk-string">\'crt\'</span>, <span class="tk-string">\'modern\'</span>, <span class="tk-string">\'tokyo\'</span>];</span></div>' +
        '<div class="dk-row dk-row-del"><span class="dk-num">62</span><span class="dk-sign dk-sign-del">-</span><span class="dk-code"><span class="tk-keyword">const</span> next = cur === <span class="tk-string">\'crt\'</span> ? <span class="tk-string">\'modern\'</span> : <span class="tk-string">\'crt\'</span>;</span></div>' +
        '<div class="dk-row dk-row-add"><span class="dk-num">62</span><span class="dk-sign dk-sign-add">+</span><span class="dk-code"><span class="tk-keyword">const</span> next = order[(order.indexOf(cur) + <span class="tk-number">1</span>) % order.length];</span></div>' +
        '<div class="dk-foot"><span class="dk-add">+1</span><span class="dk-del">-1</span><span class="dk-file">command-discovery.js</span></div>' +
        '</div>'
      );
      scroll();
    });

    // 5 — streamed reply
    at(5000, function () {
      var a = add('<div class="arow"></div>');
      var lines = [
        'done \u2014 <span class="tk-string">/skin</span> now cycles through all three:',
        '<span style="color:var(--ac)">&gt;</span> reads the active <span class="tk-default">body.theme-*</span> class',
        '<span style="color:var(--ac)">&gt;</span> advances crt \u2192 modern \u2192 tokyo and wraps',
        '<span style="color:var(--ac)">&gt;</span> persists to <span class="tk-default">localStorage</span> so it sticks on reload'
      ];
      var li = 0;
      var t = setInterval(function () {
        if (li >= lines.length) { clearInterval(t); return; }
        var d = document.createElement('div');
        d.innerHTML = lines[li++];
        a.appendChild(d);
        scroll();
      }, 750);
      timers.push({ __interval: t });
    });

    return 'demo playing';
  }

  play.stop = function () {
    clearTimers();
    // best-effort clear of any running intervals stashed above
  };

  window.aoDemo = play;
})();
