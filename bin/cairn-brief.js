#!/usr/bin/env node
/**
 * The standing brief: what this corpus knows, for a session that is starting.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('brief');
