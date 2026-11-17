// The forge's state and domain logic: repositories, labels, issues, comments, pull requests and the
// git-backed contents/merge operations, plus the JSON views the REST API serves. REST, GraphQL and
// MCP all go through the functions here, so the three surfaces always agree.

import { GitRepo, T_BLOB, T_COMMIT, T_TREE, parseIdent, parseTag, typeName } from './git.mjs';

export class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const TRIAL_NOW = Date.parse(process.env.MAKEFUN_TRIAL_NOW || '');
let clock = Math.floor((Number.isFinite(TRIAL_NOW) ? TRIAL_NOW : Date.UTC(2026, 0, 1)) / 1000);

function tick() {
  clock += 1;
  return clock;
}

export function iso(sec) {
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`;
}

export const viewer = {
  login: process.env.FORGE_LOGIN || 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
viewer.lower = viewer.login.toLowerCase();

const repos = new Map(); // lower-case name -> repo
const reposById = new Map();
let nextRepoId = 5001;
let nextIssueId = 20001;
let nextCommentId = 30001;
let nextLabelId = 40001;
let nextPullId = 50001;

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function userNodeId() {
  return `U_${b64(`User:${viewer.id}`)}`;
}

// ---------------------------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------------------------

export function findRepo(owner, name) {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner.toLowerCase() !== viewer.lower) return null;
  return repos.get(name.toLowerCase()) || null;
}

export function needRepo(owner, name) {
  const repo = findRepo(owner, name);
  if (repo === null) throw new ApiError(404, 'Not Found');
  return repo;
}

export function allRepos() {
  return [...repos.values()];
}

export function needIssue(repo, number, wantPull) {
  const n = Number(number);
  const issue = Number.isInteger(n) ? repo.issues.get(n) : undefined;
  if (issue === undefined) throw new ApiError(404, 'Not Found');
  if (wantPull === true && issue.pull === null) throw new ApiError(404, 'Not Found');
  return issue;
}

// Resolves a GraphQL global id back to the object it names.
export function nodeById(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('_');
  if (at < 0) return null;
  let text;
  try {
    text = Buffer.from(id.slice(at + 1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === 'User') return Number(parts[1]) === viewer.id ? { kind: 'User' } : null;
  const repo = reposById.get(Number(parts[1]));
  if (repo === undefined) return null;
  if (kind === 'Repository') return { kind, repo };
  const issue = repo.issues.get(Number(parts[2]));
  if (kind === 'Issue' || kind === 'PullRequest') {
    if (issue === undefined) return null;
    return { kind: issue.pull === null ? 'Issue' : 'PullRequest', repo, issue };
  }
  if (kind === 'IssueComment') {
    if (issue === undefined) return null;
    const comment = issue.comments.find((c) => c.id === Number(parts[3]));
    return comment === undefined ? null : { kind, repo, issue, comment };
  }
  if (kind === 'Label') {
    for (const label of repo.labels.values()) if (label.id === Number(parts[2])) return { kind, repo, label };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function ident(author, ts) {
  const name = author && typeof author.name === 'string' && author.name !== '' ? author.name : viewer.name;
  const email = author && typeof author.email === 'string' && author.email !== '' ? author.email : viewer.email;
  return `${name.replace(/[<>\n]/g, '')} <${email.replace(/[<>\n]/g, '')}> ${ts} +0000`;
}

export function createRepo(input) {
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'missing_field', field: 'name' }]);
  }
  if (!NAME_RE.test(name) || name === '.' || name === '..') {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
  }
  const key = name.toLowerCase();
  if (repos.has(key)) {
    throw new ApiError(422, 'Repository creation failed.', [
      { resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' },
    ]);
  }
  const now = tick();
  const id = nextRepoId++;
  const repo = {
    id,
    nodeId: `R_${b64(`Repository:${id}`)}`,
    name,
    description: typeof input.description === 'string' ? input.description : null,
    private: input.private === true || input.visibility === 'private',
    homepage: typeof input.homepage === 'string' ? input.homepage : null,
    defaultBranch: 'main',
    hasIssues: input.has_issues !== false,
    createdAt: now,
    updatedAt: now,
    pushedAt: now,
    git: new GitRepo('main'),
    labels: new Map(),
    issues: new Map(),
    nextNumber: 1,
    openIssues: 0,
  };
  repos.set(key, repo);
  reposById.set(id, repo);
  if (input.auto_init === true || input.autoInit === true) {
    const text = `# ${name}\n${repo.description ? `\n${repo.description}\n` : ''}`;
    const blob = repo.git.put(T_BLOB, Buffer.from(text, 'utf8'));
    const tree = repo.git.editTree(null, ['README.md'], 0, blob);
    const who = ident(null, now);
    const commit = repo.git.writeCommit({ tree, parents: [], message: 'Initial commit', author: who, committer: who });
    repo.git.setRef('refs/heads/main', commit);
  }
  return repo;
}

export function updateRepo(repo, input) {
  if (typeof input.name === 'string' && input.name !== repo.name) {
    if (!NAME_RE.test(input.name)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
    const key = input.name.toLowerCase();
    if (repos.has(key) && repos.get(key) !== repo) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
    }
    repos.delete(repo.name.toLowerCase());
    repo.name = input.name;
    repos.set(key, repo);
  }
  if (typeof input.description === 'string' || input.description === null) repo.description = input.description;
  if (typeof input.homepage === 'string' || input.homepage === null) repo.homepage = input.homepage;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (input.visibility === 'private') repo.private = true;
  if (input.visibility === 'public') repo.private = false;
  if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
  if (typeof input.default_branch === 'string' && input.default_branch !== repo.defaultBranch) {
    if (repo.git.branch(input.default_branch) === undefined) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
    }
    setDefaultBranch(repo, input.default_branch);
  }
  repo.updatedAt = tick();
  return repo;
}

function setDefaultBranch(repo, branch) {
  repo.defaultBranch = branch;
  repo.git.head = `refs/heads/${branch}`;
}

export function deleteRepo(repo) {
  repos.delete(repo.name.toLowerCase());
  reposById.delete(repo.id);
}

