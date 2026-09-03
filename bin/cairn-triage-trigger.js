#!/usr/bin/env node
/**
 * Spawn a triage agent when this machine can, never blocking. Wired by
 * cairn:install as a SessionStart hook, so it runs on the session-open path —
 * bundled (not tsx) so it costs ~50ms, not a 700ms boot, and it exits at once
 * because the agent it spawns is detached (cairn-0042, cairn-0046).
 *
 * Bundle-or-source is decided in bin/launch.js.
 */
const { launch } = require('./launch');

launch('triage-trigger');
