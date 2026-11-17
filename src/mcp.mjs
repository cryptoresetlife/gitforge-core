// The Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over streamable HTTP, answered as
// application/json). It speaks the 2026-07-28 revision (server/discover) and the handshake revisions
// (initialize / notifications/initialized). Every tool is a thin wrapper over the REST layer, so a
// thing created here is the very object /api/v3 serves.

import { ApiError, errorBody, rest, viewer } from './forge.mjs';

const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'gitforge-mcp', title: 'gitforge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'Tools for the repositories, issues and pull requests of this forge. Arguments follow github-mcp-server.';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const OWNER = str('Repository owner (the login the token belongs to)');
const REPO = str('Repository name');
const PAGE = num('Page number for pagination (min 1)');
const PER_PAGE = num('Results per page for pagination (min 1, max 100)');

function schema(properties, required) {
  return { type: 'object', properties, required: required || [], additionalProperties: true };
}

function pick(args, ...names) {
  for (const name of names) if (args[name] !== undefined && args[name] !== null) return args[name];
  return undefined;
}

function repoPath(args) {
  let owner = pick(args, 'owner');
  let repo = pick(args, 'repo', 'name');
  const full = pick(args, 'full_name', 'repository');
  if (typeof full === 'string' && full.includes('/') && (owner === undefined || repo === undefined)) {
    [owner, repo] = full.split('/', 2);
  }
  if (owner === undefined) owner = viewer.login;
  return ['repos', String(owner), String(repo)];
}

function pageQuery(args, extra) {
  const parts = [];
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  const page = pick(args, 'page');
  const perPage = pick(args, 'perPage', 'per_page');
  if (page !== undefined) parts.push(`page=${encodeURIComponent(String(page))}`);
  if (perPage !== undefined) parts.push(`per_page=${encodeURIComponent(String(perPage))}`);
  return parts.join('&');
}