// Called after a git push moved refs: keeps the repository's default branch and push time in step.
export function afterPush(repo, changed) {
  if (changed.length === 0) return;
  repo.pushedAt = tick();
  repo.updatedAt = repo.pushedAt;
  if (repo.git.headOid() === undefined) {
    const heads = repo.git.branches();
    if (heads.length > 0 && repo.git.branch('main') === undefined) setDefaultBranch(repo, heads[0][0]);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------------------------

export function userJson(B) {
  const api = `${B}/api/v3/users/${viewer.login}`;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: userNodeId(),
    avatar_url: `${B}/avatars/u/${viewer.id}`,
    gravatar_id: '',
    url: api,
    html_url: `${B}/${viewer.login}`,
    followers_url: `${api}/followers`,
    repos_url: `${api}/repos`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

export function fullUserJson(B) {
  const user = userJson(B);
  user.name = viewer.name;
  user.company = null;
  user.blog = '';
  user.location = null;
  user.email = viewer.email;
  user.hireable = null;
  user.bio = null;
  user.public_repos = 0;
  user.public_gists = 0;
  user.followers = 0;
  user.following = 0;
  user.created_at = iso(clock0);
  user.updated_at = iso(clock0);
  for (const repo of repos.values()) if (!repo.private) user.public_repos += 1;
  return user;
}
const clock0 = clock;

export function repoJson(repo, B) {
  const full = `${viewer.login}/${repo.name}`;
  const api = `${B}/api/v3/repos/${full}`;
  const html = `${B}/${full}`;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(B),
    html_url: html,
    description: repo.description,
    fork: false,
    url: api,
    branches_url: `${api}/branches{/branch}`,
    commits_url: `${api}/commits{/sha}`,
    contents_url: `${api}/contents/{+path}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    issues_url: `${api}/issues{/number}`,
    labels_url: `${api}/labels{/name}`,
    pulls_url: `${api}/pulls{/number}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.pushedAt),
    git_url: `${html}.git`,
    ssh_url: `${html}.git`,
    clone_url: `${html}.git`,
    homepage: repo.homepage,
    size: repo.git.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    network_count: 0,
    subscribers_count: 0,
  };
}

function labelJson(repo, label, B) {
  return {
    id: label.id,
    node_id: `LA_${b64(`Label:${repo.id}:${label.id}`)}`,
    url: `${B}/api/v3/repos/${viewer.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueNodeId(repo, issue) {
  return issue.pull === null ? `I_${b64(`Issue:${repo.id}:${issue.number}`)}` : `PR_${b64(`PullRequest:${repo.id}:${issue.number}`)}`;
}

export function commentNodeId(repo, issue, comment) {
  return `IC_${b64(`IssueComment:${repo.id}:${issue.number}:${comment.id}`)}`;
}

export function issueJson(repo, issue, B) {
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const user = userJson(B);
  const out = {
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${B}/${viewer.login}/${repo.name}/${issue.pull === null ? 'issues' : 'pull'}/${issue.number}`,
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    user,
    labels: issue.labels.map((label) => labelJson(repo, label, B)),
    state: issue.state,
    locked: false,
    assignee: issue.assignees.length > 0 ? user : null,
    assignees: issue.assignees.length > 0 ? [user] : [],
    milestone: null,
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    author_association: 'OWNER',
    active_lock_reason: null,
    body: issue.body,
    closed_by: issue.closedAt === null ? null : user,
    reactions: { url: `${api}/issues/${issue.number}/reactions`, total_count: 0 },
    timeline_url: `${api}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.stateReason,
  };
  if (issue.pull !== null) {
    out.pull_request = {
      url: `${api}/pulls/${issue.number}`,
      html_url: out.html_url,
      diff_url: `${out.html_url}.diff`,
      patch_url: `${out.html_url}.patch`,
      merged_at: issue.pull.mergedAt === null ? null : iso(issue.pull.mergedAt),
    };
  }
  return out;
}

export function commentJson(repo, issue, comment, B) {
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  return {
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${B}/${viewer.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${issue.number}`,
    id: comment.id,
    node_id: commentNodeId(repo, issue, comment),
    user: userJson(B),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    author_association: 'OWNER',
    body: comment.body,
    reactions: { url: `${api}/issues/comments/${comment.id}/reactions`, total_count: 0 },
    performed_via_github_app: null,
  };
}

function personOf(identText) {
  const who = parseIdent(identText);
  return { name: who.name, email: who.email, date: iso(who.ts) };
}

function apiMessage(message) {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

export function commitJson(repo, oid, B) {
  const info = repo.git.commit(oid);
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const author = personOf(info.author);
  const committer = personOf(info.committer);
  return {
    sha: oid,
    node_id: `C_${b64(`Commit:${repo.id}:${oid}`)}`,
    commit: {
      author,
      committer,
      message: apiMessage(info.message),
      tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
      url: `${api}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${api}/commits/${oid}`,
    html_url: `${B}/${viewer.login}/${repo.name}/commit/${oid}`,
    comments_url: `${api}/commits/${oid}/comments`,
    author: author.email === viewer.email ? userJson(B) : null,
    committer: committer.email === viewer.email ? userJson(B) : null,
    parents: info.parents.map((sha) => ({ sha, url: `${api}/commits/${sha}`, html_url: `${B}/${viewer.login}/${repo.name}/commit/${sha}` })),
  };
}

function gitCommitJson(repo, oid, B) {
  const info = repo.git.commit(oid);
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  return {
    sha: oid,
    node_id: `C_${b64(`Commit:${repo.id}:${oid}`)}`,
    url: `${api}/git/commits/${oid}`,
    html_url: `${B}/${viewer.login}/${repo.name}/commit/${oid}`,
    author: personOf(info.author),
    committer: personOf(info.committer),
    tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
    message: apiMessage(info.message),
    parents: info.parents.map((sha) => ({ sha, url: `${api}/git/commits/${sha}`, html_url: `${B}/${viewer.login}/${repo.name}/commit/${sha}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
  };
}

function branchJson(repo, name, oid, B, full) {
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  if (!full) return { name, commit: { sha: oid, url: `${api}/commits/${oid}` }, protected: false };
  return {
    name,
    commit: commitJson(repo, oid, B),
    _links: { self: `${api}/branches/${name}`, html: `${B}/${viewer.login}/${repo.name}/tree/${name}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${api}/branches/${name}/protection`,
  };
}

function refJson(repo, ref, oid, B) {
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const obj = repo.git.get(oid);
  const type = obj === undefined ? 'commit' : typeName(obj.t);
  return {
    ref,
    node_id: `REF_${b64(`Ref:${repo.id}:${ref}`)}`,
    url: `${api}/git/${ref}`,
    object: { sha: oid, type, url: `${api}/git/${type}s/${oid}` },
  };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function pathSegments(path) {
  const segments = path.split('/').filter((part) => part !== '');
  for (const part of segments) {
    if (part === '.' || part === '..' || part.includes('\0')) throw new ApiError(422, 'path contains a malformed path component');
  }
  return segments;
}

function wrapBase64(data) {
  const text = data.toString('base64');
  let out = '';
  for (let i = 0; i < text.length; i += 60) out += `${text.slice(i, i + 60)}\n`;
  return out;
}

function contentEntry(repo, path, entry, ref, B) {
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const isDir = entry.mode === '40000';
  const obj = repo.git.get(entry.oid);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const self = `${api}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  const git = `${api}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`;
  const html = `${B}/${viewer.login}/${repo.name}/${isDir ? 'tree' : 'blob'}/${ref}/${encoded}`;
  return {
    name,
    path,
    sha: entry.oid,
    size: isDir || obj === undefined ? 0 : obj.d.length,
    url: self,
    html_url: html,
    git_url: git,
    download_url: isDir ? null : `${B}/${viewer.login}/${repo.name}/raw/${ref}/${encoded}`,
    type: isDir ? 'dir' : entry.mode === '120000' ? 'symlink' : entry.mode === '160000' ? 'submodule' : 'file',
    _links: { self, git, html },
  };
}

export function getContents(repo, path, ref, B) {
  const git = repo.git;
  const tip = git.resolve(ref);
  if (tip === null) {
    if (ref) throw new ApiError(404, `No commit found for the ref ${ref}`);
    throw new ApiError(404, 'This repository is empty.');
  }
  const refName = ref || repo.defaultBranch;
  const segments = pathSegments(path);
  const found = git.lookupPath(git.commit(tip).tree, segments);
  if (found === null) throw new ApiError(404, 'Not Found');
  const clean = segments.join('/');
  if (found.mode === '40000') {
    const entries = git.tree(found.oid) || [];
    return entries
      .map((entry) => contentEntry(repo, clean === '' ? entry.name : `${clean}/${entry.name}`, entry, refName, B))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const out = contentEntry(repo, clean, found, refName, B);
  const obj = git.get(found.oid);
  out.content = obj === undefined ? '' : wrapBase64(obj.d);
  out.encoding = 'base64';
  return out;
}

function commitSummary(repo, oid, B) {
  return gitCommitJson(repo, oid, B);
}

function branchTipForWrite(repo, branchInput) {
  const git = repo.git;
  const branch = typeof branchInput === 'string' && branchInput !== '' ? branchInput : repo.defaultBranch;
  const tip = git.branch(branch);
  if (tip === undefined && git.refs.size > 0) throw new ApiError(404, `Branch ${branch} not found`);
  return { branch, tip: tip === undefined ? null : tip };
}

// Creates or updates one file with a commit. Returns { created, json }.
export function putContents(repo, path, input, B) {
  const git = repo.git;
  const segments = pathSegments(path);
  if (segments.length === 0) throw new ApiError(422, 'path cannot be empty');
  if (typeof input.message !== 'string' || input.message === '') {
    throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  }
  if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  const { branch, tip } = branchTipForWrite(repo, input.branch);
  const rootTree = tip === null ? null : git.commit(tip).tree;
  const existing = rootTree === null ? null : git.lookupPath(rootTree, segments);
  if (existing !== null && existing.mode === '40000') throw new ApiError(422, 'path is a directory');
  if (existing !== null) {
    if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (input.sha.toLowerCase() !== existing.oid) throw new ApiError(409, `${segments.join('/')} does not match ${input.sha}`);
  } else if (typeof input.sha === 'string' && input.sha !== '' && rootTree !== null) {
    // a sha for a file that is not there: the caller's view of the branch is stale
    throw new ApiError(409, `${segments.join('/')} does not match ${input.sha}`);
  }
  const data = Buffer.from(input.content.replace(/\s+/g, ''), 'base64');
  const blob = git.put(T_BLOB, data);
  const tree = git.editTree(rootTree, segments, 0, blob);
  const now = tick();
  const author = ident(input.author || input.committer, now);
  const committer = ident(input.committer || input.author, now);
  const commit = git.writeCommit({ tree, parents: tip === null ? [] : [tip], message: input.message, author, committer });
  git.setRef(`refs/heads/${branch}`, commit);
  if (tip === null && git.headOid() === undefined) setDefaultBranch(repo, branch);
  repo.pushedAt = now;
  repo.updatedAt = now;
  const content = contentEntry(repo, segments.join('/'), { mode: existing === null ? '100644' : existing.mode, oid: blob }, branch, B);
  content.content = wrapBase64(data);
  content.encoding = 'base64';
  return { created: existing === null, json: { content, commit: commitSummary(repo, commit, B) } };
}

export function deleteContents(repo, path, input, B) {
  const git = repo.git;
  const segments = pathSegments(path);
  if (typeof input.message !== 'string' || input.message === '') {
    throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  }
  if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  const { branch, tip } = branchTipForWrite(repo, input.branch);
  if (tip === null) throw new ApiError(404, 'Not Found');
  const rootTree = git.commit(tip).tree;
  const existing = git.lookupPath(rootTree, segments);
  if (existing === null || existing.mode === '40000' || segments.length === 0) throw new ApiError(404, 'Not Found');
  if (input.sha.toLowerCase() !== existing.oid) throw new ApiError(409, `${segments.join('/')} does not match ${input.sha}`);
  let tree = git.editTree(rootTree, segments, 0, null);
  if (tree === null || tree === undefined) tree = git.emptyTree();
  const now = tick();
  const author = ident(input.author || input.committer, now);
  const committer = ident(input.committer || input.author, now);
  const commit = git.writeCommit({ tree, parents: [tip], message: input.message, author, committer });
  git.setRef(`refs/heads/${branch}`, commit);
  repo.pushedAt = now;
  repo.updatedAt = now;
  return { content: null, commit: commitSummary(repo, commit, B) };
}

// ---------------------------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------------------------

export function createLabel(repo, input) {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  }
  const key = input.name.toLowerCase();
  if (repo.labels.has(key)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const label = {
    id: nextLabelId++,
    name: input.name,
    color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
    description: typeof input.description === 'string' ? input.description : null,
  };
  repo.labels.set(key, label);
  return label;
}

function resolveLabels(repo, input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const out = [];
  for (const item of input) {
    const name = typeof item === 'string' ? item : item && typeof item.name === 'string' ? item.name : null;
    if (name === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name' }]);
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) {
      throw new ApiError(422, 'Validation Failed', [{ value: name, resource: 'Label', field: 'name', code: 'invalid' }]);
    }
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function newIssueRecord(repo, title, body, labels) {
  const now = tick();
  const issue = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title,
    body: typeof body === 'string' ? body : '',
    state: 'open',
    stateReason: null,
    labels,
    assignees: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    pull: null,
  };
  repo.issues.set(issue.number, issue);
  repo.openIssues += 1;
  repo.updatedAt = now;
  return issue;
}

export function createIssue(repo, input) {
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  }
  if (input.body !== undefined && input.body !== null && typeof input.body !== 'string') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'body' }]);
  }
  const labels = resolveLabels(repo, input.labels);
  const issue = newIssueRecord(repo, input.title, input.body, labels);
  if (Array.isArray(input.assignees)) issue.assignees = input.assignees.filter((login) => typeof login === 'string' && login.toLowerCase() === viewer.lower);
  return issue;
}

export function setIssueState(repo, issue, state, reason) {
  if (state !== 'open' && state !== 'closed') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
  if (issue.pull !== null && issue.pull.merged && state === 'open') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'Cannot reopen a merged pull request' }]);
  }
  const now = tick();
  if (issue.state !== state) {
    if (state === 'closed') {
      if (issue.pull !== null) freezePull(repo, issue);
      issue.state = 'closed';
      issue.closedAt = now;
      repo.openIssues -= 1;
    } else {
      issue.state = 'open';
      issue.closedAt = null;
      repo.openIssues += 1;
      if (issue.pull !== null) {
        issue.pull.headSha = null;
        issue.pull.baseSha = null;
        issue.pull.diffBase = undefined;
      }
    }
  }
  issue.stateReason = state === 'closed' ? (typeof reason === 'string' ? reason : 'completed') : issue.pull === null && reason === 'reopened' ? 'reopened' : null;
  if (issue.pull !== null) issue.stateReason = null;
  issue.updatedAt = now;
}

