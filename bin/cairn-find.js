#!/usr/bin/env node
/**
 * Search the corpus: paste the failure text and see what is already known.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('find');
