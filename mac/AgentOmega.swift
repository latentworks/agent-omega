// Agent Omega — macOS shell (Swift + WKWebView). Native counterpart of the Windows Program.cs.
// Job: provision the user's config on first run, spawn the (bundled, self-contained) sidecar,
// host the frameless UI, bridge window controls, and harden the webview. The UI + sidecar +
// engine are shared/compiled; only this host is per-OS.
import AppKit
import WebKit
import Foundation

let HOME     = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()   // respect $HOME: matches Node/bun os.homedir (NSHomeDirectory ignores it) and keeps shell+sidecar+engine agreeing
// Workspace: --workdir arg > AGENT_OMEGA_WORKDIR env > a scratch default. The default lives
// OUTSIDE ~/.agent-omega on purpose — that tree holds the vault and is denied to the model's
// shell (opencode.json "*.agent-omega*"), so a workspace there would get every absolute-path
// command the model runs denied.
func resolveWorkdir() -> String {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--workdir"), i + 1 < args.count, !args[i + 1].isEmpty { return args[i + 1] }
    if let w = ProcessInfo.processInfo.environment["AGENT_OMEGA_WORKDIR"], !w.isEmpty { return w }
    return HOME + "/Library/Application Support/AgentOmega/workspace"
}
let WORKDIR  = resolveWorkdir()
// Control-socket port: pick a P where BOTH P (WebSocket) and P+1 (engine HTTP API) are free,
// starting at 4599 + a small per-process offset (shrinks the two-instances-launching race).
// A stale process squatting 4599 no longer wedges startup.
func portFree(_ port: UInt16) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }
    defer { close(fd) }
    var opt: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))   // TIME_WAIT is "free"; a live listener still fails the bind
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return ok == 0
}
func pickPortPair() -> Int {
    if let p = ProcessInfo.processInfo.environment["AGENT_OMEGA_WS_PORT"], let n = Int(p), n > 0 { return n }   // explicit override (tests)
    var p = 4599 + (Int(ProcessInfo.processInfo.processIdentifier) % 50) * 2
    for _ in 0..<200 {
        if portFree(UInt16(p)) && portFree(UInt16(p + 1)) { return p }
        p += 2
    }
    return 4599
}
let WS_PORT  = pickPortPair()
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
    var xdgConfigHome = ""   // non-empty => our config is isolated here (a foreign opencode config occupied ~/.config)
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

    // Is this dir an existing Agent Omega config (vs a stranger's own opencode config)? Mirrors
    // setup.mjs isAgentOmega so the app never blindly pollutes someone else's ~/.config/opencode.
    func isAgentOmega(_ dir: String) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: dir + "/skill-router/index.js") || fm.fileExists(atPath: dir + "/council/index.js")
    }
    // User data we must NOT overwrite on upgrade (their config, roster, memory, engram db).
    func isPreserved(_ rel: String) -> Bool {
        return rel == "opencode.json" || rel == "council/council.json" || rel.hasPrefix("memory/")
            || rel.hasSuffix(".db") || rel.hasSuffix(".db-wal") || rel.hasSuffix(".db-shm") || rel.hasSuffix(".log")
    }

    // ---- first-run provisioning: install/UPGRADE config + vault into the user's home, idempotent ----
    func provisionFirstRun() {
        let fm = FileManager.default
        let home = HOME
        let src = RES + "/config-template/opencode"
        // Choose where our config lives. Default ~/.config/opencode — BUT if that already holds a
        // stranger's real opencode config (not ours, not empty), don't touch it: run isolated under
        // ~/.agent-omega/xdg and point the engine there via XDG_CONFIG_HOME (set in startSidecar).
        let defaultDst = home + "/.config/opencode"
        var dst = defaultDst
        let defExists = fm.fileExists(atPath: defaultDst)
        let defEmpty = ((try? fm.contentsOfDirectory(atPath: defaultDst))?.isEmpty) ?? true
        if defExists && !defEmpty && !isAgentOmega(defaultDst) {
            xdgConfigHome = home + "/.agent-omega/xdg"
            dst = xdgConfigHome + "/opencode"
        }
        if fm.fileExists(atPath: src) {
            try? fm.createDirectory(atPath: dst, withIntermediateDirectories: true)
            // Copy the shipped tree: OVERWRITE our own code/skills/prompts (so an upgrade actually
            // ships bug fixes), but PRESERVE the user's data files, and handle node_modules specially.
            if let en = fm.enumerator(atPath: src) {
                while let relAny = en.nextObject() {
                    guard let rel = relAny as? String else { continue }
                    if rel == "node_modules" || rel.hasPrefix("node_modules/") { en.skipDescendants(); continue }
                    let s = src + "/" + rel, d = dst + "/" + rel
                    var isDir: ObjCBool = false
                    fm.fileExists(atPath: s, isDirectory: &isDir)
                    if isDir.boolValue { try? fm.createDirectory(atPath: d, withIntermediateDirectories: true); continue }
                    if isPreserved(rel) && fm.fileExists(atPath: d) { continue }   // keep the user's data
                    try? fm.createDirectory(atPath: (d as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                    if fm.fileExists(atPath: d) { try? fm.removeItem(atPath: d) }
                    try? fm.copyItem(atPath: s, toPath: d)
                }
            }
            // node_modules: add any missing bundled package (don't churn a big existing tree).
            let srcNM = src + "/node_modules", dstNM = dst + "/node_modules"
            if fm.fileExists(atPath: srcNM) {
                try? fm.createDirectory(atPath: dstNM, withIntermediateDirectories: true)
                for pkg in (try? fm.contentsOfDirectory(atPath: srcNM)) ?? [] where !fm.fileExists(atPath: dstNM + "/" + pkg) {
                    try? fm.copyItem(atPath: srcNM + "/" + pkg, toPath: dstNM + "/" + pkg)
                }
            }
        } else {
            fatalAlert("config-template missing from the app bundle — please reinstall")
        }
        // 2. secrets.sh -> ~/.agent-omega/secrets.sh, executable. Self-healing: also REFRESH a
        // stale copy (content differs from the shipped one) so an upgrade can't leave an old
        // vault script that silently fails the newer set-via-stdin contract.
        let vsrc = RES + "/secrets.sh"
        let vdst = home + "/.agent-omega/secrets.sh"
        if fm.fileExists(atPath: vsrc) {
            let shipped = try? String(contentsOfFile: vsrc, encoding: .utf8)
            let current = try? String(contentsOfFile: vdst, encoding: .utf8)
            if shipped != nil && shipped != current {
                try? fm.createDirectory(atPath: home + "/.agent-omega", withIntermediateDirectories: true)
                try? fm.removeItem(atPath: vdst)
                try? fm.copyItem(atPath: vsrc, toPath: vdst)
            }
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: vdst)
        }
        // Post-checks: a partial/failed copy above is silent, so confirm the critical outputs
        // actually landed and fail loudly (rather than boot into a broken install) if any is missing.
        for path in [dst + "/opencode.json", dst + "/skill-router", vdst] where !fm.fileExists(atPath: path) {
            fatalAlert("Agent Omega's install is incomplete — missing:\n\(path)\n\nPlease reinstall.")
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
        // If we isolated our config away from a stranger's ~/.config/opencode, the engine + plugins
        // must read from there too. XDG_CONFIG_HOME/opencode is where provisionFirstRun installed it.
        if !xdgConfigHome.isEmpty { env["XDG_CONFIG_HOME"] = xdgConfigHome }
        // Parent-death signal: the sidecar polls this PID and self-exits (killing the engine)
        // if the shell dies abnormally — otherwise both would orphan and hold the ports.
        env["AO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        if let dm = ProcessInfo.processInfo.environment["AO_DEFAULT_MODEL"], !dm.isEmpty { env["AGENT_OMEGA_DEFAULT_MODEL"] = dm }
        // Web search (optional): if anon-web + its venv are installed at ~/anon-web, wire the gateway.
        let anonRoot = HOME + "/anon-web", anonVenv = HOME + "/anon-web/.venv/bin/python"
        if fm.fileExists(atPath: anonRoot + "/anonweb") && fm.isExecutableFile(atPath: anonVenv) {
            env["AGENT_OMEGA_ANONWEB"] = anonRoot
            env["AGENT_OMEGA_ANONWEB_VENV"] = anonVenv
        }
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
        a.addButton(withTitle: "Retry")
        a.addButton(withTitle: "Open Log")
        a.addButton(withTitle: "Quit")
        // Open Log only reveals the log; loop so it re-presents the alert instead of dead-ending.
        // Only Retry (respawn) or Quit exit the loop.
        while true {
            switch a.runModal() {
            case .alertFirstButtonReturn: startSidecar(); return
            case .alertSecondButtonReturn: NSWorkspace.shared.activateFileViewerSelecting([logURL])
            default: NSApp.terminate(nil); return
            }
        }
    }

    func loadUI() {
        var comp = URLComponents()
        comp.scheme = "file"
        comp.path = RES + "/ui/app.html"
        comp.queryItems = [URLQueryItem(name: "ws", value: String(WS_PORT)),
                           URLQueryItem(name: "token", value: WS_TOKEN)]
        guard let url = comp.url else {
            fatalAlert("Agent Omega couldn't build the UI address. Please reinstall.")
        }
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
        case "saveFile":
            // WKWebView blocks blob: downloads, so the UI can't save a transcript on its own.
            // Write it to ~/Downloads natively, reveal it in Finder, and ack back to the UI so it
            // reports the truth (real path on success, honest failure otherwise).
            saveFile(msg.body as? [String: Any])
        case "openExternal":
            // Open http/https links in the user's default browser. WKWebView cancels
            // non-file:// navigations and returns nil for createWebViewWith, so the UI
            // routes external links here instead of the no-op window.open.
            if let d = msg.body as? [String: Any], let s = d["url"] as? String,
               let url = URL(string: s), let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                NSWorkspace.shared.open(url)
            }
        default: break
        }
    }

    func saveFile(_ d: [String: Any]?) {
        let rid = (d?["rid"] as? String) ?? ""
        let content = (d?["content"] as? String) ?? ""
        var name = (d?["name"] as? String) ?? "export.txt"
        name = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "..", with: "-")   // no path escape
        let ack: (Bool, String) -> Void = { [weak self] ok, pathOrErr in
            let js = "window.__aoSaveFileResult && window.__aoSaveFileResult(\(jsString(rid)), \(ok ? "true" : "false"), \(jsString(pathOrErr)))"
            DispatchQueue.main.async { self?.web.evaluateJavaScript(js, completionHandler: nil) }
        }
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: HOME + "/Downloads")
        var dest = dir.appendingPathComponent(name)
        // don't clobber: append -1, -2, … if the name is taken
        if FileManager.default.fileExists(atPath: dest.path) {
            let ext = dest.pathExtension, stem = dest.deletingPathExtension().lastPathComponent
            var n = 1
            repeat { dest = dir.appendingPathComponent(stem + "-\(n)" + (ext.isEmpty ? "" : "." + ext)); n += 1 }
            while FileManager.default.fileExists(atPath: dest.path) && n < 1000
        }
        do {
            try content.data(using: .utf8)?.write(to: dest)
            NSWorkspace.shared.activateFileViewerSelecting([dest])   // reveal in Finder
            ack(true, dest.path)
        } catch { ack(false, error.localizedDescription) }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url?.absoluteString ?? ""
        decisionHandler((u.hasPrefix("file://") || u.hasPrefix("about:")) ? .allow : .cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    // A failed ui/app.html load would otherwise leave a silent blank window — surface it loudly
    // and let the user retry rather than stare at nothing.
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        uiLoadFailed(error)
    }
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        uiLoadFailed(error)
    }
    func uiLoadFailed(_ error: Error) {
        if ProcessInfo.processInfo.environment["AO_SHELL_TESTSHOT"] != nil { return }   // silent in automated runs
        let a = NSAlert()
        a.messageText = "Agent Omega's window couldn't load"
        a.informativeText = error.localizedDescription
        a.alertStyle = .warning
        a.addButton(withTitle: "Retry")
        a.addButton(withTitle: "Quit")
        switch a.runModal() {
        case .alertFirstButtonReturn: loadUI()
        default: NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        if let s = sidecar, s.isRunning { s.terminate() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // ---- menu / responder-chain self-test (dev only): AO_MENU_SELFTEST=1 ----
    // Verifies the fix for the "no keybindings" bug WITHOUT needing Accessibility to inject real
    // key events: a menu item firing is exactly NSApp.sendAction(selector) down the responder
    // chain. We (1) audit the main menu has the standard Edit key-equivalents, then (2) put a
    // known string in the web input, select-all + copy VIA THE RESPONDER CHAIN, and read the
    // system pasteboard — proving Cmd+C reaches the WKWebView and copies. Prints MENU_* lines.
    func installMenuSelfTestIfNeeded() {
        guard ProcessInfo.processInfo.environment["AO_MENU_SELFTEST"] != nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
            // 1) audit menu structure
            let menu = NSApp.mainMenu
            let edit = menu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu
            let want: [(String, Selector)] = [("Copy", #selector(NSText.copy(_:))), ("Paste", #selector(NSText.paste(_:))), ("Cut", #selector(NSText.cut(_:))), ("Select All", #selector(NSText.selectAll(_:)))]
            var wired = 0
            for (title, sel) in want {
                if let it = edit?.items.first(where: { $0.title == title }), it.action == sel, !it.keyEquivalent.isEmpty { wired += 1 }
            }
            print("MENU_STRUCTURE main=\(menu != nil ? "present" : "MISSING") editItems=\(edit?.items.count ?? 0) stdKeyEquivsWired=\(wired)/4")
            // 2) drive copy through the responder chain (what a menu item / Cmd+C does)
            let sentinel = "AO-CLIP-SENTINEL-7f3a"
            NSPasteboard.general.clearContents()
            self.web.evaluateJavaScript("(function(){var i=document.getElementById('homeInput')||document.querySelector('textarea');if(!i)return 'noinput';i.focus();i.value='\(sentinel)';i.select();return 'set';})()") { r, _ in
                print("MENU_COPY_SETUP \(r ?? "nil")")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    let ok = NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)   // exactly what the Copy menu item does
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                        let clip = NSPasteboard.general.string(forType: .string) ?? ""
                        print("MENU_COPY_RESULT sentAction=\(ok) pasteboard=\(clip == sentinel ? "MATCH" : "MISMATCH(\(clip.prefix(20)))")")
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    // ---- automated-verification hook (dev/CI only): AO_SHELL_TESTSHOT=<s> [+ AO_SHELL_TURN] ----
    func installTestHookIfNeeded() {
        let env = ProcessInfo.processInfo.environment
        installMenuSelfTestIfNeeded()
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
        let evalJS = env["AO_SHELL_EVAL"]   // dev-only: run an arbitrary UI expression after boot (exercises host bridges like exportSession)
        DispatchQueue.main.asyncAfter(deadline: .now() + secs) {
            self.web.evaluateJavaScript("try { if (window.AOBoot && !window.AOBoot.done) window.AOBoot.finish(); 'ok' } catch (e) { String(e) }") { r, _ in
                print("BOOT_FINISH \(r ?? "nil")")
                if let js = evalJS, !js.isEmpty {
                    // Fire the (async) UI flow and let it run; the app stays alive until the
                    // AO_SHELL_TESTSHOT timer snapshots/quits, so pick a TESTSHOT large enough to
                    // cover it. We check side effects (files, DOM) rather than a JS return value.
                    let wait = Double(env["AO_SHELL_EVAL_WAIT"] ?? "50") ?? 50
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                        self.web.evaluateJavaScript("try { (\(js)); 'started' } catch(e){ 'ERR '+e }") { rr, _ in print("EVAL_STARTED \(rr ?? "nil")") }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { snap(0.5) }
                } else if let turn = turn, !turn.isEmpty {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                        self.web.evaluateJavaScript("try { window.send('\(turn)'); 'sent' } catch (e) { String(e) }") { rr, _ in print("TURN_SEND \(rr ?? "nil")") }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 22.0) {
                            self.web.evaluateJavaScript("try { var c=document.querySelector('#convo'); if(c) c.scrollTop=c.scrollHeight; var t=(c&&c.innerText)||document.body.innerText||''; t.slice(-800) } catch(e){ 'ERR '+e }") { rb, _ in
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

// JSON-encode a string into a safe JS literal (quotes included) for evaluateJavaScript.
func jsString(_ s: String) -> String {
    if let d = try? JSONSerialization.data(withJSONObject: [s]), let j = String(data: d, encoding: .utf8) {
        return String(j.dropFirst().dropLast())   // ["..."] -> "..."
    }
    return "\"\""
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

// A main menu is REQUIRED on macOS for any Cmd-shortcut to work: AppKit dispatches
// Cmd combos through the menu's key equivalents (performKeyEquivalent), so a menu-less
// app silently drops Cmd+C/V/X/A/Z — copy/paste is dead in the WKWebView without this.
// The standard Edit selectors are resolved by the responder chain; WKWebView implements
// them all.
func buildMainMenu() -> NSMenu {
    let main = NSMenu()

    let appItem = NSMenuItem(); main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide Agent Omega", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit Agent Omega", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem(); main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(NSMenuItem.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit

    let winItem = NSMenuItem(); main.addItem(winItem)
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = win

    return main
}

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.mainMenu = buildMainMenu()
app.setActivationPolicy(.regular)
app.run()
