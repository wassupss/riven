// gh:* (src/main/githubPr.ts, githubPrDetail.ts, githubPrReview.ts): pull
// requests through the `gh` CLI the user already logged in to. Access is
// whatever that login has (the user's gh wrapper may pick the account by the
// working directory, so every call runs with cwd = the repo). Bodies and
// review payloads go to gh on stdin, never on a command line.

use super::{exec, spawn_io, DEFAULT_MAX_BUFFER};
use crate::services::chat::util::{js_string, js_trim, resolve_bin, truthy, utf16_prefix};
use crate::services::collate::locale_compare;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const MB: usize = 1024 * 1024;

fn sv(v: &[&str]) -> Vec<String> {
  v.iter().map(|s| s.to_string()).collect()
}

fn re(cell: &'static OnceLock<regex::Regex>, pat: &str) -> &'static regex::Regex {
  cell.get_or_init(|| regex::Regex::new(pat).unwrap())
}

/// `s.trim().slice(0, n)`
fn clip(s: &str, n: usize) -> String {
  utf16_prefix(js_trim(s), n).to_string()
}

/// `a?.b` on loosely typed JSON: absent, null and non-objects read as absent.
fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
  v.and_then(|o| o.as_object()).and_then(|o| o.get(k)).filter(|x| !x.is_null())
}

/// `x ?? dflt` as a Value.
fn or(v: Option<&Value>, dflt: Value) -> Value {
  v.filter(|x| !x.is_null()).cloned().unwrap_or(dflt)
}

/// Copies `k` from `src` into `dst` unless it is absent (JSON.stringify drops
/// an undefined property).
fn pass(dst: &mut Map<String, Value>, k: &str, src: &Value, from: &str) {
  if let Some(v) = src.get(from) {
    dst.insert(k.into(), v.clone());
  }
}

// ---- gh -------------------------------------------------------------------------

struct Gh {
  ok: bool,
  stdout: String,
  stderr: String,
}

/// githubPr.ts gh() (missing: 'no-gh') and githubPrDetail.ts gh() (missing:
/// 'GitHub CLI (gh) not found'): execFile through the login PATH's gh.
async fn gh(cwd: &str, args: Vec<String>, timeout_ms: u64, max_buffer: usize, missing: &str) -> Gh {
  let Some(bin) = resolve_bin("gh").await else {
    return Gh { ok: false, stdout: String::new(), stderr: missing.into() };
  };
  let r = exec(&bin, &args, Some(cwd), Some(Duration::from_millis(timeout_ms)), max_buffer).await;
  if r.ok {
    Gh { ok: true, stdout: r.stdout, stderr: r.stderr }
  } else {
    let stderr = if r.stderr.is_empty() { r.message } else { r.stderr };
    Gh { ok: false, stdout: r.stdout, stderr }
  }
}

async fn gh_list(cwd: &str, args: Vec<String>, timeout_ms: u64) -> Gh {
  gh(cwd, args, timeout_ms, 16 * MB, "no-gh").await
}

async fn gh_detail(cwd: &str, args: Vec<String>) -> Gh {
  gh(cwd, args, 30000, 64 * MB, "GitHub CLI (gh) not found").await
}

/// ghStdin / ghJson: spawn with stdin.
async fn gh_stdin(cwd: &str, args: Vec<String>, input: Option<&str>, timeout_ms: u64, missing: &str) -> Gh {
  let Some(bin) = resolve_bin("gh").await else {
    return Gh { ok: false, stdout: String::new(), stderr: missing.into() };
  };
  let (ok, stdout, stderr) = spawn_io(&bin, &args, cwd, input, Duration::from_millis(timeout_ms)).await;
  Gh { ok, stdout, stderr }
}

// ---- pure helpers (githubPr.ts) ---------------------------------------------------

/// The verdict of one rollup entry: a StatusContext's state, or a CheckRun's
/// conclusion once completed (its status before).
fn verdict(raw: &Value) -> String {
  let state = get(Some(raw), "state");
  let v = match state {
    Some(s) => Some(s),
    None => {
      let status = raw.get("status");
      if status.and_then(Value::as_str) == Some("COMPLETED") { get(Some(raw), "conclusion") } else { status.filter(|x| !x.is_null()) }
    }
  };
  v.map(js_string).unwrap_or_default().to_uppercase()
}

pub fn summarise_checks(rollup: Option<&Value>) -> Value {
  let (mut total, mut passed, mut failed, mut pending) = (0, 0, 0, 0);
  if let Some(Value::Array(list)) = rollup {
    for raw in list {
      if !matches!(raw, Value::Object(_) | Value::Array(_)) {
        continue;
      }
      total += 1;
      match verdict(raw).as_str() {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => passed += 1,
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" => failed += 1,
        _ => pending += 1,
      }
    }
  }
  json!({ "total": total, "passed": passed, "failed": failed, "pending": pending })
}

