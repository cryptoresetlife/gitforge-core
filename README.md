# gitforge-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cryptoresetlife/gitforge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cryptoresetlife/gitforge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process. No dependencies, no git binary, no disk: every
surface reads and writes the same in-memory store.

- **git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (and v0), receive-pack v0,
  shallow clones and deepening, annotated tags, fast-forward-only updates with per-ref reports.
  pkt-line, packfile parsing and writing (ofs/ref deltas, zlib) are implemented here.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents, git refs/blobs/trees,
  labels, issues, comments, pull requests, their files and squash/merge/rebase merges (a three-way
  merge at file granularity, 405 on a conflict), pagination with `Link` headers.
- **GraphQL v4** at `/api/graphql`: a small parser, a schema table with introspection, validation
  and an executor for the documents `gh` and github-mcp-server send, plus batched operations.
- **MCP** at `/mcp`: JSON-RPC 2.0 over streamable HTTP (`server/discover` and the `initialize`
  handshake), with tools that wrap the REST layer.

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | the trial lifecycle: listen on an ephemeral port, register, wait, exit |
| `src/server.mjs` | HTTP/1.1 on `node:net`, auth, routing, a whole-request response cache |
| `src/git.mjs` | objects, trees, commits, packs, pkt-line, upload-pack and receive-pack |
| `src/forge.mjs` | the store, the domain logic and the REST routes |
| `src/graphql.mjs` | the GraphQL lexer, parser, schema, validation and executor |
| `src/mcp.mjs` | the MCP endpoint and its tools |

## Run it

```sh
MAKEFUN_SHOP_TOKEN=secret FORGE_PORT=8081 node main.ts
curl -H 'Authorization: Bearer secret' http://127.0.0.1:8081/api/v3/
```

With `MAKEFUN_ENV_URL` set it binds an ephemeral port instead, registers it with the env and exits
when the env says the trial is done. Needs Node 22.18 or later.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
