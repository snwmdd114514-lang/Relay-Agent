# Relay Agent v0.7.0 Test Report

Runtime regression test: **26/26 PASS**.

Passed checks:

1. Public status endpoint
2. API authentication required
3. Relay system prompt + `cuckoo` JavaScript protocol
4. JS file read
5. Write + edit
6. Glob + grep
7. Safe shell
8. `webLooking()`
9. `webHtml()`
10. `webDownload()`
11. `webFetch()` / `webPreview()` compatibility aliases
12. `auto_all` skips ordinary approval
13. System-destructive shell command hard deny
14. Delete enters approval in ask mode
15. Delete succeeds after approval
16. Shell redirection enters approval
17. Shell command succeeds after approval
18. Symlink boundary protection
19. Node globals hidden from JS sandbox
20. String code generation blocked
21. Skill bridge
22. Web bridge queue
23. Web bridge round trip
24. Session JSONL persistence
25. DeepSeek send throttle is configured for **2000–4000 ms** and uses a serial send queue
26. Relay Agent branding/version metadata

Additional syntax checks passed:

- `node --check agent/server.js`
- `node --check agent/chat-client.js`
- `node --check relay-agent.user.js`
- `bash -n agent.command`

macOS `launchctl` itself cannot be executed in the Linux test container, so launchd bootstrap is validated statically and should be verified on the target Mac using menu item `9) 测试 API` after installation.