function lowerState(value) {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function numberOf(args, ...names) {
  const value = pick(args, ...names);
  return value === undefined ? undefined : Number(value);
}

const TOOLS = [
  {
    name: 'get_me',
    description: 'Get the profile of the authenticated user, the owner of every repository on this forge.',
    inputSchema: schema({}),
    run: (args, call) => call('GET', ['user']),
  },
  {
    name: 'create_repo',
    description: 'Create a new repository in the authenticated user\'s account.',
    inputSchema: schema({ name: str('Repository name'), description: str('Repository description'), private: bool('Whether the repository is private'), autoInit: bool('Initialize the repository with a README') }, ['name']),
    run: (args, call) => call('POST', ['user', 'repos'], '', { name: args.name, description: args.description, private: args.private === true, auto_init: pick(args, 'autoInit', 'auto_init') === true }),
  },
  {
    name: 'get_repo',
    description: 'Get one repository: its id, name, owner, visibility, description and default branch.',
    inputSchema: schema({ owner: OWNER, repo: REPO }, ['owner', 'repo']),
    run: (args, call) => call('GET', repoPath(args)),
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: schema({ page: PAGE, perPage: PER_PAGE }),
    run: (args, call) => call('GET', ['user', 'repos'], pageQuery(args)),
  },
  {
    name: 'search_repositories',
    description: 'Search repositories by name or description.',
    inputSchema: schema({ query: str('Search query'), page: PAGE, perPage: PER_PAGE }, ['query']),
    run: (args, call) => call('GET', ['search', 'repositories'], pageQuery(args, { q: args.query })),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: str('Issue title'), body: str('Issue body content'), labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply (they must exist in the repository)' }, assignees: { type: 'array', items: { type: 'string' }, description: 'Logins to assign' } }, ['owner', 'repo', 'title']),
    run: (args, call) => call('POST', [...repoPath(args), 'issues'], '', { title: args.title, body: args.body, labels: args.labels, assignees: args.assignees }),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue number') }, ['owner', 'repo', 'issue_number']),
    run: (args, call) => call('GET', [...repoPath(args), 'issues', String(numberOf(args, 'issue_number', 'issueNumber', 'number'))]),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, filtered by state and labels.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', description: 'Filter by state: open, closed or all', enum: ['open', 'closed', 'all', 'OPEN', 'CLOSED', 'ALL'] }, labels: { type: 'array', items: { type: 'string' }, description: 'Filter by labels' }, sort: str('Sort by created, updated or comments'), direction: str('Sort direction: asc or desc'), since: str('Only issues updated at or after this ISO 8601 time'), page: PAGE, perPage: PER_PAGE }, ['owner', 'repo']),
    run: (args, call) => call('GET', [...repoPath(args), 'issues'], pageQuery(args, { state: lowerState(args.state), labels: Array.isArray(args.labels) ? args.labels.join(',') : args.labels, sort: lowerState(args.sort), direction: lowerState(args.direction), since: args.since })),
  },
  {
    name: 'update_issue',
    description: 'Update an issue: its title, body, state or labels.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue number'), title: str('New title'), body: str('New body'), state: { type: 'string', description: 'New state', enum: ['open', 'closed'] }, labels: { type: 'array', items: { type: 'string' }, description: 'New labels' } }, ['owner', 'repo', 'issue_number']),
    run: (args, call) => call('PATCH', [...repoPath(args), 'issues', String(numberOf(args, 'issue_number', 'issueNumber', 'number'))], '', { title: args.title, body: args.body, state: lowerState(args.state), labels: args.labels }),
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: num('Issue or pull request number'), body: str('Comment text') }, ['owner', 'repo', 'issue_number', 'body']),
    run: (args, call) => call('POST', [...repoPath(args), 'issues', String(numberOf(args, 'issue_number', 'issueNumber', 'number')), 'comments'], '', { body: args.body }),
  },
  {
    name: 'search_issues',
    description: 'Search issues and pull requests with GitHub search syntax (repo:, is:issue, is:open).',
    inputSchema: schema({ query: str('Search query'), page: PAGE, perPage: PER_PAGE }, ['query']),
    run: (args, call) => call('GET', ['search', 'issues'], pageQuery(args, { q: pick(args, 'query', 'q') })),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: str('Pull request title'), body: str('Pull request description'), head: str('Branch that holds the changes'), base: str('Branch to merge into'), draft: bool('Open as a draft') }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (args, call) => call('POST', [...repoPath(args), 'pulls'], '', { title: args.title, body: args.body, head: args.head, base: args.base, draft: args.draft === true }),
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number, with its head, base, state and mergeability.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pullNumber: num('Pull request number') }, ['owner', 'repo', 'pullNumber']),
    run: (args, call) => call('GET', [...repoPath(args), 'pulls', String(numberOf(args, 'pullNumber', 'pull_number', 'number'))]),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, filtered by state, head and base.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', description: 'Filter by state: open, closed or all', enum: ['open', 'closed', 'all'] }, head: str('Filter by head branch'), base: str('Filter by base branch'), page: PAGE, perPage: PER_PAGE }, ['owner', 'repo']),
    run: (args, call) => call('GET', [...repoPath(args), 'pulls'], pageQuery(args, { state: lowerState(args.state), head: args.head, base: args.base })),
  },
  {
    name: 'get_pull_request_files',
    description: 'List the files a pull request changes, with their statuses and line counts.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pullNumber: num('Pull request number') }, ['owner', 'repo', 'pullNumber']),
    run: (args, call) => call('GET', [...repoPath(args), 'pulls', String(numberOf(args, 'pullNumber', 'pull_number', 'number')), 'files']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (merge, squash or rebase).',
    inputSchema: schema({ owner: OWNER, repo: REPO, pullNumber: num('Pull request number'), merge_method: { type: 'string', description: 'Merge method', enum: ['merge', 'squash', 'rebase'] }, commit_title: str('Title for the merge commit'), commit_message: str('Extra detail for the merge commit') }, ['owner', 'repo', 'pullNumber']),
    run: (args, call) => call('PUT', [...repoPath(args), 'pulls', String(numberOf(args, 'pullNumber', 'pull_number', 'number')), 'merge'], '', { merge_method: lowerState(pick(args, 'merge_method', 'mergeMethod')), commit_title: pick(args, 'commit_title', 'commitTitle'), commit_message: pick(args, 'commit_message', 'commitMessage') }),
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository with their tip commits.',
    inputSchema: schema({ owner: OWNER, repo: REPO, page: PAGE, perPage: PER_PAGE }, ['owner', 'repo']),
    run: (args, call) => call('GET', [...repoPath(args), 'branches'], pageQuery(args)),
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (the default branch when from_branch is omitted).',
    inputSchema: schema({ owner: OWNER, repo: REPO, branch: str('Name of the new branch'), from_branch: str('Branch to start from') }, ['owner', 'repo', 'branch']),
    run: (args, call) => {
      const base = repoPath(args);
      const from = pick(args, 'from_branch', 'fromBranch');
      const source = from === undefined ? call('GET', base).default_branch : from;
      const tip = call('GET', [...base, 'branches', ...String(source).split('/')]);
      return call('POST', [...base, 'git', 'refs'], '', { ref: `refs/heads/${args.branch}`, sha: tip.commit.sha });
    },
  },
  {
    name: 'list_commits',
    description: 'List the commits of a branch, newest first.',
    inputSchema: schema({ owner: OWNER, repo: REPO, sha: str('Branch name, tag or commit sha to list from'), page: PAGE, perPage: PER_PAGE }, ['owner', 'repo']),
    run: (args, call) => call('GET', [...repoPath(args), 'commits'], pageQuery(args, { sha: args.sha })),
  },
  {
    name: 'get_file_contents',
    description: 'Get a file (base64 content and sha) or a directory listing from a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, path: str('Path of the file or directory'), ref: str('Branch, tag or commit sha') }, ['owner', 'repo']),
    run: (args, call) => call('GET', [...repoPath(args), 'contents', ...String(args.path || '').split('/').filter((part) => part !== '')], pageQuery({}, { ref: pick(args, 'ref', 'branch', 'sha') })),
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update one file with a commit. Updating needs the sha of the file being replaced.',
    inputSchema: schema({ owner: OWNER, repo: REPO, path: str('Path of the file'), content: str('New file content (plain text)'), message: str('Commit message'), branch: str('Branch to commit to'), sha: str('Blob sha of the file being replaced') }, ['owner', 'repo', 'path', 'content', 'message']),
    run: (args, call) => call('PUT', [...repoPath(args), 'contents', ...String(args.path || '').split('/').filter((part) => part !== '')], '', { message: args.message, content: Buffer.from(String(args.content === undefined ? '' : args.content), 'utf8').toString('base64'), branch: args.branch, sha: args.sha }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, title: tool.name.replace(/_/g, ' '), description: tool.description, inputSchema: tool.inputSchema }));

