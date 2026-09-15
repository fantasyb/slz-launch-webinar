#!/usr/bin/env node
/**
 * The always-on housekeeping daemon: audit-chain verification and self-update
 * on a fixed interval, forever. It runs no checks and promotes nothing.
 * Registered under launchd on macOS by cairn:install (survives logout/reboot).
 *
 * Bundle-or-source is decided in bin/launch.js.
 */
const { launch } = require('./launch');

launch('daemon');
