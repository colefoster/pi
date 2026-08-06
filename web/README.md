# pi-web

The browser UI for the [**pi**](../pi) harness. A thin edge: it serves the
static frontend (`public/`), proxies the harness control API (`/config`,
`/projects`, `/manifest`, `/messages`, `/health`), and bridges browser WebSockets to the
harness event stream. All agent logic lives in the harness — this package has none.

## Run

Start the harness first (in `../pi`):

```bash
cd ../pi && node harness/service.mjs        # harness API + event WS on :5179
```

Then start the web app here:

```bash
npm install                                 # first time only (dep: ws)
node server.mjs                             # → http://localhost:5178
```

If the harness runs elsewhere, point at it:

```bash
HARNESS_URL=http://otherbox:5179 node server.mjs
```

## Config

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `5178` | port this web app listens on |
| `HOST` | `127.0.0.1` | bind address (loopback-only; set `0.0.0.0` to expose) |
| `HARNESS_URL` | `http://localhost:5179` | where to reach the harness (HTTP + WS derived from it) |
