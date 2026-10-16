/**
 * Injected GitHub client factory. All HTTP goes through an injected fetch
 * implementation so tests can mock the GitHub API without network access.
 *
 * createServiceGitHub({ fetchImpl, token }) -> { user(), getIssue(), ... }
 * The token here is the caller's bearer (user token for writes, service
 * token for reads).
 */

export function httpError(httpStatus, code, message) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

const UA = "claim-api/0.1.0";

export function createServiceGitHub({ fetchImpl = fetch, token = "" } = {}) {
  const headers = {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function call(url, opts = {}) {
    const res = await fetchImpl(url, {
      ...opts,
      headers: { ...headers, ...(opts.headers || {}) },
    });
    if (res.status === 404) return null;
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") throw httpError(429, "github-rate-limited", `GitHub rate limit hit on ${url}.`);
      const body = await res.text().catch(() => "");
      throw httpError(403, "github-forbidden", `GitHub refused the request (${url}): ${body.slice(0, 160)}`);
    }
    if (res.status === 401) throw httpError(401, "bad-credentials", "GitHub rejected the token.");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw httpError(502, "github-error", `GitHub ${res.status} on ${url}: ${body.slice(0, 160)}`);
    }
    return res.json().catch(() => ({}));
  }

  const get = (url) => call(url);
  const post = (url, body, extraHeaders = {}) =>
    call(url, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });

  return {
    state: { calls: 0 },

    /** Verify a bearer token and return the GitHub login. */
    async user() {
      const data = await get("https://api.github.com/user");
      if (!data || !data.login) throw httpError(401, "invalid-token", "Token is not valid GitHub credentials.");
      return { login: data.login, id: data.id };
    },

    /** Exchange an OAuth code for a user access token. */
    async exchangeCode(clientId, clientSecret, code) {
      const res = await call("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      if (!res || !res.access_token) {
        throw httpError(401, "oauth-exchange-failed", "GitHub did not issue a token for that code.");
      }
      return res.access_token;
    },

    getIssue(owner, repo, number) {
      return get(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`);
    },
    getComments(owner, repo, number) {
      return get(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
    },
    getCommentReactions(owner, repo, commentId) {
      return get(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions?per_page=100`);
    },
    postIssueComment(owner, repo, number, body) {
      return post(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, { body });
    },
    addCommentReaction(owner, repo, commentId, content) {
      return post(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, { content });
    },
    getTimeline(owner, repo, number) {
      return get(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`);
    },
    getPull(owner, repo, prNumber) {
      return get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);
    },
    getClaimsPolicy(owner, repo) {
      return get(`https://api.github.com/repos/${owner}/${repo}/contents/.greenlight/claims.json`);
    },
  };
}
