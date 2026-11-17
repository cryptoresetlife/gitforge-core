// A compact GraphQL v4 endpoint: a hand-written lexer/parser, a schema table (types, fields, args and
// resolvers), validation of field names against that table, an executor, and introspection. It covers
// the documents gh and github-mcp-server send, resolved against the same store REST reads.

import {
  ApiError,
  addComment,
  allRepos,
  commentNodeId,
  createIssue,
  createPull,
  createRepo,
  findRepo,
  iso,
  issueNodeId,
  listIssues,
  mergePull,
  nodeById,
  pullCommits,
  pullFiles,
  pullMergeable,
  pullTips,
  setIssueState,
  updateIssue,
  updatePull,
  userNodeId,
  viewer,
} from './forge.mjs';
import { parseIdent } from './git.mjs';

// ---------------------------------------------------------------------------------------------
// lexer + parser
// ---------------------------------------------------------------------------------------------

class GqlSyntaxError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

function locate(text, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else col += 1;
  }
  return { line, column: col };
}

const PUNCT = '!$()[]{}:=@|&';

function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 0xfeff) {
      i += 1;
      continue;
    }
    if (c === 35) {
      while (i < n && text.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (c === 46) {
      if (text.startsWith('...', i)) {
        tokens.push({ t: '...', v: '...', p: i });
        i += 3;
        continue;
      }
      throw new GqlSyntaxError('Unexpected character "."', i);
    }
    const ch = text[i];
    if (PUNCT.includes(ch)) {
      tokens.push({ t: ch, v: ch, p: i });
      i += 1;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || (d >= 48 && d <= 57)) j += 1;
        else break;
      }
      tokens.push({ t: 'name', v: text.slice(i, j), p: i });
      i = j;
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i + 1;
      let float = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d >= 48 && d <= 57) j += 1;
        else if (d === 46 || d === 101 || d === 69 || d === 43 || d === 45) {
          float = true;
          j += 1;
        } else break;
      }
      tokens.push({ t: float ? 'float' : 'int', v: Number(text.slice(i, j)), p: i });
      i = j;
      continue;
    }
    if (c === 34) {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('Unterminated block string', i);
        tokens.push({ t: 'str', v: text.slice(i + 3, end).replace(/\\"""/g, '"""').trim(), p: i });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw new GqlSyntaxError('Unterminated string', i);
        const d = text[j];
        if (d === '"') break;
        if (d === '\n') throw new GqlSyntaxError('Unterminated string', i);
        if (d === '\\') {
          const e = text[j + 1];
          if (e === 'u') {
            out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
            j += 2;
          }
        } else {
          out += d;
          j += 1;
        }
      }
      tokens.push({ t: 'str', v: out, p: i });
      i = j + 1;
      continue;
    }
    throw new GqlSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ t: 'eof', v: '', p: n });
  return tokens;
}