export function updateIssue(repo, issue, input) {
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'title' }]);
    }
  }
  const labels = input.labels !== undefined ? resolveLabels(repo, input.labels) : null;
  if (input.state !== undefined) setIssueState(repo, issue, input.state, input.state_reason);
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  else if (input.body === null) issue.body = '';
  if (labels !== null) issue.labels = labels;
  if (Array.isArray(input.assignees)) issue.assignees = input.assignees.filter((login) => typeof login === 'string' && login.toLowerCase() === viewer.lower);
  issue.updatedAt = tick();
  return issue;
}

export function addComment(repo, issue, body) {
  if (typeof body !== 'string' || body === '') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  }
  const now = tick();
  const comment = { id: nextCommentId++, body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  return comment;
}

// Issues (or pull requests) of a repository, filtered and ordered the way the list endpoints ask.
export function listIssues(repo, options) {
  const wantPulls = options.pulls === true;
  const state = options.state || 'open';
  const out = [];
  for (const issue of repo.issues.values()) {
    if ((issue.pull !== null) !== wantPulls) continue;
    if (state !== 'all' && issue.state !== state) continue;
    if (options.labels) {
      let all = true;
      for (const name of options.labels) {
        if (!issue.labels.some((label) => label.name.toLowerCase() === name)) {
          all = false;
          break;
        }
      }
      if (!all) continue;
    }
    if (options.head && issue.pull.head !== options.head) continue;
    if (options.base && issue.pull.base !== options.base) continue;
    if (options.since && issue.updatedAt < options.since) continue;
    out.push(issue);
  }
  const sort = options.sort || 'created';
  const desc = options.direction !== 'asc';
  out.sort((a, b) => {
    let diff = 0;
    if (sort === 'updated') diff = a.updatedAt - b.updatedAt;
    else if (sort === 'comments') diff = a.comments.length - b.comments.length;
    if (diff === 0) diff = a.number - b.number;
    return desc ? -diff : diff;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function branchOfHead(head) {
  if (typeof head !== 'string') return '';
  const colon = head.indexOf(':');
  return colon >= 0 ? head.slice(colon + 1) : head;
}

export function createPull(repo, input) {
  const git = repo.git;
  let title = input.title;
  let body = input.body;
  if (input.issue !== undefined && title === undefined) {
    const source = repo.issues.get(Number(input.issue));
    if (source === undefined) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'issue' }]);
    title = source.title;
    body = source.body;
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }]);
  }
  const head = branchOfHead(input.head);
  const base = typeof input.base === 'string' && input.base !== '' ? input.base : '';
  if (head === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }]);
  if (base === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'base' }]);
  if (git.branch(base) === undefined) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
  if (git.branch(head) === undefined) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
  if (head === base) {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }]);
  }
  for (const other of repo.issues.values()) {
    if (other.pull !== null && other.state === 'open' && other.pull.head === head && other.pull.base === base) {
      throw new ApiError(422, 'Validation Failed', [
        { resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${viewer.login}:${head}.` },
      ]);
    }
  }
  const issue = newIssueRecord(repo, title, body, []);
  issue.pull = {
    id: nextPullId++,
    head,
    base,
    draft: input.draft === true,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha: null,
    baseSha: null,
    diffBase: undefined,
  };
  return issue;
}

function freezePull(repo, issue) {
  const pull = issue.pull;
  if (pull.headSha !== null) return;
  const git = repo.git;
  const headTip = git.branch(pull.head);
  const baseTip = git.branch(pull.base);
  pull.headSha = headTip === undefined ? null : headTip;
  pull.baseSha = baseTip === undefined ? null : baseTip;
  pull.diffBase = headTip !== undefined && baseTip !== undefined ? git.mergeBase(baseTip, headTip) : null;
}

export function pullTips(repo, issue) {
  const pull = issue.pull;
  if (pull.headSha !== null || issue.state === 'closed') {
    return { head: pull.headSha, base: pull.baseSha, diffBase: pull.diffBase === undefined ? null : pull.diffBase };
  }
  const git = repo.git;
  const headTip = git.branch(pull.head);
  const baseTip = git.branch(pull.base);
  const head = headTip === undefined ? null : headTip;
  const base = baseTip === undefined ? null : baseTip;
  return { head, base, diffBase: head !== null && base !== null ? git.mergeBase(base, head) : null };
}

function flatTreeOf(git, commitOid) {
  if (commitOid === null) return new Map();
  const info = git.commit(commitOid);
  return info === null ? new Map() : git.flatten(info.tree);
}

// Three-way merge at file granularity. Returns the merged flat tree, or null on a conflict.
function mergeTrees(git, baseTip, headTip, mergeBase) {
  const ours = flatTreeOf(git, baseTip);
  if (mergeBase === baseTip) return flatTreeOf(git, headTip);
  const theirs = flatTreeOf(git, headTip);
  if (mergeBase === headTip) return ours;
  const origin = flatTreeOf(git, mergeBase);
  const merged = new Map(ours);
  const paths = new Set([...theirs.keys(), ...origin.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const a = ours.get(path);
    const b = theirs.get(path);
    const ao = a === undefined ? '' : a.oid + a.mode;
    const bo = b === undefined ? '' : b.oid + b.mode;
    const oo = o === undefined ? '' : o.oid + o.mode;
    if (ao === bo || bo === oo) continue;
    if (ao === oo) {
      if (b === undefined) merged.delete(path);
      else merged.set(path, b);
      continue;
    }
    return null;
  }
  return merged;
}

export function pullMergeable(repo, issue) {
  if (issue.state !== 'open') return null;
  const tips = pullTips(repo, issue);
  if (tips.head === null || tips.base === null) return false;
  return mergeTrees(repo.git, tips.base, tips.head, tips.diffBase) !== null;
}

export function mergePull(repo, issue, input) {
  const pull = issue.pull;
  if (pull.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  if (issue.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const git = repo.git;
  const tips = pullTips(repo, issue);
  if (tips.head === null || tips.base === null) throw new ApiError(405, 'Pull Request is not mergeable');
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== tips.head) {
    throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const method = typeof input.merge_method === 'string' ? input.merge_method.toLowerCase() : 'merge';
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
    throw new ApiError(422, 'Invalid request.\n\nmerge_method must be one of merge, squash, rebase.');
  }
  const merged = mergeTrees(git, tips.base, tips.head, tips.diffBase);
  if (merged === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const tree = merged.size === 0 ? git.emptyTree() : git.treeFromFlat(merged);
  const now = tick();
  const who = ident(null, now);
  let message;
  if (typeof input.commit_title === 'string' && input.commit_title !== '') message = input.commit_title;
  else if (method === 'merge') message = `Merge pull request #${issue.number} from ${viewer.login}/${pull.head}`;
  else message = `${issue.title} (#${issue.number})`;
  if (typeof input.commit_message === 'string' && input.commit_message !== '') message += `\n\n${input.commit_message}`;
  else if (method === 'merge') message += `\n\n${issue.title}`;
  const parents = method === 'merge' ? [tips.base, tips.head] : [tips.base];
  const commit = git.writeCommit({ tree, parents, message, author: who, committer: who });
  pull.headSha = tips.head;
  pull.baseSha = tips.base;
  pull.diffBase = tips.diffBase;
  git.setRef(`refs/heads/${pull.base}`, commit);
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = commit;
  issue.state = 'closed';
  issue.closedAt = now;
  issue.updatedAt = now;
  repo.openIssues -= 1;
  repo.pushedAt = now;
  repo.updatedAt = now;
  return { sha: commit, merged: true, message: 'Pull Request successfully merged' };
}

function countLines(buffer) {
  if (buffer.length === 0) return [];
  const lines = buffer.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineStats(before, after) {
  const counts = new Map();
  for (const line of before) counts.set(line, (counts.get(line) || 0) + 1);
  let additions = 0;
  let kept = 0;
  for (const line of after) {
    const left = counts.get(line) || 0;
    if (left > 0) {
      counts.set(line, left - 1);
      kept += 1;
    } else additions += 1;
  }
  return { additions, deletions: before.length - kept };
}

// The files a pull request changes: its head against the merge base with its base branch.
export function pullFiles(repo, issue, B) {
  const git = repo.git;
  const tips = pullTips(repo, issue);
  if (tips.head === null) return [];
  const before = flatTreeOf(git, tips.diffBase);
  const after = flatTreeOf(git, tips.head);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const out = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
    const oldObj = a === undefined ? undefined : git.get(a.oid);
    const newObj = b === undefined ? undefined : git.get(b.oid);
    const stats = lineStats(oldObj === undefined ? [] : countLines(oldObj.d), newObj === undefined ? [] : countLines(newObj.d));
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    out.push({
      sha: b === undefined ? a.oid : b.oid,
      filename: path,
      status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.additions + stats.deletions,
      blob_url: `${B}/${viewer.login}/${repo.name}/blob/${tips.head}/${encoded}`,
      raw_url: `${B}/${viewer.login}/${repo.name}/raw/${tips.head}/${encoded}`,
      contents_url: `${api}/contents/${encoded}?ref=${tips.head}`,
    });
  }
  return out;
}

export function pullCommits(repo, issue) {
  const git = repo.git;
  const tips = pullTips(repo, issue);
  if (tips.head === null) return [];
  const skip = tips.diffBase === null ? new Set() : git.ancestors(tips.diffBase);
  return git.log(tips.head).filter((oid) => !skip.has(oid)).reverse();
}

export function pullJson(repo, issue, B, detailed) {
  const pull = issue.pull;
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  const html = `${B}/${viewer.login}/${repo.name}/pull/${issue.number}`;
  const user = userJson(B);
  const tips = pullTips(repo, issue);
  const repoView = repoJson(repo, B);
  const zero = '0000000000000000000000000000000000000000';
  const out = {
    url: `${api}/pulls/${issue.number}`,
    id: pull.id,
    node_id: issueNodeId(repo, issue),
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${api}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user,
    body: issue.body,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: issue.labels.map((label) => labelJson(repo, label, B)),
    milestone: null,
    draft: pull.draft,
    commits_url: `${api}/pulls/${issue.number}/commits`,
    review_comments_url: `${api}/pulls/${issue.number}/comments`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    statuses_url: `${api}/statuses/${tips.head || zero}`,
    head: { label: `${viewer.login}:${pull.head}`, ref: pull.head, sha: tips.head || zero, user, repo: repoView },
    base: { label: `${viewer.login}:${pull.base}`, ref: pull.base, sha: tips.base || zero, user, repo: repoView },
    _links: { self: { href: `${api}/pulls/${issue.number}` }, html: { href: html }, issue: { href: `${api}/issues/${issue.number}` } },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
  };
  if (detailed) {
    const mergeable = pullMergeable(repo, issue);
    const files = pullFiles(repo, issue, B);
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    out.merged = pull.merged;
    out.mergeable = mergeable;
    out.rebaseable = mergeable;
    out.mergeable_state = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
    out.merged_by = pull.merged ? user : null;
    out.comments = issue.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
    out.commits = pullCommits(repo, issue).length;
    out.additions = additions;
    out.deletions = deletions;
    out.changed_files = files.length;
  }
  return out;
}

export function updatePull(repo, issue, input) {
  if (typeof input.base === 'string' && input.base !== issue.pull.base) {
    if (repo.git.branch(input.base) === undefined) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
    }
    issue.pull.base = input.base;
  }
  if (typeof input.draft === 'boolean') issue.pull.draft = input.draft;
  return updateIssue(repo, issue, { title: input.title, body: input.body, state: input.state });
}

// ---------------------------------------------------------------------------------------------
// REST routing
// ---------------------------------------------------------------------------------------------

function parseQuery(raw) {
  const out = {};
  if (raw === '') return out;
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // an undecodable pair is ignored
    }
  }
  return out;
}

function pageOf(query) {
  let perPage = Number(query.per_page);
  if (!Number.isInteger(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = Number(query.page);
  if (!Number.isInteger(page) || page < 1) page = 1;
  return { perPage, page };
}

// Slices `items` to the requested page and builds the Link header for the others.
function paginate(items, query, B, rawPath) {
  const { perPage, page } = pageOf(query);
  const total = items.length;
  const last = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  let link = null;
  if (last > 1) {
    const params = [];
    for (const key of Object.keys(query)) {
      if (key !== 'page' && key !== 'per_page') params.push(`${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`);
    }
    params.push(`per_page=${perPage}`);
    const url = (n) => `<${B}${rawPath}?${params.join('&')}&page=${n}>`;
    const rels = [];
    if (page < last) rels.push(`${url(page + 1)}; rel="next"`, `${url(last)}; rel="last"`);
    if (page > 1) rels.push(`${url(1)}; rel="first"`, `${url(Math.min(page - 1, last))}; rel="prev"`);
    link = rels.join(', ');
  }
  return { slice, link };
}

function reply(status, json, link) {
  return { status, json, link: link || null };
}

function bodyObject(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Body should be a JSON object');
  return body;
}

const NOT_FOUND = () => new ApiError(404, 'Not Found');

function rootDoc(B) {
  const api = `${B}/api/v3`;
  return {
    current_user_url: `${api}/user`,
    current_user_repositories_url: `${api}/user/repos{?type,page,per_page,sort}`,
    repository_url: `${api}/repos/{owner}/{repo}`,
    issues_url: `${api}/issues`,
    rate_limit_url: `${api}/rate_limit`,
    user_url: `${api}/users/{user}`,
    user_repositories_url: `${api}/users/{user}/repos{?type,page,per_page,sort}`,
    graphql_url: `${B}/api/graphql`,
  };
}

function sortRepos(list, query) {
  const sort = query.sort;
  if (sort === 'created' || sort === 'updated' || sort === 'pushed') {
    const key = sort === 'created' ? 'createdAt' : sort === 'updated' ? 'updatedAt' : 'pushedAt';
    const asc = query.direction === 'asc';
    list.sort((a, b) => (asc ? a[key] - b[key] || a.id - b.id : b[key] - a[key] || b.id - a.id));
  } else {
    const desc = query.direction === 'desc';
    list.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      const diff = x < y ? -1 : x > y ? 1 : 0;
      return desc ? -diff : diff;
    });
  }
  return list;
}

function searchIssues(query, B) {
  const terms = (query.q || '').split(/\s+/).filter((term) => term !== '');
  let repoFilter = null;
  let kind = null;
  let state = null;
  const words = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.startsWith('repo:')) repoFilter = lower.slice(5);
    else if (lower === 'is:issue' || lower === 'type:issue') kind = 'issue';
    else if (lower === 'is:pr' || lower === 'is:pull-request' || lower === 'type:pr') kind = 'pr';
    else if (lower === 'is:open' || lower === 'state:open') state = 'open';
    else if (lower === 'is:closed' || lower === 'state:closed') state = 'closed';
    else if (!lower.includes(':')) words.push(lower.replace(/^"|"$/g, ''));
  }
  const items = [];
  for (const repo of repos.values()) {
    if (repoFilter !== null && repoFilter !== `${viewer.lower}/${repo.name.toLowerCase()}`) continue;
    for (const issue of repo.issues.values()) {
      if (kind === 'issue' && issue.pull !== null) continue;
      if (kind === 'pr' && issue.pull === null) continue;
      if (state !== null && issue.state !== state) continue;
      const hay = `${issue.title}\n${issue.body}`.toLowerCase();
      if (!words.every((word) => hay.includes(word))) continue;
      items.push(issueJson(repo, issue, B));
    }
  }
  return items;
}

