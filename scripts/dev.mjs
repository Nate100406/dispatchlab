import { spawn } from "node:child_process";
import http from "node:http";
const children = [
  spawn("npm", ["run", "serve"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@dispatchlab/dashboard"], {
    stdio: "inherit",
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
server.listen(3000, "127.0.0.1", () =>
  console.log("DispatchLab development dashboard: http://localhost:3000"),
);
function stop() {
  for (const child of children) child.kill("SIGTERM");
  server.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
