// Agent Omega — macOS shell (Swift + WKWebView). The native counterpart of the
// Windows Program.cs (WinForms + WebView2). Job, 1:1 with Windows:
//   1. generate a per-launch WS token
//   2. spawn `node sidecar.mjs <WORKDIR> <PORT>` with AO_WS_TOKEN, kill it on close
//   3. host a frameless window loading ui/app.html?ws=<port>&token=<token>
//   4. bridge window-control messages back from the UI (re-create window.chrome.webview)
//   5. harden the webview (no popups, nav locked to file://, no context menu/devtools)
// The UI + sidecar are unchanged; only this host is per-OS.
import AppKit
import WebKit
import Foundation

// ---- paths / launch config (dev build uses absolute paths; packaging resolves these later)
// Resource root: inside AgentOmega.app -> Contents/Resources; dev (bare binary) -> the repo.
let RES: String = {
    let fm = FileManager.default
    if let r = Bundle.main.resourceURL?.path, fm.fileExists(atPath: r + "/ui/app.html") { return r }
    return "/Users/user/agent-omega"   // dev fallback for bare-binary runs
}()
let APP_DIR  = RES
let UI_DIR   = RES + "/ui"
let SIDECAR  = RES + "/sidecar.mjs"
let WORKDIR  = NSHomeDirectory() + "/.agent-omega/workspace"
// node is off the GUI PATH; resolve an absolute path (fall back to `env node`).
func resolveNode() -> (String, [String]) {
    let fm = FileManager.default
    for c in ["\(NSHomeDirectory())/.local/node/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where fm.isExecutableFile(atPath: c) { return (c, []) }
    return ("/usr/bin/env", ["node"])
}
let WS_PORT  = 4599
let WS_TOKEN = UUID().uuidString                            // only the real window gets it
let BG       = NSColor(red: 7/255.0, green: 9/255.0, blue: 11/255.0, alpha: 1)

// Re-create the WebView2 `window.chrome.webview` surface the UI expects:
//  - postMessage(obj)  -> native host (WKScriptMessageHandler "host")   [window controls]
//  - addEventListener('message', fn) -> stored; host->page replies via _emit (api-get is a
//    dead/no-op path on Windows too, so this just must not throw)
// Also kill the right-click context menu (Windows disables AreDefaultContextMenusEnabled).
let SHIM_JS = """
(function(){
  if (!window.chrome) window.chrome = {};
  var listeners = [];
  window.chrome.webview = {
    postMessage: function(o){ try { window.webkit.messageHandlers.host.postMessage(o); } catch(e){} },
    addEventListener: function(type, fn){ if (type === 'message' && typeof fn === 'function') listeners.push(fn); },
    removeEventListener: function(type, fn){ if (type === 'message'){ var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
    _emit: function(data){ var ev = { data: data }; listeners.slice().forEach(function(fn){ try { fn(ev); } catch(e){} }); }
  };
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); }, true);
})();
"""

final class Shell: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var sidecar: Process?
    var maximized = false
    var restoreFrame = NSRect.zero

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(atPath: WORKDIR, withIntermediateDirectories: true)

        // Window: looks frameless (transparent/hidden titlebar, native buttons hidden — the
        // HTML titlebar draws its own controls), but stays .titled so it can become key for
        // text input and gets native edge-resize for free (replaces Program.cs's WM_NCHITTEST).
        let rect = NSRect(x: 0, y: 0, width: 1120, height: 720)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Agent Omega"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = BG
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 760, height: 480)
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.center()

        // WebView + hardening
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "host")
        ucc.addUserScript(WKUserScript(source: SHIM_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc
        web = WKWebView(frame: rect, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        web.underPageBackgroundColor = BG          // no white flash before app.html paints
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)

        startSidecar()
        loadUI()

        // Autonomous-verify hook: AO_SHELL_TESTSHOT=<seconds> -> fast-forward the boot intro
        // (its rAF/timers get throttled when this test window isn't frontmost), then snapshot
        // the revealed live home and quit.
        if let s = ProcessInfo.processInfo.environment["AO_SHELL_TESTSHOT"], let secs = Double(s) {
            let turn = ProcessInfo.processInfo.environment["AO_SHELL_TURN"]
            let snap: (Double) -> Void = { delay in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self.web.takeSnapshot(with: WKSnapshotConfiguration()) { img, _ in
                        if let img = img, let tiff = img.tiffRepresentation,
                           let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: APP_DIR + "/_smoke/shell-shot.png"))
                            print("SHELL_SNAPSHOT_OK")
                        }
                        NSApp.terminate(nil)
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) {
                self.web.evaluateJavaScript("try { if (window.AOBoot && !window.AOBoot.done) window.AOBoot.finish(); 'ok' } catch (e) { String(e) }") { r, _ in
                    print("BOOT_FINISH \(r ?? "nil")")
                    if let turn = turn, !turn.isEmpty {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                            self.web.evaluateJavaScript("try { window.send('\(turn)'); 'sent' } catch (e) { String(e) }") { rr, _ in print("TURN_SEND \(rr ?? "nil")") }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 20.0) {
                                self.web.evaluateJavaScript("try { var c=document.querySelector('.convo'); if(c) c.scrollTop=c.scrollHeight; var t=(c&&c.innerText)||document.body.innerText||''; t.slice(-700) } catch(e){ 'ERR '+e }") { rb, _ in
                                    print("CONVO_TEXT >>>"); print((rb as? String) ?? "nil"); print("<<<")
                                    self.web.takeSnapshot(with: WKSnapshotConfiguration()) { img, _ in
                                        if let img = img, let tiff = img.tiffRepresentation,
                                           let rep = NSBitmapImageRep(data: tiff),
                                           let png = rep.representation(using: .png, properties: [:]) {
                                            try? png.write(to: URL(fileURLWithPath: APP_DIR + "/_smoke/shell-shot.png"))
                                            print("SHELL_SNAPSHOT_OK")
                                        }
                                        NSApp.terminate(nil)
                                    }
                                }
                            }
                        }
                    } else {
                        snap(3.5)
                    }
                }
            }
        }
    }

    func loadUI() {
        var comp = URLComponents()
        comp.scheme = "file"
        comp.path = UI_DIR + "/app.html"
        comp.queryItems = [URLQueryItem(name: "ws", value: String(WS_PORT)),
                           URLQueryItem(name: "token", value: WS_TOKEN)]
        guard let url = comp.url else { return }
        web.loadFileRequest(URLRequest(url: url),
                            allowingReadAccessTo: URL(fileURLWithPath: APP_DIR, isDirectory: true))
    }

    func startSidecar() {
        let p = Process()
        let (nodeExe, nodePre) = resolveNode()
        p.executableURL = URL(fileURLWithPath: nodeExe)
        var sidecarArgs = nodePre + [SIDECAR, WORKDIR, String(WS_PORT)]
        if let dm = ProcessInfo.processInfo.environment["AO_DEFAULT_MODEL"], !dm.isEmpty { sidecarArgs.append(dm) }
        p.arguments = sidecarArgs
        p.currentDirectoryURL = URL(fileURLWithPath: APP_DIR)
        var env = ProcessInfo.processInfo.environment
        env["AO_WS_TOKEN"] = WS_TOKEN
        p.environment = env
        FileManager.default.createFile(atPath: "/tmp/ao-sidecar.log", contents: nil)
        if let log = FileHandle(forWritingAtPath: "/tmp/ao-sidecar.log") {
            p.standardOutput = log
            p.standardError = log
        }
        do { try p.run(); sidecar = p; print("SIDECAR_STARTED pid \(p.processIdentifier)") }
        catch { print("SIDECAR_FAIL \(error)") }
    }

    // Window controls from the HTML titlebar — mirrors Program.cs OnUiMessage.
    func userContentController(_ ucc: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard msg.name == "host" else { return }
        var type: String?
        if let d = msg.body as? [String: Any] { type = d["type"] as? String }
        else if let s = msg.body as? String { type = s }
        guard let t = type else { return }
        switch t {
        case "close": NSApp.terminate(nil)
        case "minimize": window.miniaturize(nil)
        case "maximize":
            if maximized { window.setFrame(restoreFrame, display: true, animate: false); maximized = false }
            else {
                restoreFrame = window.frame
                if let vf = window.screen?.visibleFrame { window.setFrame(vf, display: true, animate: false) }
                maximized = true
            }
        case "drag":
            // The transparent native titlebar + isMovableByWindowBackground already provide
            // window dragging on macOS, so this HTML drag signal needs no explicit handling.
            break
        default: break
        }
    }

    // Only the local app UI may load (Program.cs NavigationStarting filter).
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url?.absoluteString ?? ""
        decisionHandler((u.hasPrefix("file://") || u.hasPrefix("about:")) ? .allow : .cancel)
    }
    // No uncontrolled popups (window.open / target=_blank).
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func applicationWillTerminate(_ note: Notification) {
        if let s = sidecar, s.isRunning { s.terminate() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.setActivationPolicy(.regular)
app.run()
