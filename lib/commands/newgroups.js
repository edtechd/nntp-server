// https://tools.ietf.org/html/rfc3977#section-7.3
//
'use strict';


const from2      = require('from2');
const pump       = require('pump');
const through2   = require('through2');
const status     = require('../status');


const CMD_RE = /^NEWGROUPS (\d{6,8})\s(\d{6})(?:\sGMT)?$/i;


module.exports = {
  head:     'NEWGROUPS',
  validate: CMD_RE,
  pipeline: true,

  async run(session, cmd) {
    let [ , d, t ] = cmd.match(CMD_RE);

    // Backward compatibility, as per RFC 3977 section 7.3.2:
    // 76 => 1976, 12 => 2012
    if (d.length === 6) {
      let current_year = new Date().getUTCFullYear();
      let century = Math.floor(current_year / 100);

      if (Number(d.slice(0, 2)) > current_year % 100) {
        d = String(century - 1) + d;
      } else {
        d = String(century) + d;
      }
    }

    let [ , year, month, day ] = d.match(/^(....)(..)(..)$/);
    let [ , hour, min, sec ]   = t.match(/^(..)(..)(..)$/);

    let ts = new Date(Date.UTC(year, month, day, hour, min, sec));

    let groups = await session.server._getGroups(session, ts);

    if (Array.isArray(groups)) groups = from2.obj(groups);

    let stream = through2.obj(function (group, encoding, callback) {
      this.push(`${group.name} ${group.max_index} ${group.min_index} n`);
      callback();
    });

    pump(groups, stream);

    return [
      status._215_INFO_FOLLOWS,
      stream,
      '.'
    ];
  }
};
