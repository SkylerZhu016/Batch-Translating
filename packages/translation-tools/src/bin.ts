#!/usr/bin/env node

import { runTranslationToolsCli } from './cli.js';

process.exitCode = await runTranslationToolsCli(process.argv.slice(2));
