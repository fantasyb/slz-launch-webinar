#!/usr/bin/env node
/**
 * The offline consolidation pass. Run by cairn:install as two automatic hooks —
 * --hook at SessionEnd (harvest the transcript that just closed into drafts/)
 * and --surface at SessionStart (report what a prior session left) — so nobody
 * ever types a command. Also runs by hand over explicit transcripts.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build. This one is on the session-open and session-close path, so the
 * bundle matters: a 700ms tsx boot on every session start is a tax nobody agreed
 * to. The hook modes never throw and always exit 0 — a consolidation pass must
 * not be the reason a session fails to open or close (cairn-0046).
 */
const { launch } = require('./launch');

launch('sleep');