function parseDocument(text) {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expect = (type) => {
    const token = tokens[at];
    if (token.t !== type) throw new GqlSyntaxError(`Expected ${type}, found ${token.t === 'eof' ? 'end of document' : JSON.stringify(String(token.v))}`, token.p);
    at += 1;
    return token;
  };
  const accept = (type) => {
    if (tokens[at].t === type) {
      at += 1;
      return true;
    }
    return false;
  };

  const parseValue = () => {
    const token = next();
    switch (token.t) {
      case '$':
        return { k: 'var', name: expect('name').v };
      case 'int':
      case 'float':
      case 'str':
        return { k: 'lit', v: token.v };
      case 'name':
        if (token.v === 'true') return { k: 'lit', v: true };
        if (token.v === 'false') return { k: 'lit', v: false };
        if (token.v === 'null') return { k: 'lit', v: null };
        return { k: 'lit', v: token.v };
      case '[': {
        const items = [];
        while (!accept(']')) items.push(parseValue());
        return { k: 'list', items };
      }
      case '{': {
        const fields = [];
        while (!accept('}')) {
          const name = expect('name').v;
          expect(':');
          fields.push({ name, value: parseValue() });
        }
        return { k: 'obj', fields };
      }
      default:
        throw new GqlSyntaxError(`Unexpected ${JSON.stringify(String(token.v))} in a value`, token.p);
    }
  };

  const parseArgs = () => {
    const args = [];
    if (!accept('(')) return args;
    while (!accept(')')) {
      const name = expect('name').v;
      expect(':');
      args.push({ name, value: parseValue() });
    }
    return args;
  };

  const parseDirectives = () => {
    const out = [];
    while (accept('@')) out.push({ name: expect('name').v, args: parseArgs() });
    return out;
  };

  const parseTypeRef = () => {
    let text;
    if (accept('[')) {
      text = `[${parseTypeRef()}]`;
      expect(']');
    } else text = expect('name').v;
    if (accept('!')) text += '!';
    return text;
  };

  const parseSelectionSet = () => {
    expect('{');
    const out = [];
    while (!accept('}')) {
      if (accept('...')) {
        const token = peek();
        if (token.t === 'name' && token.v !== 'on') {
          next();
          out.push({ k: 'spread', name: token.v, directives: parseDirectives(), p: token.p });
        } else {
          let on = null;
          if (token.t === 'name') {
            next();
            on = expect('name').v;
          }
          const directives = parseDirectives();
          out.push({ k: 'inline', on, directives, sel: parseSelectionSet(), p: token.p });
        }
        continue;
      }
      const first = expect('name');
      let alias = first.v;
      let name = first.v;
      if (accept(':')) name = expect('name').v;
      const args = parseArgs();
      const directives = parseDirectives();
      const sel = peek().t === '{' ? parseSelectionSet() : null;
      out.push({ k: 'field', alias, name, args, directives, sel, p: first.p });
    }
    return out;
  };

  const operations = [];
  const fragments = new Map();
  while (peek().t !== 'eof') {
    const token = peek();
    if (token.t === '{') {
      operations.push({ type: 'query', name: null, vars: [], sel: parseSelectionSet(), p: token.p });
      continue;
    }
    if (token.t !== 'name') throw new GqlSyntaxError(`Unexpected ${JSON.stringify(String(token.v))}`, token.p);
    next();
    if (token.v === 'fragment') {
      const name = expect('name').v;
      const on = expect('name');
      if (on.v !== 'on') throw new GqlSyntaxError('Expected "on"', on.p);
      const cond = expect('name').v;
      parseDirectives();
      fragments.set(name, { name, on: cond, sel: parseSelectionSet(), p: token.p });
      continue;
    }
    if (token.v !== 'query' && token.v !== 'mutation' && token.v !== 'subscription') {
      throw new GqlSyntaxError(`Unexpected ${JSON.stringify(token.v)}`, token.p);
    }
    const name = peek().t === 'name' ? next().v : null;
    const vars = [];
    if (accept('(')) {
      while (!accept(')')) {
        expect('$');
        const varName = expect('name').v;
        expect(':');
        const type = parseTypeRef();
        const def = accept('=') ? parseValue() : undefined;
        parseDirectives();
        vars.push({ name: varName, type, def });
      }
    }
    parseDirectives();
    operations.push({ type: token.v, name, vars, sel: parseSelectionSet(), p: token.p });
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------------------------------------
// schema helpers
// ---------------------------------------------------------------------------------------------

function namedType(type) {
  return type.replace(/[[\]!]/g, '');
}

function f(type, resolve, args) {
  return { type, resolve: resolve || null, args: args || null };
}

function cursorOf(index) {
  return Buffer.from(`cursor:v2:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const n = Number(text.slice(text.lastIndexOf(':') + 1));
  return Number.isInteger(n) ? n : -1;
}

// Relay-style slicing of an already ordered list.
function connect(items, args) {
  let start = 0;
  let end = items.length;
  if (args.after !== undefined && args.after !== null) start = Math.min(end, Math.max(0, indexOfCursor(args.after) + 1));
  if (args.before !== undefined && args.before !== null) {
    const before = indexOfCursor(args.before);
    if (before >= 0) end = Math.max(start, Math.min(end, before));
  }
  const first = Number.isInteger(args.first) ? Math.max(0, args.first) : null;
  const last = Number.isInteger(args.last) ? Math.max(0, args.last) : null;
  let from = start;
  let to = end;
  if (first !== null) to = Math.min(end, start + Math.min(first, 100));
  else if (last !== null) from = Math.max(start, end - Math.min(last, 100));
  else to = Math.min(end, start + 100);
  const edges = [];
  for (let i = from; i < to; i += 1) edges.push({ node: items[i], cursor: cursorOf(i) });
  return {
    edges,
    nodes: edges.map((edge) => edge.node),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: to < end,
      hasPreviousPage: from > start,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

const CONNECTION_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

const types = {};

function connectionType(name, extra) {
  types[`${name}Edge`] = { kind: 'OBJECT', fields: { node: f(name), cursor: f('String!') } };
  types[`${name}Connection`] = {
    kind: 'OBJECT',
    fields: { edges: f(`[${name}Edge]`), nodes: f(`[${name}]`), pageInfo: f('PageInfo!'), totalCount: f('Int!'), ...(extra || {}) },
  };
}

function enumType(name, values) {
  types[name] = { kind: 'ENUM', values };
}

function inputType(name, fields) {
  types[name] = { kind: 'INPUT_OBJECT', inputFields: fields };
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

function fail(message, type) {
  const err = new Error(message);
  err.gqlType = type || 'UNPROCESSABLE';
  return err;
}

function repoUrl(repo, ctx) {
  return `${ctx.B}/${viewer.login}/${repo.name}`;
}

function refSource(repo, full) {
  const oid = repo.git.refs.get(full);
  return oid === undefined ? null : { repo, ref: full, oid };
}

function issueStates(args) {
  const filter = args.filterBy && Array.isArray(args.filterBy.states) ? args.filterBy.states : args.states;
  return Array.isArray(filter) && filter.length > 0 ? filter.map((s) => String(s).toUpperCase()) : null;
}

function orderOf(args, fallbackDesc) {
  const order = args.orderBy || {};
  const field = typeof order.field === 'string' ? order.field.toUpperCase() : 'CREATED_AT';
  const direction = typeof order.direction === 'string' ? order.direction.toUpperCase() : fallbackDesc ? 'DESC' : 'ASC';
  return { sort: field === 'UPDATED_AT' ? 'updated' : field === 'COMMENTS' ? 'comments' : 'created', direction: direction === 'DESC' ? 'desc' : 'asc' };
}

function repoIssues(repo, args) {
  const states = issueStates(args);
  const order = orderOf(args, false);
  const labels = Array.isArray(args.labels) && args.labels.length > 0 ? args.labels.map((name) => String(name).toLowerCase()) : null;
  let list = listIssues(repo, { state: 'all', sort: order.sort, direction: order.direction, labels });
  if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
  return connect(list.map((issue) => ({ repo, issue })), args);
}

function pullState(issue) {
  return issue.pull.merged ? 'MERGED' : issue.state.toUpperCase();
}

function repoPulls(repo, args) {
  const states = Array.isArray(args.states) && args.states.length > 0 ? args.states.map((s) => String(s).toUpperCase()) : null;
  const order = orderOf(args, false);
  const labels = Array.isArray(args.labels) && args.labels.length > 0 ? args.labels.map((name) => String(name).toLowerCase()) : null;
  let list = listIssues(repo, { pulls: true, state: 'all', sort: order.sort, direction: order.direction, labels });
  if (states !== null) list = list.filter((issue) => states.includes(pullState(issue)));
  if (typeof args.headRefName === 'string') list = list.filter((issue) => issue.pull.head === args.headRefName);
  if (typeof args.baseRefName === 'string') list = list.filter((issue) => issue.pull.base === args.baseRefName);
  return connect(list.map((issue) => ({ repo, issue })), args);
}

function needNode(id, kind) {
  const node = nodeById(id);
  if (node === null || (kind !== undefined && node.kind !== kind)) {
    throw fail(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
  }
  return node;
}

function shortRef(name) {
  if (typeof name !== 'string') return name;
  let out = name.startsWith('refs/heads/') ? name.slice(11) : name;
  const colon = out.indexOf(':');
  if (colon >= 0) out = out.slice(colon + 1);
  return out;
}

function runApi(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApiError) {
      let message = err.message;
      if (Array.isArray(err.errors) && err.errors.length > 0) {
        const first = err.errors[0];
        if (typeof first.message === 'string') message = first.message;
        else if (first.field) message = `${message}: ${first.resource || 'input'}.${first.field} is ${first.code || 'invalid'}`;
      }
      throw fail(message, err.status === 404 ? 'NOT_FOUND' : 'UNPROCESSABLE');
    }
    throw err;
  }
}

const userFields = {
  id: f('ID!', () => userNodeId()),
  databaseId: f('Int', () => viewer.id),
  login: f('String!', () => viewer.login),
  name: f('String', () => viewer.name),
  email: f('String!', () => viewer.email),
  url: f('URI!', (s, a, ctx) => `${ctx.B}/${viewer.login}`),
  avatarUrl: f('URI!', (s, a, ctx) => `${ctx.B}/avatars/u/${viewer.id}`, { size: 'Int' }),
  resourcePath: f('URI!', () => `/${viewer.login}`),
  isViewer: f('Boolean!', () => true),
  isSiteAdmin: f('Boolean!', () => false),
  bio: f('String', () => null),
  company: f('String', () => null),
  location: f('String', () => null),
  createdAt: f('DateTime!', () => iso(Math.floor(Date.UTC(2026, 0, 1) / 1000))),
  repositories: f('RepositoryConnection!', (s, args) => {
    let list = allRepos();
    if (args.privacy === 'PUBLIC') list = list.filter((repo) => !repo.private);
    if (args.privacy === 'PRIVATE') list = list.filter((repo) => repo.private);
    return connect(list, args);
  }, { ...CONNECTION_ARGS, privacy: 'RepositoryPrivacy', orderBy: 'RepositoryOrder', ownerAffiliations: '[RepositoryAffiliation]', isFork: 'Boolean' }),
  repository: f('Repository', (s, args) => findRepo(viewer.login, args.name), { name: 'String!', followRenames: 'Boolean' }),
  organizations: f('OrganizationConnection!', (s, args) => connect([], args), CONNECTION_ARGS),
};

types.Node = { kind: 'INTERFACE', fields: { id: f('ID!') }, possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label', 'Ref', 'Commit'] };
types.Actor = { kind: 'INTERFACE', fields: { login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl, resourcePath: userFields.resourcePath }, possibleTypes: ['User'] };
types.RepositoryOwner = { kind: 'INTERFACE', fields: { id: userFields.id, login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl, repositories: userFields.repositories, repository: userFields.repository }, possibleTypes: ['User', 'Organization'] };
types.User = { kind: 'OBJECT', interfaces: ['Node', 'Actor', 'RepositoryOwner'], fields: userFields };
types.Organization = { kind: 'OBJECT', interfaces: ['Node', 'Actor', 'RepositoryOwner'], fields: { id: f('ID!'), login: f('String!'), name: f('String'), url: f('URI!') } };
connectionType('Organization');
connectionType('User');

types.PageInfo = { kind: 'OBJECT', fields: { hasNextPage: f('Boolean!'), hasPreviousPage: f('Boolean!'), startCursor: f('String'), endCursor: f('String') } };

types.Repository = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (repo) => repo.nodeId),
    databaseId: f('Int', (repo) => repo.id),
    name: f('String!'),
    nameWithOwner: f('String!', (repo) => `${viewer.login}/${repo.name}`),
    owner: f('RepositoryOwner!', () => ({ user: true })),
    description: f('String'),
    url: f('URI!', (repo, a, ctx) => repoUrl(repo, ctx)),
    sshUrl: f('GitSSHRemote!', (repo, a, ctx) => `${repoUrl(repo, ctx)}.git`),
    homepageUrl: f('URI', (repo) => repo.homepage),
    resourcePath: f('URI!', (repo) => `/${viewer.login}/${repo.name}`),
    isPrivate: f('Boolean!', (repo) => repo.private),
    isFork: f('Boolean!', () => false),
    isArchived: f('Boolean!', () => false),
    isTemplate: f('Boolean!', () => false),
    isEmpty: f('Boolean!', (repo) => repo.git.refs.size === 0),
    isInOrganization: f('Boolean!', () => false),
    visibility: f('RepositoryVisibility!', (repo) => (repo.private ? 'PRIVATE' : 'PUBLIC')),
    defaultBranchRef: f('Ref', (repo) => refSource(repo, repo.git.head)),
    viewerPermission: f('RepositoryPermission', () => 'ADMIN'),
    viewerCanAdminister: f('Boolean!', () => true),
    viewerDefaultMergeMethod: f('PullRequestMergeMethod!', () => 'MERGE'),
    hasIssuesEnabled: f('Boolean!', (repo) => repo.hasIssues),
    hasWikiEnabled: f('Boolean!', () => true),
    hasProjectsEnabled: f('Boolean!', () => true),
    hasDiscussionsEnabled: f('Boolean!', () => false),
    mergeCommitAllowed: f('Boolean!', () => true),
    squashMergeAllowed: f('Boolean!', () => true),
    rebaseMergeAllowed: f('Boolean!', () => true),
    deleteBranchOnMerge: f('Boolean!', () => false),
    stargazerCount: f('Int!', () => 0),
    forkCount: f('Int!', () => 0),
    parent: f('Repository', () => null),
    templateRepository: f('Repository', () => null),
    createdAt: f('DateTime!', (repo) => iso(repo.createdAt)),
    updatedAt: f('DateTime!', (repo) => iso(repo.updatedAt)),
    pushedAt: f('DateTime', (repo) => iso(repo.pushedAt)),
    issue: f('Issue', (repo, args) => {
      const issue = repo.issues.get(args.number);
      return issue === undefined || issue.pull !== null ? null : { repo, issue };
    }, { number: 'Int!' }),
    issueOrPullRequest: f('IssueOrPullRequest', (repo, args) => {
      const issue = repo.issues.get(args.number);
      return issue === undefined ? null : { repo, issue };
    }, { number: 'Int!' }),
    issues: f('IssueConnection!', repoIssues, { ...CONNECTION_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' }),
    pullRequest: f('PullRequest', (repo, args) => {
      const issue = repo.issues.get(args.number);
      return issue === undefined || issue.pull === null ? null : { repo, issue };
    }, { number: 'Int!' }),
    pullRequests: f('PullRequestConnection!', repoPulls, { ...CONNECTION_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' }),
    labels: f('LabelConnection', (repo, args) => {
      let list = [...repo.labels.values()];
      if (typeof args.query === 'string' && args.query !== '') list = list.filter((label) => label.name.toLowerCase().includes(args.query.toLowerCase()));
      return connect(list.map((label) => ({ repo, label })), args);
    }, { ...CONNECTION_ARGS, query: 'String', orderBy: 'LabelOrder' }),
    label: f('Label', (repo, args) => {
      const label = repo.labels.get(String(args.name).toLowerCase());
      return label === undefined ? null : { repo, label };
    }, { name: 'String!' }),
    ref: f('Ref', (repo, args) => {
      const name = String(args.qualifiedName);
      return refSource(repo, name.startsWith('refs/') ? name : `refs/heads/${name}`) || refSource(repo, `refs/tags/${name}`);
    }, { qualifiedName: 'String!' }),
    refs: f('RefConnection', (repo, args) => {
      const prefix = String(args.refPrefix || 'refs/heads/');
      const list = repo.git.refList().filter(([name]) => name.startsWith(prefix)).map(([name, oid]) => ({ repo, ref: name, oid }));
      return connect(list, args);
    }, { ...CONNECTION_ARGS, refPrefix: 'String!', query: 'String' }),
    object: f('GitObject', (repo, args) => {
      const expression = typeof args.oid === 'string' ? args.oid : typeof args.expression === 'string' ? args.expression.split(':')[0] : null;
      const oid = repo.git.resolve(expression === null || expression === 'HEAD' ? undefined : expression);
      return oid === null ? null : { repo, oid };
    }, { oid: 'GitObjectID', expression: 'String' }),
    assignableUsers: f('UserConnection!', (repo, args) => connect([{ user: true }], args), { ...CONNECTION_ARGS, query: 'String' }),
    mentionableUsers: f('UserConnection!', (repo, args) => connect([{ user: true }], args), { ...CONNECTION_ARGS, query: 'String' }),
    collaborators: f('UserConnection', (repo, args) => connect([{ user: true }], args), CONNECTION_ARGS),
  },
};
connectionType('Repository');

const issueCommon = {
  databaseId: f('Int', (s) => (s.issue.pull === null ? s.issue.id : s.issue.pull.id)),
  number: f('Int!', (s) => s.issue.number),
  title: f('String!', (s) => s.issue.title),
  body: f('String!', (s) => s.issue.body),
  bodyText: f('String!', (s) => s.issue.body),
  bodyHTML: f('HTML!', (s) => s.issue.body),
  url: f('URI!', (s, a, ctx) => `${repoUrl(s.repo, ctx)}/${s.issue.pull === null ? 'issues' : 'pull'}/${s.issue.number}`),
  resourcePath: f('URI!', (s) => `/${viewer.login}/${s.repo.name}/${s.issue.pull === null ? 'issues' : 'pull'}/${s.issue.number}`),
  createdAt: f('DateTime!', (s) => iso(s.issue.createdAt)),
  updatedAt: f('DateTime!', (s) => iso(s.issue.updatedAt)),
  closedAt: f('DateTime', (s) => (s.issue.closedAt === null ? null : iso(s.issue.closedAt))),
  closed: f('Boolean!', (s) => s.issue.state === 'closed'),
  locked: f('Boolean!', () => false),
  author: f('Actor', () => ({ user: true })),
  authorAssociation: f('CommentAuthorAssociation!', () => 'OWNER'),
  repository: f('Repository!', (s) => s.repo),
  milestone: f('Milestone', () => null),
  labels: f('LabelConnection', (s, args) => connect(s.issue.labels.map((label) => ({ repo: s.repo, label })), args), { ...CONNECTION_ARGS, orderBy: 'LabelOrder' }),
  assignees: f('UserConnection!', (s, args) => connect(s.issue.assignees.map(() => ({ user: true })), args), CONNECTION_ARGS),
  comments: f('IssueCommentConnection!', (s, args) => connect(s.issue.comments.map((comment) => ({ repo: s.repo, issue: s.issue, comment })), args), CONNECTION_ARGS),
  viewerCanUpdate: f('Boolean!', () => true),
  viewerDidAuthor: f('Boolean!', () => true),
};

types.Issue = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (s) => issueNodeId(s.repo, s.issue)),
    ...issueCommon,
    state: f('IssueState!', (s) => s.issue.state.toUpperCase()),
    stateReason: f('IssueStateReason', (s) => (s.issue.stateReason === null ? null : s.issue.stateReason.toUpperCase())),
    isPinned: f('Boolean', () => false),
  },
};
connectionType('Issue');

types.PullRequest = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (s) => issueNodeId(s.repo, s.issue)),
    ...issueCommon,
    state: f('PullRequestState!', (s) => pullState(s.issue)),
    merged: f('Boolean!', (s) => s.issue.pull.merged),
    mergedAt: f('DateTime', (s) => (s.issue.pull.mergedAt === null ? null : iso(s.issue.pull.mergedAt))),
    mergedBy: f('Actor', (s) => (s.issue.pull.merged ? { user: true } : null)),
    mergeable: f('MergeableState!', (s) => {
      const state = pullMergeable(s.repo, s.issue);
      return state === null ? 'UNKNOWN' : state ? 'MERGEABLE' : 'CONFLICTING';
    }),
    mergeStateStatus: f('MergeStateStatus!', (s) => {
      const state = pullMergeable(s.repo, s.issue);
      return state === null ? 'UNKNOWN' : state ? 'CLEAN' : 'DIRTY';
    }),
    isDraft: f('Boolean!', (s) => s.issue.pull.draft),
    isCrossRepository: f('Boolean!', () => false),
    maintainerCanModify: f('Boolean!', () => false),
    headRefName: f('String!', (s) => s.issue.pull.head),
    baseRefName: f('String!', (s) => s.issue.pull.base),
    headRefOid: f('GitObjectID!', (s) => pullTips(s.repo, s.issue).head || '0'.repeat(40)),
    baseRefOid: f('GitObjectID!', (s) => pullTips(s.repo, s.issue).base || '0'.repeat(40)),
    headRef: f('Ref', (s) => refSource(s.repo, `refs/heads/${s.issue.pull.head}`)),
    baseRef: f('Ref', (s) => refSource(s.repo, `refs/heads/${s.issue.pull.base}`)),
    headRepository: f('Repository', (s) => s.repo),
    baseRepository: f('Repository', (s) => s.repo),
    headRepositoryOwner: f('RepositoryOwner', () => ({ user: true })),
    mergeCommit: f('Commit', (s) => (s.issue.pull.mergeCommitSha === null ? null : { repo: s.repo, oid: s.issue.pull.mergeCommitSha })),
    reviewDecision: f('PullRequestReviewDecision', () => null),
    additions: f('Int!', (s, a, ctx) => pullFiles(s.repo, s.issue, ctx.B).reduce((sum, file) => sum + file.additions, 0)),
    deletions: f('Int!', (s, a, ctx) => pullFiles(s.repo, s.issue, ctx.B).reduce((sum, file) => sum + file.deletions, 0)),
    changedFiles: f('Int!', (s, a, ctx) => pullFiles(s.repo, s.issue, ctx.B).length),
    files: f('PullRequestChangedFileConnection', (s, args, ctx) => connect(pullFiles(s.repo, s.issue, ctx.B), args), CONNECTION_ARGS),
    commits: f('PullRequestCommitConnection!', (s, args) => connect(pullCommits(s.repo, s.issue).map((oid) => ({ commit: { repo: s.repo, oid } })), args), CONNECTION_ARGS),
  },
};
connectionType('PullRequest');

types.PullRequestChangedFile = {
  kind: 'OBJECT',
  fields: {
    path: f('String!', (file) => file.filename),
    additions: f('Int!'),
    deletions: f('Int!'),
    changeType: f('PatchStatus!', (file) => (file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED')),
  },
};
connectionType('PullRequestChangedFile');
types.PullRequestCommit = { kind: 'OBJECT', fields: { commit: f('Commit!') } };
connectionType('PullRequestCommit');

types.Label = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (s) => `LA_${Buffer.from(`Label:${s.repo.id}:${s.label.id}`).toString('base64url')}`),
    name: f('String!', (s) => s.label.name),
    color: f('String!', (s) => s.label.color),
    description: f('String', (s) => s.label.description),
    isDefault: f('Boolean!', () => false),
  },
};
connectionType('Label');

types.IssueComment = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (s) => commentNodeId(s.repo, s.issue, s.comment)),
    databaseId: f('Int', (s) => s.comment.id),
    body: f('String!', (s) => s.comment.body),
    bodyText: f('String!', (s) => s.comment.body),
    author: f('Actor', () => ({ user: true })),
    authorAssociation: f('CommentAuthorAssociation!', () => 'OWNER'),
    createdAt: f('DateTime!', (s) => iso(s.comment.createdAt)),
    updatedAt: f('DateTime!', (s) => iso(s.comment.updatedAt)),
    url: f('URI!', (s, a, ctx) => `${repoUrl(s.repo, ctx)}/issues/${s.issue.number}#issuecomment-${s.comment.id}`),
    issue: f('Issue!', (s) => ({ repo: s.repo, issue: s.issue })),
    repository: f('Repository!', (s) => s.repo),
    viewerDidAuthor: f('Boolean!', () => true),
    isMinimized: f('Boolean!', () => false),
  },
};
connectionType('IssueComment');

types.Ref = {
  kind: 'OBJECT',
  interfaces: ['Node'],
  fields: {
    id: f('ID!', (s) => `REF_${Buffer.from(`Ref:${s.repo.id}:${s.ref}`).toString('base64url')}`),
    name: f('String!', (s) => (s.ref.startsWith('refs/heads/') ? s.ref.slice(11) : s.ref.startsWith('refs/tags/') ? s.ref.slice(10) : s.ref)),
    prefix: f('String!', (s) => (s.ref.startsWith('refs/heads/') ? 'refs/heads/' : s.ref.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/')),
    target: f('GitObject', (s) => ({ repo: s.repo, oid: s.repo.git.peel(s.oid) || s.oid })),
    repository: f('Repository!', (s) => s.repo),
  },
};
connectionType('Ref');

function commitInfo(s) {
  return s.repo.git.commit(s.oid) || { tree: '', parents: [], author: '', committer: '', message: '' };
}

const commitFields = {
  id: f('ID!', (s) => `C_${Buffer.from(`Commit:${s.repo.id}:${s.oid}`).toString('base64url')}`),
  oid: f('GitObjectID!', (s) => s.oid),
  abbreviatedOid: f('String!', (s) => s.oid.slice(0, 7)),
  message: f('String!', (s) => commitInfo(s).message.replace(/\n$/, '')),
  messageHeadline: f('String!', (s) => commitInfo(s).message.split('\n')[0]),
  messageBody: f('String!', (s) => commitInfo(s).message.split('\n').slice(2).join('\n').replace(/\n$/, '')),
  committedDate: f('DateTime!', (s) => iso(parseIdent(commitInfo(s).committer).ts)),
  authoredDate: f('DateTime!', (s) => iso(parseIdent(commitInfo(s).author).ts)),
  url: f('URI!', (s, a, ctx) => `${repoUrl(s.repo, ctx)}/commit/${s.oid}`),
  commitUrl: f('URI!', (s, a, ctx) => `${repoUrl(s.repo, ctx)}/commit/${s.oid}`),
  repository: f('Repository!', (s) => s.repo),
};
types.GitObject = { kind: 'INTERFACE', fields: { id: commitFields.id, oid: commitFields.oid, abbreviatedOid: commitFields.abbreviatedOid, commitUrl: commitFields.commitUrl, repository: commitFields.repository }, possibleTypes: ['Commit'] };
types.Commit = { kind: 'OBJECT', interfaces: ['Node', 'GitObject'], fields: commitFields };
types.Milestone = { kind: 'OBJECT', fields: { id: f('ID!'), number: f('Int!'), title: f('String!') } };

types.IssueOrPullRequest = { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest'] };
types.SearchResultItem = { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest', 'Repository', 'User'] };
types.SearchResultItemEdge = { kind: 'OBJECT', fields: { node: f('SearchResultItem'), cursor: f('String!') } };
types.SearchResultItemConnection = {
  kind: 'OBJECT',
  fields: {
    edges: f('[SearchResultItemEdge]'),
    nodes: f('[SearchResultItem]'),
    pageInfo: f('PageInfo!'),
    issueCount: f('Int!'),
    repositoryCount: f('Int!'),
    userCount: f('Int!'),
    discussionCount: f('Int!'),
    codeCount: f('Int!'),
    wikiCount: f('Int!'),
  },
};
types.RateLimit = { kind: 'OBJECT', fields: { limit: f('Int!'), cost: f('Int!'), remaining: f('Int!'), used: f('Int!'), nodeCount: f('Int!'), resetAt: f('DateTime!') } };

function search(args) {
  const kind = String(args.type || 'ISSUE').toUpperCase();
  const terms = String(args.query || '').split(/\s+/).filter((term) => term !== '');
  let repoFilter = null;
  let only = null;
  let state = null;
  const words = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.startsWith('repo:')) repoFilter = lower.slice(5);
    else if (lower === 'is:issue' || lower === 'type:issue') only = 'issue';
    else if (lower === 'is:pr' || lower === 'type:pr') only = 'pr';
    else if (lower === 'is:open' || lower === 'state:open') state = 'open';
    else if (lower === 'is:closed' || lower === 'state:closed') state = 'closed';
    else if (!lower.includes(':')) words.push(lower.replace(/^"|"$/g, ''));
  }
  const items = [];
  if (kind === 'REPOSITORY') {
    for (const repo of allRepos()) if (words.every((word) => repo.name.toLowerCase().includes(word) || (repo.description || '').toLowerCase().includes(word))) items.push(repo);
  } else if (kind === 'ISSUE' || kind === 'ISSUE_ADVANCED') {
    for (const repo of allRepos()) {
      if (repoFilter !== null && repoFilter !== `${viewer.lower}/${repo.name.toLowerCase()}`) continue;
      for (const issue of repo.issues.values()) {
        if (only === 'issue' && issue.pull !== null) continue;
        if (only === 'pr' && issue.pull === null) continue;
        if (state !== null && issue.state !== state) continue;
        const hay = `${issue.title}\n${issue.body}`.toLowerCase();
        if (words.every((word) => hay.includes(word))) items.push({ repo, issue });
      }
    }
  }
  const out = connect(items, args);
  out.issueCount = kind === 'REPOSITORY' ? 0 : items.length;
  out.repositoryCount = kind === 'REPOSITORY' ? items.length : 0;
  out.userCount = 0;
  out.discussionCount = 0;
  out.codeCount = 0;
  out.wikiCount = 0;
  return out;
}

types.Query = {
  kind: 'OBJECT',
  fields: {
    viewer: f('User!', () => ({ user: true })),
    repository: f('Repository', (s, args) => findRepo(args.owner, args.name), { owner: 'String!', name: 'String!', followRenames: 'Boolean' }),
    repositoryOwner: f('RepositoryOwner', (s, args) => (String(args.login).toLowerCase() === viewer.lower ? { user: true } : null), { login: 'String!' }),
    user: f('User', (s, args) => (String(args.login).toLowerCase() === viewer.lower ? { user: true } : null), { login: 'String!' }),
    organization: f('Organization', () => null, { login: 'String!' }),
    node: f('Node', (s, args) => nodeSource(nodeById(args.id)), { id: 'ID!' }),
    nodes: f('[Node]!', (s, args) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeSource(nodeById(id))) : []), { ids: '[ID!]!' }),
    search: f('SearchResultItemConnection!', (s, args) => search(args), { ...CONNECTION_ARGS, query: 'String!', type: 'SearchType!' }),
    rateLimit: f('RateLimit', () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, nodeCount: 1, resetAt: iso(Math.floor(Date.UTC(2026, 0, 1) / 1000) + 3600) }), { dryRun: 'Boolean' }),
  },
};

