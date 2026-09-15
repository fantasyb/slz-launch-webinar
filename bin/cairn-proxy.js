#!/usr/bin/env node
/**
 * The gateway: sit in front of MCP servers and ride findings back on their results.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('mcp-proxy');
