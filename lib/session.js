// Client session. Contains all info about current connection state.
//
'use strict';


const _              = require('lodash');
const crypto         = require('crypto');
const Denque         = require('denque');
const debug_err      = require('debug')('nntp-server.error');
const debug_net      = require('debug')('nntp-server.network');
const destroy        = require('destroy');
const serializeError = require('serialize-error').serializeError;
const split2         = require('split2');
const pump           = require('pump');
const flattenStream  = require('./flatten-stream');
const status         = require('./status');

const CMD_WAIT     = 0;
const CMD_PENDING  = 1;
const CMD_RESOLVED = 2;
const CMD_REJECTED = 3;

// same as lodash.escapeRegExp
function escape_regexp(str) {
  return str.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function is_stream(s) { return s && typeof s.on === 'function'; }


function Command(fn, cmd_line) {
  this.state = CMD_WAIT;
  this.fn = fn;
  this.cmd_line = cmd_line;
  this.resolved_value = null;
  this.rejected_value = null;
}

Command.prototype.run = function () {
  this.state = CMD_PENDING;

  return this.fn().then(
    value => {
      this.state = CMD_RESOLVED;
      this.resolved_value = value;
    },
    value => {
      this.state = CMD_REJECTED;
      this.rejected_value = value;
    }
  );
};


function Session(server, stream) {
  this.in_stream  = stream;
  this.out_stream = flattenStream();
  this.server     = server;

  // Could be just {}, but this is more clean
  // if this.groups.name is not set, group is not selected
  this.group = {
    min_index:       0,
    max_index:       0,
    total:           0,
    name:            null,
    description:     '',
    current_article: 0
  };

  this.pipeline = new Denque();

  this.debug_mark = crypto.pseudoRandomBytes(3).toString('hex');

  // Random string used to track connection in logs
  debug_net('    [%s] %s', this.debug_mark, 'new connection');

  // Create RE to search command name. Longest first (for subcommands)
  let commands = Object.keys(this.server.commands).sort().reverse();

  this.__search_cmd_re = RegExp(`^(${commands.map(escape_regexp).join('|')})`, 'i');

  this.lines = split2();

  this.write(status._201_SRV_READY_RO);

  pump(stream, this.lines);

  pump(this.out_stream, stream);

  if (debug_net.enabled) {
    let debug_logger = split2();

    pump(this.out_stream, debug_logger);

    debug_logger.on('data', line => {
      debug_net('<-- [%s] %s', this.debug_mark, line);
    });
  }

  this.lines.on('data', line => {
    debug_net('--> [%s] %s', this.debug_mark, line);
    this.parse(line);
  });

  this.lines.on('error', err => {
    debug_err('ERROR: %O', serializeError(err));
    this.server._onError(err);
    this.out_stream.destroy();
  });

  this.lines.on('end', () => {
    debug_net('    [%s] %s', this.debug_mark, 'connection closed');
    this.server._connectionClose(this);
    this.out_stream.destroy();
  });
}

// By default connection is not secure
Session.prototype.secure = false;
// Default mode is "reader"
Session.prototype.reader = true;

Session.prototype.authenticated = false;
Session.prototype.authinfo_user = null;
Session.prototype.authinfo_pass = null;

Session.prototype.current_group = null;

/**
 * Send strings to connected client, adding CRLF after each
 *
 * data:
 *
 * - String
 * - Stream of strings (object mode)
 * - null (close session)
 * - Array with any combinations above
 */
Session.prototype.write = function (data) {
  if (!this.out_stream.writable) {
    if (is_stream(data)) destroy(data);
    return;
  }

  this.out_stream.write(data);
};

Session.prototype.writeRawData = function (data) {
	// we write raw body to the in_stream to avoid additional data processing
  if (!this.in_stream.writable) {
    if (is_stream(data)) destroy(data);
	console.log("bodystream is not writable");
    return;
  }

 for(let i=0; i < data.length; i++) {
  this.in_stream.write(data[i]);
  this.in_stream.write("\r\n");	 
 }
};


function enqueue(session, command) {
  session.pipeline.push(command);
  session.tick();
}

// Parse client commands and push into pipeline
//
Session.prototype.parse = function (data) {
  let input = data.toString().replace(/\r?\n$/, '');

  // Command not recognized
  if (!this.__search_cmd_re.test(input)) {
    enqueue(this, new Command(() => Promise.resolve(status._500_CMD_UNKNOWN), input));
    return;
  }

  let cmd = input.match(this.__search_cmd_re)[1].toUpperCase();

  // Command looks known, but whole validation failed -> bad params
  if (!this.server.commands[cmd].validate.test(input)) {
    enqueue(this, new Command(() => Promise.resolve(status._501_SYNTAX_ERROR), input));
    return;
  }

  // Command require auth, but it was not done yet
  // Force secure connection if needed
  if (this.server._needAuth(this, cmd)) {
    enqueue(this, new Command(() => Promise.resolve(
      this.secure ? status._480_AUTH_REQUIRED : status._483_NOT_SECURE
    ), input));
    return;
  }

  enqueue(this, new Command(() => Promise.resolve(this.server.commands[cmd].run(this, input)), input));
};


Session.prototype.tick = function () {
  if (this.pipeline.isEmpty()) return;

  let cmd = this.pipeline.peekFront();
  if (cmd.state === CMD_RESOLVED) {
	if(cmd.cmd_line.indexOf('BODY')==0 || cmd.cmd_line.indexOf('ARTICLE')==0)
		this.writeRawData(cmd.resolved_value);
	else
		this.write(cmd.resolved_value);
    this.pipeline.shift();
    this.tick();

  } else if (cmd.state === CMD_REJECTED) {
    _.set(cmd.rejected_value, 'nntp_command', cmd.cmd_line);
    this.write(status._403_FUCKUP);
    debug_err('ERROR: %O', serializeError(cmd.rejected_value));
    this.server._onError(cmd.rejected_value);
    this.pipeline.shift();
    this.tick();

  } else if (cmd.state === CMD_WAIT) {
    // stop executing commands on closed connection
    if (!this.out_stream.writable) return;
    cmd.run().then(() => this.tick());
  }
};


module.exports = Session;

module.exports.create = function (server, stream) {
  return new Session(server, stream);
};