pub fn review_state_of(decision: Option<&Value>) -> &'static str {
  match decision.filter(|v| !v.is_null()).map(js_string).unwrap_or_default().to_uppercase().as_str() {
    "APPROVED" => "approved",
    "CHANGES_REQUESTED" => "changes_requested",
    "REVIEW_REQUIRED" => "review_required",
    _ => "none",
  }
}

fn num_key(v: &Value) -> i64 {
  v.get("number").and_then(Value::as_f64).map(|f| f as i64).unwrap_or(0)
}

/// Map key for a JS Map keyed by a property value.
fn key_of(v: Option<&Value>) -> String {
  v.map(|x| x.to_string()).unwrap_or_else(|| "undefined".into())
}

/// Stacks: a PR whose base branch is another PR's head sits under it. Newest
/// root first, children ascending, every PR exactly once.
pub fn build_stacks(prs: Vec<Value>) -> Vec<Value> {
  let mut by_head: HashMap<String, usize> = HashMap::new();
  for (i, pr) in prs.iter().enumerate() {
    by_head.insert(key_of(pr.get("headRefName")), i);
  }
  let parent_of = |i: usize| -> Option<usize> {
    let p = *by_head.get(&key_of(prs[i].get("baseRefName")))?;
    (num_key(&prs[p]) != num_key(&prs[i])).then_some(p)
  };
  let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
  let mut roots: Vec<usize> = Vec::new();
  for i in 0..prs.len() {
    match parent_of(i) {
      None => roots.push(i),
      Some(p) => children.entry(num_key(&prs[p])).or_default().push(i),
    }
  }
  let mut out = Vec::new();
  let mut seen: HashSet<i64> = HashSet::new();
  fn walk(i: usize, depth: i64, parent: Option<i64>, prs: &[Value], children: &HashMap<i64, Vec<usize>>, seen: &mut HashSet<i64>, out: &mut Vec<Value>) {
    let n = num_key(&prs[i]);
    if !seen.insert(n) {
      return;
    }
    let mut o = prs[i].as_object().cloned().unwrap_or_default();
    o.insert("parent".into(), parent.map(Value::from).unwrap_or(Value::Null));
    o.insert("depth".into(), depth.into());
    out.push(Value::Object(o));
    let mut kids = children.get(&n).cloned().unwrap_or_default();
    kids.sort_by_key(|&c| num_key(&prs[c]));
    for c in kids {
      walk(c, depth + 1, Some(n), prs, children, seen, out);
    }
  }
  roots.sort_by_key(|&r| std::cmp::Reverse(num_key(&prs[r])));
  for r in roots {
    walk(r, 0, None, &prs, &children, &mut seen, &mut out);
  }
  for i in 0..prs.len() {
    if !seen.contains(&num_key(&prs[i])) {
      walk(i, 0, None, &prs, &children, &mut seen, &mut out);
    }
  }
  out
}

fn login_of(v: Option<&Value>) -> Option<&Value> {
  get(v, "login")
}

pub fn to_pull_requests(raw: &[Value], login: Option<&str>) -> Vec<Value> {
  let mapped = raw
    .iter()
    .map(|p| {
      let author = login_of(p.get("author"));
      let author_is_me = login.is_some_and(|l| author.and_then(Value::as_str) == Some(l));
      let asked = |r: &Value| login.is_some_and(|l| get(Some(r), "login").and_then(Value::as_str) == Some(l));
      let needs = login.is_some_and(|l| !l.is_empty())
        && !author_is_me
        && p.get("reviewRequests").and_then(Value::as_array).is_some_and(|rs| rs.iter().any(asked));
      let mut o = Map::new();
      pass(&mut o, "number", p, "number");
      pass(&mut o, "title", p, "title");
      pass(&mut o, "url", p, "url");
      o.insert("state".into(), json!(or(p.get("state"), json!("OPEN")).as_str().map(str::to_string).unwrap_or_else(|| js_string(&or(p.get("state"), json!("OPEN")))).to_uppercase()));
      o.insert("author".into(), or(author, json!("")));
      o.insert("isMine".into(), json!(login.is_some_and(|l| !l.is_empty()) && author_is_me));
      o.insert("needsMyReview".into(), json!(needs));
      pass(&mut o, "headRefName", p, "headRefName");
      pass(&mut o, "baseRefName", p, "baseRefName");
      o.insert("isDraft".into(), json!(truthy(p.get("isDraft"))));
      o.insert("review".into(), json!(review_state_of(p.get("reviewDecision"))));
      o.insert("checks".into(), summarise_checks(p.get("statusCheckRollup")));
      pass(&mut o, "updatedAt", p, "updatedAt");
      Value::Object(o)
    })
    .collect();
  build_stacks(mapped)
}

const PR_FIELDS: &str = "number,title,url,state,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,reviewRequests,updatedAt";

// Who gh is logged in as, per repo directory. githubPr.ts cached the first
// answer for the life of the app, but gh can answer differently by directory
// (a gh wrapper that picks the account by the working directory, GH_CONFIG_DIR
// per project), and then every other repo's "mine" / "review requested" was
// judged against the wrong account. Electron still has the app-wide cache.
const LOGIN_CACHE_MAX: usize = 64;