function routeIssues(method, repo, segs, query, body, B, rawPath) {
  const sub = segs[4];
  if (sub === undefined) {
    if (method === 'GET') {
      const labels = query.labels ? query.labels.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '') : null;
      const since = query.since ? Math.floor(Date.parse(query.since) / 1000) : 0;
      const list = listIssues(repo, { state: query.state, labels, sort: query.sort, direction: query.direction, since: since || 0 });
      const { slice, link } = paginate(list, query, B, rawPath);
      return reply(200, slice.map((issue) => issueJson(repo, issue, B)), link);
    }
    if (method === 'POST') return reply(201, issueJson(repo, createIssue(repo, bodyObject(body)), B));
    throw NOT_FOUND();
  }
  if (sub === 'comments') {
    // /issues/comments[/{id}]
    const id = Number(segs[5]);
    if (segs[5] === undefined && method === 'GET') {
      const all = [];
      for (const issue of repo.issues.values()) for (const comment of issue.comments) all.push(commentJson(repo, issue, comment, B));
      const { slice, link } = paginate(all, query, B, rawPath);
      return reply(200, slice, link);
    }
    for (const issue of repo.issues.values()) {
      const at = issue.comments.findIndex((comment) => comment.id === id);
      if (at < 0) continue;
      const comment = issue.comments[at];
      if (method === 'GET') return reply(200, commentJson(repo, issue, comment, B));
      if (method === 'PATCH') {
        const input = bodyObject(body);
        if (typeof input.body !== 'string' || input.body === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
        comment.body = input.body;
        comment.updatedAt = tick();
        return reply(200, commentJson(repo, issue, comment, B));
      }
      if (method === 'DELETE') {
        issue.comments.splice(at, 1);
        tick();
        return reply(204);
      }
    }
    throw NOT_FOUND();
  }
  const issue = needIssue(repo, sub);
  const tail = segs[5];
  if (tail === undefined) {
    if (method === 'GET') return reply(200, issueJson(repo, issue, B));
    if (method === 'PATCH' || method === 'POST') return reply(200, issueJson(repo, updateIssue(repo, issue, bodyObject(body)), B));
    throw NOT_FOUND();
  }
  if (tail === 'comments') {
    if (method === 'GET') {
      const { slice, link } = paginate(issue.comments, query, B, rawPath);
      return reply(200, slice.map((comment) => commentJson(repo, issue, comment, B)), link);
    }
    if (method === 'POST') return reply(201, commentJson(repo, issue, addComment(repo, issue, bodyObject(body).body), B));
    throw NOT_FOUND();
  }
  if (tail === 'labels') {
    if (method === 'GET') return reply(200, issue.labels.map((label) => labelJson(repo, label, B)));
    if (method === 'POST' || method === 'PUT') {
      const input = Array.isArray(body) ? body : bodyObject(body).labels;
      const labels = resolveLabels(repo, input);
      if (method === 'PUT') issue.labels = labels;
      else for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
      issue.updatedAt = tick();
      return reply(200, issue.labels.map((label) => labelJson(repo, label, B)));
    }
    if (method === 'DELETE') {
      if (segs[6] === undefined) issue.labels = [];
      else {
        const at = issue.labels.findIndex((label) => label.name.toLowerCase() === segs[6].toLowerCase());
        if (at < 0) throw NOT_FOUND();
        issue.labels.splice(at, 1);
      }
      issue.updatedAt = tick();
      return segs[6] === undefined ? reply(204) : reply(200, issue.labels.map((label) => labelJson(repo, label, B)));
    }
  }
  throw NOT_FOUND();
}

