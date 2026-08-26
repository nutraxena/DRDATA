/* Dr-Diary — normalisation helpers for messy spreadsheet values. */
(function (DD) {
  'use strict';

  var DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var DAY_LABEL = {
    SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday',
    THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', ANY: 'Any Day'
  };
  var DAY_SHORT = {
    SUN: 'Sun', MON: 'Mon', TUE: 'Tue', WED: 'Wed',
    THU: 'Thu', FRI: 'Fri', SAT: 'Sat', ANY: 'Any'
  };
  var DAY_WORDS = {
    sunday: 'SUN', sun: 'SUN', monday: 'MON', mon: 'MON', tuesday: 'TUE', tue: 'TUE',
    tues: 'TUE', wednesday: 'WED', wed: 'WED', thursday: 'THU', thu: 'THU', thur: 'THU',
    thurs: 'THU', friday: 'FRI', fri: 'FRI', saturday: 'SAT', sat: 'SAT',
    anyday: 'ANY', any: 'ANY', daily: 'ANY', all: 'ANY', everyday: 'ANY'
  };

  function clean(v) {
    return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  }

  /** "FRIDAY", "MON,WED", "Any Day" -> ["FRI"] / ["MON","WED"] / ["ANY"] */
  function parseDays(raw) {
    if (raw === null || raw === undefined || raw === '') return [];
    var tokens = String(raw).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'any' && tokens[i + 1] === 'day') { out.push('ANY'); i++; continue; }
      var d = DAY_WORDS[tokens[i]];
      if (d && out.indexOf(d) === -1) out.push(d);
    }
    if (out.indexOf('ANY') !== -1) return ['ANY'];
    return out.sort(function (a, b) { return DAYS.indexOf(a) - DAYS.indexOf(b); });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  /**
   * Accepts an Excel day-fraction (0.604166 -> "14:30"), a text time ("1:00",
   * "1 PM", "13:00"), or "ANY TIME". Returns "HH:MM", or null when unknown.
   * A bare hour of 1-7 with no am/pm is read as PM — field rounds run afternoons.
   */
  function parseTime(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && isFinite(raw)) {
      var mins = Math.round((raw - Math.floor(raw)) * 24 * 60);
      return pad(Math.floor(mins / 60) % 24) + ':' + pad(mins % 60);
    }
    var s = String(raw).trim().toLowerCase();
    if (!s || /^any/.test(s.replace(/\s+/g, ''))) return null;

    var asNum = Number(s);
    if (!isNaN(asNum) && asNum > 0 && asNum < 1) return parseTime(asNum);

    var m = s.match(/^(\d{1,2})\s*[:.\s]?\s*(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var mer = m[3] ? m[3][0] : null;
    if (isNaN(h) || h > 24 || min > 59) return null;
    if (mer === 'p' && h < 12) h += 12;
    else if (mer === 'a' && h === 12) h = 0;
    else if (!mer && h >= 1 && h <= 7) h += 12;
    return pad(h % 24) + ':' + pad(min);
  }

  /** "13:00" -> "1:00 PM"; null -> "Any time" */
  function formatTime(t) {
    if (!t) return 'Any time';
    var parts = String(t).split(':');
    var h = parseInt(parts[0], 10);
    var m = parts[1] || '00';
    if (isNaN(h)) return 'Any time';
    var mer = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + mer;
  }

  /** Sort key: unknown times go last. */
  function timeKey(t) {
    if (!t) return 9999;
    var p = String(t).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  /** "079-9898777892", "+91 98765 43210" -> "9898777892"; junk -> "" */
  function parseMobile(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw)
      .split(/[,/;&]+/)
      .map(function (part) {
        var d = part.replace(/\D/g, '');
        if (d.length < 10) return '';
        var ten = d.slice(-10);
        if (!/^[6-9]/.test(ten)) return '';
        // 9000000000 / 8888888888 are placeholders, not numbers.
        var distinct = {};
        for (var i = 0; i < ten.length; i++) distinct[ten[i]] = 1;
        if (Object.keys(distinct).length < 4) return '';
        return ten;
      })
      .filter(Boolean)
      .filter(function (v, i, a) { return a.indexOf(v) === i; })
      .join(', ');
  }

  function firstMobile(raw) {
    var all = parseMobile(raw);
    return all ? all.split(',')[0].trim() : '';
  }

  /** "DR A SAMPLE" -> "Dr A Sample" for display. */
  function titleCase(s) {
    return clean(s).toLowerCase().replace(/\b([a-z])/g, function (_, c) { return c.toUpperCase(); })
      .replace(/\bDr\b\.?/i, 'Dr');
  }

  /** Lowercase, punctuation-free haystack used by search. */
  function searchKey(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function todayKey(d) {
    return DAYS[(d || new Date()).getDay()];
  }

  function isoDate(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }

  /** "3 days ago" / "Today" / "Yesterday" from an ISO date string. */
  function relativeDays(iso) {
    if (!iso) return '';
    var then = new Date(iso + 'T00:00:00');
    if (isNaN(then.getTime())) return '';
    var now = new Date(isoDate() + 'T00:00:00');
    var diff = Math.round((now - then) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 30) return diff + ' days ago';
    if (diff < 365) return Math.floor(diff / 30) + ' month' + (diff < 60 ? '' : 's') + ' ago';
    return Math.floor(diff / 365) + ' year' + (diff < 730 ? '' : 's') + ' ago';
  }

  DD.parse = {
    DAYS: DAYS,
    DAY_LABEL: DAY_LABEL,
    DAY_SHORT: DAY_SHORT,
    clean: clean,
    parseDays: parseDays,
    parseTime: parseTime,
    formatTime: formatTime,
    timeKey: timeKey,
    parseMobile: parseMobile,
    firstMobile: firstMobile,
    titleCase: titleCase,
    searchKey: searchKey,
    todayKey: todayKey,
    isoDate: isoDate,
    relativeDays: relativeDays
  };
})(window.DD = window.DD || {});
