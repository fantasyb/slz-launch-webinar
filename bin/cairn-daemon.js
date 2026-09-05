#!/usr/bin/env node
/**
 * The always-on triage daemon. Session-start triage is bursty and stops the
 * moment you stop working; this drains the queue on a fixed interval, forever.
 * Registered under launchd on macOS by cairn:install (survives logout/reboot).
 *
 * Bundle-or-source is decided in bin/launch.js.
 */
const { launch } = require('./launch');

launch('daemon');
