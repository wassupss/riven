#!/usr/bin/env python3
"""Capture N frames from the demo page through one headless Chrome.

Launching a browser per frame took ~30s/frame; here the page is loaded once and
each frame is `renderFrame(n)` + `Page.captureScreenshot` over the DevTools
protocol. Raw-socket WebSocket client so there are no third-party deps.
"""
import base64, json, os, socket, struct, subprocess, sys, time, urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333
URL = sys.argv[1]
OUT = sys.argv[2]
N = int(sys.argv[3])
W, H, SCALE = 1280, 760, 2


class WS:
    """Minimal client-side WebSocket (text frames only, always masked)."""

    def __init__(self, url):
        _, rest = url.split("://", 1)
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)))
        self.s.settimeout(30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self.s.recv(4096)
        self.buf = self.buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise IOError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, method, params=None):
        self.id += 1
        payload = json.dumps({"id": self.id, "method": method, "params": params or {}}).encode()
        head = bytearray([0x81])
        n = len(payload)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126); head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127); head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.s.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        return self.id

    def frame(self):
        b0, b1 = self._recv(2)
        ln = b1 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._recv(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._recv(8))[0]
        return self._recv(ln)

    def call(self, method, params=None):
        want = self.send(method, params)
        while True:
            msg = json.loads(self.frame())
            if msg.get("id") == want:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})


proc = subprocess.Popen(
    [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
     f"--remote-debugging-port={PORT}", "--user-data-dir=/tmp/rivendemo/cdp-profile",
     f"--window-size={W},{H}", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(60):
    try:
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2))
        pages = [t for t in tabs if t.get("type") == "page"]
        if pages:
            ws_url = pages[0]["webSocketDebuggerUrl"]
            break
    except Exception:
        pass
    time.sleep(0.5)
if not ws_url:
    proc.kill(); sys.exit("chrome did not come up")

ws = WS(ws_url)
ws.call("Page.enable")
ws.call("Emulation.setDeviceMetricsOverride",
        {"width": W, "height": H, "deviceScaleFactor": SCALE, "mobile": False})
ws.call("Page.navigate", {"url": URL})
time.sleep(2.5)                                   # let fonts + first paint settle

os.makedirs(OUT, exist_ok=True)
t0 = time.time()
for i in range(N):
    ws.call("Runtime.evaluate", {"expression": f"renderFrame({i})"})
    shot = ws.call("Page.captureScreenshot", {"format": "png"})
    with open(os.path.join(OUT, f"{i:04d}.png"), "wb") as fh:
        fh.write(base64.b64decode(shot["data"]))
    if i % 50 == 0:
        print(f"{i}/{N}  {time.time() - t0:.0f}s", flush=True)

print(f"captured {N} frames in {time.time() - t0:.0f}s")
proc.kill()
