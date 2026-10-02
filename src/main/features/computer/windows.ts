import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Point } from './geometry'
import { LineHelper } from './helper'
import type { AppRef, BackendCheck, InputBackend, MouseButton } from './input'
import { WINDOWS_MODIFIERS, windowsKey, type Combo } from './keys'

/**
 * Windows input: `SetCursorPos` and `SendInput` from user32, reached from a
 * persistent PowerShell process through Add-Type (C# compiled at startup —
 * the reason the process is kept alive rather than started per action).
 *
 * The helper declares itself per-monitor DPI aware so SetCursorPos takes
 * physical pixels; points arrive here in DIP and are converted with
 * Electron's `screen.dipToScreenPoint`, which knows each monitor's scale.
 *
 * Not exercised on real Windows hardware yet.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class EaonInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  static void Send(INPUT input) {
    INPUT[] inputs = new INPUT[] { input };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "). An elevated window may be in front.");
  }
  static void Mouse(uint flags, uint data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i); }
  public static void Key(ushort vk, bool up, bool ext) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u); Send(i); }
  static void Unicode(ushort ch, bool up) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = ch; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); Send(i); }

  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int x, int y, string button, int clicks) {
    SetCursorPos(x, y); Thread.Sleep(40);
    uint down = 2, up = 4;
    if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int n = 0; n < clicks; n++) { Mouse(down, 0); Thread.Sleep(25); Mouse(up, 0); if (n < clicks - 1) Thread.Sleep(70); }
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); Thread.Sleep(60); Mouse(2, 0); Thread.Sleep(90);
    for (int i = 1; i <= 24; i++) { SetCursorPos(x1 + (x2 - x1) * i / 24, y1 + (y2 - y1) * i / 24); Thread.Sleep(12); }
    Thread.Sleep(90); Mouse(4, 0);
  }
  public static void Scroll(int x, int y, int dx, int dy) {
    SetCursorPos(x, y); Thread.Sleep(40);
    int n = Math.Max(Math.Abs(dx), Math.Abs(dy));
    for (int i = 0; i < n; i++) {
      if (i < Math.Abs(dy)) Mouse(0x0800, unchecked((uint)(dy > 0 ? -120 : 120)));
      if (i < Math.Abs(dx)) Mouse(0x1000, unchecked((uint)(dx > 0 ? 120 : -120)));
      Thread.Sleep(16);
    }
  }
  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\n') { Key(0x0D, false, false); Key(0x0D, true, false); }
      else if (c == '\t') { Key(0x09, false, false); Key(0x09, true, false); }
      else { Unicode(c, false); Unicode(c, true); }
      Thread.Sleep(6);
    }
  }
  public static string Foreground() { IntPtr h = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(h, out pid); return h.ToInt64().ToString() + ":" + pid; }
  public static bool Activate(long hwnd) {
    // Only the foreground process may hand focus away; a synthetic Alt tap
    // counts as user input and lifts that restriction.
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(new IntPtr(hwnd));
  }
}
'@
[EaonInput]::DpiAware()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $result = $null
    switch ($req.cmd) {
      'check' { $result = @{ ok = $true } }
      'cursor' { $p = [EaonInput]::Cursor(); $result = @{ x = $p.X; y = $p.Y } }
      'move' { [EaonInput]::Move([int]$req.x, [int]$req.y) }
      'click' { [EaonInput]::Click([int]$req.x, [int]$req.y, [string]$req.button, [int]$req.clicks) }
      'drag' { [EaonInput]::Drag([int]$req.x1, [int]$req.y1, [int]$req.x2, [int]$req.y2) }
      'scroll' { [EaonInput]::Scroll([int]$req.x, [int]$req.y, [int]$req.dx, [int]$req.dy) }
      'type' { [EaonInput]::Type([string]$req.text) }
      'key' {
        $mods = @($req.modifiers)
        foreach ($m in $mods) { [EaonInput]::Key([uint16]$m.vk, $false, [bool]$m.ext) }
        if ($null -ne $req.key) {
          [EaonInput]::Key([uint16]$req.key.vk, $false, [bool]$req.key.ext)
          Start-Sleep -Milliseconds 20
          [EaonInput]::Key([uint16]$req.key.vk, $true, [bool]$req.key.ext)
        }
        [array]::Reverse($mods)
        foreach ($m in $mods) { [EaonInput]::Key([uint16]$m.vk, $true, [bool]$m.ext) }
      }
      'frontmost' {
        $parts = [EaonInput]::Foreground().Split(':')
        $proc = Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue
        $name = ''
        if ($proc) { $name = $proc.ProcessName }
        $result = @{ name = $name; pid = [int]$parts[1]; bundleId = $null; window = $parts[0] }
      }
      'activate' { $result = [EaonInput]::Activate([long]$req.window) }
      'open' { Start-Process -FilePath ([string]$req.name) }
      default { throw "unknown command $($req.cmd)" }
    }
    $out = @{ id = $req.id; ok = $true; result = $result }
  } catch {
    $id = -1
    if ($req) { $id = $req.id }
    $out = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`

export class WindowsInput implements InputBackend {
  readonly name = 'user32 SendInput via PowerShell'
  private helper = new LineHelper('PowerShell', 'powershell.exe', () => {
    const file = join(tmpdir(), 'eaon-computer-input.ps1')
    writeFileSync(file, SCRIPT, 'utf8')
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
  })

  constructor(
    private readonly toNative: (point: Point) => Point,
    private readonly fromNative: (point: Point) => Point
  ) {}

  private native(point: Point): Point {
    const p = this.toNative(point)
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }

  async check(): Promise<BackendCheck> {
    try {
      // First start compiles the C# shim, which can take a few seconds.
      await this.helper.request('check', {}, 30_000)
      return { available: true }
    } catch (error) {
      return { available: false, detail: (error as Error).message }
    }
  }

  async move(point: Point): Promise<void> {
    await this.helper.request('move', { ...this.native(point) }, 30_000)
  }

  async click(point: Point, button: MouseButton, clicks: number): Promise<void> {
    await this.helper.request('click', { ...this.native(point), button, clicks }, 30_000)
  }

  async drag(from: Point, to: Point): Promise<void> {
    const a = this.native(from)
    const b = this.native(to)
    await this.helper.request('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, 30_000)
  }

  async scroll(point: Point, dx: number, dy: number): Promise<void> {
    await this.helper.request('scroll', { ...this.native(point), dx, dy }, 30_000)
  }

  async type(text: string): Promise<void> {
    await this.helper.request('type', { text }, 30_000)
  }

  async key(combo: Combo): Promise<void> {
    if (combo.modifiers.includes('fn')) throw new Error('fn cannot be pressed from software on Windows.')
    const key = combo.key === null ? null : windowsKey(combo.key)
    if (combo.key !== null && !key) throw new Error(`The key "${combo.key}" has no Windows key code.`)
    const modifiers = combo.modifiers.map((m) => WINDOWS_MODIFIERS[m as Exclude<typeof m, 'fn'>])
    await this.helper.request('key', { modifiers, key }, 30_000)
  }

  async cursor(): Promise<Point> {
    return this.fromNative(await this.helper.request<Point>('cursor', {}, 30_000))
  }

  async frontmost(): Promise<AppRef | null> {
    return this.helper.request<AppRef | null>('frontmost', {}, 30_000)
  }

  async activate(app: AppRef): Promise<void> {
    if (app.window) await this.helper.request('activate', { window: app.window }, 30_000)
  }

  async locked(): Promise<boolean> {
    return false
  }

  async openApp(name: string): Promise<void> {
    await this.helper.request('open', { name }, 30_000)
  }

  dispose(): void {
    this.helper.kill()
  }
}
