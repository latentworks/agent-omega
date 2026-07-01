// Agent Omega — macOS shell (Swift + WKWebView). Native counterpart of the Windows Program.cs.
// Job: provision the user's config on first run, spawn the (bundled, self-contained) sidecar,
// host the frameless UI, bridge window controls, and harden the webview. The UI + sidecar +
// engine are shared/compiled; only this host is per-OS.
import AppKit
import WebKit
import Foundation

let HOME     = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()   // respect $HOME: matches Node/bun os.homedir (NSHomeDirectory ignores it) and keeps shell+sidecar+engine agreeing
let WORKDIR  = HOME + "/.agent-omega/workspace"
let WS_PORT  = 4599
let WS_TOKEN = UUID().uuidString
let BG       = NSColor(red: 7/255.0, green: 9/255.0, blue: 11/255.0, alpha: 1)

// Resource root: prefer the .app bundle's Resources; for a bare-binary DEV run, derive the repo
// relative to the executable (<repo>/mac/AgentOmega -> <repo>). No hardcoded home path anywhere.
func resourceRoot() -> String? {
    let fm = FileManager.default
    if let r = Bundle.main.resourceURL?.path, fm.fileExists(atPath: r + "/ui/app.html") { return r }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let repo = exe.deletingLastPathComponent().deletingLastPathComponent().path   // mac/ -> repo
    if fm.fileExists(atPath: repo + "/ui/app.html") { return repo }
    return nil
}

