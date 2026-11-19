# Working on this locally

Everything below assumes macOS. Once set up, the loop is:
**edit → commit → push → Netlify deploys in ~30 seconds.**

> Since continuous deployment is live, **anything pushed to `main` goes straight to
> the whole batch.** Use a branch for anything non-trivial — see *Safer changes* below.

---

## One-time setup

### 1. Check git

```bash
git --version
```

If macOS prompts to install the developer tools, accept — that includes git.

### 2. Clone the repo

```bash
cd ~/Projects          # or wherever you keep things; mkdir -p ~/Projects first
git clone https://github.com/aryan-42/hrm-timetable.git
cd hrm-timetable
```

### 3. Tell git who you are

```bash
git config user.name  "Aryan Singh"
git config user.email "aryn.snh@gmail.com"   # the email on your GitHub account
```

### 4. Authenticate

The simplest route is the GitHub CLI:

```bash
brew install gh        # install Homebrew first if needed: https://brew.sh
gh auth login          # choose GitHub.com → HTTPS → login with a browser
```

That stores credentials so `git push` just works. Without `gh`, git will ask for a
password on first push — use a Personal Access Token from
github.com/settings/tokens (scope: `repo`), not your account password.

---

## The everyday loop

```bash
git pull                      # always start here
# ...edit index.html...
git add -A
git commit -m "Fix exam time for STHR"
git push
```

Netlify picks it up automatically. Watch the build at app.netlify.com → your site → Deploys.

### Previewing before you push

No build step — it's one static file:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Note that Google sign-in will **not** work on
localhost unless `http://localhost:8000` is added to Supabase → Authentication →
URL Configuration → Redirect URLs. The schedule itself renders fine without signing in.

---

## Safer changes

For anything beyond a typo, don't commit to `main` directly:

```bash
git checkout -b fix-exam-times     # new branch
# ...edit...
git add -A && git commit -m "Correct STHR exam time"
git push -u origin fix-exam-times
```

Then open a pull request on GitHub. Netlify builds a **deploy preview** at its own
URL — check it there, and merge only once it looks right. Merging to `main` is what
ships it to students.

```bash
git checkout main && git pull      # back to main afterwards
```

---

## If something breaks in production

Don't scramble to fix forward. Roll back first:

**Netlify → Deploys → the last good deploy → Publish deploy.**

The site reverts immediately. Then fix the code properly on a branch.

---

## Never commit these

The `.gitignore` already blocks them, but as a rule: **no roster files.** Anything
mapping roll numbers to electives (`Course_wise_Students*.xlsx`, generated `.sql`
with enrolment rows) stays out — this repo is public, and that data is 121
classmates'.

Secrets likewise: the Apps Script `PUSH_SECRET` belongs in Script Properties, never
in a file here. The Supabase *anon* key in `index.html` is fine — it's designed to be
public, and Row Level Security is what protects the data.

---

## Optional: Claude Code CLI

To work on this with Claude from your terminal:

```bash
npm install -g @anthropic-ai/claude-code    # needs Node.js
cd ~/Projects/hrm-timetable
claude
```

It reads the repo directly, so you can ask for changes in place rather than copying
files around.
