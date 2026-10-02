import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
const detached = process.platform !== "win32";
const children = [
  spawn("npm", ["run", "serve"], { stdio: "inherit", detached }),
  spawn("npm", ["run", "dev", "-w", "@dispatchlab/dashboard"], {
    stdio: "inherit",
    detached,
  }),
];
const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: req.url.startsWith("/api/") ? 8787 : 3001,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "localhost:3000" },
    },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(503);
    res.end("Development servers are starting. Refresh in a moment.");
  });
  req.pipe(upstream);
});
// Next's hot-reload connection needs an upgrade tunnel, not an HTTP-only proxy.
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3001, "127.0.0.1", () => {
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(`${headers}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
server.listen(3000, "127.0.0.1", () =>
  console.log("DispatchLab development dashboard: http://localhost:3000"),
);
function stop() {
  for (const child of children) {
    try {
      if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      /* Child already exited. */
    }
  }
  server.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