function nodeSource(node) {
  if (node === null) return null;
  switch (node.kind) {
    case 'User':
      return { user: true };
    case 'Repository':
      return node.repo;
    case 'Issue':
    case 'PullRequest':
      return { repo: node.repo, issue: node.issue };
    case 'IssueComment':
      return { repo: node.repo, issue: node.issue, comment: node.comment };
    case 'Label':
      return { repo: node.repo, label: node.label };
    default:
      return null;
  }
}

// The concrete type of a value returned for an interface or union.
function runtimeType(value) {
  if (value.user === true) return 'User';
  if (value.comment !== undefined) return 'IssueComment';
  if (value.issue !== undefined) return value.issue.pull === null ? 'Issue' : 'PullRequest';
  if (value.label !== undefined) return 'Label';
  if (value.ref !== undefined) return 'Ref';
  if (value.oid !== undefined) return 'Commit';
  if (value.git !== undefined) return 'Repository';
  return null;
}

function payload(name, fields) {
  types[name] = { kind: 'OBJECT', fields: { clientMutationId: f('String'), ...fields } };
}

payload('CreateIssuePayload', { issue: f('Issue') });
payload('UpdateIssuePayload', { issue: f('Issue') });
payload('CloseIssuePayload', { issue: f('Issue') });
payload('ReopenIssuePayload', { issue: f('Issue') });
payload('AddCommentPayload', { commentEdge: f('IssueCommentEdge'), subject: f('Node'), timelineEdge: f('IssueCommentEdge') });
payload('CreatePullRequestPayload', { pullRequest: f('PullRequest') });
payload('UpdatePullRequestPayload', { pullRequest: f('PullRequest') });
payload('MergePullRequestPayload', { pullRequest: f('PullRequest'), actor: f('Actor') });
payload('ClosePullRequestPayload', { pullRequest: f('PullRequest') });
payload('ReopenPullRequestPayload', { pullRequest: f('PullRequest') });
payload('CreateRepositoryPayload', { repository: f('Repository') });

