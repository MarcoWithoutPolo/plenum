import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { defaultHome } from './store/db.js';

/**
 * Windows job objects for agent runs and test commands (1.0.1 S3). An AI sometimes starts a dev
 * server in the background and never stops it; once the AI's process exits, nothing links that
 * server to it any more, and it kept running. Windows can put a process and everything it ever
 * starts into a "job" that ends them all together. Node can't make one, so a tiny launcher does:
 * it is compiled from the C# below, on first use, by the C# compiler that comes with Windows, into
 * Plenum's data folder. If that isn't possible (a locked-down computer), runs work as before.
 */
export const JOB_SOURCE = String.raw`// plenum-job: runs a command line inside a Windows job object, so everything it starts (servers an
// AI started in the background and forgot, included) ends when the command does or is stopped.
// Usage: plenum-job.exe <command line, passed through exactly as written>
// Compiled on first use by Windows' own C# compiler (Add-Type), into Plenum's data folder.
using System;
using System.Runtime.InteropServices;

public static class PlenumJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, System.Text.StringBuilder commandLine, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    const uint KillOnJobClose = 0x2000;
    const int ExtendedLimitInformation = 9;
    const int StartfUseStdHandles = 0x100;
    const uint CreateUnicodeEnvironment = 0x400;

    public static int Main()
    {
        // Everything after this program's own name, exactly as it was written.
        string line = Marshal.PtrToStringUni(GetCommandLineW());
        string rest = AfterFirstToken(line);
        if (rest.Length == 0) { Console.Error.WriteLine("plenum-job: no command"); return 2; }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = KillOnJobClose;
        SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));
        // In the job before anything starts, so every child and grandchild is in it too.
        AssignProcessToJobObject(job, GetCurrentProcess());

        var si = new StartupInfo();
        si.cb = Marshal.SizeOf(typeof(StartupInfo));
        si.dwFlags = StartfUseStdHandles;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        ProcessInfo pi;
        if (!CreateProcessW(null, new System.Text.StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true,
                CreateUnicodeEnvironment, IntPtr.Zero, null, ref si, out pi))
        {
            int error = Marshal.GetLastWin32Error();
            // 2 and 3: not found. Said the way Plenum recognizes a missing program (isNotFound).
            Console.Error.WriteLine(error == 2 || error == 3
                ? "plenum-job: ENOENT, couldn't find the program in: " + rest
                : "plenum-job: couldn't start (" + error + "): " + rest);
            return 1;
        }
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        // Returning closes the job's last handle: whatever the command left running ends now.
        return (int)code;
    }

    /** The command line without its first token, quoted or not (the CreateProcess rules). */
    static string AfterFirstToken(string line)
    {
        int i = 0;
        if (line.Length > 0 && line[0] == '"')
        {
            i = line.IndexOf('"', 1);
            i = i < 0 ? line.Length : i + 1;
        }
        else
        {
            while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        }
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line.Substring(i);
    }
}
`;

let launcher: Promise<string | undefined> | undefined;

/** The launcher's path, compiled on first use; undefined when not on Windows or it can't be made. */
export function jobLauncher(): Promise<string | undefined> {
  if (process.platform !== 'win32' || process.env.PLENUM_NO_JOBS === '1')
    return Promise.resolve(undefined);
  launcher ??= compile().catch(() => undefined);
  return launcher;
}

async function compile(): Promise<string | undefined> {
  const hash = createHash('sha256').update(JOB_SOURCE).digest('hex').slice(0, 10);
  // PLENUM_JOB_DIR: tests keep it out of the real data folder.
  const dir = process.env.PLENUM_JOB_DIR ?? join(defaultHome(), 'bin');
  const exe = join(dir, `plenum-job-${hash}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  // Each process compiles to its own name and moves it into place, so two never collide.
  // The name has to end in .exe, or the compiler makes a library instead of a program.
  const own = join(dir, `plenum-job-${hash}.${process.pid}.exe`);
  const source = `${own}.cs`;
  writeFileSync(source, JOB_SOURCE);
  try {
    const ok = await new Promise<boolean>((done) => {
      const p = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -Path $env:PLENUM_JOB_CS -OutputAssembly $env:PLENUM_JOB_EXE -OutputType ConsoleApplication',
        ],
        {
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, PLENUM_JOB_CS: source, PLENUM_JOB_EXE: own },
        },
      );
      const timer = setTimeout(() => {
        p.kill();
        done(false);
      }, 60_000);
      p.once('exit', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
      p.once('error', () => {
        clearTimeout(timer);
        done(false);
      });
    });
    // Only a launcher that really runs a command (and passes its exit code on) is used.
    if (!ok || !existsSync(own) || (await exitCodeVia(own)) !== 3) return undefined;
    if (!existsSync(exe)) renameSync(own, exe);
    return exe;
  } finally {
    rmSync(source, { force: true });
    rmSync(own, { force: true });
  }
}

/** Run `cmd /c exit 3` through a freshly compiled launcher. */
function exitCodeVia(launcher: string): Promise<number | null> {
  return new Promise((done) => {
    const p = spawn(launcher, [`${process.env.ComSpec ?? 'cmd.exe'} /d /c exit 3`], {
      windowsHide: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    const timer = setTimeout(() => {
      p.kill();
      done(null);
    }, 15_000);
    p.once('exit', (code) => {
      clearTimeout(timer);
      done(code);
    });
    p.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

/**
 * The command line Node would give Windows for this command and arguments (libuv's quoting), so the
 * launcher can pass it on exactly. Verbatim arguments (cmd.exe /s /c "…") are joined as they are.
 */
export function windowsCommandLine(command: string, args: string[], verbatim: boolean): string {
  return [command, ...args].map((a) => (verbatim ? a : quoteArg(a))).join(' ');
}

/** libuv's quote_cmd_arg: backslashes double only before a quote or the closing quote. */
export function quoteArg(arg: string): string {
  const slash = '\\';
  if (arg === '') return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === slash) {
      slashes++;
      continue;
    }
    if (ch === '"') out += `${slash.repeat(slashes * 2 + 1)}"`;
    else out += slash.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${slash.repeat(slashes * 2)}"`;
}
