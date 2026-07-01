# NOTICE

Agent Omega is built on and redistributes a **modified fork** of the open-source
**opencode** engine, which is licensed under the MIT License.

Full credit for the underlying agent engine goes to the opencode project and its
contributors (https://github.com/sst/opencode). Agent Omega wraps opencode with a
C# .NET desktop shell, a Node.js sidecar, and a Python web bridge; the core
agent runtime is opencode.

The prebuilt engine binary shipped with Agent Omega (distributed as a GitHub
Release download) is a **build of a modified fork** of opencode — the source is
changed from upstream — and is distributed under opencode's MIT license,
reproduced verbatim below. That binary also statically bundles opencode's own
third-party npm dependencies, each under its own OSI-approved license; their
notices are carried by the opencode project and its `node_modules`, not restated
here.

Agent Omega's on-demand **skills** (brainstorming, writing-plans, tdd, verify,
debugging, code-review, run-app, orchestration) are adapted from patterns in the
MIT-licensed "superpowers" skills collection and Anthropic's Claude Code / OpenAI
Codex working styles — ideas borrowed and rewritten, credited here.

---

opencode — MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
