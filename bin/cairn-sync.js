#!/usr/bin/env node
/**
 * Pull the shared corpus and re-federate, so a reader is current.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('sync');
