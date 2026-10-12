# Publish NexaRoom-GV on GitHub

1. Create a **new empty** public (or private during review) repository named `NexaRoom-GV`. Do **not** initialize a GitHub README, `.gitignore`, or license if uploading via Git CLI.
2. Extract this ZIP to your Windows PC. The directory containing `manage.py` and this README should be the repository root.
3. Check the files for secrets and private data before publishing.
4. Open PowerShell in the extracted `NexaRoom-GV` folder, then run:

```powershell
git init
git branch -M main
git add .
git status
git commit -m "Initial public release: NexaRoom-GV V9.9"
git remote add origin https://github.com/YOUR_USERNAME/NexaRoom-GV.git
git push -u origin main
```

GitHub authentication may prompt you to sign in through your browser or Git credential manager. Never paste a personal access token in a chat.

**Important:** Do NOT publish the V9.9 UI patch ZIP as a standalone repository. This full-source archive is the one to publish. GitHub may not convert a single ZIP attachment into browsable source files; extract and commit its contents.

**Before launch:** verify local import checks, screenshots, README, and a safe demo link. See README for functionality and limitations.
