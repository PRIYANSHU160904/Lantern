// Tiny read-only HTTP endpoint: GET /status -> peer.getStatus() as JSON.
// Used by the demo orchestrator now and by the web dashboard later (CORS is open so a static page can poll it).
import http from 'node:http';

export function startStatusServer(peer, port, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/status')) {
      const body = JSON.stringify(peer.getStatus());
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(body);
    } else {
      res.writeHead(404); res.end();
    }
  });
  server.listen(port, host);
  server.unref();
  return server;
}
