#!/usr/bin/env node
// Agent Omega — terminal ATTACH client (entry point). Thin wrapper: all logic lives in
// scripts/attach/*.mjs. Run over SSH (e.g. from Termius) to drive the ALREADY-RUNNING desktop
// Agent Omega from a plain terminal — see REMOTE.md. Preferred launcher: the `omg` command.
//
//   node scripts/attach.mjs            # attach (auto-pick if one instance)
//   node scripts/attach.mjs <selector> # port / cwd substring / .json path
//   ATTACH_HISTORY=50 / ATTACH_PLAIN=1 / ATTACH_THOUGHTS=1 / ATTACH_ASCII=1 / ATTACH_DEBUG=1
import { run } from './attach/controller.mjs'
run().catch((e) => { try { process.stdout.write('\x1b[?25h\x1b[0m') } catch {}; process.stderr.write('attach error: ' + ((e && e.message) || e) + '\n'); process.exit(1) })