function inputOf(args) {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail('Argument "input" is required', 'UNPROCESSABLE');
  return input;
}

types.Mutation = {
  kind: 'OBJECT',
  fields: {
    createIssue: f('CreateIssuePayload', (s, args) => {
      const input = inputOf(args);
      const { repo } = needNode(input.repositoryId, 'Repository');
      const labels = Array.isArray(input.labelIds) ? input.labelIds.map((id) => needNode(id, 'Label').label.name) : undefined;
      const issue = runApi(() => createIssue(repo, { title: input.title, body: input.body, labels }));
      return { clientMutationId: input.clientMutationId || null, issue: { repo, issue } };
    }, { input: 'CreateIssueInput!' }),
    updateIssue: f('UpdateIssuePayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.id, 'Issue');
      const patch = { title: input.title === null ? undefined : input.title, body: input.body === null ? undefined : input.body };
      if (typeof input.state === 'string') patch.state = input.state.toLowerCase();
      runApi(() => updateIssue(repo, issue, patch));
      return { clientMutationId: input.clientMutationId || null, issue: { repo, issue } };
    }, { input: 'UpdateIssueInput!' }),
    closeIssue: f('CloseIssuePayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.issueId, 'Issue');
      const reason = typeof input.stateReason === 'string' ? input.stateReason.toLowerCase() : undefined;
      runApi(() => setIssueState(repo, issue, 'closed', reason));
      return { clientMutationId: input.clientMutationId || null, issue: { repo, issue } };
    }, { input: 'CloseIssueInput!' }),
    reopenIssue: f('ReopenIssuePayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.issueId, 'Issue');
      runApi(() => setIssueState(repo, issue, 'open', 'reopened'));
      return { clientMutationId: input.clientMutationId || null, issue: { repo, issue } };
    }, { input: 'ReopenIssueInput!' }),
    addComment: f('AddCommentPayload', (s, args) => {
      const input = inputOf(args);
      const node = nodeById(input.subjectId);
      if (node === null || node.issue === undefined) throw fail(`Could not resolve to a node with the global id of '${String(input.subjectId)}'`, 'NOT_FOUND');
      const comment = runApi(() => addComment(node.repo, node.issue, input.body));
      const edge = { node: { repo: node.repo, issue: node.issue, comment }, cursor: cursorOf(node.issue.comments.length - 1) };
      return { clientMutationId: input.clientMutationId || null, commentEdge: edge, timelineEdge: edge, subject: { repo: node.repo, issue: node.issue } };
    }, { input: 'AddCommentInput!' }),
    createPullRequest: f('CreatePullRequestPayload', (s, args) => {
      const input = inputOf(args);
      const { repo } = needNode(input.repositoryId, 'Repository');
      const issue = runApi(() => createPull(repo, { title: input.title, body: input.body, head: shortRef(input.headRefName), base: shortRef(input.baseRefName), draft: input.draft === true }));
      return { clientMutationId: input.clientMutationId || null, pullRequest: { repo, issue } };
    }, { input: 'CreatePullRequestInput!' }),
    updatePullRequest: f('UpdatePullRequestPayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.pullRequestId, 'PullRequest');
      const patch = { title: input.title === null ? undefined : input.title, body: input.body === null ? undefined : input.body };
      if (typeof input.state === 'string') patch.state = input.state.toLowerCase();
      if (typeof input.baseRefName === 'string') patch.base = shortRef(input.baseRefName);
      runApi(() => updatePull(repo, issue, patch));
      return { clientMutationId: input.clientMutationId || null, pullRequest: { repo, issue } };
    }, { input: 'UpdatePullRequestInput!' }),
    mergePullRequest: f('MergePullRequestPayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.pullRequestId, 'PullRequest');
      runApi(() => mergePull(repo, issue, {
        merge_method: typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge',
        commit_title: input.commitHeadline,
        commit_message: input.commitBody,
        sha: input.expectedHeadOid,
      }));
      return { clientMutationId: input.clientMutationId || null, pullRequest: { repo, issue }, actor: { user: true } };
    }, { input: 'MergePullRequestInput!' }),
    closePullRequest: f('ClosePullRequestPayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.pullRequestId, 'PullRequest');
      runApi(() => setIssueState(repo, issue, 'closed'));
      return { clientMutationId: input.clientMutationId || null, pullRequest: { repo, issue } };
    }, { input: 'ClosePullRequestInput!' }),
    reopenPullRequest: f('ReopenPullRequestPayload', (s, args) => {
      const input = inputOf(args);
      const { repo, issue } = needNode(input.pullRequestId, 'PullRequest');
      runApi(() => setIssueState(repo, issue, 'open'));
      return { clientMutationId: input.clientMutationId || null, pullRequest: { repo, issue } };
    }, { input: 'ReopenPullRequestInput!' }),
    createRepository: f('CreateRepositoryPayload', (s, args) => {
      const input = inputOf(args);
      const repo = runApi(() => createRepo({ name: input.name, description: input.description, private: String(input.visibility).toUpperCase() === 'PRIVATE' }));
      return { clientMutationId: input.clientMutationId || null, repository: repo };
    }, { input: 'CreateRepositoryInput!' }),
  },
};