function routePulls(method, repo, segs, query, body, B, rawPath) {
  const sub = segs[4];
  if (sub === undefined) {
    if (method === 'GET') {
      const list = listIssues(repo, {
        pulls: true,
        state: query.state,
        sort: query.sort === 'updated' ? 'updated' : 'created',
        direction: query.direction || (query.sort && query.sort !== 'created' ? 'desc' : 'desc'),
        head: query.head ? branchOfHead(query.head) : null,
        base: query.base || null,
      });
      const { slice, link } = paginate(list, query, B, rawPath);
      return reply(200, slice.map((issue) => pullJson(repo, issue, B, false)), link);
    }
    if (method === 'POST') return reply(201, pullJson(repo, createPull(repo, bodyObject(body)), B, true));
    throw NOT_FOUND();
  }
  const issue = needIssue(repo, sub, true);
  const tail = segs[5];
  if (tail === undefined) {
    if (method === 'GET') return reply(200, pullJson(repo, issue, B, true));
    if (method === 'PATCH') return reply(200, pullJson(repo, updatePull(repo, issue, bodyObject(body)), B, true));
    throw NOT_FOUND();
  }
  if (tail === 'files' && method === 'GET') {
    const { slice, link } = paginate(pullFiles(repo, issue, B), query, B, rawPath);
    return reply(200, slice, link);
  }
  if (tail === 'commits' && method === 'GET') {
    const { slice, link } = paginate(pullCommits(repo, issue), query, B, rawPath);
    return reply(200, slice.map((oid) => commitJson(repo, oid, B)), link);
  }
  if (tail === 'merge') {
    if (method === 'PUT') return reply(200, mergePull(repo, issue, bodyObject(body)));
    if (method === 'GET') {
      if (issue.pull.merged) return reply(204);
      throw NOT_FOUND();
    }
  }
  if ((tail === 'comments' || tail === 'reviews' || tail === 'requested_reviewers') && method === 'GET') {
    return reply(200, tail === 'requested_reviewers' ? { users: [], teams: [] } : []);
  }
  throw NOT_FOUND();
}

