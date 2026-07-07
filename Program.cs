using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

// Agent Omega (A/O) host. Spawns the node ACP sidecar (sidecar.mjs -> `opencode acp`)
// and hosts the frameless WebView2 window. The UI talks to the sidecar over a local
// WebSocket (ws://127.0.0.1:PORT) for ALL engine I/O including interactive permissions;
// the host only owns the window and its title-bar controls.
static class Program
{
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wParam, IntPtr lParam);
    const int WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 0x2;
    // Edge/corner hit codes: the UI forwards a "resize" message when the pointer grabs a window
    // edge (there's no visible border strip anymore — the web content runs to the edge), and we
    // hand it to the native sizing loop just like the title-bar drag hands off HTCAPTION.
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

    const string NODE = "node"; // resolved via PATH; setup verifies Node is installed
    static readonly string SIDECAR = Path.Combine(AppContext.BaseDirectory, "sidecar.mjs");
    // Scratch workspace lives under LocalAppData, NOT ~/.agent-omega — that tree holds the vault
    // and is blocked from the model's shell, so a workspace there would get every absolute-path
    // command denied. Override with AGENT_OMEGA_WORKDIR or --workdir <path> to open a real project.
    static string _workdir = ResolveWorkdir();
    // Logs live under ~/.agent-omega/logs (intentionally inside the shell-blocked tree, away from
    // the model). This captures sidecar + engine stderr so a boot crash is diagnosable.
    static readonly string LOG_DIR = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agent-omega", "logs");
    static readonly string LOG_PATH = Path.Combine(LOG_DIR, "sidecar.log");
    static int _wsPort = 4599;   // resolved to a free loopback port pair at launch (control socket + engine API on +1)
    static readonly string WS_TOKEN = Guid.NewGuid().ToString("N"); // per-launch control-socket token; only the real window gets it

    static string ResolveWorkdir()
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 1; i < args.Length - 1; i++)
            if (args[i] == "--workdir" && !string.IsNullOrWhiteSpace(args[i + 1])) return args[i + 1];
        var env = Environment.GetEnvironmentVariable("AGENT_OMEGA_WORKDIR");
        if (!string.IsNullOrWhiteSpace(env)) return env;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentOmega", "workspace");
    }

    // Find a free loopback port P where BOTH P (control socket) and P+1 (engine API) are open,
    // so a second instance or an unrelated listener on 4599 can't wedge startup. Two instances
    // launched at once could still race for the same P (a brief probe-then-bind gap); starting the
    // scan at a per-process offset makes that collision unlikely, and a lost race fails cleanly
    // (the sidecar exits on EADDRINUSE and the shell reports engine-down) rather than corrupting.
    static int FreePortPair(int start)
    {
        int offset = (Environment.ProcessId % 200) * 2;   // even offset keeps the P/P+1 pairing aligned
        for (int i = 0; i < 400; i++)
        {
            int p = start + ((offset + i * 2) % 400);
            if (IsFree(p) && IsFree(p + 1)) return p;
        }
        return start;
    }
    static bool IsFree(int port)
    {
        try { var l = new TcpListener(IPAddress.Loopback, port); l.Start(); l.Stop(); return true; }
        catch { return false; }
    }

    static Form _form;
    static WebView2 _web;
    static Process _sidecar;
    static bool _maximized; static Rectangle _restoreBounds;

    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Directory.CreateDirectory(_workdir);
        Directory.CreateDirectory(LOG_DIR);
        _wsPort = FreePortPair(4599);

        string uiFile = new Uri(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui", "app.html")).AbsoluteUri;  // properly percent-encodes spaces/unicode in the path
        string defaultUrl = uiFile + "?ws=" + _wsPort + "&token=" + WS_TOKEN;
        // args[0] is a debug override; only honor a local file:// or loopback URL, never an arbitrary remote one.
        string url = (args.Length > 0 && (args[0].StartsWith("file:///") || args[0].StartsWith("http://127.0.0.1") || args[0].StartsWith("http://localhost")))
            ? args[0]
            : defaultUrl;

        var bg = Color.FromArgb(7, 9, 11);
        _form = new AppForm
        {
            Text = "Agent Omega",
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.CenterScreen,
            Width = 1120, Height = 720, BackColor = bg,
            MinimumSize = new Size(760, 480),
            Padding = new Padding(0),  // web content runs edge-to-edge (no bezel strip); resize is forwarded from the UI and the corners are rounded by DWM (see AppForm)
        };
        try { var ico = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent-omega.ico"); if (File.Exists(ico)) _form.Icon = new Icon(ico); } catch { }

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = bg };
        _form.Controls.Add(_web);

        _form.Load += async (s, e) =>
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetTempPath(), "agent-omega-webview2"));
                await _web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Agent Omega needs the Microsoft WebView2 Runtime, which doesn't appear to be installed.\n\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/ then relaunch.\n\n(" + ex.Message + ")", "Agent Omega — WebView2 Runtime required", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Exit();
                return;
            }
            var c = _web.CoreWebView2;
            c.Settings.AreDefaultContextMenusEnabled = false;
            c.Settings.IsStatusBarEnabled = false;
            c.Settings.AreBrowserAcceleratorKeysEnabled = false; // kill Ctrl+P print, Ctrl+F, Ctrl+R, F5
            c.Settings.IsZoomControlEnabled = false;
            c.Settings.AreDevToolsEnabled = false;               // no DevTools access to the local UI
            c.Settings.IsGeneralAutofillEnabled = false;
            c.Settings.IsPasswordAutosaveEnabled = false;
            _web.AllowExternalDrop = false;                      // dropping a file must not navigate the webview away
            c.NewWindowRequested += (s2, ev) => { ev.Handled = true; };   // no uncontrolled popups (window.open / target=_blank)
            c.NavigationStarting += (s2, ev) => { if (!(ev.Uri.StartsWith("file:///") || ev.Uri.StartsWith("about:"))) ev.Cancel = true; };  // only the local app UI may load
            c.WebMessageReceived += OnUiMessage;   // window controls only
            // Replay a startup engine failure that fired before the page was ready to hear it.
            c.NavigationCompleted += (s2, ev) => { if (_pendingEngineDown != null) { try { c.PostWebMessageAsJson(_pendingEngineDown); } catch { } } };
            c.Navigate(url);   // load the UI FIRST so it can receive engine-status messages
            StartSidecar();
        };
        _form.FormClosed += (s, e) => KillProc(ref _sidecar);

        Application.Run(_form);
    }

    static StreamWriter _logWriter;

    static void StartSidecar()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = NODE,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,   // capture sidecar + engine stderr to a log so a boot crash is diagnosable
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(SIDECAR),
            };
            psi.ArgumentList.Add(SIDECAR);
            psi.ArgumentList.Add(_workdir.Replace("\\", "/"));
            psi.ArgumentList.Add(_wsPort.ToString());
            psi.EnvironmentVariables["AO_WS_TOKEN"] = WS_TOKEN;
            psi.EnvironmentVariables["AO_PARENT_PID"] = Environment.ProcessId.ToString();   // sidecar self-exits if this shell dies abnormally

            try { _logWriter = new StreamWriter(new FileStream(LOG_PATH, FileMode.Create, FileAccess.Write, FileShare.Read)) { AutoFlush = true }; } catch { _logWriter = null; }
            _sidecar = Process.Start(psi);
            _sidecar.EnableRaisingEvents = true;
            _sidecar.OutputDataReceived += (s, e) => { if (e.Data != null) try { _logWriter?.WriteLine(e.Data); } catch { } };
            _sidecar.ErrorDataReceived += (s, e) => { if (e.Data != null) try { _logWriter?.WriteLine(e.Data); } catch { } };
            _sidecar.BeginOutputReadLine();
            _sidecar.BeginErrorReadLine();
            _sidecar.Exited += (s, e) => { try { PostEngineDown("the engine process exited (code " + _sidecar.ExitCode + ") — check that Node.js is installed, that you ran npm install in the app folder, and that the engine binary is present (see SETUP.md). Details: " + LOG_PATH); } catch { } };
        }
        catch (Exception ex)
        {
            PostEngineDown("could not start the engine — is Node.js installed and on your PATH? (" + ex.Message + ")");
        }
    }

    static string _pendingEngineDown = null;
    // Surface an engine failure to the UI, safely and on the UI thread; cache it so it can be
    // replayed if the page hadn't finished loading yet (NavigationCompleted above).
    static void PostEngineDown(string msg)
    {
        string safe = msg.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", " ");
        _pendingEngineDown = "{\"type\":\"engine-down\",\"message\":\"" + safe + "\"}";
        try { _web?.BeginInvoke((Action)(() => { try { _web.CoreWebView2?.PostWebMessageAsJson(_pendingEngineDown); } catch { } })); } catch { }
    }

    // Tell the UI whether the window is app-maximized. A maximized window has no floating edges to
    // grab and no rounded corners, so the UI's edge-resize band must go dormant (else it shows
    // phantom resize cursors and swallows clicks in the outer few px). Host owns the truth.
    static void PostWinState()
    {
        string js = "{\"type\":\"winstate\",\"maximized\":" + (_maximized ? "true" : "false") + "}";
        try { _web?.BeginInvoke((Action)(() => { try { _web.CoreWebView2?.PostWebMessageAsJson(js); } catch { } })); } catch { }
    }

    static void OnUiMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // The UI posts OBJECTS via win() (postMessage({type:...})). TryGetWebMessageAsString
        // THROWS for non-string messages — which silently killed every window control. Read
        // the JSON instead (works for both an object {type:...} and a bare quoted string).
        string msg = null, dir = null;
        try
        {
            using var d = System.Text.Json.JsonDocument.Parse(e.WebMessageAsJson);
            var root = d.RootElement;
            if (root.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                msg = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (root.TryGetProperty("dir", out var dv)) dir = dv.GetString();
            }
            else if (root.ValueKind == System.Text.Json.JsonValueKind.String)
                msg = root.GetString();
        }
        catch { return; }
        if (msg == null) return;
        switch (msg)
        {
            case "close": _form.Close(); break;
            case "minimize": _form.WindowState = FormWindowState.Minimized; break;
            case "maximize":
                if (_maximized) { _form.Bounds = _restoreBounds; _maximized = false; }
                else { _restoreBounds = _form.Bounds; _form.Bounds = Screen.FromHandle(_form.Handle).WorkingArea; _maximized = true; }
                // A window sized to fill the screen shouldn't have rounded corners (they'd leave gaps at the screen corners).
                (_form as AppForm)?.SetRounded(!_maximized);
                PostWinState();
                break;
            case "drag":
                // Native drag-to-restore: dragging a maximized window shrinks it back to its floating
                // size (kept under the cursor, top-aligned so the pointer stays on the title bar) and
                // THEN follows the pointer. Without this it would slide off-screen while _maximized
                // stayed stale-true (rounding off, edge-resize dead). See review 2026-07-07.
                if (_maximized)
                {
                    var wa = _form.Bounds; var pt = Cursor.Position;
                    int nw = _restoreBounds.Width, nh = _restoreBounds.Height;
                    double fx = wa.Width > 0 ? (pt.X - wa.X) / (double)wa.Width : 0.5;
                    _form.Bounds = new Rectangle(pt.X - (int)(fx * nw), wa.Y, nw, nh);
                    _maximized = false;
                    (_form as AppForm)?.SetRounded(true);
                    PostWinState();
                }
                ReleaseCapture();
                SendMessage(_form.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                break;
            case "resize":
                // Forwarded edge/corner grab from the UI -> hand off to the native sizing loop.
                if (!_maximized)
                {
                    int ht = dir switch
                    {
                        "left" => HTLEFT, "right" => HTRIGHT, "top" => HTTOP, "bottom" => HTBOTTOM,
                        "topleft" => HTTOPLEFT, "topright" => HTTOPRIGHT,
                        "bottomleft" => HTBOTTOMLEFT, "bottomright" => HTBOTTOMRIGHT, _ => 0
                    };
                    if (ht != 0) { ReleaseCapture(); SendMessage(_form.Handle, WM_NCLBUTTONDOWN, (IntPtr)ht, IntPtr.Zero); }
                }
                break;
        }
    }

    static void KillProc(ref Process p)
    {
        var pr = p; p = null;
        try { if (pr != null && !pr.HasExited) pr.Kill(true); } catch { }
    }
}

