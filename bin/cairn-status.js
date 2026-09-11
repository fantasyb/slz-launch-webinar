#!/usr/bin/env node
/**
 * Is anyone using this corpus, and is it answering well — from anywhere.
 *
 * Every other command an agent reaches for is `node bin/cairn-<x>.js`; status
 * was npm-only, so the first external crew that tried the bin path for it got
 * ENOENT. Same launcher as the rest: bundle-or-source is decided in
 * bin/launch.js, including what to do with a stale build.
 */
const { launch } = require('./launch');

launch('status');
