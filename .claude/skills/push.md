---
name: push
description: "Push code to remote repositories. GitHub (aiyafun) gets a full security audit first; cnb.cool pushes directly."
user_invocable: true
---

# /push — Safe Push to Remote

Push the current branch to the appropriate remote repository. The workflow differs based on the target:

- **GitHub (aiyafun)**: open-source target — run a full security & compliance audit before pushing
- **cnb.cool (origin)**: private repo — push directly, no filtering needed

## Step 0: Determine Target

Ask the user which remote to push to if not specified in the invocation argument:
- `github` → open-source flow (full audit)
- `cnb` / `origin` → private flow (direct push)

If the user says "github", go to **Step 1**. If "cnb" or "origin", skip to **Step 6**.

---

## GitHub Open-Source Flow (Steps 1–5)

### Step 1: Secret Scan

Scan ALL staged and modified files for these patterns. **Do NOT skip any pattern.**

```
sk-[a-zA-Z0-9_-]{20,}          # OpenAI / generic API keys
AKIA[0-9A-Z]{16}               # AWS access key
AKLT[a-zA-Z0-9+/=]{20,}        # VolcEngine access key
-----BEGIN (RSA |EC )?PRIVATE KEY-----
password\s*[:=]\s*"[^"]{8,}"   # password assignments
secret\s*[:=]\s*"[^"]{8,}"     # secret assignments
postgresql://[^:]+:[^@]+@[^/]+  # database connection strings with credentials
redis://:[^@]+@                 # Redis connection strings with password
wxe[0-9a-f]{14}                # WeChat AppID
apiv3.*key.*=.*"[^"]{32}"      # WeChat APIv3 key
[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ # Real IP addresses (check context — ignore 127.0.0.1, 0.0.0.0, example ranges)
```

Also grep the **entire working tree** (not just staged files) for real server IPs, domain credentials, or hardcoded tokens that might have been missed.

If any real secret is found:
1. Report the file, line number, and matched pattern
2. **STOP** — do not push
3. Suggest a fix (e.g., move to .env, use placeholder, split string with `.join('')`)

### Step 2: Verify .gitignore Coverage

Confirm these files/dirs are in `.gitignore` and NOT tracked by git:

```
.env / .env.local / .env.production
deploy.config.json
deploy/xray-bin
deploy/xray-config.json
docs/凭证清单.md
docs/开发进度与交接.md
docs/生产化部署.md
docs/火山Supabase迁移.md
docs/微信支付接入.md
docs/方案-*.md
.cnb.yml
.idea / .vscode
```

Run `git ls-files` to verify none of these are tracked. If any are tracked, run `git rm --cached` to untrack them before proceeding.

### Step 3: Commercial Content Check

Scan for commercially sensitive content that should not be open-sourced:

- Internal pricing, revenue numbers, or customer data
- Server deployment addresses (real IPs, real domain configs beyond examples)
- Internal team communication (WeChat/Feishu group IDs, webhook URLs with tokens)
- Proprietary business logic comments referencing internal decisions
- Any file under `docs/` that is not meant to be public

### Step 4: Contributor Attribution

All commits pushed to GitHub must use:

```
GIT_AUTHOR_NAME="AiyaFun"
GIT_AUTHOR_EMAIL="293326193+AiyaFun@users.noreply.github.com"
GIT_COMMITTER_NAME="AiyaFun"
GIT_COMMITTER_EMAIL="293326193+AiyaFun@users.noreply.github.com"
```

Check `git log` for any commits with other author names (e.g., "Claude", personal names, cnb.cool noreply addresses). If found, rewrite with `git filter-branch` before pushing.

### Step 5: Push to GitHub

```bash
git push github <current-branch>:main
```

If GitHub Push Protection blocks the push, read the error, fix the offending pattern (split strings, use placeholders), and retry.

---

## cnb.cool Private Flow (Step 6)

### Step 6: Direct Push

No audit needed — this is the private repo.

```bash
git push origin <current-branch>
```

---

## Summary

After pushing, report:
- Which remote was pushed to
- How many commits were pushed
- Any issues found and fixed during the audit (GitHub flow only)