class ToolFailure extends Error {
  constructor(payload) {
    super(payload.message);
    this.payload = payload;
  }
}

function callTool(params, B) {
  const tool = TOOL_BY_NAME.get(params.name);
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  const missing = tool.inputSchema.required.filter((name) => {
    if (args[name] !== undefined && args[name] !== null && args[name] !== '') return false;
    if (name === 'pullNumber') return args.pull_number === undefined && args.number === undefined;
    if (name === 'issue_number') return args.issueNumber === undefined && args.number === undefined;
    if ((name === 'owner' || name === 'repo') && typeof args.full_name === 'string') return false;
    return true;
  });
  if (missing.length > 0) {
    return { content: [{ type: 'text', text: `missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` }], isError: true };
  }
  const call = (method, segs, query, body) => {
    try {
      const out = rest(method, segs, query || '', body, B, `/api/v3/${segs.map(encodeURIComponent).join('/')}`);
      return out.json === undefined ? { ok: true } : out.json;
    } catch (err) {
      if (err instanceof ApiError) throw new ToolFailure(errorBody(err));
      throw err;
    }
  };
  try {
    const value = tool.run(args, call);
    const result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
    return result;
  } catch (err) {
    if (err instanceof ToolFailure) return { content: [{ type: 'text', text: JSON.stringify(err.payload) }], isError: true };
    throw err;
  }
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

// Answers one JSON-RPC message; undefined for a notification.
function dispatch(message, B) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }
  const { id, method } = message;
  const params = message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
  if (id === undefined || id === null) return undefined;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: typeof asked === 'string' && SUPPORTED.includes(asked) ? asked : SUPPORTED[1],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOL_LIST });
    case 'tools/call': {
      if (typeof params.name !== 'string' || !TOOL_BY_NAME.has(params.name)) {
        return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      }
      if (params.arguments !== undefined && params.arguments !== null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
        return rpcError(id, -32602, 'Invalid params: arguments must be an object');
      }
      return ok(callTool(params, B));
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'logging/setLevel':
      return ok({});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function mcpHttp(method, headers, body, B) {
  if (method === 'DELETE') return { status: 204, json: undefined, extra: '' };
  if (method !== 'POST') return { status: 405, json: rpcError(null, -32600, 'Method Not Allowed: POST JSON-RPC messages to this endpoint'), extra: 'Allow: POST, DELETE\r\n' };
  let message;
  try {
    message = JSON.parse(body === null ? '' : body.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error'), extra: '' };
  }
  if (Array.isArray(message)) {
    if (message.length === 0) return { status: 400, json: rpcError(null, -32600, 'Invalid Request'), extra: '' };
    const answers = [];
    for (const item of message) {
      const answer = dispatch(item, B);
      if (answer !== undefined) answers.push(answer);
    }
    if (answers.length === 0) return { status: 202, json: undefined, extra: '' };
    return { status: 200, json: answers, extra: '' };
  }
  const answer = dispatch(message, B);
  if (answer === undefined) return { status: 202, json: undefined, extra: '' };
  const invalid = answer.error !== undefined && answer.error.code === -32600;
  return { status: invalid ? 400 : 200, json: answer, extra: '' };
}