function routeGit(method, repo, segs, body, B) {
  const git = repo.git;
  const kind = segs[4];
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    const rest = segs.slice(5).join('/');
    if (rest === '' && method === 'POST') {
      const input = bodyObject(body);
      const ref = input.ref;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.split('/').length < 3 || /[\s~^:?*[\\]/.test(ref)) {
        throw new ApiError(422, 'Reference name is invalid');
      }
      if (typeof input.sha !== 'string' || !git.has(input.sha.toLowerCase())) throw new ApiError(422, 'Object does not exist');
      if (git.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
      const sha = input.sha.toLowerCase();
      git.setRef(ref, sha);
      afterPush(repo, [{ ref }]);
      return reply(201, refJson(repo, ref, sha, B));
    }
    const full = rest === '' ? 'refs/' : `refs/${rest}`;
    const exact = git.refs.get(full);
    if (method === 'GET') {
      if (exact !== undefined && kind !== 'matching-refs') return reply(200, refJson(repo, full, exact, B));
      const matches = git.refList().filter(([name]) => name.startsWith(full));
      if (kind === 'ref' || (matches.length === 0 && kind !== 'matching-refs')) throw NOT_FOUND();
      return reply(200, matches.map(([name, oid]) => refJson(repo, name, oid, B)));
    }
    if (exact === undefined) throw new ApiError(method === 'DELETE' ? 422 : 404, method === 'DELETE' ? 'Reference does not exist' : 'Not Found');
    if (method === 'PATCH') {
      const input = bodyObject(body);
      const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
      if (!git.has(sha)) throw new ApiError(422, 'Object does not exist');
      if (input.force !== true && !git.isAncestor(exact, sha)) throw new ApiError(422, 'Update is not a fast forward');
      git.setRef(full, sha);
      afterPush(repo, [{ ref: full }]);
      return reply(200, refJson(repo, full, sha, B));
    }
    if (method === 'DELETE') {
      git.deleteRef(full);
      afterPush(repo, [{ ref: full }]);
      return reply(204);
    }
    throw NOT_FOUND();
  }
  const api = `${B}/api/v3/repos/${viewer.login}/${repo.name}`;
  if (kind === 'commits') {
    if (method === 'GET' && segs[5] !== undefined) {
      const oid = segs[5].toLowerCase();
      if (git.commit(oid) === null) throw NOT_FOUND();
      return reply(200, gitCommitJson(repo, oid, B));
    }
    if (method === 'POST' && segs[5] === undefined) {
      const input = bodyObject(body);
      if (typeof input.message !== 'string') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
      const tree = typeof input.tree === 'string' ? input.tree.toLowerCase() : '';
      if (git.tree(tree) === null) throw new ApiError(422, 'Tree SHA does not exist');
      const parents = Array.isArray(input.parents) ? input.parents.map((sha) => String(sha).toLowerCase()) : [];
      for (const parent of parents) if (git.commit(parent) === null) throw new ApiError(422, 'Parent SHA does not exist or is not a commit object');
      const now = tick();
      const author = ident(input.author || input.committer, now);
      const committer = ident(input.committer || input.author, now);
      const oid = git.writeCommit({ tree, parents, message: input.message, author, committer });
      return reply(201, gitCommitJson(repo, oid, B));
    }
  }
  if (kind === 'blobs') {
    if (method === 'GET' && segs[5] !== undefined) {
      const oid = segs[5].toLowerCase();
      const obj = git.get(oid);
      if (obj === undefined || obj.t !== T_BLOB) throw NOT_FOUND();
      return reply(200, { sha: oid, node_id: `B_${b64(`Blob:${repo.id}:${oid}`)}`, size: obj.d.length, url: `${api}/git/blobs/${oid}`, content: wrapBase64(obj.d), encoding: 'base64' });
    }
    if (method === 'POST' && segs[5] === undefined) {
      const input = bodyObject(body);
      if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
      const data = input.encoding === 'base64' ? Buffer.from(input.content.replace(/\s+/g, ''), 'base64') : Buffer.from(input.content, 'utf8');
      const oid = git.put(T_BLOB, data);
      tick();
      return reply(201, { sha: oid, url: `${api}/git/blobs/${oid}` });
    }
  }
  if (kind === 'trees') {
    const treeView = (oid, recursive) => {
      const out = [];
      const walk = (treeOid, prefix) => {
        for (const entry of git.tree(treeOid) || []) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          const isTree = entry.mode === '40000';
          const item = { path, mode: isTree ? '040000' : entry.mode, type: isTree ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid };
          if (!isTree) {
            const obj = git.get(entry.oid);
            item.size = obj === undefined ? 0 : obj.d.length;
          }
          item.url = `${api}/git/${isTree ? 'trees' : 'blobs'}/${entry.oid}`;
          out.push(item);
          if (isTree && recursive) walk(entry.oid, path);
        }
      };
      walk(oid, '');
      return { sha: oid, url: `${api}/git/trees/${oid}`, tree: out, truncated: false };
    };
    if (method === 'GET' && segs[5] !== undefined) {
      let oid = segs.slice(5).join('/');
      const lowered = oid.toLowerCase();
      if (git.tree(lowered) !== null) oid = lowered;
      else {
        const commit = git.resolve(oid);
        if (commit === null) throw NOT_FOUND();
        oid = git.commit(commit).tree;
      }
      return reply(200, treeView(oid, false));
    }
    if (method === 'POST' && segs[5] === undefined) {
      const input = bodyObject(body);
      if (!Array.isArray(input.tree)) throw new ApiError(422, 'Invalid request.\n\n"tree" wasn\'t supplied.');
      let root = null;
      if (typeof input.base_tree === 'string' && input.base_tree !== '') {
        root = input.base_tree.toLowerCase();
        if (git.tree(root) === null) throw new ApiError(422, 'base_tree is not a valid tree oid');
      }
      for (const item of input.tree) {
        if (item === null || typeof item !== 'object' || typeof item.path !== 'string') throw new ApiError(422, 'tree.path is required');
        const segments = pathSegments(item.path);
        if (segments.length === 0) throw new ApiError(422, 'tree.path is required');
        let blob;
        if (typeof item.content === 'string') blob = git.put(T_BLOB, Buffer.from(item.content, 'utf8'));
        else if (typeof item.sha === 'string') {
          blob = item.sha.toLowerCase();
          if (!git.has(blob)) throw new ApiError(422, 'tree.sha does not exist');
        } else blob = null;
        if (blob !== null && git.get(blob).t === T_TREE) {
          // grafting a whole subtree: copy its files under the path
          for (const [path, entry] of git.flatten(blob)) root = git.editTree(root, [...segments, ...path.split('/')], 0, entry.oid);
          continue;
        }
        const next = git.editTree(root, segments, 0, blob);
        if (next !== undefined) root = next;
      }
      if (root === null) root = git.emptyTree();
      tick();
      return reply(201, treeView(root, false));
    }
  }
  if (kind === 'tags' && method === 'GET' && segs[5] !== undefined) {
    const oid = segs[5].toLowerCase();
    const obj = git.get(oid);
    if (obj === undefined || obj.t !== 4) throw NOT_FOUND();
    const tag = parseTag(obj.d);
    return reply(200, { sha: oid, url: `${api}/git/tags/${oid}`, tag: tag.tag, message: apiMessage(tag.message), tagger: personOf(tag.tagger), object: { sha: tag.object, type: tag.type, url: `${api}/git/${tag.type}s/${tag.object}` } });
  }
  throw NOT_FOUND();
}

