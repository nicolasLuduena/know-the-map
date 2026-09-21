/**
 * The store key of a repository: what is left of a clone URL once the ways
 * of writing the same repository are stripped. `git+https://…`, `git@…:`,
 * `ssh://git@…` and a trailing `.git` all name one key, and GitHub owners
 * are case-insensitive, so the whole key is lowercased. The result is
 * `host/owner/repo`, whose slashes become directory separators in the store.
 */
export const repositoryKey = (repository: string): string =>
  repository
    .replace(/^git\+/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/^([^/:]+):/, "$1/")
    .replace(/\/+$/, "")
    .toLowerCase();
