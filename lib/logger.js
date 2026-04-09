'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

class Logger {

  constructor(level = 'info') {
    this._level = LEVELS[level] ?? LEVELS.info;
  }

  error(msg, ctx) { this._write('error', msg, ctx); }
  warn(msg, ctx) { this._write('warn', msg, ctx); }
  info(msg, ctx) { this._write('info', msg, ctx); }
  debug(msg, ctx) { this._write('debug', msg, ctx); }

  _write(level, msg, ctx) {
    if (LEVELS[level] > this._level) return;
    const ts = new Date().toISOString();
    const prefix = `${ts} [${level.toUpperCase()}]`;
    if (ctx) {
      process.stdout.write(`${prefix} ${msg} ${JSON.stringify(ctx)}\n`);
    } else {
      process.stdout.write(`${prefix} ${msg}\n`);
    }
  }
}

module.exports = { Logger };
