#!/usr/bin/env node
/**
 * Write a finding from the command line.
 *
 * Bundle-or-source is decided in bin/launch.js, including what to do with a
 * stale build.
 */
const { launch } = require('./launch');

launch('record');