for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'HTML', 'GitObjectID', 'GitSSHRemote']) types[name] = { kind: 'SCALAR' };

enumType('SearchType', ['DISCUSSION', 'ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER']);
enumType('IssueState', ['CLOSED', 'OPEN']);
enumType('IssueStateReason', ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE']);
enumType('IssueClosedStateReason', ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE']);
enumType('PullRequestState', ['CLOSED', 'MERGED', 'OPEN']);
enumType('PullRequestUpdateState', ['CLOSED', 'OPEN']);
enumType('MergeableState', ['CONFLICTING', 'MERGEABLE', 'UNKNOWN']);
enumType('MergeStateStatus', ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
enumType('PullRequestMergeMethod', ['MERGE', 'REBASE', 'SQUASH']);
enumType('PullRequestReviewDecision', ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
enumType('PatchStatus', ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED']);
enumType('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE']);
enumType('RepositoryVisibility', ['INTERNAL', 'PRIVATE', 'PUBLIC']);
enumType('RepositoryPrivacy', ['PRIVATE', 'PUBLIC']);
enumType('RepositoryAffiliation', ['COLLABORATOR', 'ORGANIZATION_MEMBER', 'OWNER']);
enumType('RepositoryOrderField', ['CREATED_AT', 'NAME', 'PUSHED_AT', 'STARGAZERS', 'UPDATED_AT']);
enumType('IssueOrderField', ['COMMENTS', 'CREATED_AT', 'UPDATED_AT']);
enumType('LabelOrderField', ['CREATED_AT', 'NAME']);
enumType('OrderDirection', ['ASC', 'DESC']);
enumType('CommentAuthorAssociation', ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'MEMBER', 'NONE', 'OWNER']);
enumType('__TypeKind', ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']);

inputType('IssueOrder', { field: 'IssueOrderField!', direction: 'OrderDirection!' });
inputType('LabelOrder', { field: 'LabelOrderField!', direction: 'OrderDirection!' });
inputType('RepositoryOrder', { field: 'RepositoryOrderField!', direction: 'OrderDirection!' });
inputType('IssueFilters', { states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String', mentioned: 'String', since: 'DateTime' });
inputType('CreateIssueInput', { repositoryId: 'ID!', title: 'String!', body: 'String', assigneeIds: '[ID!]', labelIds: '[ID!]', milestoneId: 'ID', clientMutationId: 'String' });
inputType('UpdateIssueInput', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' });
inputType('CloseIssueInput', { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' });
inputType('ReopenIssueInput', { issueId: 'ID!', clientMutationId: 'String' });
inputType('AddCommentInput', { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' });
inputType('CreatePullRequestInput', { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', headRepositoryId: 'ID', clientMutationId: 'String' });
inputType('UpdatePullRequestInput', { pullRequestId: 'ID!', title: 'String', body: 'String', state: 'PullRequestUpdateState', baseRefName: 'String', clientMutationId: 'String' });
inputType('MergePullRequestInput', { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', authorEmail: 'String', clientMutationId: 'String' });
inputType('ClosePullRequestInput', { pullRequestId: 'ID!', clientMutationId: 'String' });
inputType('ReopenPullRequestInput', { pullRequestId: 'ID!', clientMutationId: 'String' });
inputType('CreateRepositoryInput', { name: 'String!', visibility: 'RepositoryVisibility!', description: 'String', ownerId: 'ID', clientMutationId: 'String' });

// ---- introspection types: sources are { tn } (a named type), { wrap } (a type reference string) ----

function typeRefSource(ref) {
  if (ref.endsWith('!')) return { wrap: 'NON_NULL', of: ref.slice(0, -1) };
  if (ref.startsWith('[')) return { wrap: 'LIST', of: ref.slice(1, -1) };
  return types[ref] === undefined ? { tn: ref, missing: true } : { tn: ref };
}

function fieldSources(typeName) {
  const def = types[typeName];
  return Object.keys(def.fields).map((name) => ({ fieldName: name, def: def.fields[name] }));
}

function argSources(args) {
  if (!args) return [];
  return Object.keys(args).map((name) => ({ argName: name, type: args[name] }));
}

types.__Type = {
  kind: 'OBJECT',
  fields: {
    kind: f('__TypeKind!', (s) => (s.wrap ? s.wrap : s.missing ? 'SCALAR' : types[s.tn].kind)),
    name: f('String', (s) => (s.wrap ? null : s.tn)),
    description: f('String', () => null),
    specifiedByURL: f('String', () => null),
    fields: f('[__Field!]', (s) => {
      if (s.wrap || s.missing) return null;
      const def = types[s.tn];
      return def.kind === 'OBJECT' || def.kind === 'INTERFACE' ? fieldSources(s.tn) : null;
    }, { includeDeprecated: 'Boolean' }),
    interfaces: f('[__Type!]', (s) => {
      if (s.wrap || s.missing) return null;
      const def = types[s.tn];
      return def.kind === 'OBJECT' || def.kind === 'INTERFACE' ? (def.interfaces || []).map((tn) => ({ tn })) : null;
    }),
    possibleTypes: f('[__Type!]', (s) => {
      if (s.wrap || s.missing) return null;
      const def = types[s.tn];
      return def.kind === 'INTERFACE' || def.kind === 'UNION' ? def.possibleTypes.map((tn) => ({ tn })) : null;
    }),
    enumValues: f('[__EnumValue!]', (s) => {
      if (s.wrap || s.missing) return null;
      const def = types[s.tn];
      return def.kind === 'ENUM' ? def.values.map((value) => ({ enumValue: value })) : null;
    }, { includeDeprecated: 'Boolean' }),
    inputFields: f('[__InputValue!]', (s) => {
      if (s.wrap || s.missing) return null;
      const def = types[s.tn];
      return def.kind === 'INPUT_OBJECT' ? argSources(def.inputFields) : null;
    }, { includeDeprecated: 'Boolean' }),
    ofType: f('__Type', (s) => (s.wrap ? typeRefSource(s.of) : null)),
    isOneOf: f('Boolean', () => false),
  },
};
types.__Field = {
  kind: 'OBJECT',
  fields: {
    name: f('String!', (s) => s.fieldName),
    description: f('String', () => null),
    args: f('[__InputValue!]!', (s) => argSources(s.def.args), { includeDeprecated: 'Boolean' }),
    type: f('__Type!', (s) => typeRefSource(s.def.type)),
    isDeprecated: f('Boolean!', () => false),
    deprecationReason: f('String', () => null),
  },
};
types.__InputValue = {
  kind: 'OBJECT',
  fields: {
    name: f('String!', (s) => s.argName),
    description: f('String', () => null),
    type: f('__Type!', (s) => typeRefSource(s.type)),
    defaultValue: f('String', () => null),
    isDeprecated: f('Boolean!', () => false),
    deprecationReason: f('String', () => null),
  },
};
types.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: f('String!', (s) => s.enumValue),
    description: f('String', () => null),
    isDeprecated: f('Boolean!', () => false),
    deprecationReason: f('String', () => null),
  },
};
types.__Directive = {
  kind: 'OBJECT',
  fields: {
    name: f('String!'),
    description: f('String', () => null),
    locations: f('[String!]!', () => ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT']),
    args: f('[__InputValue!]!', () => [{ argName: 'if', type: 'Boolean!' }], { includeDeprecated: 'Boolean' }),
    isRepeatable: f('Boolean!', () => false),
  },
};
types.__Schema = {
  kind: 'OBJECT',
  fields: {
    description: f('String', () => null),
    types: f('[__Type!]!', () => Object.keys(types).map((tn) => ({ tn }))),
    queryType: f('__Type!', () => ({ tn: 'Query' })),
    mutationType: f('__Type', () => ({ tn: 'Mutation' })),
    subscriptionType: f('__Type', () => null),
    directives: f('[__Directive!]!', () => [{ name: 'include' }, { name: 'skip' }]),
  },
};

const META_FIELDS = {
  __schema: f('__Schema!', () => ({})),
  __type: f('__Type', (s, args) => (types[args.name] === undefined ? null : { tn: args.name }), { name: 'String!' }),
};
const TYPENAME_FIELD = f('String!');

function fieldDef(typeName, fieldName) {
  if (fieldName === '__typename') return TYPENAME_FIELD;
  if (typeName === 'Query' && (fieldName === '__schema' || fieldName === '__type')) return META_FIELDS[fieldName];
  const def = types[typeName];
  if (def === undefined || def.fields === undefined) return undefined;
  const found = def.fields[fieldName];
  return Object.prototype.hasOwnProperty.call(def.fields, fieldName) ? found : undefined;
}

// ---------------------------------------------------------------------------------------------
// validation + execution
// ---------------------------------------------------------------------------------------------

function validate(doc, op, text, opLabel) {
  const errors = [];
  const seenFragments = new Set();
  const walk = (typeName, sel, path) => {
    const def = types[typeName];
    for (const item of sel) {
      if (item.k === 'field') {
        const fd = fieldDef(typeName, item.name);
        if (fd === undefined) {
          const onUnion = def !== undefined && def.kind === 'UNION';
          errors.push({
            path: [...path, item.alias],
            extensions: { code: onUnion ? 'selectionMismatch' : 'undefinedField', typeName, fieldName: item.name },
            locations: [locate(text, item.p)],
            message: onUnion ? `Selections can't be made directly on unions (see selections on ${typeName})` : `Field '${item.name}' doesn't exist on type '${typeName}'`,
          });
          continue;
        }
        const inner = namedType(fd.type);
        const innerDef = types[inner];
        const composite = innerDef !== undefined && (innerDef.kind === 'OBJECT' || innerDef.kind === 'INTERFACE' || innerDef.kind === 'UNION');
        if (item.sel !== null) {
          if (!composite) {
            errors.push({
              path: [...path, item.alias],
              extensions: { code: 'selectionMismatch', nodeName: `field '${item.name}'`, typeName: inner },
              locations: [locate(text, item.p)],
              message: `Selections can't be made on scalars (field '${item.name}' returns ${inner} but has selections [${item.sel.map((s) => (s.k === 'field' ? `"${s.name}"` : '...')).join(', ')}])`,
            });
          } else walk(inner, item.sel, [...path, item.alias]);
        } else if (composite) {
          errors.push({
            path: [...path, item.alias],
            extensions: { code: 'selectionMismatch', nodeName: `field '${item.name}'`, typeName: inner },
            locations: [locate(text, item.p)],
            message: `Field must have selections (field '${item.name}' returns ${inner} but has no selections. Did you mean '${item.name} { ... }'?)`,
          });
        }
      } else if (item.k === 'inline') {
        const target = item.on === null ? typeName : item.on;
        if (types[target] === undefined) {
          errors.push({ path: [...path, `... on ${target}`], extensions: { code: 'undefinedType', typeName: target }, locations: [locate(text, item.p)], message: `No such type ${target}, so it can't be a fragment condition` });
          continue;
        }
        walk(target, item.sel, path);
      } else {
        const fragment = doc.fragments.get(item.name);
        if (fragment === undefined) {
          errors.push({ path: [...path, `... ${item.name}`], extensions: { code: 'undefinedFragment', fragmentName: item.name }, locations: [locate(text, item.p)], message: `Fragment ${item.name} was used, but not defined` });
          continue;
        }
        if (seenFragments.has(item.name)) continue;
        seenFragments.add(item.name);
        if (types[fragment.on] === undefined) {
          errors.push({ path: [`fragment ${item.name}`], extensions: { code: 'undefinedType', typeName: fragment.on }, locations: [locate(text, fragment.p)], message: `No such type ${fragment.on}, so it can't be a fragment condition` });
          continue;
        }
        walk(fragment.on, fragment.sel, [`fragment ${item.name}`]);
      }
    }
  };
  walk(op.type === 'mutation' ? 'Mutation' : 'Query', op.sel, [opLabel]);
  return errors;
}

function valueOf(node, vars) {
  switch (node.k) {
    case 'var':
      return vars[node.name];
    case 'lit':
      return node.v;
    case 'list':
      return node.items.map((item) => valueOf(item, vars));
    default: {
      const out = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, vars);
      return out;
    }
  }
}

function directivesAllow(directives, vars) {
  for (const directive of directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const arg = directive.args.find((a) => a.name === 'if');
    const on = arg === undefined ? true : valueOf(arg.value, vars) === true;
    if (directive.name === 'skip' && on) return false;
    if (directive.name === 'include' && !on) return false;
  }
  return true;
}

function typeApplies(condition, concrete) {
  if (condition === null || condition === concrete) return true;
  const def = types[condition];
  return def !== undefined && Array.isArray(def.possibleTypes) && def.possibleTypes.includes(concrete);
}

function execute(doc, op, vars, ctx) {
  const errors = [];

  const collect = (typeName, sel, into) => {
    for (const item of sel) {
      if (item.directives.length > 0 && !directivesAllow(item.directives, vars)) continue;
      if (item.k === 'field') {
        const list = into.get(item.alias);
        if (list === undefined) into.set(item.alias, [item]);
        else list.push(item);
      } else if (item.k === 'inline') {
        if (typeApplies(item.on, typeName)) collect(typeName, item.sel, into);
      } else {
        const fragment = doc.fragments.get(item.name);
        if (fragment !== undefined && typeApplies(fragment.on, typeName)) collect(typeName, fragment.sel, into);
      }
    }
    return into;
  };

  const complete = (type, value, fields, path) => {
    if (value === null || value === undefined) return null;
    let ref = type;
    if (ref.endsWith('!')) ref = ref.slice(0, -1);
    if (ref.startsWith('[')) {
      const inner = ref.slice(1, -1);
      if (!Array.isArray(value)) return null;
      return value.map((item, index) => complete(inner, item, fields, [...path, index]));
    }
    const def = types[ref];
    if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
    let concrete = ref;
    if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
      concrete = runtimeType(value);
      if (concrete === null) return null;
    }
    let sel = fields[0].sel;
    if (fields.length > 1) {
      sel = [];
      for (const field of fields) if (field.sel !== null) for (const item of field.sel) sel.push(item);
    }
    return sel === null ? null : object(concrete, value, sel, path);
  };

  const object = (typeName, source, sel, path) => {
    const out = {};
    for (const [alias, fields] of collect(typeName, sel, new Map())) {
      const field = fields[0];
      if (field.name === '__typename') {
        out[alias] = typeName;
        continue;
      }
      const fd = fieldDef(typeName, field.name);
      if (fd === undefined) continue;
      const here = [...path, alias];
      try {
        let value;
        if (fd.resolve === null) value = source[field.name];
        else {
          const args = {};
          for (const arg of field.args) args[arg.name] = valueOf(arg.value, vars);
          value = fd.resolve(source, args, ctx);
        }
        out[alias] = complete(fd.type, value, fields, here);
      } catch (err) {
        if (err.gqlType === undefined) throw err;
        errors.push({ type: err.gqlType, path: here, locations: [locate(ctx.text, field.p)], message: err.message });
        out[alias] = null;
      }
    }
    return out;
  };

  const data = object(op.type === 'mutation' ? 'Mutation' : 'Query', {}, op.sel, []);
  return errors.length > 0 ? { data, errors } : { data };
}

function coerceVariables(op, given) {
  const vars = {};
  const errors = [];
  for (const def of op.vars) {
    let value = given[def.name];
    if (value === undefined && def.def !== undefined) value = valueOf(def.def, {});
    if ((value === undefined || value === null) && def.type.endsWith('!')) {
      errors.push({
        message: `Variable $${def.name} of type ${def.type} was provided invalid value`,
        extensions: { value: value === undefined ? null : value, problems: [{ path: [], explanation: 'Expected value to not be null' }] },
      });
      continue;
    }
    if (value !== undefined) {
      const base = namedType(def.type);
      if (base === 'Int' && typeof value === 'string' && /^-?\d+$/.test(value)) value = Number(value);
      vars[def.name] = value;
    }
  }
  return { vars, errors };
}

const documentCache = new Map();

function runOne(request, B) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  const text = request.query;
  if (typeof text !== 'string' || text.trim() === '') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  let doc = documentCache.get(text);
  if (doc === undefined) {
    try {
      doc = parseDocument(text);
    } catch (err) {
      if (err instanceof GqlSyntaxError) {
        return { errors: [{ message: `Parse error: ${err.message}`, locations: [locate(text, err.pos)], extensions: { code: 'parseError' } }] };
      }
      throw err;
    }
    if (documentCache.size > 500) documentCache.clear();
    documentCache.set(text, doc);
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'No query string was present' }] };
  let op;
  const wanted = typeof request.operationName === 'string' && request.operationName !== '' ? request.operationName : null;
  if (wanted !== null) {
    op = doc.operations.find((candidate) => candidate.name === wanted);
    if (op === undefined) return { errors: [{ message: `No operation named "${wanted}"` }] };
  } else if (doc.operations.length === 1) op = doc.operations[0];
  else return { errors: [{ message: 'An operation name is required' }] };
  if (op.type === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };
  const label = `${op.type}${op.name === null ? '' : ` ${op.name}`}`;
  const invalid = validate(doc, op, text, label);
  if (invalid.length > 0) return { errors: invalid };
  const given = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables) ? request.variables : {};
  const coerced = coerceVariables(op, given);
  if (coerced.errors.length > 0) return { errors: coerced.errors };
  return execute(doc, op, coerced.vars, { B, text });
}

// Serves POST /api/graphql: one operation object, or an array of them answered in order.
export function graphqlHttp(body, B) {
  let request;
  try {
    request = body === null || body.length === 0 ? undefined : JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, json: { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' } };
  }
  if (Array.isArray(request)) return { status: 200, json: request.map((item) => runOne(item, B)) };
  return { status: 200, json: runOne(request, B) };
}

// Runs one operation for an in-process caller (the MCP tools).
export function graphqlRun(query, variables, B) {
  return runOne({ query, variables }, B);
}