fn login_cache() -> &'static Mutex<HashMap<String, String>> {
  static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
  C.get_or_init(Default::default)
}

fn cached_login(cwd: &str) -> Option<String> {
  login_cache().lock().unwrap().get(cwd).cloned()
}

fn remember_login(cwd: &str, login: &str) {
  let mut c = login_cache().lock().unwrap();
  if c.len() >= LOGIN_CACHE_MAX && !c.contains_key(cwd) {
    c.clear();
  }
  c.insert(cwd.to_string(), login.to_string());
}

async fn viewer_login(cwd: &str) -> Option<String> {
  if let Some(l) = cached_login(cwd) {
    return Some(l);
  }
  let r = gh_list(cwd, sv(&["api", "user", "--jq", ".login"]), 20000).await;
  let login = if r.ok { js_trim(&r.stdout).to_string() } else { String::new() };
  if login.is_empty() {
    return None;
  }
  remember_login(cwd, &login);
  Some(login)
}

fn classify(stderr: &str) -> &'static str {
  let s = stderr.to_lowercase();
  if s.contains("no-gh") {
    "no-gh"
  } else if s.contains("auth login") || s.contains("authentication") || s.contains("not logged") {
    "not-authed"
  } else if s.contains("no git remote") || s.contains("not a git repository") || s.contains("could not determine") {
    "no-remote"
  } else {
    "failed"
  }
}

pub async fn list_pull_requests(repo_dir: &str, state: Option<&Value>) -> Value {
  let login = viewer_login(repo_dir).await;
  let s = match state.and_then(Value::as_str) {
    Some("closed") => "closed",
    Some("all") => "all",
    _ => "open",
  };
  let r = gh_list(repo_dir, sv(&["pr", "list", "--state", s, "--limit", "50", "--json", PR_FIELDS]), 20000).await;
  if !r.ok {
    return json!({ "ok": false, "prs": [], "login": login, "error": classify(&r.stderr), "detail": clip(&r.stderr, 300) });
  }
  let text = if r.stdout.is_empty() { "[]" } else { &r.stdout };
  let raw: Vec<Value> = match serde_json::from_str::<Value>(text) {
    Ok(Value::Array(a)) => a,
    _ => return json!({ "ok": false, "prs": [], "login": login, "error": "failed", "detail": "unreadable response" }),
  };
  json!({ "ok": true, "prs": to_pull_requests(&raw, login.as_deref()), "login": login })
}

// ---- new PR (githubPr.ts) -----------------------------------------------------------

/// Publishes the branch (its own step: it puts the user's commits on a server).
pub async fn push_branch(repo_dir: &str, branch: &str) -> Value {
  static B: OnceLock<regex::Regex> = OnceLock::new();
  if !re(&B, r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$").is_match(branch) {
    return json!({ "ok": false, "error": "bad branch name" });
  }
  let r = exec("git", &sv(&["-C", repo_dir, "push", "-u", "origin", branch]), None, Some(Duration::from_millis(120000)), DEFAULT_MAX_BUFFER).await;
  if r.ok {
    return json!({ "ok": true });
  }
  let text = if !r.stderr.is_empty() {
    r.stderr
  } else if !r.message.is_empty() {
    r.message
  } else {
    "push failed".into()
  };
  json!({ "ok": false, "error": clip(&text, 400) })
}

const TEMPLATE_PATHS: [&str; 6] = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
];

async fn read_template(repo_dir: &str) -> String {
  let dir = repo_dir.to_string();
  tokio::task::spawn_blocking(move || {
    for rel in TEMPLATE_PATHS {
      if let Ok(b) = std::fs::read(super::join(&dir, rel)) {
        return String::from_utf8_lossy(&b).into_owned();
      }
    }
    String::new()
  })
  .await
  .unwrap_or_default()
}

/// git(): trimmed stdout, '' on any failure, 10s.
async fn git_text(repo_dir: &str, rest: &[&str]) -> String {
  let mut a = sv(&["-C", repo_dir]);
  a.extend(sv(rest));
  let r = exec("git", &a, None, Some(Duration::from_millis(10000)), DEFAULT_MAX_BUFFER).await;
  if r.ok { js_trim(&r.stdout).to_string() } else { String::new() }
}

/// feat/some-thing -> "Some thing"
pub fn humanize_branch(branch: &str) -> String {
  static SEP: OnceLock<regex::Regex> = OnceLock::new();
  let last = branch.rsplit('/').next().unwrap_or(branch);
  let words = re(&SEP, r"[-_]+").replace_all(last, " ");
  let words = js_trim(&words);
  let mut cs = words.chars();
  match cs.next() {
    Some(c) => format!("{}{}", c.to_uppercase(), cs.as_str()),
    None => branch.to_string(),
  }
}

