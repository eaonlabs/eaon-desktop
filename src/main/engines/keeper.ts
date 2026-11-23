import { createHash } from 'node:crypto'

/**
 * The keeper: a small Python program Eaon puts on a cloud environment's
 * machine, which runs an agent there so it doesn't depend on this computer
 * staying awake or connected (engines/kept.ts). It is detached from the ssh
 * connection that started it (its own session, its std streams on files), so
 * closing the laptop, losing the network or quitting Eaon leaves the agent
 * working.
 *
 * Everything goes through files in the run's folder (`~/.eaon/runs/<id>`):
 * - `in`: what Eaon sends, appended; the keeper feeds it to the agent's stdin
 *   as it grows (`in.eof` closes stdin once all of it is in).
 * - `out`, `err`: the agent's output, as it comes. Eaon reads `out` from the
 *   byte it got to, so a reader that reconnects misses nothing.
 * - `pid`, `exit`: the agent's process id, then its exit code once it ends.
 * - `stop`: Eaon asks for the agent to be ended.
 * A run nothing has written to or read from for `IDLE` seconds ends itself.
 *
 * Python 3 and nothing else: every exe.dev image and nearly any Linux or macOS
 * machine has it.
 */
export const KEEPER_SOURCE = String.raw`import os, select, signal, subprocess, sys, threading, time

IDLE = int(os.environ.get('EAON_KEEPER_IDLE', '21600'))
READ_QUIET = int(os.environ.get('EAON_KEEPER_READ_QUIET', '300'))

def path(d, name):
    return os.path.join(d, name)

def touch(p):
    with open(p, 'ab'):
        pass
    os.utime(p, None)

def copy(stream, target, d):
    with open(target, 'ab', buffering=0) as out:
        while True:
            chunk = stream.read1(65536) if hasattr(stream, 'read1') else stream.read(65536)
            if not chunk:
                return
            out.write(chunk)
            touch(path(d, 'seen'))

def serve(d, cwd, env, argv):
    for name in ('in', 'out', 'err', 'seen'):
        touch(path(d, name))
    try:
        p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, **env))
    except OSError as error:
        with open(path(d, 'err'), 'ab') as e:
            e.write(('%s: %s\n' % (argv[0], error.strerror)).encode())
        with open(path(d, 'exit'), 'w') as f:
            f.write('127')
        return
    with open(path(d, 'pid'), 'w') as f:
        f.write(str(p.pid))
    copiers = [threading.Thread(target=copy, args=(p.stdout, path(d, 'out'), d), daemon=True), threading.Thread(target=copy, args=(p.stderr, path(d, 'err'), d), daemon=True)]
    for copier in copiers:
        copier.start()
    fed = 0
    closed = False
    while p.poll() is None:
        busy = False
        try:
            with open(path(d, 'in'), 'rb') as f:
                f.seek(fed)
                data = f.read()
        except OSError:
            data = b''
        if data and not closed:
            try:
                p.stdin.write(data)
                p.stdin.flush()
            except (BrokenPipeError, OSError):
                closed = True
            fed += len(data)
            touch(path(d, 'seen'))
            busy = True
        if not closed and not data and os.path.exists(path(d, 'in.eof')):
            closed = True
            try:
                p.stdin.close()
            except OSError:
                pass
        if os.path.exists(path(d, 'stop')):
            os.remove(path(d, 'stop'))
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        try:
            if time.time() - os.path.getmtime(path(d, 'seen')) > IDLE:
                p.terminate()
        except OSError:
            pass
        if not busy:
            time.sleep(0.05)
    code = p.wait()
    for copier in copiers:
        copier.join(5)
    with open(path(d, 'exit'), 'w') as f:
        f.write(str(code if code >= 0 else 128 - code))

def start(d, cwd, env, argv):
    os.makedirs(d, exist_ok=True)
    for stale in ('exit', 'stop', 'in.eof'):
        if os.path.exists(path(d, stale)):
            os.remove(path(d, stale))
    if os.fork():
        for _ in range(100):
            if os.path.exists(path(d, 'pid')) or os.path.exists(path(d, 'exit')):
                break
            time.sleep(0.05)
        print('started')
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        serve(d, cwd, env, argv)
    finally:
        os._exit(0)

def gone():
    # The reader's connection closed: its stdout pipe has no one at the other end.
    try:
        poller = select.poll()
        poller.register(1, select.POLLOUT)
        return any(ev & (select.POLLERR | select.POLLHUP) for _, ev in poller.poll(0))
    except (OSError, AttributeError):
        return False

def read(d, offset):
    if not os.path.isdir(d):
        sys.exit(4)
    out = sys.stdout.buffer
    quiet = time.time()
    with open(path(d, 'out'), 'rb') as f:
        f.seek(offset)
        while True:
            chunk = f.read(65536)
            if chunk:
                out.write(chunk)
                out.flush()
                touch(path(d, 'seen'))
                quiet = time.time()
                continue
            if os.path.exists(path(d, 'exit')):
                rest = f.read()
                if rest:
                    out.write(rest)
                    out.flush()
                sys.exit(0)
            if os.getppid() == 1 or gone():
                sys.exit(5)
            # A reader nothing comes through for a while ends, and Eaon starts another: one left by a
            # connection that went without a word is gone within minutes, not when the run ends.
            if time.time() - quiet > READ_QUIET:
                sys.exit(6)
            time.sleep(0.05)

def status(d):
    if not os.path.isdir(d):
        print('missing')
    elif os.path.exists(path(d, 'exit')):
        with open(path(d, 'exit')) as f:
            print('done ' + f.read().strip())
    else:
        size = os.path.getsize(path(d, 'out')) if os.path.exists(path(d, 'out')) else 0
        print('running %d' % size)

def main():
    what, d = sys.argv[1], os.path.expanduser(sys.argv[2])
    if what == 'start':
        cwd = sys.argv[3]
        rest = sys.argv[4:]
        env = {}
        while rest and rest[0] != '--':
            name, _, value = rest[0].partition('=')
            env[name] = value
            rest = rest[1:]
        start(d, os.path.expanduser(cwd), env, rest[1:])
    elif what == 'read':
        read(d, int(sys.argv[3]))
    elif what == 'status':
        status(d)
    elif what == 'stop':
        if os.path.isdir(d) and not os.path.exists(path(d, 'exit')):
            touch(path(d, 'stop'))
    elif what == 'eof':
        touch(path(d, 'in.eof'))

main()
`

/** Where the keeper lives on a machine: named for its own contents, so a newer Eaon puts its newer keeper beside an older one. */
export const KEEPER_PATH = `~/.eaon/keeper-${createHash('sha256').update(KEEPER_SOURCE).digest('hex').slice(0, 10)}.py`
