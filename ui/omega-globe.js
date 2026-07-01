// omega-globe.js — the signature Ω: a volumetric 3D dot-cloud of the Omega glyph spinning on the
// vertical axis behind the wordmark, depth-shaded, tinted to the live accent (--ac). Canvas-2D.
// Ported from the Agent Omega CRT design file. Self-mounting on <canvas id="omegaGlobe">.
(function () {
  let pts = null, start = 0, raf = null

  function hexToRgb(hex) {
    const h = (hex || '#ffb454').replace('#', '').trim()
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
  }

  // render the Ω glyph to an offscreen canvas, sample opaque pixels, then extrude them in depth
  // (COPIES at random z) so it reads as one solid 3D body rather than a flat sheet
  function buildPoints() {
    const S = 220, off = document.createElement('canvas')
    off.width = S; off.height = S
    const c = off.getContext('2d')
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'
    c.font = 'bold 190px Georgia, "Times New Roman", serif'
    c.fillText('Ω', S / 2, S / 2 + 8)
    const d = c.getImageData(0, 0, S, S).data, flat = [], step = 3
    for (let y = 0; y < S; y += step)
      for (let x = 0; x < S; x += step)
        if (d[(y * S + x) * 4 + 3] > 130) flat.push({ x: (x - S / 2) / (S / 2), y: (y - S / 2) / (S / 2) })
    const D = 0.1, COPIES = 3, out = []
    for (let i = 0; i < flat.length; i++)
      for (let k = 0; k < COPIES; k++) out.push({ x: flat[i].x, y: flat[i].y, z: (Math.random() * 2 - 1) * D })
    return out
  }

  function accent() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ac').trim()
    return v || '#ffb454'
  }

  function draw() {
    const c = document.getElementById('omegaGlobe')
    if (!c) { raf = null; return }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = c.clientWidth, h = c.clientHeight
    if (w && h) {
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!pts) pts = buildPoints()
      const t = (performance.now() - start) / 1000
      const spin = (1 - Math.exp(-t / 1.0)) * 2.0 + t * 0.5        // quick spin-up, then ~12s/rev drift
      const cs = Math.cos(spin), sn = Math.sin(spin)
      const TILT = 20 * Math.PI / 180, ct = Math.cos(TILT), st = Math.sin(TILT)
      const cx = w / 2, cy = h * 0.44, R = Math.min(w, h) * 0.461, F = 3.0
      const rgb = hexToRgb(accent()), appear = Math.min(1, t / 0.8), base = 0.22
      const back = [], front = []
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], lx = p.x, ly = -p.y, lz = p.z
        const x1 = lx * cs + lz * sn, z1 = -lx * sn + lz * cs       // spin about the vertical axis
        const y2 = ly * ct - z1 * st, z2 = ly * st + z1 * ct        // 20deg axial tilt
        const persp = F / (F - z2)
        const px = cx + x1 * R * persp, py = cy - y2 * R * persp
        const fr = (z2 + 1) / 2                                     // 0 far, 1 near
        const a = base * appear * (0.14 + 0.86 * fr * fr)           // depth shading
        const ds = 1.1 * persp
        ;(z2 >= 0 ? front : back).push([px, py, a, ds])
      }
      for (const dd of back) { ctx.fillStyle = `rgba(${rgb},${dd[2]})`; ctx.fillRect(dd[0], dd[1], dd[3], dd[3]) }
      for (const dd of front) { ctx.fillStyle = `rgba(${rgb},${dd[2]})`; ctx.fillRect(dd[0], dd[1], dd[3], dd[3]) }
    }
    raf = requestAnimationFrame(draw)
  }

  function startGlobe() {
    if (!document.getElementById('omegaGlobe')) { requestAnimationFrame(startGlobe); return }
    start = performance.now()
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(draw)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startGlobe)
  else startGlobe()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0 } }   // don't burn 60fps off-screen / minimized
    else if (!raf) { raf = requestAnimationFrame(draw) }
  })
})()