pub async fn new_pr_draft(repo_dir: &str) -> Value {
  let branch = git_text(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
  if branch.is_empty() || branch == "HEAD" {
    return json!({ "branch": branch, "base": "", "title": "", "body": "", "commits": 0, "hasTemplate": false, "pushed": false, "error": "not on a branch" });
  }
  let viewed = gh_list(repo_dir, sv(&["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]), 20000).await;
  let base = if viewed.ok { js_trim(&viewed.stdout).to_string() } else { String::new() };
  let log = if base.is_empty() { String::new() } else { git_text(repo_dir, &["log", "--format=%s", &format!("origin/{base}..HEAD")]).await };
  let subjects: Vec<&str> = if log.is_empty() { Vec::new() } else { log.split('\n').filter(|s| !s.is_empty()).collect() };
  let title = if subjects.len() == 1 { subjects[0].to_string() } else { humanize_branch(&branch) };
  let body = read_template(repo_dir).await;
  let pushed = !git_text(repo_dir, &["rev-parse", "--verify", &format!("origin/{branch}")]).await.is_empty();
  json!({ "branch": branch, "base": base, "title": title, "body": body, "commits": subjects.len(), "hasTemplate": !body.is_empty(), "pushed": pushed })
}

fn looks_unpushed(stderr: &str) -> bool {
  let s = stderr.to_lowercase();
  s.contains("must first push") || s.contains("no git remote found") || s.contains("head branch")
}

/// `String(input?.k ?? '')`
fn field(input: Option<&Value>, k: &str) -> String {
  match get(input, k) {
    Some(v) => js_string(v),
    None => String::new(),
  }
}

pub async fn create_pull_request(repo_dir: &str, input: Option<&Value>) -> Value {
  let title = field(input, "title");
  let body = field(input, "body");
  let base = field(input, "base");
  let draft = truthy(input.and_then(|i| i.get("draft")));
  let title = js_trim(&title);
  if title.is_empty() {
    return json!({ "ok": false, "error": "a pull request needs a title" });
  }
  let mut args = sv(&["pr", "create", "--title", title, "--body-file", "-"]);
  if !js_trim(&base).is_empty() {
    args.push("--base".into());
    args.push(js_trim(&base).into());
  }
  if draft {
    args.push("--draft".into());
  }
  let r = gh_stdin(repo_dir, args, Some(&body), 60000, "no-gh").await;
  if r.ok {
    let url = js_trim(&r.stdout).split('\n').find(|l| l.starts_with("http")).unwrap_or("").to_string();
    return json!({ "ok": true, "url": url });
  }
  json!({ "ok": false, "error": clip(&r.stderr, 400), "needsPush": looks_unpushed(&r.stderr) })
}

/// GitHub's own form in the browser.
pub async fn create_web(repo_dir: &str) -> Value {
  let r = gh_list(repo_dir, sv(&["pr", "create", "--web"]), 30000).await;
  if r.ok { json!({ "ok": true }) } else { json!({ "ok": false, "error": clip(&r.stderr, 300) }) }
}

// ---- one PR (githubPrDetail.ts) --------------------------------------------------------

async fn repo_slug_with(slug: Gh) -> Option<String> {
  static SLUG: OnceLock<regex::Regex> = OnceLock::new();
  let s = if slug.ok { js_trim(&slug.stdout).to_string() } else { String::new() };
  re(&SLUG, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").is_match(&s).then_some(s)
}

const SLUG_ARGS: [&str; 5] = ["repo", "view", "--json", "nameWithOwner", "--jq"];

fn slug_args() -> Vec<String> {
  let mut a = sv(&SLUG_ARGS);
  a.push(".nameWithOwner".into());
  a
}

const VIEW_FIELDS: &str = "number,title,url,body,author,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,reviews,comments";

/// Reviews (verdict + summary) and line-less comments, oldest first. Empty
/// COMMENTED reviews (shells for line comments) and PENDING drafts are skipped.
pub fn to_conversation(reviews: Option<&Value>, comments: Option<&Value>) -> Vec<Value> {
  let mut out: Vec<(String, Value)> = Vec::new();
  for rv in reviews.and_then(Value::as_array).into_iter().flatten() {
    let body = js_trim(get(Some(rv), "body").and_then(Value::as_str).unwrap_or("")).to_string();
    let state = get(Some(rv), "state").map(js_string).unwrap_or_default();
    if body.is_empty() && state == "COMMENTED" {
      continue;
    }
    if state == "PENDING" {
      continue;
    }
    let at = or(get(Some(rv), "submittedAt"), json!(""));
    out.push((js_string(&at), json!({ "kind": "review", "author": or(login_of(rv.get("author")), json!("")), "body": body, "at": at, "state": state })));
  }
  for cm in comments.and_then(Value::as_array).into_iter().flatten() {
    let body = js_trim(get(Some(cm), "body").and_then(Value::as_str).unwrap_or("")).to_string();
    if body.is_empty() {
      continue;
    }
    let at = or(get(Some(cm), "createdAt"), json!(""));
    out.push((js_string(&at), json!({ "kind": "comment", "author": or(login_of(cm.get("author")), json!("")), "body": body, "at": at })));
  }
  out.sort_by(|a, b| locale_compare(&a.0, &b.0));
  out.into_iter().map(|(_, v)| v).collect()
}

/// `a || b || dflt` over properties.
fn first_truthy(c: &Value, keys: &[&str]) -> Option<Value> {
  keys.iter().filter_map(|k| c.get(*k)).find(|v| truthy(Some(v))).cloned()
}

pub fn to_check_runs(rollup: Option<&Value>) -> Vec<Value> {
  let Some(Value::Array(list)) = rollup else { return Vec::new() };
  list
    .iter()
    .map(|c| {
      json!({
        "name": first_truthy(c, &["name", "context"]).unwrap_or(json!("")),
        "state": verdict(c),
        "url": first_truthy(c, &["detailsUrl", "targetUrl"]).unwrap_or(Value::Null),
      })
    })
    .collect()
}

/// `gh api --paginate --slurp`: one array per page, flattened.
pub fn flatten_pages(parsed: &Value) -> Vec<Value> {
  let Some(a) = parsed.as_array() else { return Vec::new() };
  if a.is_empty() {
    return Vec::new();
  }
  if a[0].is_array() {
    a.iter().flat_map(|p| match p {
      Value::Array(x) => x.clone(),
      other => vec![other.clone()],
    })
    .collect()
  } else {
    a.clone()
  }
}

const THREADS_QUERY: &str = concat!(
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){",
  "repository(owner:$owner,name:$name){pullRequest(number:$number){",
  "reviewThreads(first:50,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{",
  "id isResolved isOutdated path line originalLine startLine diffSide resolvedBy{login}",
  "comments(first:50){nodes{id databaseId author{login} body createdAt outdated diffHunk}}",
  "}}}}}"
);

/// gh prints one JSON document per page, back to back.
pub fn parse_graphql_pages(stdout: &str) -> Vec<Value> {
  let mut chunks = Vec::new();
  let mut start = 0;
  let b = stdout.as_bytes();
  for i in 0..b.len() {
    if b[i] == b'\n' && b.get(i + 1) == Some(&b'{') {
      chunks.push(&stdout[start..i]);
      start = i + 1;
    }
  }
  chunks.push(&stdout[start..]);
  chunks.into_iter().map(js_trim).filter(|s| !s.is_empty()).filter_map(|s| serde_json::from_str(s).ok()).collect()
}

pub fn to_threads(pages: &[Value]) -> Vec<Value> {
  let mut out = Vec::new();
  for p in pages {
    let nodes = get(get(get(get(get(Some(p), "data"), "repository"), "pullRequest"), "reviewThreads"), "nodes");
    for t in nodes.and_then(Value::as_array).into_iter().flatten() {
      let comments: Vec<Value> = get(get(Some(t), "comments"), "nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| {
          let mut o = Map::new();
          pass(&mut o, "id", c, "id");
          o.insert("databaseId".into(), or(c.get("databaseId"), Value::Null));
          o.insert("author".into(), or(login_of(c.get("author")), json!("")));
          pass(&mut o, "body", c, "body");
          pass(&mut o, "createdAt", c, "createdAt");
          o.insert("outdated".into(), json!(truthy(c.get("outdated"))));
          o.insert("diffHunk".into(), or(c.get("diffHunk"), json!("")));
          Value::Object(o)
        })
        .collect();
      let mut o = Map::new();
      pass(&mut o, "id", t, "id");
      pass(&mut o, "path", t, "path");
      o.insert("line".into(), or(t.get("line"), Value::Null));
      o.insert("originalLine".into(), or(t.get("originalLine"), Value::Null));
      o.insert("startLine".into(), or(t.get("startLine"), Value::Null));
      o.insert("diffSide".into(), or(t.get("diffSide"), json!("RIGHT")));
      o.insert("isResolved".into(), json!(truthy(t.get("isResolved"))));
      o.insert("isOutdated".into(), json!(truthy(t.get("isOutdated"))));
      o.insert("resolvedBy".into(), or(login_of(t.get("resolvedBy")), Value::Null));
      o.insert("comments".into(), Value::Array(comments));
      out.push(Value::Object(o));
    }
  }
  out
}

/// `Number.isInteger(n) && n > 0`
fn pr_number(v: Option<&Value>) -> Option<i64> {
  let f = v?.as_f64()?;
  (f.fract() == 0.0 && f > 0.0 && f.is_finite()).then_some(f as i64)
}

/// `String(v ?? '')`
fn string_or_empty(v: Option<&Value>) -> Value {
  json!(v.filter(|x| !x.is_null()).map(js_string).unwrap_or_default())
}

/// `Number(v ?? 0)`; NaN is null in JSON.
fn number_or0(v: Option<&Value>) -> Value {
  match v.filter(|x| !x.is_null()) {
    None => json!(0),
    Some(Value::Number(n)) => Value::Number(n.clone()),
    Some(Value::Bool(b)) => json!(i64::from(*b)),
    Some(Value::String(s)) => {
      let t = js_trim(s);
      if t.is_empty() {
        json!(0)
      } else {
        t.parse::<f64>().ok().map(crate::services::chat::util::jnum).unwrap_or(Value::Null)
      }
    }
    Some(_) => Value::Null,
  }
}

pub async fn pr_detail(repo_dir: &str, number: Option<&Value>) -> Value {
  let Some(num) = pr_number(number) else { return json!({ "ok": false, "error": "bad pr number" }) };
  let n = num.to_string();
  let view = gh_detail(repo_dir, sv(&["pr", "view", &n, "--json", VIEW_FIELDS])).await;
  if !view.ok {
    return json!({ "ok": false, "error": clip(&view.stderr, 300) });
  }
  let Ok(v) = serde_json::from_str::<Value>(&view.stdout) else { return json!({ "ok": false, "error": "unreadable response" }) };
  let Some(slug) = repo_slug_with(gh_detail(repo_dir, slug_args()).await).await else {
    return json!({ "ok": false, "error": "could not resolve the GitHub repository" });
  };
  let (owner, name) = slug.split_once('/').unwrap_or((&slug, ""));

  // One REST request per 100 files: cached for a minute.
  let files_res = gh_detail(repo_dir, sv(&["api", &format!("repos/{slug}/pulls/{n}/files"), "--paginate", "--slurp", "--cache", "60s"])).await;
  let mut files = Vec::new();
  if files_res.ok {
    if let Ok(parsed) = serde_json::from_str::<Value>(&files_res.stdout) {
      let pages = flatten_pages(&parsed);
      // `f.filename` on a null entry threw, and the list was [].
      if !pages.iter().any(Value::is_null) {
        files = pages
          .iter()
          .map(|f| {
            let mut o = Map::new();
            pass(&mut o, "filename", f, "filename");
            pass(&mut o, "previousFilename", f, "previous_filename");
            pass(&mut o, "status", f, "status");
            pass(&mut o, "additions", f, "additions");
            pass(&mut o, "deletions", f, "deletions");
            pass(&mut o, "changes", f, "changes");
            o.insert("patch".into(), or(f.get("patch"), Value::Null));
            Value::Object(o)
          })
          .collect();
      }
    }
  }

  let threads_res = gh_detail(
    repo_dir,
    vec![
      "api".into(),
      "graphql".into(),
      "--paginate".into(),
      "-f".into(),
      format!("query={THREADS_QUERY}"),
      "-F".into(),
      format!("owner={owner}"),
      "-F".into(),
      format!("name={name}"),
      "-F".into(),
      format!("number={n}"),
    ],
  )
  .await;
  let threads = if threads_res.ok { to_threads(&parse_graphql_pages(&threads_res.stdout)) } else { Vec::new() };

  // Number(v.number): undefined is NaN (null in JSON), null is 0.
  let number_v = match v.get("number") {
    None => Value::Null,
    Some(x) => number_or0(Some(x)),
  };
  json!({
    "ok": true,
    "detail": {
      "number": number_v,
      "title": string_or_empty(v.get("title")),
      "url": string_or_empty(v.get("url")),
      "body": string_or_empty(v.get("body")),
      "author": string_or_empty(login_of(v.get("author"))),
      "state": string_or_empty(v.get("state")),
      "isDraft": truthy(v.get("isDraft")),
      "baseRefName": string_or_empty(v.get("baseRefName")),
      "headRefName": string_or_empty(v.get("headRefName")),
      "headRefOid": string_or_empty(v.get("headRefOid")),
      "mergeable": json!(v.get("mergeable").filter(|x| !x.is_null()).map(js_string).unwrap_or_else(|| "UNKNOWN".into())),
      "mergeStateStatus": string_or_empty(v.get("mergeStateStatus")),
      "review": review_state_of(v.get("reviewDecision")),
      "checks": summarise_checks(v.get("statusCheckRollup")),
      "checkRuns": to_check_runs(v.get("statusCheckRollup")),
      "additions": number_or0(v.get("additions")),
      "deletions": number_or0(v.get("deletions")),
      "changedFiles": number_or0(v.get("changedFiles")),
      "files": files,
      "threads": threads,
      "conversation": to_conversation(v.get("reviews"), v.get("comments")),
    }
  })
}

/// encodeURIComponent
fn encode_uri_component(s: &str) -> String {
  let mut out = String::new();
  for b in s.bytes() {
    if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

/// Both sides of one file of a PR, for the diff editor. A missing side (an
/// added or deleted file) is an empty string, not an error.
pub async fn pr_file_contents(repo_dir: &str, number: Option<&Value>, file_path: &str) -> Value {
  let empty = |error: &str| json!({ "ok": false, "base": "", "head": "", "baseRefOid": "", "headRefOid": "", "error": error });
  let Some(num) = pr_number(number) else { return empty("bad pr number") };
  if file_path.is_empty() || file_path.starts_with('/') || file_path.contains("..") {
    return empty("bad path");
  }
  let view = gh_detail(repo_dir, sv(&["pr", "view", &num.to_string(), "--json", "baseRefOid,headRefOid"])).await;
  if !view.ok {
    return empty(&clip(&view.stderr, 300));
  }
  let Ok(oids) = serde_json::from_str::<Value>(&view.stdout) else { return empty("unreadable response") };
  let Some(slug) = repo_slug_with(gh_detail(repo_dir, slug_args()).await).await else {
    return empty("could not resolve the GitHub repository");
  };
  let oid = |k: &str| or(get(Some(&oids), k), json!("")).as_str().map(str::to_string).unwrap_or_else(|| js_string(&oids[k]));
  let (base_oid, head_oid) = (oid("baseRefOid"), oid("headRefOid"));
  let encoded: Vec<String> = file_path.split('/').map(encode_uri_component).collect();
  let encoded = encoded.join("/");
  let at = |r: String| {
    let (dir, slug, encoded) = (repo_dir.to_string(), slug.clone(), encoded.clone());
    async move {
      if r.is_empty() {
        return String::new();
      }
      let g = gh_detail(
        &dir,
        sv(&["api", &format!("repos/{slug}/contents/{encoded}?ref={r}"), "-H", "Accept: application/vnd.github.raw", "--cache", "5m"]),
      )
      .await;
      if g.ok { g.stdout } else { String::new() }
    }
  };
  // Both sides at once (Promise.all).
  let base_task = tokio::spawn(at(base_oid.clone()));
  let head = at(head_oid.clone()).await;
  let base = base_task.await.unwrap_or_default();
  json!({ "ok": true, "base": base, "head": head, "baseRefOid": base_oid, "headRefOid": head_oid })
}

// ---- reviews (githubPrReview.ts) --------------------------------------------------------

const REVIEW_MISSING: &str = "GitHub CLI (gh) not found";

async fn gh_json(cwd: &str, args: Vec<String>, input: Option<&str>) -> Gh {
  gh_stdin(cwd, args, input, 30000, REVIEW_MISSING).await
}

fn write_result(r: &Gh) -> Value {
  if r.ok { json!({ "ok": true }) } else { json!({ "ok": false, "error": clip(&r.stderr, 400) }) }
}

/// JS `Number(v)` for a comparison (`a < b`).
fn js_num(v: &Value) -> f64 {
  match v {
    Value::Null => 0.0,
    Value::Bool(b) => f64::from(u8::from(*b)),
    Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
    Value::String(s) => {
      let t = js_trim(s);
      if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
    }
    _ => f64::NAN,
  }
}

/// The body for POST /pulls/{n}/reviews. A multi-line comment needs
/// start_line AND start_side.
pub fn review_payload(event: &Value, body: &Value, comments: &[Value], commit_id: &Value) -> Value {
  let mut p = Map::new();
  p.insert("event".into(), event.clone());
  p.insert("body".into(), body.clone());
  p.insert("commit_id".into(), commit_id.clone());
  if !comments.is_empty() {
    let list: Vec<Value> = comments
      .iter()
      .map(|c| {
        let mut one = Map::new();
        pass(&mut one, "path", c, "path");
        pass(&mut one, "line", c, "line");
        pass(&mut one, "side", c, "side");
        pass(&mut one, "body", c, "body");
        if let Some(start) = c.get("startLine") {
          if js_num(start) < js_num(c.get("line").unwrap_or(&Value::Null)) {
            one.insert("start_line".into(), start.clone());
            if let Some(side) = c.get("side") {
              one.insert("start_side".into(), side.clone());
            }
          }
        }
        Value::Object(one)
      })
      .collect();
    p.insert("comments".into(), Value::Array(list));
  }
  Value::Object(p)
}

pub async fn submit_review(repo_dir: &str, number: Option<&Value>, event: Option<&Value>, body: Option<&Value>, comments: Option<&Value>, commit_id: Option<&Value>) -> Value {
  let Some(num) = pr_number(number) else { return json!({ "ok": false, "error": "bad pr number" }) };
  let ev = event.and_then(Value::as_str).unwrap_or("");
  if !matches!(ev, "APPROVE" | "REQUEST_CHANGES" | "COMMENT") {
    return json!({ "ok": false, "error": "bad review event" });
  }
  let body = or(body, json!(""));
  let comments: Vec<Value> = or(comments, json!([])).as_array().cloned().unwrap_or_default();
  let commit_id = or(commit_id, json!(""));
  if js_trim(body.as_str().unwrap_or("")).is_empty() && comments.is_empty() && ev != "APPROVE" {
    return json!({ "ok": false, "error": "nothing to submit" });
  }
  let Some(slug) = repo_slug_with(gh_json(repo_dir, slug_args(), None).await).await else {
    return json!({ "ok": false, "error": "could not resolve the GitHub repository" });
  };
  let payload = review_payload(&json!(ev), &body, &comments, &commit_id);
  let r = gh_json(
    repo_dir,
    sv(&["api", "--method", "POST", &format!("repos/{slug}/pulls/{num}/reviews"), "--input", "-"]),
    Some(&payload.to_string()),
  )
  .await;
  write_result(&r)
}

fn thread_id_ok(id: &str) -> bool {
  static T: OnceLock<regex::Regex> = OnceLock::new();
  re(&T, r"^PRRT_[A-Za-z0-9_-]+$").is_match(id)
}

const REPLY_MUTATION: &str = "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}";

pub async fn reply_to_thread(repo_dir: &str, thread_id: &str, body: Option<&Value>) -> Value {
  if !thread_id_ok(thread_id) {
    return json!({ "ok": false, "error": "bad thread id" });
  }
  let body = or(body, json!(""));
  if js_trim(body.as_str().unwrap_or("")).is_empty() {
    return json!({ "ok": false, "error": "empty reply" });
  }
  let input = json!({ "query": REPLY_MUTATION, "variables": { "threadId": thread_id, "body": body } });
  let r = gh_json(repo_dir, sv(&["api", "graphql", "--input", "-"]), Some(&input.to_string())).await;
  write_result(&r)
}

pub async fn set_thread_resolved(repo_dir: &str, thread_id: &str, resolved: bool) -> Value {
  if !thread_id_ok(thread_id) {
    return json!({ "ok": false, "error": "bad thread id" });
  }
  let field = if resolved { "resolveReviewThread" } else { "unresolveReviewThread" };
  let query = format!("mutation($threadId:ID!){{{field}(input:{{threadId:$threadId}}){{thread{{id isResolved}}}}}}");
  let input = json!({ "query": query, "variables": { "threadId": thread_id } });
  let r = gh_json(repo_dir, sv(&["api", "graphql", "--input", "-"]), Some(&input.to_string())).await;
  write_result(&r)
}

#[cfg(test)]
mod tests {
  #[test]
  fn login_is_cached_per_repo_directory() {
    super::remember_login("/tmp/riven-test-a", "alice");
    super::remember_login("/tmp/riven-test-b", "bob");
    assert_eq!(super::cached_login("/tmp/riven-test-a").as_deref(), Some("alice"));
    assert_eq!(super::cached_login("/tmp/riven-test-b").as_deref(), Some("bob"));
    assert_eq!(super::cached_login("/tmp/riven-test-c"), None);
  }

  use super::*;

  // The cases of src/main/githubPr.test.ts, githubPrDetail.test.ts and
  // githubPrReview.test.ts that cover pure helpers.
  #[test]
  fn checks_both_shapes() {
    let r = summarise_checks(Some(&json!([
      { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
      { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" },
      { "__typename": "CheckRun", "status": "IN_PROGRESS" },
      { "__typename": "StatusContext", "state": "SUCCESS" },
      { "__typename": "StatusContext", "state": "PENDING" },
      null
    ])));
    assert_eq!(r, json!({ "total": 5, "passed": 2, "failed": 1, "pending": 2 }));
  }

  #[test]
  fn stacks() {
    let prs = vec![
      json!({ "number": 1, "headRefName": "a", "baseRefName": "main" }),
      json!({ "number": 3, "headRefName": "c", "baseRefName": "b" }),
      json!({ "number": 2, "headRefName": "b", "baseRefName": "a" }),
      json!({ "number": 5, "headRefName": "e", "baseRefName": "main" }),
    ];
    let out: Vec<(i64, i64)> = build_stacks(prs).iter().map(|p| (p["number"].as_i64().unwrap(), p["depth"].as_i64().unwrap())).collect();
    assert_eq!(out, vec![(5, 0), (1, 0), (2, 1), (3, 2)]);
  }

  #[test]
  fn humanize() {
    assert_eq!(humanize_branch("feat/some-thing"), "Some thing");
    assert_eq!(humanize_branch("fix_bug"), "Fix bug");
    assert_eq!(humanize_branch("feat/--"), "feat/--");
  }

  #[test]
  fn graphql_pages() {
    let pages = parse_graphql_pages("{\"a\":1}\n{\"b\":2}\n{bad");
    assert_eq!(pages, vec![json!({ "a": 1 }), json!({ "b": 2 })]);
  }

  #[test]
  fn payload_multiline() {
    let p = review_payload(&json!("COMMENT"), &json!("x"), &[json!({ "path": "a", "line": 5, "side": "RIGHT", "startLine": 3, "body": "b" }), json!({ "path": "a", "line": 5, "side": "LEFT", "startLine": 5, "body": "c" })], &json!("abc"));
    assert_eq!(p.to_string(), r#"{"event":"COMMENT","body":"x","commit_id":"abc","comments":[{"path":"a","line":5,"side":"RIGHT","body":"b","start_line":3,"start_side":"RIGHT"},{"path":"a","line":5,"side":"LEFT","body":"c"}]}"#);
  }

  #[test]
  fn uri_component() {
    assert_eq!(encode_uri_component("a b#?.ts"), "a%20b%23%3F.ts");
    assert_eq!(encode_uri_component("한"), "%ED%95%9C");
  }
}