function routeRepo(method, segs, query, body, B, rawPath) {
  const repo = needRepo(segs[1], segs[2]);
  const sub = segs[3];
  const git = repo.git;
  if (sub === undefined) {
    if (method === 'GET') return reply(200, repoJson(repo, B));
    if (method === 'PATCH') return reply(200, repoJson(updateRepo(repo, bodyObject(body)), B));
    if (method === 'DELETE') {
      deleteRepo(repo);
      return reply(204);
    }
    throw NOT_FOUND();
  }
  switch (sub) {
    case 'issues':
      return routeIssues(method, repo, segs, query, body, B, rawPath);
    case 'pulls':
      return routePulls(method, repo, segs, query, body, B, rawPath);
    case 'contents': {
      const path = segs.slice(4).join('/');
      if (method === 'GET') return reply(200, getContents(repo, path, query.ref, B));
      if (method === 'PUT') {
        const result = putContents(repo, path, bodyObject(body), B);
        return reply(result.created ? 201 : 200, result.json);
      }
      if (method === 'DELETE') {
        const input = bodyObject(body);
        if (input.message === undefined && query.message !== undefined) input.message = query.message;
        if (input.sha === undefined && query.sha !== undefined) input.sha = query.sha;
        if (input.branch === undefined && query.branch !== undefined) input.branch = query.branch;
        return reply(200, deleteContents(repo, path, input, B));
      }
      throw NOT_FOUND();
    }
    case 'readme': {
      if (method !== 'GET') throw NOT_FOUND();
      const tip = git.resolve(query.ref);
      if (tip === null) throw NOT_FOUND();
      const entries = git.tree(git.commit(tip).tree) || [];
      const found = entries.find((entry) => /^readme(\.|$)/i.test(entry.name) && entry.mode !== '40000');
      if (found === undefined) throw NOT_FOUND();
      return reply(200, getContents(repo, found.name, query.ref, B));
    }
    case 'branches': {
      if (method !== 'GET') throw NOT_FOUND();
      if (segs[4] === undefined) {
        const { slice, link } = paginate(git.branches(), query, B, rawPath);
        return reply(200, slice.map(([name, oid]) => branchJson(repo, name, oid, B, false)), link);
      }
      const name = segs.slice(4).join('/');
      const oid = git.branch(name);
      if (oid === undefined) throw new ApiError(404, 'Branch not found');
      return reply(200, branchJson(repo, name, oid, B, true));
    }
    case 'commits': {
      if (method !== 'GET') throw NOT_FOUND();
      if (segs[4] === undefined) {
        const tip = git.resolve(query.sha);
        if (tip === null) {
          if (query.sha) throw NOT_FOUND();
          throw new ApiError(409, 'Git Repository is empty.');
        }
        const { perPage, page } = pageOf(query);
        let list = git.log(tip, query.path ? Infinity : page * perPage + 1);
        if (query.path) {
          const segments = pathSegments(query.path);
          list = list.filter((oid) => {
            const info = git.commit(oid);
            const mine = git.lookupPath(info.tree, segments);
            const before = info.parents.length > 0 ? git.lookupPath(git.commit(info.parents[0]).tree, segments) : null;
            return (mine === null ? '' : mine.oid) !== (before === null ? '' : before.oid);
          });
        }
        const { slice, link } = paginate(list, query, B, rawPath);
        return reply(200, slice.map((oid) => commitJson(repo, oid, B)), link);
      }
      const oid = git.resolve(segs.slice(4).join('/'));
      if (oid === null) throw new ApiError(422, `No commit found for SHA: ${segs.slice(4).join('/')}`);
      const view = commitJson(repo, oid, B);
      const info = git.commit(oid);
      const before = info.parents.length > 0 ? flatTreeOf(git, info.parents[0]) : new Map();
      const after = git.flatten(info.tree);
      const files = [];
      let additions = 0;
      let deletions = 0;
      for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const a = before.get(path);
        const b = after.get(path);
        if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
        const stats = lineStats(a === undefined ? [] : countLines(git.get(a.oid).d), b === undefined ? [] : countLines(git.get(b.oid).d));
        additions += stats.additions;
        deletions += stats.deletions;
        files.push({ sha: b === undefined ? a.oid : b.oid, filename: path, status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', additions: stats.additions, deletions: stats.deletions, changes: stats.additions + stats.deletions });
      }
      view.stats = { total: additions + deletions, additions, deletions };
      view.files = files;
      return reply(200, view);
    }
    case 'git':
      return routeGit(method, repo, segs, body, B);
    case 'labels': {
      if (segs[4] === undefined) {
        if (method === 'GET') {
          const { slice, link } = paginate([...repo.labels.values()], query, B, rawPath);
          return reply(200, slice.map((label) => labelJson(repo, label, B)), link);
        }
        if (method === 'POST') {
          const label = createLabel(repo, bodyObject(body));
          tick();
          return reply(201, labelJson(repo, label, B));
        }
        throw NOT_FOUND();
      }
      const key = segs.slice(4).join('/').toLowerCase();
      const label = repo.labels.get(key);
      if (label === undefined) throw NOT_FOUND();
      if (method === 'GET') return reply(200, labelJson(repo, label, B));
      if (method === 'PATCH') {
        const input = bodyObject(body);
        if (typeof input.new_name === 'string' && input.new_name !== '') {
          repo.labels.delete(key);
          label.name = input.new_name;
          repo.labels.set(label.name.toLowerCase(), label);
        }
        if (typeof input.color === 'string') label.color = input.color.replace(/^#/, '');
        if (typeof input.description === 'string') label.description = input.description;
        tick();
        return reply(200, labelJson(repo, label, B));
      }
      if (method === 'DELETE') {
        repo.labels.delete(key);
        for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((item) => item !== label);
        tick();
        return reply(204);
      }
      throw NOT_FOUND();
    }
    case 'tags': {
      if (method !== 'GET') throw NOT_FOUND();
      const tags = git.refList().filter(([name]) => name.startsWith('refs/tags/'));
      const { slice, link } = paginate(tags, query, B, rawPath);
      return reply(200, slice.map(([name, oid]) => {
        const sha = git.peel(oid) || oid;
        return { name: name.slice(10), commit: { sha, url: `${B}/api/v3/repos/${viewer.login}/${repo.name}/commits/${sha}` }, node_id: `REF_${b64(`Ref:${repo.id}:${name}`)}` };
      }), link);
    }
    case 'collaborators':
    case 'assignees':
    case 'contributors':
      if (method === 'GET' && segs[4] === undefined) return reply(200, [userJson(B)]);
      throw NOT_FOUND();
    case 'topics':
      if (method === 'GET') return reply(200, { names: [] });
      throw NOT_FOUND();
    case 'languages':
      if (method === 'GET') return reply(200, {});
      throw NOT_FOUND();
    case 'milestones':
    case 'releases':
    case 'forks':
    case 'hooks':
    case 'deployments':
      if (method === 'GET' && segs[4] === undefined) return reply(200, []);
      throw NOT_FOUND();
    default:
      throw NOT_FOUND();
  }
}

// Serves one REST call. `segs` are the decoded path segments after /api/v3; `rawQuery` is the query
// string as sent; `rawPath` the request path (for Link headers). Throws ApiError for error replies.
export function rest(method, segs, rawQuery, body, B, rawPath) {
  const head = segs[0];
  const query = parseQuery(rawQuery);
  if (head === undefined) {
    if (method === 'GET') return reply(200, rootDoc(B));
    throw NOT_FOUND();
  }
  switch (head) {
    case 'repos':
      if (segs.length < 3) throw NOT_FOUND();
      return routeRepo(method, segs, query, body, B, rawPath);
    case 'user':
      if (segs[1] === undefined && method === 'GET') return reply(200, fullUserJson(B));
      if (segs[1] === 'repos' && segs[2] === undefined) {
        if (method === 'POST') return reply(201, repoJson(createRepo(bodyObject(body)), B));
        if (method === 'GET') {
          let list = sortRepos([...repos.values()], query);
          if (query.visibility === 'public' || query.type === 'public') list = list.filter((repo) => !repo.private);
          else if (query.visibility === 'private' || query.type === 'private') list = list.filter((repo) => repo.private);
          const { slice, link } = paginate(list, query, B, rawPath);
          return reply(200, slice.map((repo) => repoJson(repo, B)), link);
        }
      }
      if ((segs[1] === 'orgs' || segs[1] === 'teams' || segs[1] === 'emails' || segs[1] === 'starred' || segs[1] === 'issues') && method === 'GET') {
        if (segs[1] === 'emails') return reply(200, [{ email: viewer.email, primary: true, verified: true, visibility: 'public' }]);
        if (segs[1] === 'issues') {
          const all = [];
          for (const repo of repos.values()) for (const issue of listIssues(repo, { state: query.state })) all.push(issueJson(repo, issue, B));
          const { slice, link } = paginate(all, query, B, rawPath);
          return reply(200, slice, link);
        }
        return reply(200, []);
      }
      throw NOT_FOUND();
    case 'users':
      if (segs[1] === undefined || segs[1].toLowerCase() !== viewer.lower) throw NOT_FOUND();
      if (segs[2] === undefined && method === 'GET') return reply(200, fullUserJson(B));
      if (segs[2] === 'repos' && method === 'GET') {
        const { slice, link } = paginate(sortRepos([...repos.values()], query), query, B, rawPath);
        return reply(200, slice.map((repo) => repoJson(repo, B)), link);
      }
      if (segs[2] === 'orgs' && method === 'GET') return reply(200, []);
      throw NOT_FOUND();
    case 'meta':
      if (method === 'GET' && segs[1] === undefined) {
        return reply(200, { verifiable_password_authentication: false, installed_version: '3.14.0', github_services_sha: '0000000000000000000000000000000000000000' });
      }
      throw NOT_FOUND();
    case 'rate_limit':
      if (method === 'GET') {
        const core = { limit: 5000, used: 0, remaining: 5000, reset: clock0 + 3600 };
        return reply(200, { resources: { core, search: { ...core, limit: 30, remaining: 30 }, graphql: core }, rate: core });
      }
      throw NOT_FOUND();
    case 'search':
      if (method === 'GET' && segs[1] === 'issues') {
        const items = searchIssues(query, B);
        const { slice, link } = paginate(items, query, B, rawPath);
        return reply(200, { total_count: items.length, incomplete_results: false, items: slice }, link);
      }
      if (method === 'GET' && segs[1] === 'repositories') {
        const words = (query.q || '').toLowerCase().split(/\s+/).filter((term) => term !== '' && !term.includes(':'));
        const items = [...repos.values()].filter((repo) => words.every((word) => repo.name.toLowerCase().includes(word) || (repo.description || '').toLowerCase().includes(word)));
        const { slice, link } = paginate(items, query, B, rawPath);
        return reply(200, { total_count: items.length, incomplete_results: false, items: slice.map((repo) => repoJson(repo, B)) }, link);
      }
      throw NOT_FOUND();
    case 'repositories': {
      const repo = reposById.get(Number(segs[1]));
      if (repo === undefined || method !== 'GET' || segs[2] !== undefined) throw NOT_FOUND();
      return reply(200, repoJson(repo, B));
    }
    default:
      throw NOT_FOUND();
  }
}

export function errorBody(err) {
  const out = { message: err.message, documentation_url: 'https://docs.github.com/rest', status: String(err.status) };
  if (err.errors !== undefined) out.errors = err.errors;
  return out;
}

export { T_COMMIT };