// Frameless, edge-to-edge, rounded window. FormBorderStyle.None gives us no native chrome; we
// add WS_THICKFRAME back purely so the OS sizing loop works (the UI forwards edge grabs to it via
// the "resize" message), then swallow WM_NCCALCSIZE so that frame contributes ZERO visible border
// — the WebView2 child fills the whole window and the web content runs clean to the edge. DWM
// rounds the outer corners so the sharp square corners are gone. No WS_MAXIMIZEBOX: OS maximize /
// Aero-snap stays off so it can't fight the app's own WorkingArea "maximize".
class AppForm : Form
{
    const int WM_NCCALCSIZE = 0x83;
    const int WS_THICKFRAME = 0x00040000;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWCP_ROUND = 2, DWMWCP_DONOTROUND = 1;
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.Style |= WS_THICKFRAME; return cp; }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetRounded(true);
    }

    // Toggle the DWM rounded-corner preference (rounded when floating, square when filling the screen).
    public void SetRounded(bool round)
    {
        try { int pref = round ? DWMWCP_ROUND : DWMWCP_DONOTROUND; DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int)); }
        catch { }
    }

    protected override void WndProc(ref Message m)
    {
        // Client area == whole window: the WS_THICKFRAME sizing frame stays functional but draws nothing.
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero) { m.Result = IntPtr.Zero; return; }
        base.WndProc(ref m);
    }
}
