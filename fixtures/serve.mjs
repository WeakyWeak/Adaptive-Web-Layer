import { createServer } from "node:http";
import { readFile } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  // Accept both documented root URLs and workspace-relative fixture URLs.
  const fixturePath = pathname.startsWith("/fixtures/") ? pathname.slice("/fixtures".length) : pathname;
  const filePath = resolve(fixtureRoot, `.${fixturePath === "/" ? "/docs-bright.html" : fixturePath}`);
  if (filePath !== fixtureRoot && !filePath.startsWith(`${fixtureRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    const contentType = extname(filePath) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
});

const port = Number(process.env.FIXTURE_PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  console.log(`Fixtures available at http://localhost:${port}`);
});
