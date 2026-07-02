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
            Padding = new Padding(AppForm.GRIP),  // exposes a thin border for native edge-resize hit-testing (doubles as a subtle CRT bezel)
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

    static void OnUiMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // The UI posts OBJECTS via win() (postMessage({type:...})). TryGetWebMessageAsString
        // THROWS for non-string messages — which silently killed every window control. Read
        // the JSON instead (works for both an object {type:...} and a bare quoted string).
        string msg = null;
        try
        {
            using var d = System.Text.Json.JsonDocument.Parse(e.WebMessageAsJson);
            var root = d.RootElement;
            if (root.ValueKind == System.Text.Json.JsonValueKind.Object)
                msg = root.TryGetProperty("type", out var t) ? t.GetString() : null;
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
                break;
            case "drag":
                ReleaseCapture();
                SendMessage(_form.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                break;
        }
    }

    static void KillProc(ref Process p)
    {
        var pr = p; p = null;
        try { if (pr != null && !pr.HasExited) pr.Kill(true); } catch { }
    }
}

// Frameless windows (FormBorderStyle.None) have no native resize. AppForm hit-tests the
// GRIP-px border that the form's Padding exposes around the WebView2 child, so Windows
// handles edge/corner resizing natively (no per-pixel JS plumbing).
class AppForm : Form
{
    public const int GRIP = 6;
    const int WM_NCHITTEST = 0x84;
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
        {
            int lp = m.LParam.ToInt32();
            var p = PointToClient(new Point(unchecked((short)(lp & 0xFFFF)), unchecked((short)((lp >> 16) & 0xFFFF))));
            int w = ClientSize.Width, h = ClientSize.Height;
            bool l = p.X < GRIP, r = p.X >= w - GRIP, t = p.Y < GRIP, b = p.Y >= h - GRIP;
            int ht = (t && l) ? HTTOPLEFT : (t && r) ? HTTOPRIGHT : (b && l) ? HTBOTTOMLEFT : (b && r) ? HTBOTTOMRIGHT
                   : l ? HTLEFT : r ? HTRIGHT : t ? HTTOP : b ? HTBOTTOM : 0;
            if (ht != 0) { m.Result = (IntPtr)ht; return; }
        }
        base.WndProc(ref m);
    }
}
