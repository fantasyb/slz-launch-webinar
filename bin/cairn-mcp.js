#!/usr/bin/env node
/**
 * The find/record pair as an MCP server, for a client that will call tools.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('mcp-server');