// node lookup — ONLY for the dev path (bare binary, no compiled sidecar bundled). The shipped
// .app runs the bundled compiled sidecar and never touches this.
func resolveNode() -> (String, [String]) {
    let fm = FileManager.default
    for c in ["\(HOME)/.local/node/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where fm.isExecutableFile(atPath: c) { return (c, []) }
    return ("/usr/bin/env", ["node"])
}

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
    var RES = ""
    var quitting = false
    var maximized = false
    var restoreFrame = NSRect.zero
    let logURL = URL(fileURLWithPath: HOME + "/Library/Logs/AgentOmega/sidecar.log")

    func applicationDidFinishLaunching(_ note: Notification) {
        // single-instance: if Agent Omega is already running, focus it and quit this copy
        // (avoids a second window fighting over the sidecar port).
        if let bid = Bundle.main.bundleIdentifier {
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bid).filter { $0 != .current }
            if let other = others.first { other.activate(options: [.activateAllWindows]); exit(0) }
        }
        guard let res = resourceRoot() else {
            fatalAlert("Agent Omega's resources couldn't be found in the app bundle. Please reinstall.")
        }
        RES = res
        try? FileManager.default.createDirectory(atPath: WORKDIR, withIntermediateDirectories: true)
        provisionFirstRun()

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

        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "host")
        ucc.addUserScript(WKUserScript(source: SHIM_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc
        web = WKWebView(frame: rect, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        web.underPageBackgroundColor = BG
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)

        startSidecar()
        loadUI()
        installTestHookIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.showWelcomeIfNeeded() }
    }

    // ---- first-run onboarding: a keyless user needs a model, so point them at the vault ----
    func showWelcomeIfNeeded() {
        if ProcessInfo.processInfo.environment["AO_SHELL_TESTSHOT"] != nil { return }
        let marker = HOME + "/.agent-omega/.welcomed"
        if FileManager.default.fileExists(atPath: marker) { return }
        let a = NSAlert()
        a.messageText = "Welcome to Agent Omega"
        a.informativeText = """
        To begin, give it a model:

        • Cloud — paste an API key (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Z.AI). Open Settings with the gear icon (top-right), press ⌃, , or type /settings, then choose Vault.

        • Local — run a local server (llama.cpp / Ollama / LM Studio) and pick the “local” model.

        Keys are stored encrypted in the macOS Keychain and never leave your Mac.
        """
        a.addButton(withTitle: "Got it")
        a.runModal()
        try? "".write(toFile: marker, atomically: true, encoding: .utf8)
    }

    // ---- first-run provisioning: install config + vault into the user's home, idempotent ----
    func provisionFirstRun() {
        let fm = FileManager.default
        let home = HOME
        // 1. config-template/opencode -> ~/.config/opencode  (shallow merge; never clobber user entries)
        let src = RES + "/config-template/opencode"
        let dst = home + "/.config/opencode"
        if fm.fileExists(atPath: src) {
            try? fm.createDirectory(atPath: dst, withIntermediateDirectories: true)
            if let items = try? fm.contentsOfDirectory(atPath: src) {
                for it in items where !fm.fileExists(atPath: dst + "/" + it) {
                    try? fm.copyItem(atPath: src + "/" + it, toPath: dst + "/" + it)
                }
            }
            // node_modules may pre-exist (a stock opencode install) without our plugin deps —
            // merge in any bundled package that's missing so council/engram can import.
            let srcNM = src + "/node_modules", dstNM = dst + "/node_modules"
            if fm.fileExists(atPath: srcNM) {
                try? fm.createDirectory(atPath: dstNM, withIntermediateDirectories: true)
                for pkg in (try? fm.contentsOfDirectory(atPath: srcNM)) ?? [] where !fm.fileExists(atPath: dstNM + "/" + pkg) {
                    try? fm.copyItem(atPath: srcNM + "/" + pkg, toPath: dstNM + "/" + pkg)
                }
            }
        }
        // 2. secrets.sh -> ~/.agent-omega/secrets.sh (if absent), executable
        let vsrc = RES + "/secrets.sh"
        let vdst = home + "/.agent-omega/secrets.sh"
        if fm.fileExists(atPath: vsrc) && !fm.fileExists(atPath: vdst) {
            try? fm.createDirectory(atPath: home + "/.agent-omega", withIntermediateDirectories: true)
            try? fm.copyItem(atPath: vsrc, toPath: vdst)
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: vdst)
        }
    }

    // ---- sidecar: bundled compiled binary (no Node) if present, else dev `node sidecar.mjs` ----
    func startSidecar() {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: logURL.path, contents: nil)

        let p = Process()
        let compiled = RES + "/sidecar"     // bun-compiled standalone binary
        if fm.isExecutableFile(atPath: compiled) {
            p.executableURL = URL(fileURLWithPath: compiled)
            p.arguments = []                               // WORKDIR/PORT/model come via env (argv is ambiguous for bun standalone)
        } else {
            let (node, pre) = resolveNode()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = pre + [RES + "/sidecar.mjs"]
        }
        p.currentDirectoryURL = URL(fileURLWithPath: RES)

        var env = ProcessInfo.processInfo.environment
        env["AO_WS_TOKEN"] = WS_TOKEN
        // The compiled sidecar's import.meta.dirname is a virtual bunfs path, so tell it where the
        // real bundled engine is (the sidecar honors AGENT_OMEGA_ENGINE). Correct for the dev path too.
        env["AGENT_OMEGA_ENGINE"] = RES + "/engine/opencode"
        env["AGENT_OMEGA_WORKDIR"] = WORKDIR
        env["AGENT_OMEGA_WS_PORT"] = String(WS_PORT)
        if let dm = ProcessInfo.processInfo.environment["AO_DEFAULT_MODEL"], !dm.isEmpty { env["AGENT_OMEGA_DEFAULT_MODEL"] = dm }
        // A Finder-launched app gets a minimal PATH; give the engine's shell tools the usual bin dirs.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        p.environment = env

        if let log = try? FileHandle(forWritingTo: logURL) { p.standardOutput = log; p.standardError = log }
        p.terminationHandler = { [weak self] proc in
            guard let self = self, !self.quitting else { return }
            DispatchQueue.main.async { self.sidecarFailed("The background engine exited unexpectedly (code \(proc.terminationStatus)).") }
        }
        do { try p.run(); sidecar = p }
        catch { sidecarFailed("Couldn't start the background engine: \(error.localizedDescription)") }
    }

    func sidecarFailed(_ why: String) {
        if ProcessInfo.processInfo.environment["AO_SHELL_TESTSHOT"] != nil { return }   // silent in automated runs
        let a = NSAlert()
        a.messageText = "Agent Omega's engine couldn't start"
        a.informativeText = why + "\n\nDetails: \(logURL.path)"
        a.alertStyle = .warning
        a.addButton(withTitle: "OK")
        a.runModal()
    }

    func loadUI() {
        var comp = URLComponents()
        comp.scheme = "file"
        comp.path = RES + "/ui/app.html"
        comp.queryItems = [URLQueryItem(name: "ws", value: String(WS_PORT)),
                           URLQueryItem(name: "token", value: WS_TOKEN)]
        guard let url = comp.url else { return }
        web.loadFileRequest(URLRequest(url: url), allowingReadAccessTo: URL(fileURLWithPath: RES, isDirectory: true))
    }

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
            // Transparent native titlebar + isMovableByWindowBackground already drag the window.
            break
        default: break
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url?.absoluteString ?? ""
        decisionHandler((u.hasPrefix("file://") || u.hasPrefix("about:")) ? .allow : .cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        if let s = sidecar, s.isRunning { s.terminate() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // ---- automated-verification hook (dev/CI only): AO_SHELL_TESTSHOT=<s> [+ AO_SHELL_TURN] ----
    func installTestHookIfNeeded() {
        let env = ProcessInfo.processInfo.environment
        guard let s = env["AO_SHELL_TESTSHOT"], let secs = Double(s) else { return }
        let turn = env["AO_SHELL_TURN"]
        let snap: (Double) -> Void = { delay in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.web.takeSnapshot(with: WKSnapshotConfiguration()) { img, _ in
                    if let img = img, let tiff = img.tiffRepresentation,
                       let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: (env["AO_SHOT_OUT"] ?? (self.RES + "/_smoke/shell-shot.png"))))
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
                        DispatchQueue.main.asyncAfter(deadline: .now() + 22.0) {
                            self.web.evaluateJavaScript("try { var c=document.querySelector('.convo'); if(c) c.scrollTop=c.scrollHeight; var t=(c&&c.innerText)||document.body.innerText||''; t.slice(-800) } catch(e){ 'ERR '+e }") { rb, _ in
                                print("CONVO_TEXT >>>"); print((rb as? String) ?? "nil"); print("<<<")
                                snap(0.5)
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

func fatalAlert(_ msg: String) -> Never {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = "Agent Omega can't start"
    a.informativeText = msg
    a.alertStyle = .critical
    a.addButton(withTitle: "Quit")
    a.runModal()
    exit(1)
}

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.setActivationPolicy(.regular)
app.run()
